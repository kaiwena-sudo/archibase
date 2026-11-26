import { describe, expect, it, vi } from "vitest";
import { MemoryCreditStore, KEY_FORMAT, generateKey, hashKey, usdToAtomic, extractKey } from "../src/credits.js";
import { JsonPlanStore, type PlanStore } from "../src/db/client.js";
import { FileVectorStore } from "../src/db/vectors.js";
import { buildRoutes, createApp } from "../src/index.js";
import { createPaymentGateway, loadPaymentConfig } from "../src/middleware/x402.js";
import { WALLET } from "./helpers.js";
import { TEST_PLAN_FILE, TEST_VECTOR_DIR } from "./data.js";

const NETWORKS = { main: "eip155:8453", test: "eip155:84532" } as const;
const SEARCH = "/api/v1/plans/search?bedrooms=3";

function setup(opts: { network?: keyof typeof NETWORKS; store?: PlanStore } = {}) {
  const cfg = loadPaymentConfig({ WALLET_ADDRESS: WALLET, FACILITATOR_URL: "mock", X402_NETWORK: NETWORKS[opts.network ?? "main"], ALLOW_MOCK_FACILITATOR: "true" } as NodeJS.ProcessEnv);
  const credits = new MemoryCreditStore();
  const app = createApp({
    store: opts.store ?? new JsonPlanStore(TEST_PLAN_FILE),
    gateway: createPaymentGateway(cfg, buildRoutes(cfg)),
    vectors: new FileVectorStore(TEST_VECTOR_DIR),
    publicBaseUrl: "http://test.local",
    siteUrl: "https://site.test",
    credits,
  });
  const call = (path: string, init?: RequestInit) => app.request(path, init);
  return { app, credits, call };
}

async function fund(credits: MemoryCreditStore, usd: number, test = false) {
  const key = generateKey();
  await credits.create({ keyHash: await hashKey(key), amount: usdToAtomic(String(usd)), test });
  return key;
}
describe("key format", () => {
  it("generates 256-bit keys that match the format and hash to 64 hex chars", async () => {
    const k = generateKey();
    expect(k).toMatch(KEY_FORMAT);
    expect(generateKey()).not.toBe(k);
    expect(await hashKey(k)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reads X-API-Key or a Bearer ak_ token, and nothing else", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
    expect(extractKey(h({ "x-api-key": " ak_abc " }))).toBe("ak_abc");
    expect(extractKey(h({ authorization: "Bearer ak_abc" }))).toBe("ak_abc");
    expect(extractKey(h({ authorization: "Bearer other" }))).toBeUndefined();
    expect(extractKey(h({}))).toBeUndefined();
  });
});

describe("paying with credits", () => {
  it("serves a search, deducts $0.02 and reports the balance", async () => {
    const t = setup();
    const key = await fund(t.credits, 1);
    const res = await t.call(SEARCH, { headers: { "X-API-Key": key } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-archibase-credits-remaining")).toBe("0.98");
    expect((await res.json()).count).toBeGreaterThan(0);
    const bearer = await t.call(SEARCH, { headers: { Authorization: `Bearer ${key}` } });
    expect(bearer.headers.get("x-archibase-credits-remaining")).toBe("0.96");
    expect((await t.credits.balance(await hashKey(key)))!.balance).toBe(960_000);
  });

  it("charges $0.10 for geometry, and nothing for a plan that doesn't exist", async () => {
    const t = setup();
    const key = await fund(t.credits, 1);
    const ok = await t.call("/api/v1/plans/ab-modern-3br-0004/vector", { headers: { "X-API-Key": key } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-archibase-credits-remaining")).toBe("0.90");
    const missing = await t.call("/api/v1/plans/nope-nope-0000/vector", { headers: { "X-API-Key": key } });
    expect(missing.status).toBe(404);
    expect((await t.credits.balance(await hashKey(key)))!.balance).toBe(900_000);
  });

  it("rejects bad keys without falling through to a payment request", async () => {
    const t = setup();
    expect((await t.call(SEARCH, { headers: { "X-API-Key": "ak_short" } })).status).toBe(401);
    expect((await t.call(SEARCH, { headers: { "X-API-Key": generateKey() } })).status).toBe(401); // well-formed but unknown
    expect((await t.call(SEARCH)).status).toBe(402); // no key: normal x402 challenge
  });

  it("says how much is left when credits run out", async () => {
    const t = setup();
    const key = await fund(t.credits, 0.03);
    expect((await t.call(SEARCH, { headers: { "X-API-Key": key } })).status).toBe(200);
    const res = await t.call(SEARCH, { headers: { "X-API-Key": key } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "insufficient_credits", balance_usd: 0.01, price_usd: 0.02, contact: null });
  });

  it("refunds when the handler fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: PlanStore = { kind: "broken", searchPlans: () => Promise.reject(new Error("db down")) };
    const t = setup({ store: broken });
    const key = await fund(t.credits, 1);
    const res = await t.call(SEARCH, { headers: { "X-API-Key": key } });
    expect(res.status).toBe(500);
    expect((await t.credits.balance(await hashKey(key)))!.balance).toBe(1_000_000);
  });

  it("never spends the same credit twice under concurrent calls", async () => {
    const t = setup();
    const key = await fund(t.credits, 0.06);
    const results = await Promise.all(Array.from({ length: 6 }, () => t.call(SEARCH, { headers: { "X-API-Key": key } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
  });

  it("reports the balance at /api/v1/account", async () => {
    const t = setup();
    const key = await fund(t.credits, 2.5);
    const res = await t.call("/api/v1/account", { headers: { "X-API-Key": key } });
    expect(await res.json()).toMatchObject({ balance_usd: 2.5, balance_atomic: 2_500_000, prices: { search_usd: 0.02, geometry_usd: 0.1 } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await t.call("/api/v1/account")).status).toBe(401);
  });

  it("honours test-labelled keys only on testnet deployments", async () => {
    const main = setup({ network: "main" });
    const testKey = await fund(main.credits, 1, true);
    expect((await main.call(SEARCH, { headers: { "X-API-Key": testKey } })).status).toBe(401);
    expect((await main.call("/api/v1/account", { headers: { "X-API-Key": testKey } })).status).toBe(401);
    const test = setup({ network: "test" });
    const k2 = await fund(test.credits, 1, true);
    expect((await test.call(SEARCH, { headers: { "X-API-Key": k2 } })).status).toBe(200);
  });
});
