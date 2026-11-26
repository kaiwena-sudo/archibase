/**
 * Archibase API client with x402 payments and hard spending limits.
 *
 * Every paid call is checked twice before any money moves:
 *   - per call: the price must be <= maxPriceUsd (x402 spend controls), and
 *   - per session: price + spent so far must be <= budgetUsd (a payment policy).
 * Only USDC on the configured network can be paid, because that is the only scheme registered.
 */
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export const MAINNET = "eip155:8453";
export const TESTNET = "eip155:84532";

export const DEFAULT_API_URL = "https://api.archibase.dev";
const USDC_DECIMALS = 6;

export interface ClientConfig {
  apiUrl: string;
  network: string;
  privateKey?: `0x${string}`;
  /** Prepaid credits key (ak_…): an alternative to a wallet. The credit balance is the spending cap. */
  apiKey?: string;
  /** Trusted payment receiver pin. Wallet payments fail closed when this is not configured. */
  expectedPayTo?: string;
  maxPriceUsd: number;
  budgetUsd: number;
  /** Log each HTTP exchange (method, path, status, error body) to stderr. Never logs keys or signatures. */
  debug?: boolean;
}

export class ConfigError extends Error {}

function usd(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number of US dollars`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ClientConfig {
  const apiUrl = (env.ARCHIBASE_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
  if (!/^https:\/\//.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl)) {
    throw new ConfigError("ARCHIBASE_API_URL must be https (or http://localhost for development)");
  }
  const network = env.ARCHIBASE_NETWORK ?? MAINNET;
  if (network !== MAINNET && network !== TESTNET) {
    throw new ConfigError(`ARCHIBASE_NETWORK must be ${MAINNET} (Base) or ${TESTNET} (Base Sepolia)`);
  }
  const key = env.ARCHIBASE_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ConfigError("ARCHIBASE_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const apiKey = env.ARCHIBASE_API_KEY?.trim() || undefined;
  if (apiKey && !/^ak_[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new ConfigError("ARCHIBASE_API_KEY doesn't look like an Archibase key (ak_ followed by 43 characters)");
  if (apiKey && key) throw new ConfigError("Set ARCHIBASE_API_KEY (issued on request) or ARCHIBASE_PRIVATE_KEY (wallet), not both");
  const expectedPayTo = env.ARCHIBASE_EXPECTED_PAY_TO?.trim() || undefined;
  if (expectedPayTo && !/^0x[0-9a-fA-F]{40}$/.test(expectedPayTo)) throw new ConfigError("ARCHIBASE_EXPECTED_PAY_TO must be a 0x-prefixed 20-byte EVM address");
  return {
    apiUrl,
    network,
    apiKey,
    expectedPayTo,
    privateKey: key ? (key as `0x${string}`) : undefined,
    maxPriceUsd: usd("ARCHIBASE_MAX_PRICE_USD", env.ARCHIBASE_MAX_PRICE_USD, 0.25),
    budgetUsd: usd("ARCHIBASE_BUDGET_USD", env.ARCHIBASE_BUDGET_USD, 2),
    debug: env.ARCHIBASE_DEBUG === "1",
  };
}

export const toAtomic = (dollars: number): bigint => BigInt(Math.round(dollars * 10 ** USDC_DECIMALS));
export const fromAtomic = (atomic: bigint): number => Number(atomic) / 10 ** USDC_DECIMALS;

export interface PaidResult {
  status: number;
  body: unknown;
  /** Present when a payment settled. */
  paid?: { amountUsd: number; transaction?: string; network?: string };
  /** Present when the call was paid with an API key: credits left afterwards. */
  creditsRemainingUsd?: number;
}

export class ArchibaseClient {
  private spent = 0n;
  private readonly payFetch?: typeof fetch;
  readonly walletAddress?: string;

  private readonly baseFetch: typeof fetch;

  constructor(readonly cfg: ClientConfig, baseFetch: typeof fetch = fetch) {
    this.baseFetch = cfg.debug ? debugFetch(baseFetch) : baseFetch;
    baseFetch = this.baseFetch;
    if (!cfg.privateKey) return;
    const account = privateKeyToAccount(cfg.privateKey);
    this.walletAddress = account.address;
    const budget = toAtomic(cfg.budgetUsd);
    this.payFetch = wrapFetchWithPaymentFromConfig(baseFetch, {
      schemes: [{ network: cfg.network as `${string}:${string}`, client: new ExactEvmScheme(account) }],
      spendControls: { maxAmountPerPayment: `$${cfg.maxPriceUsd}` },
      // Session budget: drop any option that would take total spend past the budget.
      policies: [(_v, reqs) => reqs.filter((r) => this.spent + BigInt(r.amount) <= budget)],
    }) as typeof fetch;
  }

  get spentUsd(): number {
    return fromAtomic(this.spent);
  }

  get remainingUsd(): number {
    return Math.max(0, this.cfg.budgetUsd - this.spentUsd);
  }

  /** Free: the discovery document (prices, schemas). */
  async discovery(): Promise<unknown> {
    const res = await this.baseFetch(`${this.cfg.apiUrl}/.well-known/x402.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`discovery failed: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * GET a paid resource. Free errors (400/404) come back without paying. Without a wallet, a 402
   * is returned as-is so the caller can explain what it would cost.
   */
  async get(path: string): Promise<PaidResult> {
    const url = `${this.cfg.apiUrl}${path}`;
    if (this.cfg.apiKey) {
      // Prepaid credits: the server deducts the price (and refunds on errors), so there is no 402 exchange.
      const res = await this.baseFetch(url, { headers: { "X-API-Key": this.cfg.apiKey }, signal: AbortSignal.timeout(60_000) });
      const left = res.headers.get("x-archibase-credits-remaining");
      return { status: res.status, body: await res.json().catch(() => null), ...(left !== null && { creditsRemainingUsd: Number(left) }) };
    }
    // Ask unpaid first: validation errors and missing plans are free, and we learn the price.
    const probe = await this.baseFetch(url, { signal: AbortSignal.timeout(30_000) });
    if (probe.status !== 402) return { status: probe.status, body: await probe.json().catch(() => null) };
    const challenge = await probe.json().catch(() => null);
    if (!this.payFetch) return { status: 402, body: challenge };

    // Payments are serialised: each call's budget check sees every earlier payment, so parallel
    // calls cannot all pass the check before any of them is recorded (SEC-01).
    return this.withPaymentLock(() => this.payForChallenge(url, challenge));
  }

  private lock: Promise<unknown> = Promise.resolve();

  private withPaymentLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async payForChallenge(url: string, challenge: unknown): Promise<PaidResult> {
    const payFetch = this.payFetch;
    if (!payFetch) return { status: 402, body: challenge };

    const pinned = this.cfg.expectedPayTo;
    const offered = ((challenge as { accepts?: { network?: string; payTo?: string }[] } | null)?.accepts ?? []).filter((a) => a.network === this.cfg.network);
    if (!pinned) {
      throw new Error("Set ARCHIBASE_EXPECTED_PAY_TO to the trusted receiver address before wallet payments; nothing was paid");
    }
    if (offered.some((a) => (a.payTo ?? "").toLowerCase() !== pinned.toLowerCase())) {
      throw new Error("the API asks to be paid at a wallet other than ARCHIBASE_EXPECTED_PAY_TO; nothing was paid");
    }

    const price = cheapestAmount(challenge, this.cfg.network);
    if (price === undefined) {
      throw new Error(`the API does not accept USDC on ${this.cfg.network}; check ARCHIBASE_NETWORK and ARCHIBASE_API_URL`);
    }
    if (fromAtomic(price) > this.cfg.maxPriceUsd) {
      throw new Error(`price $${fromAtomic(price)} is above ARCHIBASE_MAX_PRICE_USD ($${this.cfg.maxPriceUsd}); nothing was paid`);
    }
    if (this.spent + price > toAtomic(this.cfg.budgetUsd)) {
      throw new Error(
        `this call costs $${fromAtomic(price)} but only $${this.remainingUsd.toFixed(2)} of the session budget ` +
          `(ARCHIBASE_BUDGET_USD = $${this.cfg.budgetUsd}) is left; nothing was paid`,
      );
    }

    const res = await payFetch(url, { signal: AbortSignal.timeout(60_000) });
    const body = await res.json().catch(() => null);
    const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    if (res.ok && header) {
      const receipt = decodePaymentResponseHeader(header) as { transaction?: string; network?: string; success?: boolean };
      this.spent += price;
      return { status: res.status, body, paid: { amountUsd: fromAtomic(price), transaction: receipt.transaction, network: receipt.network } };
    }
    return { status: res.status, body };
  }
}

/** Lowest atomic amount the challenge accepts on `network`, if any. */
export function cheapestAmount(challenge: unknown, network: string): bigint | undefined {
  const accepts = (challenge as { accepts?: { network?: string; amount?: string }[] } | null)?.accepts ?? [];
  const amounts = accepts.filter((a) => a.network === network && a.amount && /^\d+$/.test(a.amount)).map((a) => BigInt(a.amount!));
  return amounts.length ? amounts.reduce((a, b) => (b < a ? b : a)) : undefined;
}

function debugFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const paying = req.headers.has("payment-signature") || req.headers.has("x-payment");
    const res = await inner(req);
    const path = new URL(req.url).pathname + new URL(req.url).search;
    let detail = "";
    if (res.status >= 400 && res.status !== 402) detail = " " + (await res.clone().text().catch(() => "")).slice(0, 300);
    console.error(`[archibase] ${req.method} ${path}${paying ? " (with payment)" : ""} -> ${res.status}${detail}`);
    return res;
  };
}
