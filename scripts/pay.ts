/**
 * Real paying client: signs an EIP-3009 USDC authorization and calls the API.
 *
 * Use with a testnet server (X402_NETWORK=eip155:84532, FACILITATOR_URL=https://x402.org/facilitator)
 * and a buyer wallet holding Base Sepolia USDC (https://faucet.circle.com):
 *
 *   BUYER_PRIVATE_KEY=0x... npm run pay -- "?bedrooms=2&style=industrial"
 *   BUYER_PRIVATE_KEY=0x... npm run pay -- "/api/v1/plans/<plan_id>/vector"
 */
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) {
  console.error("Set BUYER_PRIVATE_KEY to a funded test wallet's private key");
  process.exit(1);
}
const base = process.env.API_URL ?? "http://localhost:3000";
// "?bedrooms=2" buys a search; a path such as "/api/v1/plans/<plan_id>/vector" buys that resource.
const arg = process.argv[2] ?? "?bedrooms=3";
const target = arg.startsWith("/") ? `${base}${arg}` : `${base}/api/v1/plans/search${arg}`;

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(key)) }],
});

const res = await payFetch(target);
console.log("status:", res.status);
const receipt = res.headers.get("payment-response");
if (receipt) console.log("settlement:", decodePaymentResponseHeader(receipt));
console.log(JSON.stringify(await res.json(), null, 2));
