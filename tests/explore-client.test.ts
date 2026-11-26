import { TEST_PLANS, TEST_VECTOR } from "./data.js";
import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import * as client from "../src/site/client/explore.js";

// A throwaway key that only ever signs test payloads.
const account = privateKeyToAccount(generatePrivateKey());
const challenge = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "https://api.test/api/v1/plans/search?bedrooms=2", description: "Search", mimeType: "application/json" },
  accepts: [{
    scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x0000000000000000000000000000000000000001", maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" },
  }],
  extensions: { bazaar: { info: { input: { type: "http" } } } },
};
const accepted = challenge.accepts[0]!;
const toStrings = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

describe("browser payment matches the official x402 client", () => {
  it("builds the same typed data and payload shape", async () => {
    const signed: any[] = [];
    const spy = { address: account.address, signTypedData: async (m: any) => (signed.push(m), account.signTypedData(m)) };
    const lib: any = await new x402Client().register("eip155:*", new ExactEvmScheme(spy as any)).createPaymentPayload(challenge as any);
    const libTyped = signed[0];

    const auth = client.makeAuthorization(accepted, account.address, Number(libTyped.message.validBefore) - 120, new Uint8Array(32).fill(7));
    const ours = client.paymentTypedData(accepted, auth);

    expect(ours.domain).toEqual(libTyped.domain);
    expect(ours.types).toEqual(libTyped.types);
    expect(ours.primaryType).toBe(libTyped.primaryType);
    // same fields, same decimal-string values (nonce is random in the library, fixed here)
    const { nonce: _n1, ...a } = ours.message;
    const { nonce: _n2, ...b } = toStrings(libTyped.message);
    expect(a).toEqual(b);
    expect(auth.nonce).toMatch(/^0x(07){32}$/);

    const payment = client.buildPayment(challenge, accepted, auth, "0xsig");
    expect(Object.keys(payment).sort()).toEqual(Object.keys(lib).sort());
    expect(payment.accepted).toEqual(lib.accepted);
    expect(payment.resource).toEqual(lib.resource);
    expect(payment.extensions).toEqual(lib.extensions);
    expect(payment.x402Version).toBe(lib.x402Version);
    expect(Object.keys(payment.payload.authorization).sort()).toEqual(Object.keys(lib.payload.authorization).sort());
  });

  it("produces a signature a contract would accept (recovers the payer)", async () => {
    const auth = client.makeAuthorization(accepted, account.address, 1_800_000_000, new Uint8Array(32).fill(1));
    const td = client.paymentTypedData(accepted, auth);
    const message = { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) };
    const signature = await account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message } as any);
    expect(await verifyTypedData({ address: account.address, domain: td.domain, types: td.types, primaryType: td.primaryType, message, signature } as any)).toBe(true);
  });

  it("encodes the header as base64 JSON that round-trips", () => {
    const p = client.buildPayment(challenge, accepted, client.makeAuthorization(accepted, account.address, 1, new Uint8Array(32)), "0x1");
    expect(JSON.parse(Buffer.from(client.encodePayment(p), "base64").toString())).toEqual(p);
    expect(client.parseChallenge(Buffer.from(JSON.stringify(challenge)).toString("base64"))).toEqual(challenge);
  });
});

describe("fetchPaid", () => {
  const make = (handler: (url: string, init?: RequestInit) => Response) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return handler(String(url), init);
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = orig) };
  };
  const wallet = (log: string[] = []) => ({
    connect: async () => (log.push("connect"), account.address as string),
    ensureChain: async (id: number) => void log.push("chain " + id),
    signTypedData: async () => (log.push("sign"), "0x" + "ab".repeat(65)),
  });
  const pay402 = () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });

  it("sends an API key and never touches the wallet", async () => {
    const m = make(() => new Response("{}"));
    try {
      await client.fetchPaid("https://api.test/x", { apiKey: "ak_1", wallet: null, network: "eip155:8453" });
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.headers["X-API-Key"]).toBe("ak_1");
    } finally { m.restore(); }
  });

  it("answers a 402 by signing once and retrying with PAYMENT-SIGNATURE", async () => {
    const log: string[] = [];
    const m = make((_u, init) => ((init?.headers as any)?.["PAYMENT-SIGNATURE"] ? new Response("{}") : pay402()));
    try {
      const res = await client.fetchPaid("https://api.test/x", { wallet: wallet(log), network: "eip155:8453", now: () => 1000, random: () => new Uint8Array(32) });
      expect(res.status).toBe(200);
      expect(log).toEqual(["connect", "chain 8453", "sign"]);
      expect(m.calls).toHaveLength(2);
      const sent = JSON.parse(Buffer.from(m.calls[1]!.headers["PAYMENT-SIGNATURE"]!, "base64").toString());
      expect(sent.payload.authorization).toMatchObject({ from: account.address, to: accepted.payTo, value: "20000", validBefore: "1120" });
    } finally { m.restore(); }
  });

  it("refuses prices above the limit, wrong networks and a missing wallet, without signing", async () => {
    const log: string[] = [];
    const m = make(() => pay402());
    try {
      await expect(client.fetchPaid("https://api.test/x", { wallet: wallet(log), network: "eip155:8453", maxUsd: 0.01 })).rejects.toThrow(/above the \$0.01 limit/);
      await expect(client.fetchPaid("https://api.test/x", { wallet: wallet(log), network: "eip155:84532" })).rejects.toThrow(/doesn't accept USDC/);
      await expect(client.fetchPaid("https://api.test/x", { wallet: null, network: "eip155:8453" })).rejects.toThrow(/connect a wallet or enter an API key/);
      expect(log).toEqual([]);
    } finally { m.restore(); }
  });

  it("passes non-402 responses straight through", async () => {
    const m = make(() => new Response('{"error":"vector_not_found"}', { status: 404 }));
    try {
      expect((await client.fetchPaid("https://api.test/x", { wallet: null, network: "eip155:8453" })).status).toBe(404);
    } finally { m.restore(); }
  });
});

describe("browserWallet", () => {
  it("switches chain only when needed and signs v4 typed data with the EIP712Domain included", async () => {
    const calls: any[] = [];
    const eth = { request: async (a: any) => (calls.push(a), a.method === "eth_chainId" ? "0x1" : a.method === "eth_requestAccounts" ? [account.address] : "0xsig") };
    const w = client.browserWallet(eth);
    expect(await w.connect()).toBe(account.address);
    await w.ensureChain(8453);
    expect(calls.find((c) => c.method === "wallet_switchEthereumChain").params[0].chainId).toBe("0x2105");
    const td = client.paymentTypedData(accepted, client.makeAuthorization(accepted, account.address, 1, new Uint8Array(32)));
    await w.signTypedData(account.address, td);
    const sent = JSON.parse(calls.at(-1).params[1]);
    expect(sent.types.EIP712Domain.map((f: any) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(sent.primaryType).toBe("TransferWithAuthorization");
    const calls2: any[] = [];
    const same = client.browserWallet({ request: async (a: any) => (calls2.push(a), "0x2105") });
    await same.ensureChain(8453);
    expect(calls2.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
});

describe("drawing", () => {
  const vector = TEST_VECTOR;
  const plans = TEST_PLANS;

  it("draws rooms, doors and windows and escapes text", () => {
    const plan = plans.find((p: any) => p.plan_id === vector.plan_id);
    const svg = client.planSvg(vector, plan);
    expect(svg).toMatch(/^<svg viewBox="0 0 \d+ \d+"/);
    expect(svg).toContain('class="room r-');
    expect(svg.match(/<path class="room/g)!.length).toBeGreaterThanOrEqual(vector.rooms.filter((r: any) => r.level === vector.rooms[0].level).length);
    expect(client.planSvg(vector, null, { labels: false })).not.toContain("<text");
    expect(client.esc('<img src=x onerror="a">&')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&amp;");
  });

  it("finds the dominant wall direction of a rotated rectangle", () => {
    const a = (30 * Math.PI) / 180;
    const rect = [[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]].map(([x, y]) => [x! * Math.cos(a) - y! * Math.sin(a), x! * Math.sin(a) + y! * Math.cos(a)]);
    expect(client.dominantAngle([[rect]]) * (180 / Math.PI)).toBeCloseTo(30, 0);
  });

  it("maps room types to the palette", () => {
    expect(client.colourClass("bedroom")).toBe("bedroom");
    expect(client.colourClass("restroom")).toBe("bathroom");
    expect(client.colourClass("corridor")).toBe("living");
    expect(client.colourClass("elevator")).toBe("balcony");
    expect(client.colourClass("mystery")).toBe("other");
  });
});
