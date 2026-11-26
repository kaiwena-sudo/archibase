/**
 * Validate floor plan records and load them into the store.
 *
 *   npm run seed -- incoming/habs-batch-01.json [more.json ...] [--dry-run] [--skip-invalid]
 *
 * Target comes from DATABASE_URL:
 *   file:<path> (default file:data/plans.json)  → merged into that JSON file by plan_id;
 *                                                 rights_ref values go to data/rights.json
 *   https://<project>.supabase.co                → upserted; needs a service-role SUPABASE_KEY
 *
 * Every record must pass src/db/validate.ts: valid graph, consistent bedroom
 * count, and provenance with a licence that allows resale. By default one bad
 * record aborts the whole run, so a batch is either fully in or fully out.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SupabasePlanStore, type FloorPlan } from "../src/db/client.js";
import { toPublicPlan, validatePlan, type InternalRights } from "../src/db/validate.js";

type Rec = FloorPlan & InternalRights;

export interface SeedReport {
  accepted: Rec[];
  rejected: { plan_id: string; errors: string[] }[];
  warnings: { plan_id: string; warnings: string[] }[];
}

export function checkRecords(records: unknown[]): SeedReport {
  const report: SeedReport = { accepted: [], rejected: [], warnings: [] };
  const seen = new Set<string>();
  for (const [i, rec] of records.entries()) {
    const id = (rec as { plan_id?: unknown })?.plan_id;
    const label = typeof id === "string" ? id : `#${i}`;
    const { errors, warnings } = validatePlan(rec);
    if (typeof id === "string") {
      if (seen.has(id)) errors.push("duplicate plan_id in this batch");
      seen.add(id);
    }
    if (warnings.length) report.warnings.push({ plan_id: label, warnings });
    if (errors.length) report.rejected.push({ plan_id: label, errors });
    else report.accepted.push(rec as Rec);
  }
  return report;
}

/** Merge records into a JSON file store by plan_id; keep rights_ref out of the served file. */
export async function writeToJsonFile(path: string, records: Rec[]): Promise<{ added: number; updated: number }> {
  const existing: FloorPlan[] = JSON.parse(await readFile(path, "utf8").catch(() => "[]"));
  const byId = new Map(existing.map((p) => [p.plan_id, p]));
  let added = 0;
  let updated = 0;
  for (const r of records) {
    if (byId.has(r.plan_id)) updated++;
    else added++;
    byId.set(r.plan_id, toPublicPlan(r));
  }
  const merged = [...byId.values()].sort((a, b) => a.plan_id.localeCompare(b.plan_id));
  await writeFile(path, JSON.stringify(merged, null, 2) + "\n");

  const withRights = records.filter((r) => r.rights_ref);
  if (withRights.length) {
    const rightsPath = join(dirname(path), "rights.json");
    const rights: Record<string, string> = JSON.parse(await readFile(rightsPath, "utf8").catch(() => "{}"));
    for (const r of withRights) rights[r.plan_id] = r.rights_ref!;
    await writeFile(rightsPath, JSON.stringify(rights, null, 2) + "\n");
  }
  return { added, updated };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipInvalid = args.includes("--skip-invalid");
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("usage: npm run seed -- <records.json> [...] [--dry-run] [--skip-invalid]");
    process.exit(2);
  }

  const records: unknown[] = [];
  for (const f of files) {
    const parsed = JSON.parse(await readFile(f, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${f} must contain a JSON array of plan records`);
    records.push(...parsed);
  }

  const report = checkRecords(records);
  for (const w of report.warnings) console.warn(`⚠ ${w.plan_id}: ${w.warnings.join("; ")}`);
  for (const r of report.rejected) console.error(`✗ ${r.plan_id}:\n    - ${r.errors.join("\n    - ")}`);
  console.log(`${report.accepted.length} valid, ${report.rejected.length} rejected, ${report.warnings.length} with warnings`);

  if (report.rejected.length && !skipInvalid) {
    console.error("Aborting: fix the rejected records or pass --skip-invalid.");
    process.exit(1);
  }
  if (dryRun || !report.accepted.length) return;

  const dbUrl = process.env.DATABASE_URL?.trim() || "file:data/plans.json";
  if (dbUrl.startsWith("file:")) {
    const path = resolve(dbUrl.slice("file:".length));
    const { added, updated } = await writeToJsonFile(path, report.accepted);
    console.log(`Wrote ${path}: ${added} added, ${updated} updated`);
  } else if (/^https:\/\/.+\.supabase\.co\/?$/.test(dbUrl)) {
    const key = process.env.SUPABASE_KEY;
    if (!key) throw new Error("SUPABASE_KEY (service role) is required to seed Supabase");
    await new SupabasePlanStore(dbUrl, key).upsertPlans(report.accepted);
    console.log(`Upserted ${report.accepted.length} record(s) into Supabase`);
  } else {
    throw new Error(`Unsupported DATABASE_URL "${dbUrl}"`);
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch {
      /* no .env */
    }
  }
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
