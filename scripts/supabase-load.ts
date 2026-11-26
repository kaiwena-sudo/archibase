/**
 * Load plan records (and their vector geometry) into Supabase through the Management API.
 *
 *   SUPABASE_PROJECT_REF=<ref> npm run supabase:load -- incoming/swiss/plans-*.json --vectors incoming/swiss/vectors
 *   SUPABASE_PROJECT_REF=<ref> npm run supabase:load -- data/plans.json --vectors data/vectors --dry-run
 *
 * Auth: a Supabase personal access token sent as `Authorization: Bearer <token>` to
 * api.supabase.com. Set SUPABASE_ACCESS_TOKEN, or (in a cloud session) let the network proxy
 * inject a saved credential for that host. No service-role key is needed for loading.
 *
 * Every record passes the same validation as `npm run seed` (src/db/validate.ts); one invalid
 * record aborts the run unless --skip-invalid. Rows are upserted by plan_id, so re-running is safe.
 * Options: --exclude-source synthetic (repeatable) leaves out records of that provenance source.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toRow, type FloorPlan } from "../src/db/client.js";
import { layoutKey, qualityFlags } from "../src/db/layout.js";
import { checkRecords } from "./seed.js";

const PLAN_BATCH = 200;
const VECTOR_BATCH = 100;
/** The Management API rejects large bodies (413); big records (whole building floors) get smaller batches. */
const MAX_BATCH_BYTES = 2_000_000;

/** Split rows into batches of at most `maxRows` rows and about MAX_BATCH_BYTES of JSON. */
export function batches<T>(rows: T[], maxRows: number, maxBytes = MAX_BATCH_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const row of rows) {
    const n = JSON.stringify(row).length;
    if (cur.length && (cur.length >= maxRows || size + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(row);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
const TAG = "$archibase_json$";

const PLAN_COLUMNS: [string, string][] = [
  ["plan_id", "text"], ["style", "text"], ["building_type", "text"], ["total_area_m2", "numeric"], ["bedrooms", "integer"],
  ["bedrooms_inferred", "integer"], ["bathrooms", "numeric"], ["adjacency_graph", "jsonb"],
  ["source", "text"], ["built", "boolean"], ["license", "text"], ["author", "text"],
  ["source_url", "text"], ["attribution", "text"], ["rights_ref", "text"],
  ["layout_key", "text"], ["quality_flags", "text[]"],
];

/** A plan as a row for this loader: the API row plus the layout fingerprint and quality flags. */
export function loadRow(p: FloorPlan): object {
  return { ...toRow(p), layout_key: layoutKey(p), quality_flags: qualityFlags(p) };
}

/** SQL that upserts a batch of rows passed as one dollar-quoted JSON literal. */
export function upsertSql(table: string, columns: [string, string][], rows: object[]): string {
  const json = JSON.stringify(rows);
  if (json.includes(TAG)) throw new Error(`data contains the quoting tag ${TAG}`);
  const names = columns.map(([c]) => c);
  return (
    `insert into public.${table} (${names.join(", ")})\n` +
    `select ${names.join(", ")} from jsonb_to_recordset(${TAG}${json}${TAG}::jsonb)\n` +
    `  as x(${columns.map(([c, t]) => `${c} ${t}`).join(", ")})\n` +
    `on conflict (plan_id) do update set ${names.filter((c) => c !== "plan_id").map((c) => `${c} = excluded.${c}`).join(", ")};`
  );
}

export async function runSql(ref: string, query: string): Promise<unknown> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k: string) => args.includes(k);
  const values = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]!] : []));
  const vectorsDir = values("--vectors")[0];
  const excluded = new Set(values("--exclude-source"));
  const skip = new Set(args.flatMap((a, i) => (a.startsWith("--") ? [i, ...(a === "--vectors" || a === "--exclude-source" ? [i + 1] : [])] : [])));
  const files = args.filter((_, i) => !skip.has(i));
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!ref || !files.length) {
    console.error("usage: SUPABASE_PROJECT_REF=<ref> npm run supabase:load -- <plans.json ...> [--vectors <dir>] [--exclude-source synthetic] [--dry-run] [--skip-invalid]");
    process.exit(2);
  }

  const records: unknown[] = [];
  for (const f of files) records.push(...(JSON.parse(await readFile(f, "utf8")) as unknown[]));
  const kept = records.filter((r) => !excluded.has((r as FloorPlan).provenance?.source));
  const report = checkRecords(kept);
  for (const r of report.rejected) console.error(`✗ ${r.plan_id}: ${r.errors.join("; ")}`);
  console.log(`${report.accepted.length} valid, ${report.rejected.length} rejected` + (excluded.size ? `, ${records.length - kept.length} excluded by source` : ""));
  if (report.rejected.length && !flag("--skip-invalid")) process.exit(1);

  // Pair each plan with its geometry file, if any.
  const vectors: { plan_id: string; vector: unknown }[] = [];
  if (vectorsDir) {
    for (const p of report.accepted) {
      const raw = await readFile(join(vectorsDir, `${p.plan_id}.json`), "utf8").catch(() => null);
      if (raw) vectors.push({ plan_id: p.plan_id, vector: JSON.parse(raw) });
    }
  }
  console.log(`${vectors.length} with geometry`);
  if (flag("--dry-run")) return;

  let done = 0;
  for (const batch of batches(report.accepted.map(loadRow), PLAN_BATCH)) {
    await runSql(ref, upsertSql("floor_plans", PLAN_COLUMNS, batch));
    done += batch.length;
    process.stdout.write(`\rplans ${done}/${report.accepted.length}`);
  }
  console.log();
  done = 0;
  for (const batch of batches(vectors, VECTOR_BATCH)) {
    await runSql(ref, upsertSql("floor_plan_vectors", [["plan_id", "text"], ["vector", "jsonb"]], batch));
    done += batch.length;
    process.stdout.write(`\rgeometry ${done}/${vectors.length}`);
  }
  if (vectors.length) console.log();
  // Ranks are global (a new plan can duplicate an existing one), so refresh them after every load.
  const ranked = (await runSql(ref, "select public.refresh_layout_ranks() as changed;")) as { changed: number }[];
  console.log(`layout ranks updated: ${ranked[0]?.changed ?? 0}`);
  await runSql(ref, "refresh materialized view public.catalogue_stats;"); // site figures (db/schema.sql)
  const counts = await runSql(ref,
    "select (select count(*) from public.floor_plans) as plans, (select count(*) from public.floor_plan_vectors) as vectors, " +
    "pg_size_pretty(pg_database_size(current_database())) as db_size;");
  console.log("database now:", JSON.stringify(counts));
}

if (process.argv[1]?.endsWith("supabase-load.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
