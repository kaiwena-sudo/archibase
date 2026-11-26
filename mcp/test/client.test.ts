import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ArchibaseClient, ConfigError, loadConfig, TESTNET } from "../src/client.js";

// A fresh throwaway key per run, used only to sign mock payments; it never holds funds.
const KEY = generatePrivateKey();
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EXPECTED_PAY_TO = "0x0000000000000000000000000000000000000001";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** A fake Archibase: 402 with terms unless a payment header is present; 404 for /missing. */
function fakeApi(priceAtomic: string) {
  const calls: { url: string; paid: boolean }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const paid = req.headers.has("payment-signature");
    calls.push({ url: req.url, paid });
    if (req.url.includes("/missing")) return Response.json({ error: "vector_not_found" }, { status: 404 });
    if (paid) {
      return Response.json({ results: [] }, {
        headers: { "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: TESTNET }) },
      });
    }
    const terms = {
      x402Version: 2,
      resource: { url: req.url, description: "test", mimeType: "application/json" },
      accepts: [{
        scheme: "exact", network: TESTNET, amount: priceAtomic, asset: USDC_SEPOLIA,
        payTo: EXPECTED_PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" },
      }],
    };
    return Response.json(terms, { status: 402, headers: { "payment-required": b64(terms) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const config = (over: Record<string, string> = {}) =>
  loadConfig({ ARCHIBASE_API_URL: "https://api.test", ARCHIBASE_NETWORK: TESTNET, ARCHIBASE_PRIVATE_KEY: KEY, ARCHIBASE_EXPECTED_PAY_TO: EXPECTED_PAY_TO, ...over });

describe("loadConfig", () => {
  it("defaults to Base mainnet with a $2 budget and $0.25 per call", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ network: "eip155:8453", budgetUsd: 2, maxPriceUsd: 0.25, privateKey: undefined });
  });

  it("rejects bad keys, networks and plain-http remote URLs", () => {
    expect(() => loadConfig({ ARCHIBASE_PRIVATE_KEY: "0x1234" })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCHIBASE_NETWORK: "eip155:1" })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCHIBASE_API_URL: "http://example.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCHIBASE_BUDGET_USD: "-1" })).toThrow(ConfigError);
    expect(loadConfig({ ARCHIBASE_API_URL: "http://localhost:3000" }).apiUrl).toBe("http://localhost:3000");
  });
});

describe("ArchibaseClient spending", () => {
  it("pays and records the spend", async () => {
    const api = fakeApi("20000");
    const c = new ArchibaseClient(config(), api.fetchImpl);
    const r = await c.get("/api/v1/plans/search?bedrooms=2");
    expect(r.status).toBe(200);
    expect(r.paid).toMatchObject({ amountUsd: 0.02, network: TESTNET });
    expect(c.spentUsd).toBeCloseTo(0.02);
    expect(api.calls.filter((x) => x.paid)).toHaveLength(1);
  });

  it("without a wallet, returns the price and never pays", async () => {
    const api = fakeApi("20000");
    const c = new ArchibaseClient(config({ ARCHIBASE_PRIVATE_KEY: "" }), api.fetchImpl);
    const r = await c.get("/api/v1/plans/search");
    expect(r.status).toBe(402);
    expect(api.calls.some((x) => x.paid)).toBe(false);
  });

  it("refuses a price above the per-call maximum", async () => {
    const api = fakeApi("500000"); // $0.50
    const c = new ArchibaseClient(config(), api.fetchImpl);
    await expect(c.get("/api/v1/plans/search")).rejects.toThrow(/above ARCHIBASE_MAX_PRICE_USD/);
    expect(api.calls.some((x) => x.paid)).toBe(false);
  });

  it("refuses a challenge that pays someone other than the configured receiver", async () => {
    const api = fakeApi("20000");
    const evil = api.fetchImpl;
    const swapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await evil(input, init);
      if (res.status !== 402) return res;
      const body = (await res.json()) as { accepts: { payTo: string }[] };
      body.accepts.forEach((a) => (a.payTo = "0x000000000000000000000000000000000000dEaD"));
      return new Response(JSON.stringify(body), { status: 402, headers: res.headers });
    }) as typeof fetch;
    const c = new ArchibaseClient(config(), swapped);
    await expect(c.get("/api/v1/plans/search")).rejects.toThrow(/other than ARCHIBASE_EXPECTED_PAY_TO/);
    expect(api.calls.some((x) => x.paid)).toBe(false);
  });

  it("stops at the session budget", async () => {
    const api = fakeApi("20000");
    const c = new ArchibaseClient(config({ ARCHIBASE_BUDGET_USD: "0.05" }), api.fetchImpl);
    await c.get("/a");
    await c.get("/b");
    await expect(c.get("/c")).rejects.toThrow(/session budget/);
    expect(api.calls.filter((x) => x.paid)).toHaveLength(2);
    expect(c.remainingUsd).toBeCloseTo(0.01);
  });

  it("never overspends the budget with parallel calls (SEC-01)", async () => {
    const api = fakeApi("20000");
    const c = new ArchibaseClient(config({ ARCHIBASE_BUDGET_USD: "0.03" }), api.fetchImpl);
    const results = await Promise.allSettled([c.get("/a"), c.get("/b"), c.get("/c")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(api.calls.filter((x) => x.paid)).toHaveLength(1);
    expect(c.spentUsd).toBeCloseTo(0.02);
  });

  it("passes free errors through without paying", async () => {
    const api = fakeApi("20000");
    const c = new ArchibaseClient(config(), api.fetchImpl);
    const r = await c.get("/api/v1/plans/missing/vector");
    expect(r.status).toBe(404);
    expect(api.calls).toHaveLength(1);
  });
});

describe("API key (prepaid credits) mode", () => {
  const KEYED = "ak_" + "a".repeat(43);

  it("validates the key and refuses to combine it with a wallet key", () => {
    expect(loadConfig({ ARCHIBASE_API_KEY: KEYED }).apiKey).toBe(KEYED);
    expect(() => loadConfig({ ARCHIBASE_API_KEY: "ak_short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCHIBASE_API_KEY: KEYED, ARCHIBASE_PRIVATE_KEY: KEY })).toThrow(/not both/);
  });

  it("sends the key, never signs a payment, and reports the credits left", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ results: [] }), { headers: { "x-archibase-credits-remaining": "4.98" } });
    }) as typeof fetch;
    const c = new ArchibaseClient(loadConfig({ ARCHIBASE_API_URL: "https://api.test", ARCHIBASE_API_KEY: KEYED }), fetchImpl);
    const r = await c.get("/api/v1/plans/search");
    expect(r).toMatchObject({ status: 200, creditsRemainingUsd: 4.98 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["X-API-Key"]).toBe(KEYED);
    expect(calls[0]!.headers).not.toHaveProperty("PAYMENT-SIGNATURE");
    expect(c.spentUsd).toBe(0);
  });

  it("passes an out-of-credits answer through so the tool can explain it", async () => {
    const fetchImpl = (async () => Response.json({ error: "insufficient_credits", balance_usd: 0.01 }, { status: 402 })) as typeof fetch;
    const c = new ArchibaseClient(loadConfig({ ARCHIBASE_API_URL: "https://api.test", ARCHIBASE_API_KEY: KEYED }), fetchImpl);
    expect(await c.get("/x")).toMatchObject({ status: 402, body: { error: "insufficient_credits" } });
  });
});
