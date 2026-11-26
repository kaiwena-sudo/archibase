import { describe, expect, it } from "vitest";
import { describeAccepts, loadPaymentConfig } from "../src/middleware/x402.js";

const WALLET = "0x0000000000000000000000000000000000000001";
const env = (extra: Record<string, string> = {}) =>
  ({
    WALLET_ADDRESS: WALLET,
    X402_NETWORK: "eip155:8453",
    FACILITATOR_URL: "cdp",
    CDP_API_KEY_ID: "test-id",
    CDP_API_KEY_SECRET: "test-secret",
    ...extra,
  }) as NodeJS.ProcessEnv;

describe("multi-network payment terms", () => {
  it("advertises the primary network and each extra network, all paying the same wallet", async () => {
    const cfg = loadPaymentConfig(env({ X402_EXTRA_NETWORKS: "eip155:137, eip155:42161" }));
    const terms = await describeAccepts(cfg);
    expect(terms.map((t) => t.network)).toEqual(["eip155:8453", "eip155:137", "eip155:42161"]);
    for (const t of terms) {
      expect(t.payTo).toBe(WALLET);
      expect(t.amount).toBe("20000"); // $0.02 in USDC atomic units, on every chain
    }
  });

  it("uses each chain's own USDC contract", async () => {
    const cfg = loadPaymentConfig(env({ X402_EXTRA_NETWORKS: "eip155:137,eip155:42161" }));
    const terms = await describeAccepts(cfg);
    const assets = Object.fromEntries(terms.map((t) => [t.network, t.asset.toLowerCase()]));
    expect(assets["eip155:137"]).toBe("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359");
    expect(assets["eip155:42161"]).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(assets["eip155:8453"]).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });

  it("is unchanged when no extra networks are set", async () => {
    const cfg = loadPaymentConfig(env());
    expect((await describeAccepts(cfg)).map((t) => t.network)).toEqual(["eip155:8453"]);
  });

  it("rejects malformed or duplicate entries", () => {
    expect(() => loadPaymentConfig(env({ X402_EXTRA_NETWORKS: "polygon" }))).toThrow(/CAIP-2/);
    const cfg = loadPaymentConfig(env({ X402_EXTRA_NETWORKS: "eip155:8453,eip155:137,eip155:137" }));
    expect(cfg.extraNetworks).toEqual(["eip155:137"]);
  });
});
