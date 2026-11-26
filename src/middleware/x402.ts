/**
 * x402 payment gateway for Archibase.
 *
 * Wraps the official `@x402/hono` middleware (x402 protocol v2) and adds:
 *   1. Config loading/validation from env (wallet, network, price, facilitator).
 *   2. `X-PAYMENT` → `PAYMENT-SIGNATURE` header aliasing, so v1-style agents work.
 *   3. A JSON 402 body. v2 transports payment terms in the base64 `PAYMENT-REQUIRED`
 *      header and leaves the body empty; we mirror the decoded terms into the body
 *      so agents that only read JSON can still discover how to pay.
 *   4. An optional local mock facilitator (FACILITATOR_URL=mock) for development:
 *      accepts any structurally valid simulated payment and fakes settlement.
 *      It never moves funds and is refused when NODE_ENV=production.
 */
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { FacilitatorResponseError, HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { SettleError, VerifyError } from "@x402/core/types";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig as createCdpFacilitatorConfig } from "@coinbase/x402";
import { createHash } from "node:crypto";

export const X402_VERSION = 2;

export interface PaymentConfig {
  walletAddress: `0x${string}`;
  network: Network;
  /** Extra networks accepted on every paid route, in addition to `network` (X402_EXTRA_NETWORKS). */
  extraNetworks?: Network[];
  /** Search price, e.g. "$0.02". Converted to USDC atomic units (6 decimals) by the EVM scheme. */
  price: string;
  /** Price of one plan's vector geometry, e.g. "$0.1". */
  vectorPrice: string;
  facilitatorUrl: string;
  facilitatorApiKey?: string;
  /** Set when FACILITATOR_URL=cdp: Coinbase Developer Platform secret API key. */
  cdp?: { keyId: string; keySecret: string };
  mock: boolean;
  maxTimeoutSeconds: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
/** Networks where the mock facilitator may run without an explicit override. */
export const TESTNETS = new Set(["eip155:84532"]);
/** Smallest USDC unit (6 decimals). */
const MIN_PRICE_USD = 0.000001;
const CAIP2_EVM = /^eip155:\d+$/;

export const NETWORK_NAMES: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "eip155:137": "Polygon",
  "eip155:42161": "Arbitrum One",
};

/** Every network a paid route accepts: the primary first, then the extras. */
export function paymentNetworks(cfg: PaymentConfig): Network[] {
  return [cfg.network, ...(cfg.extraNetworks ?? [])];
}

function parsePrice(name: string, raw: string): string {
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < MIN_PRICE_USD) {
    throw new Error(`${name} must be a number >= ${MIN_PRICE_USD} (1 USDC atomic unit)`);
  }
  // Fixed-point formatting: String(1e-7) would yield "1e-7", which the price parser rejects.
  return `$${usd.toFixed(6).replace(/\.?0+$/, "")}`;
}

export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const walletAddress = env.WALLET_ADDRESS?.trim() ?? "";
  if (!EVM_ADDRESS.test(walletAddress)) {
    throw new Error("WALLET_ADDRESS must be set to a 0x-prefixed 20-byte EVM address");
  }
  if (ZERO_ADDRESS.test(walletAddress)) {
    throw new Error("WALLET_ADDRESS is the zero address; payments sent there are unrecoverable");
  }

  // Default to Base Sepolia so an unconfigured server never takes mainnet payments by accident.
  const network = (env.X402_NETWORK?.trim() || "eip155:84532") as Network;
  if (!CAIP2_EVM.test(network)) {
    throw new Error(`X402_NETWORK must be a CAIP-2 EVM id like eip155:8453 (got "${network}")`);
  }

  const price = parsePrice("PRICE_USD", env.PRICE_USD ?? "0.02");
  const vectorPrice = parsePrice("VECTOR_PRICE_USD", env.VECTOR_PRICE_USD ?? "0.10");

  const facilitatorUrl = env.FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
  const mock = facilitatorUrl === "mock";
  if (mock && env.NODE_ENV === "production") {
    throw new Error("FACILITATOR_URL=mock is a development stub and is refused when NODE_ENV=production");
  }
  // Fail closed: the mock accepts forged payments, so on a real-money network it
  // needs an explicit opt-in on top of not being in production.
  if (mock && !TESTNETS.has(network) && env.ALLOW_MOCK_FACILITATOR !== "true") {
    throw new Error(
      `FACILITATOR_URL=mock is refused on ${network} (not a testnet). ` +
        "Use eip155:84532, or set ALLOW_MOCK_FACILITATOR=true for local testing only.",
    );
  }

  // FACILITATOR_URL=cdp: Coinbase Developer Platform's mainnet facilitator, authenticated with
  // a CDP secret API key (both parts are secrets; never put them in wrangler.toml).
  let cdp: PaymentConfig["cdp"];
  if (facilitatorUrl === "cdp") {
    const keyId = env.CDP_API_KEY_ID?.trim();
    const keySecret = env.CDP_API_KEY_SECRET?.trim();
    if (!keyId || !keySecret) {
      throw new Error("FACILITATOR_URL=cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET (set them as secrets)");
    }
    cdp = { keyId, keySecret };
  }

  return {
    walletAddress: walletAddress as `0x${string}`,
    network,
    price,
    vectorPrice,
    facilitatorUrl,
    facilitatorApiKey: env.FACILITATOR_API_KEY?.trim() || undefined,
    ...(cdp && { cdp }),
    mock,
    maxTimeoutSeconds: 120,
    extraNetworks: parseExtraNetworks(env.X402_EXTRA_NETWORKS, network, mock),
  };
}

/** X402_EXTRA_NETWORKS: comma-separated CAIP-2 ids, e.g. "eip155:137,eip155:42161". */
function parseExtraNetworks(raw: string | undefined, primary: Network, mock: boolean): Network[] {
  const ids = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: Network[] = [];
  for (const id of ids) {
    if (!CAIP2_EVM.test(id)) throw new Error(`X402_EXTRA_NETWORKS entry "${id}" is not a CAIP-2 EVM id`);
    if (id === primary || out.includes(id as Network)) continue;
    out.push(id as Network);
  }
  if (out.length && mock) throw new Error("X402_EXTRA_NETWORKS cannot be used with the mock facilitator");
  return out;
}

/**
 * Development-only facilitator. Performs the same requirement matching a real
 * facilitator would (scheme, network, asset, payee, amount) but replaces the
 * EIP-3009 signature check with a "looks like a hex signature" check, and returns
 * a deterministic fake transaction hash instead of broadcasting.
 */
export class MockFacilitatorClient implements FacilitatorClient {
  private readonly networks: Network[];
  constructor(networks: Network | Network[]) {
    this.networks = Array.isArray(networks) ? networks : [networks];
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: this.networks.map((network) => ({ x402Version: X402_VERSION, scheme: "exact", network })),
      extensions: [],
      signers: {},
    };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const a = payload.accepted;
    const sig = payload.payload?.signature;
    const auth = payload.payload?.authorization as { from?: string } | undefined;
    const fail = (invalidReason: string): VerifyResponse => ({ isValid: false, invalidReason });

    if (payload.x402Version !== X402_VERSION) return fail("invalid_x402_version");
    if (a.scheme !== req.scheme || a.network !== req.network) return fail("unsupported_scheme");
    if (a.asset.toLowerCase() !== req.asset.toLowerCase()) return fail("invalid_payload");
    if (a.payTo.toLowerCase() !== req.payTo.toLowerCase()) return fail("invalid_exact_evm_payload_recipient_mismatch");
    if (BigInt(a.amount) < BigInt(req.amount)) return fail("invalid_exact_evm_payload_authorization_value");
    if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{20,}$/.test(sig)) return fail("invalid_exact_evm_payload_signature");

    return { isValid: true, payer: auth?.from ?? "0x0000000000000000000000000000000000000000" };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const check = await this.verify(payload, req);
    if (!check.isValid) {
      return { success: false, errorReason: check.invalidReason, transaction: "", network: req.network };
    }
    const tx = "0x" + createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return { success: true, transaction: tx, network: req.network, payer: check.payer };
  }
}

/**
 * Normalizes facilitator failures. Legitimate payment rejections (VerifyError /
 * SettleError carrying a reason code) pass through; anything else (network
 * errors, 5xx, HTML error pages) becomes a FacilitatorResponseError, which the
 * middleware turns into a 502 that we report to clients as a generic 503.
 * Without this, a facilitator outage surfaces to a correctly-paying client as a
 * 402 "your payment is invalid", including the facilitator's raw error text.
 */
export class GuardedFacilitatorClient implements FacilitatorClient {
  constructor(private readonly inner: FacilitatorClient) {}

  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FacilitatorResponseError) throw err;
      if ((err instanceof VerifyError && err.invalidReason) || (err instanceof SettleError && err.errorReason)) {
        throw err;
      }
      console.error(`[x402] facilitator ${op} failed:`, err);
      const wrapped = new FacilitatorResponseError(`facilitator_${op}_unavailable`);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  getSupported() {
    return this.guard("supported", () => this.inner.getSupported());
  }
  verify(p: PaymentPayload, r: PaymentRequirements) {
    return this.guard("verify", () => this.inner.verify(p, r));
  }
  settle(p: PaymentPayload, r: PaymentRequirements) {
    return this.guard("settle", () => this.inner.settle(p, r));
  }
}

export function createFacilitatorClient(cfg: PaymentConfig): FacilitatorClient {
  if (cfg.mock) return new MockFacilitatorClient(paymentNetworks(cfg));
  if (cfg.cdp) {
    // Coinbase's package signs a short-lived JWT per request with the CDP key.
    const cdpConfig = createCdpFacilitatorConfig(cfg.cdp.keyId, cfg.cdp.keySecret);
    return new GuardedFacilitatorClient(new HTTPFacilitatorClient({ ...cdpConfig, timeoutMs: 30_000 }));
  }
  const key = cfg.facilitatorApiKey;
  return new GuardedFacilitatorClient(new HTTPFacilitatorClient({
    url: cfg.facilitatorUrl,
    timeoutMs: 30_000,
    ...(key && {
      createAuthHeaders: async () => {
        const h = { Authorization: `Bearer ${key}` };
        return { verify: h, settle: h, supported: h };
      },
    }),
  }));
}

export function createResourceServer(cfg: PaymentConfig): x402ResourceServer {
  let server = new x402ResourceServer(createFacilitatorClient(cfg));
  for (const network of paymentNetworks(cfg)) server = server.register(network, new ExactEvmScheme());
  return server;
}

/**
 * Payment terms for the discovery document, resolved locally (USD price → USDC
 * contract, atomic amount, EIP-712 domain) so discovery works even while the
 * facilitator is unreachable.
 */
export async function describeAccepts(cfg: PaymentConfig, price = cfg.price): Promise<PaymentRequirements[]> {
  const scheme = new ExactEvmScheme();
  return Promise.all(
    paymentNetworks(cfg).map(async (network) => {
      const { amount, asset, extra } = await scheme.parsePrice(price, network);
      return { scheme: "exact", network, amount, asset, payTo: cfg.walletAddress, maxTimeoutSeconds: cfg.maxTimeoutSeconds, extra: extra ?? {} } as PaymentRequirements;
    }),
  );
}

/** Accept the legacy `X-PAYMENT` header by copying it to `PAYMENT-SIGNATURE`. */
const aliasLegacyPaymentHeader: MiddlewareHandler = async (c, next) => {
  const legacy = c.req.header("x-payment");
  if (legacy && !c.req.header("payment-signature")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("payment-signature", legacy);
    c.req.raw = new Request(c.req.raw, { headers });
  }
  await next();
};

/**
 * Only machine-readable reason codes (e.g. "invalid_exact_evm_payload_signature")
 * and the library's fixed messages reach clients; free text from a facilitator
 * could leak internal hostnames or stack traces.
 */
const SAFE_MESSAGES = new Set(["Payment required", "No matching payment requirements"]);
function publicError(error: string | undefined, fallback: string): string {
  if (!error) return fallback;
  return /^[a-z0-9_]{1,80}$/.test(error) || SAFE_MESSAGES.has(error) ? error : fallback;
}

function jsonResponse(body: unknown, status: number, base?: Headers): Response {
  const headers = new Headers(base);
  headers.set("Content-Type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status, headers });
}

/** Re-emit a 402 with the decoded PAYMENT-REQUIRED terms as the JSON body. */
function withJsonPaymentTerms(res: Response): Response {
  if (res.status !== 402 || !res.headers.get("content-type")?.includes("application/json")) return res;

  const required = res.headers.get("payment-required");
  if (required) {
    let terms;
    try {
      terms = decodePaymentRequiredHeader(required);
    } catch {
      return res;
    }
    terms = { ...terms, error: publicError(terms.error, "payment_verification_failed") };
    const headers = new Headers(res.headers);
    headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(terms));
    return jsonResponse(
      {
        x402Version: terms.x402Version,
        error: terms.error,
        // Convenience top-level field for simple agents.
        payTo: terms.accepts[0]?.payTo,
        resource: terms.resource,
        // Verbatim: clients copy an entry into PaymentPayload.accepted, which must match exactly.
        accepts: terms.accepts,
        // Human/agent-friendly annotations, index-aligned with `accepts`.
        acceptsInfo: terms.accepts.map((a) => ({
          assetSymbol: "USDC", // USD prices resolve to the network's USDC contract (6 decimals)
          networkName: NETWORK_NAMES[a.network] ?? a.network,
        })),
        ...(terms.extensions && { extensions: terms.extensions }),
        howToPay:
          "Sign an EIP-3009 transferWithAuthorization for one entry in `accepts`, base64-encode an " +
          "x402 v2 PaymentPayload whose `accepted` is that entry verbatim, and retry with it in the " +
          "PAYMENT-SIGNATURE (or X-PAYMENT) header.",
      },
      402,
      headers,
    );
  }

  // Settlement failed after the handler ran: the library sends a PAYMENT-RESPONSE
  // receipt with success=false and an empty body. Surface the reason code.
  const receipt = res.headers.get("payment-response");
  if (receipt) {
    try {
      const settle = decodePaymentResponseHeader(receipt);
      return jsonResponse(
        {
          x402Version: X402_VERSION,
          error: publicError(settle.errorReason, "settlement_failed"),
          network: settle.network,
          retryable: true,
        },
        402,
        res.headers,
      );
    } catch {
      return res;
    }
  }
  return res;
}

const facilitatorUnavailable = () =>
  new Response(JSON.stringify({ error: "payment_facilitator_unavailable", retryable: true }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "10" },
  });

export interface PaymentGateway {
  middleware: MiddlewareHandler;
  resourceServer: x402ResourceServer;
  config: PaymentConfig;
}

export function createPaymentGateway(
  cfg: PaymentConfig,
  routes: RoutesConfig,
  resourceServer: x402ResourceServer = createResourceServer(cfg),
): PaymentGateway {
  // Built on the first paid request, not here. paymentMiddleware() starts fetching the
  // facilitator's /supported list as soon as it is constructed. On Cloudflare Workers the app is
  // built inside whichever request arrives first; if that is a free request (discovery), it
  // returns before the fetch completes, the runtime cancels the fetch, and the next paid request
  // inherits a failed initialisation (a 503). Agents read discovery first, so this mattered.
  // Constructed here, the initialisation runs inside a paid request that awaits it.
  let x402: MiddlewareHandler | undefined;

  const middleware: MiddlewareHandler = async (c, next) => {
    x402 ??= paymentMiddleware(routes, resourceServer);
    await aliasLegacyPaymentHeader(c, async () => {});
    let handlerRan = false;
    const res = await x402(c, async () => {
      handlerRan = true;
      await next();
    });
    if (res instanceof Response) {
      // Before the handler, the x402 layer returns 502 for facilitator failures
      // (see GuardedFacilitatorClient) and 500 when initialization fails (e.g. the
      // facilitator doesn't support our network). Both are retryable from the
      // client's view; details stay in server logs.
      if (!handlerRan && (res.status === 502 || res.status === 500)) return facilitatorUnavailable();
      return withJsonPaymentTerms(res);
    }
    // After the handler ran: settlement failure (402) or facilitator outage (502).
    if (c.res.status === 402 || c.res.status === 502) {
      const settled = c.res;
      c.res = undefined; // reset so Hono doesn't merge stale headers into the new response
      c.res = settled.status === 502 ? facilitatorUnavailable() : withJsonPaymentTerms(settled);
    }
    return undefined;
  };

  return { middleware, resourceServer, config: cfg };
}
