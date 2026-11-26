/**
 * End-to-end walkthrough of the x402 flow against a running server.
 *
 *   FACILITATOR_URL=mock WALLET_ADDRESS=0x... npm run dev    # terminal 1
 *   npm run demo                                             # terminal 2
 *
 * Steps: discovery → unpaid 402 → bad query (400, no charge) → simulated
 * payment via X-PAYMENT → 200 with PAYMENT-RESPONSE receipt.
 * The simulated signature only passes the mock facilitator; a real facilitator
 * rejects it. Use scripts/pay.ts for a real signed payment on Base Sepolia.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { randomBytes } from "node:crypto";

const BASE = process.env.API_URL ?? "http://localhost:3000";
const QUERY = "?bedrooms=3&m2_min=140&m2_max=230&style=modern";
const hr = (title: string) => console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);
let failures = 0;
const expect = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

hr("1. Discovery: GET /.well-known/x402.json");
const disc = await fetch(`${BASE}/.well-known/x402.json`);
const discBody = (await disc.json()) as { resources: { resource: string; accepts: unknown[] }[] };
expect(disc.status === 200, `status ${disc.status}`);
console.log(JSON.stringify(discBody.resources[0]?.accepts, null, 2));

hr("2. Unpaid request → 402");
const unpaid = await fetch(`${BASE}/api/v1/plans/search${QUERY}`);
const unpaidBody = (await unpaid.json()) as Record<string, unknown>;
expect(unpaid.status === 402, `status ${unpaid.status}`);
console.log(JSON.stringify(unpaidBody, null, 2));
const challenge = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!);
const req = challenge.accepts[0]!;
expect(challenge.x402Version === 2, "PAYMENT-REQUIRED header decodes to x402Version 2");
expect(req.amount === "20000", `amount ${req.amount} (= $0.02 USDC)`);

hr("3. Invalid query → 400 before the paywall");
const bad = await fetch(`${BASE}/api/v1/plans/search?bedrooms=two`);
expect(bad.status === 400, `status ${bad.status}: ${JSON.stringify(((await bad.json()) as { details: string[] }).details)}`);

hr("4. Bad simulated payment (wrong payee) → 402");
const now = Math.floor(Date.now() / 1000);
const makePayload = (payTo: string): PaymentPayload => ({
  x402Version: 2,
  resource: challenge.resource,
  accepted: { ...req, payTo },
  payload: {
    signature: "0x" + randomBytes(65).toString("hex"),
    authorization: {
      from: "0x1111111111111111111111111111111111111111",
      to: payTo,
      value: req.amount,
      validAfter: String(now - 60),
      validBefore: String(now + req.maxTimeoutSeconds),
      nonce: "0x" + randomBytes(32).toString("hex"),
    },
  },
});
const encode = (p: PaymentPayload) => Buffer.from(JSON.stringify(p)).toString("base64");
const wrong = await fetch(`${BASE}/api/v1/plans/search${QUERY}`, {
  headers: { "X-PAYMENT": encode(makePayload("0x2222222222222222222222222222222222222222")) },
});
expect(wrong.status === 402, `status ${wrong.status}: ${((await wrong.json()) as { error?: string }).error}`);

hr("5. Simulated payment via X-PAYMENT → 200");
const paid = await fetch(`${BASE}/api/v1/plans/search${QUERY}`, {
  headers: { "X-PAYMENT": encode(makePayload(req.payTo)) },
});
const paidBody = (await paid.json()) as { count: number; results: { plan_id: string }[] };
expect(paid.status === 200, `status ${paid.status}`);
expect(paidBody.count >= 1, `${paidBody.count} plan(s): ${paidBody.results?.map((r) => r.plan_id).join(", ")}`);
const receipt = paid.headers.get("payment-response");
expect(!!receipt, "PAYMENT-RESPONSE settlement receipt present");
if (receipt) console.log(decodePaymentResponseHeader(receipt));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
