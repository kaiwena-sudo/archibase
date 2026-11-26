import { randomBytes } from "node:crypto";
import { x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { buildRoutes, createApp } from "../src/index.js";
import { JsonPlanStore, type PlanStore } from "../src/db/client.js";
import { FileVectorStore, type VectorStore } from "../src/db/vectors.js";
import { createPaymentGateway, loadPaymentConfig } from "../src/middleware/x402.js";
import { TEST_PLAN_FILE, TEST_VECTOR_DIR } from "./data.js";

export const WALLET = "0x0000000000000000000000000000000000000001";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const SEARCH = "/api/v1/plans/search";

export const mockConfig = () =>
  // Mainnet + mock needs the explicit opt-in; tests assert against Base mainnet USDC terms.
  loadPaymentConfig({
    WALLET_ADDRESS: WALLET,
    FACILITATOR_URL: "mock",
    X402_NETWORK: "eip155:8453",
    ALLOW_MOCK_FACILITATOR: "true",
  } as NodeJS.ProcessEnv);

export function makeApp(opts: { store?: PlanStore; facilitator?: FacilitatorClient; vectors?: VectorStore; siteUrl?: string } = {}) {
  const cfg = mockConfig();
  const resourceServer = opts.facilitator
    ? new x402ResourceServer(opts.facilitator).register(cfg.network, new ExactEvmScheme())
    : undefined;
  const gateway = createPaymentGateway(cfg, buildRoutes(cfg), resourceServer);
  const store = opts.store ?? new JsonPlanStore(TEST_PLAN_FILE);
  const vectors = opts.vectors ?? new FileVectorStore(TEST_VECTOR_DIR);
  return createApp({ store, gateway, vectors, publicBaseUrl: "http://test.local", siteUrl: opts.siteUrl });
}

export function challengeFrom(res: Response): PaymentRequired {
  const header = res.headers.get("payment-required");
  if (!header) throw new Error("missing PAYMENT-REQUIRED header");
  return decodePaymentRequiredHeader(header);
}

export function simulatedPayment(
  challenge: PaymentRequired,
  overrides: { payTo?: string; signature?: string } = {},
): string {
  const req = challenge.accepts[0]!;
  const payTo = overrides.payTo ?? req.payTo;
  const now = Math.floor(Date.now() / 1000);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: challenge.resource,
    accepted: { ...req, payTo },
    payload: {
      signature: overrides.signature ?? "0x" + randomBytes(65).toString("hex"),
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: payTo,
        value: req.amount,
        validAfter: String(now - 60),
        validBefore: String(now + req.maxTimeoutSeconds),
        nonce: "0x" + randomBytes(32).toString("hex"),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
