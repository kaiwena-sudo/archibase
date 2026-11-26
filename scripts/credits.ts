/**
 * Manage prepaid-credit API keys directly (trial keys for prospects, support fixes).
 *
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/credits.ts create --usd 2 --label "PlanFinder trial"
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/credits.ts list
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/credits.ts topup <id> --usd 5
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/credits.ts disable <id>
 *
 * `create` prints the key ONCE: only its hash is stored, so it can't be shown again. Send it to the
 * recipient over a private channel. `<id>` is the first 8 characters of the key's hash, shown by `list`.
 * Add --test to make a key that only testnet deployments honour. Auth: as for scripts/supabase-load.ts.
 */
import { generateKey, hashKey, usdToAtomic } from "../src/credits.js";
import { runSql } from "./supabase-load.js";

const ref = process.env.SUPABASE_PROJECT_REF;
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k: string) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
const lit = (v: string) => "'" + v.replace(/'/g, "''") + "'";

function usage(): never {
  console.error("usage: credits.ts create --usd N [--label TEXT] [--test] | list | topup <id> --usd N | disable <id>");
  process.exit(2);
}
if (!ref || !cmd) usage();

function amount(): number {
  const n = Number(opt("--usd"));
  if (!Number.isFinite(n) || n <= 0 || n > 10_000) throw new Error("--usd must be a positive number of dollars");
  return usdToAtomic(String(n));
}
function id(): string {
  const v = rest[0];
  if (!v || !/^[0-9a-f]{8}$/.test(v)) throw new Error("give the 8-character id shown by `list`");
  return v;
}

if (cmd === "create") {
  const key = generateKey();
  const hash = await hashKey(key);
  const atomic = amount();
  const label = opt("--label");
  const test = rest.includes("--test");
  const sql = "insert into public.api_keys (key_hash, label, balance, test) values (" + lit(hash) + ", " + (label ? lit(label) : "null") + ", " + atomic + ", " + test + ");";
  await runSql(ref, sql);
  console.log("created " + (test ? "TEST " : "") + "key with $" + atomic / 1e6 + " (id " + hash.slice(0, 8) + "). Shown once:\n\n" + key + "\n");
} else if (cmd === "list") {
  const rows = (await runSql(ref, "select left(key_hash, 8) as id, coalesce(label, '') as label, balance, test, disabled, created_at, last_used_at from public.api_keys order by created_at desc limit 200;")) as Record<string, any>[];
  for (const r of rows) {
    const flags = (r.disabled ? "DISABLED " : "") + (r.test ? "test " : "");
    const used = r.last_used_at ? String(r.last_used_at).slice(0, 10) : "never";
    console.log(r.id + "  $" + (Number(r.balance) / 1e6).toFixed(2).padStart(8) + "  " + flags + r.label + "  created " + String(r.created_at).slice(0, 10) + "  last used " + used);
  }
  if (!rows.length) console.log("no keys");
} else if (cmd === "topup") {
  // Find the key first and refuse unless exactly one matches, then change it by its full hash (SEC-14).
  const hash = await uniqueKeyHash(ref, id());
  if (!hash) process.exit(1);
  const out = (await runSql(ref, "update public.api_keys set balance = balance + " + amount() + " where key_hash = " + lit(hash) + " returning left(key_hash, 8) as id, balance;")) as { id: string; balance: number }[];
  console.log("ok: balance now $" + (Number(out[0]!.balance) / 1e6).toFixed(2));
} else if (cmd === "disable") {
  const hash = await uniqueKeyHash(ref, id());
  if (!hash) process.exit(1);
  await runSql(ref, "update public.api_keys set disabled = true where key_hash = " + lit(hash) + ";");
  console.log("disabled");
} else usage();

/** The one key whose hash starts with `prefix`; prints and returns undefined unless exactly one matches. */
async function uniqueKeyHash(ref: string, prefix: string): Promise<string | undefined> {
  const rows = (await runSql(ref, "select key_hash from public.api_keys where key_hash like " + lit(prefix + "%") + ";")) as { key_hash: string }[];
  if (rows.length !== 1) {
    console.log("matched " + rows.length + " keys; nothing was changed");
    return undefined;
  }
  return rows[0]!.key_hash;
}
