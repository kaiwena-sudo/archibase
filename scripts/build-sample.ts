/**
 * Build src/site/sample-data.ts: the free sample set (about 20 real plans with geometry), bundled
 * into the Worker so the free endpoints (/api/v1/sample, /explore) cost nothing to serve and can't
 * be used to pull the catalogue. Picks are deterministic (ordered by md5 of the plan id) and
 * spread across sources, building types and bedroom counts.
 *
 *   SUPABASE_PROJECT_REF=<ref> NODE_USE_ENV_PROXY=1 npx tsx scripts/build-sample.ts
 */
import { writeFileSync } from "node:fs";
import { fromRow, SUPABASE_COLUMNS, supabaseHeaders, type FloorPlan } from "../src/db/client.js";
import type { PlanVector } from "../src/db/vectors.js";
import { runSql } from "./supabase-load.js";

const ref = process.env.SUPABASE_PROJECT_REF;
if (!ref) throw new Error("set SUPABASE_PROJECT_REF");
const BASE = `https://${ref}.supabase.co`;
const KEY = process.env.SUPABASE_KEY ?? "proxy-injected"; // the sandbox proxy injects the real key

/**
 * Small, clean, typical plans: layout is canonical, unflagged, has geometry no bigger than 70 KB.
 * Asks for several candidates; the first `n` that also pass the shape check below are kept.
 */
const wanted: { sql: string; n: number }[] = [];
const pick = (where: string, n: number) => {
  const sql = `
  (select f.plan_id from public.floor_plans f join public.floor_plan_vectors v using (plan_id)
   where f.layout_rank = 1 and f.quality_flags = '{}' and pg_column_size(v.vector) < 70000 and ${where}
   order by md5(f.plan_id) limit ${n * 6})`;
  wanted.push({ sql, n });
  return sql;
};
/** A floor that is a long thin strip (a station platform) is unreadable as a thumbnail. */
function aspect(v: PlanVector): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of v.rooms) for (const poly of r.polygon) for (const [x, y] of poly[0]!) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const w = maxX - minX, h = maxY - minY;
  return Math.max(w, h) / Math.max(1e-9, Math.min(w, h));
}

// The one historic US plan with geometry: fixed, not sampled.
wanted.push({ sql: "(select plan_id from public.floor_plans where plan_id = 'habs-ala786-mobile-creole-cottage')", n: 1 });

const queries = [
  ...[1, 2, 3, 4].map((b) => pick(`f.plan_id like 'sd-%' and f.bedrooms = ${b} and f.bedrooms_inferred = 0 and f.total_area_m2 between 35 and 140`, 1)),
  ...[1, 2, 3, 4].map((b) => pick(`f.plan_id like 'rp-%' and f.bedrooms = ${b} and f.total_area_m2 between 35 and 200`, 1)),
  pick(`f.building_type = 'industrial' and f.total_area_m2 between 300 and 1500 and jsonb_array_length(f.adjacency_graph->'nodes') between 8 and 30`, 3),
  pick(`f.building_type = 'office' and f.total_area_m2 between 300 and 1500 and jsonb_array_length(f.adjacency_graph->'nodes') between 8 and 40`, 2),
  pick(`f.building_type = 'retail' and f.total_area_m2 between 200 and 1500`, 1),
  pick(`f.building_type = 'transport' and f.total_area_m2 between 300 and 3000`, 1),
  pick(`f.building_type = 'government' and f.total_area_m2 between 300 and 1500`, 1),
  pick(`f.building_type = 'sports' and f.total_area_m2 between 300 and 2500`, 1),
  pick(`f.building_type = 'mixed' and f.total_area_m2 between 200 and 1200`, 1),
  pick(`f.building_type = 'hospitality' and f.total_area_m2 between 200 and 1200`, 1),
];

void queries; // building `queries` registered each group in `wanted`

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: { ...supabaseHeaders(KEY), Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const MAX_ASPECT = 3.2;
const ids: string[] = [];
for (const { sql, n } of wanted) {
  const cands = ((await runSql(ref, sql + ";")) as { plan_id: string }[]).map((r) => r.plan_id);
  const vs = await rest<{ plan_id: string; vector: PlanVector }[]>(`floor_plan_vectors?plan_id=in.(${cands.join(",")})&select=plan_id,vector`);
  const byId = new Map(vs.map((v) => [v.plan_id, v.vector]));
  const good = cands.filter((id) => byId.has(id) && aspect(byId.get(id)!) <= MAX_ASPECT).slice(0, n);
  if (good.length < n) console.warn(`  only ${good.length}/${n} passed the shape check for: ${cands.slice(0, 2).join(", ")}…`);
  ids.push(...good);
}
console.log(`${ids.length} plans picked:`, ids.join(", "));
const list = `(${ids.join(",")})`;
const plans = (await rest<any[]>(`floor_plans?plan_id=in.${list}&select=${SUPABASE_COLUMNS.join(",")}`)).map(fromRow);
const vectors = await rest<{ plan_id: string; vector: PlanVector }[]>(`floor_plan_vectors?plan_id=in.${list}&select=plan_id,vector`);
for (const p of plans) {
  const transcription = (p.adjacency_graph as { transcription?: { notes?: unknown } }).transcription;
  if (typeof transcription?.notes === "string") {
    transcription.notes = transcription.notes.replace(/\s*Test data:\s*verify before sale\.?/gi, "").trim();
  }
}
const order = new Map(ids.map((id, i) => [id, i]));
plans.sort((a, b) => order.get(a.plan_id)! - order.get(b.plan_id)!);
const vmap = Object.fromEntries(vectors.map((v) => [v.plan_id, v.vector]));
for (const p of plans) {
  if (!vmap[p.plan_id]) throw new Error(`no geometry for ${p.plan_id}`);
  delete p.vector_schema_url;
}

const bytes = JSON.stringify(vmap).length + JSON.stringify(plans).length;
writeFileSync(
  new URL("../src/site/sample-data.ts", import.meta.url),
  `// Generated by scripts/build-sample.ts from the live database. Do not edit by hand.\n` +
    `import type { FloorPlan } from "../db/client.js";\nimport type { PlanVector } from "../db/vectors.js";\n\n` +
    `export const SAMPLE_PLANS: FloorPlan[] = ${JSON.stringify(plans)};\n\n` +
    `export const SAMPLE_VECTORS: Record<string, PlanVector> = ${JSON.stringify(vmap)};\n`,
);
console.log(`wrote src/site/sample-data.ts: ${plans.length} plans, ${(bytes / 1024).toFixed(0)} KB`);
