import { describe, expect, it } from "vitest";
import { describeAccepts, loadPaymentConfig } from "../src/middleware/x402.js";
import { BASE_USDC, WALLET } from "./helpers.js";

const load = (vars: Record<string, string>) => loadPaymentConfig(vars as NodeJS.ProcessEnv);

describe("loadPaymentConfig", () => {
  it("applies defaults: Base Sepolia, $0.02, public facilitator", () => {
    expect(load({ WALLET_ADDRESS: WALLET })).toMatchObject({
      walletAddress: WALLET,
      network: "eip155:84532",
      price: "$0.02",
      facilitatorUrl: "https://x402.org/facilitator",
      mock: false,
    });
  });

  it.each([
    ["missing", {}],
    ["not hex", { WALLET_ADDRESS: "0xZZ9693Bc6afc0C5328bA36FaF03C514EF312287C" }],
    ["too short", { WALLET_ADDRESS: "0x1234" }],
    ["no 0x prefix", { WALLET_ADDRESS: WALLET.slice(2) }],
  ])("rejects a %s wallet", (_n, vars) => {
    expect(() => load(vars)).toThrow(/WALLET_ADDRESS/);
  });

  it.each(["base", "solana:mainnet", "eip155:"])("rejects network %s", (net) => {
    expect(() => load({ WALLET_ADDRESS: WALLET, X402_NETWORK: net })).toThrow(/X402_NETWORK/);
  });

  it.each(["0", "-1", "abc", "Infinity"])("rejects price %s", (price) => {
    expect(() => load({ WALLET_ADDRESS: WALLET, PRICE_USD: price })).toThrow(/PRICE_USD/);
  });

  it("enables the mock facilitator in development", () => {
    expect(load({ WALLET_ADDRESS: WALLET, FACILITATOR_URL: "mock" }).mock).toBe(true);
  });

  it("refuses the mock facilitator under NODE_ENV=production", () => {
    expect(() => load({ WALLET_ADDRESS: WALLET, FACILITATOR_URL: "mock", NODE_ENV: "production" })).toThrow(/production/);
  });
});

describe("loadPaymentConfig hardening", () => {
  it("rejects the zero address", () => {
    expect(() => load({ WALLET_ADDRESS: "0x" + "0".repeat(40) })).toThrow(/zero address/);
  });

  it("refuses the mock facilitator on mainnet without an explicit opt-in", () => {
    expect(() => load({ WALLET_ADDRESS: WALLET, FACILITATOR_URL: "mock", X402_NETWORK: "eip155:8453" })).toThrow(
      /not a testnet/,
    );
    expect(
      load({ WALLET_ADDRESS: WALLET, FACILITATOR_URL: "mock", X402_NETWORK: "eip155:8453", ALLOW_MOCK_FACILITATOR: "true" })
        .mock,
    ).toBe(true);
  });

  it("formats tiny prices without exponent notation", async () => {
    const cfg = load({ WALLET_ADDRESS: WALLET, PRICE_USD: "0.000001" });
    expect(cfg.price).toBe("$0.000001");
    const [a] = await describeAccepts(cfg);
    expect(a!.amount).toBe("1");
  });

  it("rejects prices below one USDC atomic unit", () => {
    expect(() => load({ WALLET_ADDRESS: WALLET, PRICE_USD: "0.0000001" })).toThrow(/PRICE_USD/);
  });
});

describe("describeAccepts", () => {
  it("resolves $0.02 to 20000 atomic USDC on Base", async () => {
    const [a] = await describeAccepts(load({ WALLET_ADDRESS: WALLET, X402_NETWORK: "eip155:8453" }));
    expect(a).toMatchObject({ scheme: "exact", network: "eip155:8453", amount: "20000", asset: BASE_USDC, payTo: WALLET });
  });

  it("uses the Base Sepolia USDC contract on testnet", async () => {
    const [a] = await describeAccepts(load({ WALLET_ADDRESS: WALLET, X402_NETWORK: "eip155:84532" }));
    expect(a!.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("honours PRICE_USD", async () => {
    const [a] = await describeAccepts(load({ WALLET_ADDRESS: WALLET, PRICE_USD: "0.25" }));
    expect(a!.amount).toBe("250000");
  });
});
