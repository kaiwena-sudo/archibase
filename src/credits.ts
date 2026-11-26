/**
 * Prepaid credits: API keys for people (and tools) that don't pay per call with a wallet.
 *
 * - A key is `ak_` + 43 base64url characters (256 bits). Only its SHA-256 hash is stored.
 * - Balances are USDC base units (6 decimals), the same unit as x402 prices ($0.02 = 20000).
 * - Keys are created by the maintainer tooling for trials or partners; no payment processor is
 *   connected to key creation.
 */

export const KEY_FORMAT = /^ak_[A-Za-z0-9_-]{43}$/;
export const ATOMIC_PER_USD = 1_000_000;

export const usdToAtomic = (price: string): number => Math.round(Number(price.replace(/^\$/, "")) * ATOMIC_PER_USD);
export const atomicToUsd = (atomic: number): number => atomic / ATOMIC_PER_USD;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function generateKey(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return "ak_" + b64url(random(32));
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** X-API-Key, or `Authorization: Bearer ak_…`. Never the query string (it would end up in logs). */
export function extractKey(headers: { get(name: string): string | null | undefined }): string | undefined {
  const direct = headers.get("x-api-key")?.trim();
  if (direct) return direct;
  const bearer = /^Bearer\s+(ak_\S+)$/i.exec(headers.get("authorization") ?? "");
  return bearer?.[1];
}

/* ------------------------------------------------------------------ store */

export interface CreditStore {
  readonly kind: string;
  /** Deduct atomically. Returns the new balance, or null if the key is unknown, disabled, or has too little. */
  spend(keyHash: string, amount: number, allowTest: boolean): Promise<number | null>;
  refund(keyHash: string, amount: number): Promise<void>;
  /** Current balance, or null for an unknown key. */
  balance(keyHash: string): Promise<{ balance: number; test: boolean } | null>;
  /** Make a key directly (admin script, trials). */
  create(args: { keyHash: string; amount: number; label?: string; test?: boolean }): Promise<void>;
}

interface MemKey { balance: number; test: boolean; disabled: boolean; label?: string }
/** In-memory store: tests and local development. Mirrors the SQL functions in db/schema.sql. */
export class MemoryCreditStore implements CreditStore {
  readonly kind = "memory";
  keys = new Map<string, MemKey>();

  async spend(hash: string, amount: number, allowTest: boolean) {
    const k = this.keys.get(hash);
    if (!k || k.disabled || k.balance < amount || (k.test && !allowTest)) return null;
    k.balance -= amount;
    return k.balance;
  }
  async refund(hash: string, amount: number) {
    const k = this.keys.get(hash);
    if (k) k.balance += amount;
  }
  async balance(hash: string) {
    const k = this.keys.get(hash);
    return k ? { balance: k.balance, test: k.test } : null;
  }
  async create({ keyHash, amount, label, test = false }: { keyHash: string; amount: number; label?: string; test?: boolean }) {
    this.keys.set(keyHash, { balance: amount, test, disabled: false, label });
  }
}

/** Supabase store: PostgREST calls to the atomic functions in db/schema.sql (needs the server key). */
export class SupabaseCreditStore implements CreditStore {
  readonly kind = "supabase";
  constructor(private readonly baseUrl: string, private readonly headers: () => Record<string, string>, private readonly fetchImpl: typeof fetch = fetch) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(new URL(`/rest/v1/rpc/${fn}`, this.baseUrl), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Supabase ${fn} failed: ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }

  async spend(hash: string, amount: number, allowTest: boolean) {
    const left = await this.rpc<number | null>("spend_credits", { p_hash: hash, p_amount: amount, p_allow_test: allowTest });
    return left === null || left === undefined ? null : Number(left);
  }
  async refund(hash: string, amount: number) {
    await this.rpc("refund_credits", { p_hash: hash, p_amount: amount });
  }
  async balance(hash: string) {
    const url = new URL("/rest/v1/api_keys", this.baseUrl);
    url.searchParams.set("select", "balance,test,disabled");
    url.searchParams.set("key_hash", `eq.${hash}`);
    const res = await this.fetchImpl(url, { headers: { ...this.headers(), Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Supabase balance failed: ${res.status}`);
    const rows = (await res.json()) as { balance: number; test: boolean; disabled: boolean }[];
    const row = rows[0];
    return row && !row.disabled ? { balance: Number(row.balance), test: row.test } : null;
  }
  async create({ keyHash, amount, label, test = false }: { keyHash: string; amount: number; label?: string; test?: boolean }) {
    const res = await this.fetchImpl(new URL("/rest/v1/api_keys", this.baseUrl), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ key_hash: keyHash, balance: amount, label: label ?? null, test }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Supabase create key failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

/** The store for this environment: Supabase when DATABASE_URL points at it, otherwise in memory (dev only). */
export function createCreditStore(env: Record<string, string | undefined>, headers: (key: string) => Record<string, string>): CreditStore {
  const db = env.DATABASE_URL?.trim() ?? "";
  if (/^https:\/\/.+\.supabase\.co\/?$/.test(db) && env.SUPABASE_KEY) {
    const key = env.SUPABASE_KEY;
    return new SupabaseCreditStore(db, () => headers(key));
  }
  return new MemoryCreditStore();
}
