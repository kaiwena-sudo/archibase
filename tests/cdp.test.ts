import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createFacilitatorConfig } from "@coinbase/x402";
import { loadPaymentConfig } from "../src/middleware/x402.js";
import { WALLET } from "./helpers.js";

/** A throwaway key in CDP's Ed25519 secret format: base64(32-byte seed || 32-byte public key). */
function fakeCdpSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([seed, pub]).toString("base64");
}

describe("Coinbase Developer Platform facilitator", () => {
  it("requires both CDP secrets when FACILITATOR_URL=cdp", () => {
    const base = { WALLET_ADDRESS: WALLET, X402_NETWORK: "eip155:8453", FACILITATOR_URL: "cdp" } as NodeJS.ProcessEnv;
    expect(() => loadPaymentConfig(base)).toThrow(/CDP_API_KEY_ID and CDP_API_KEY_SECRET/);
    const cfg = loadPaymentConfig({ ...base, CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s" });
    expect(cfg.cdp).toEqual({ keyId: "id", keySecret: "s" });
    expect(cfg.mock).toBe(false);
  });

  it("signs a per-request JWT for verify, settle and supported", async () => {
    const cfg = createFacilitatorConfig("organizations/test/apiKeys/test", fakeCdpSecret());
    expect(cfg.url).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
    const headers = (await cfg.createAuthHeaders!()) as Record<string, Record<string, string>>;
    for (const path of ["verify", "settle", "supported"]) {
      const auth = headers[path]!.Authorization!;
      expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      const claims = JSON.parse(Buffer.from(auth.split(".")[1]!, "base64url").toString());
      expect(claims.uris[0]).toMatch(new RegExp(`api\\.cdp\\.coinbase\\.com/platform/v2/x402/${path}$`));
    }
  });
});
