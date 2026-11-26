/**
 * Compute layout fingerprints and quality flags for plans already in Supabase, then re-rank.
 * New loads do this themselves (scripts/supabase-load.ts); this backfills older rows and is
 * also the way to apply a change to the fingerprint rules in src/db/layout.ts.
 *
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/supabase-layouts.ts            # report only
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/supabase-layouts.ts --apply    # write + re-rank
 *
 * Auth as for supabase-load.ts (personal access token for api.supabase.com).
 */
import type { FloorPlan } from "../src/db/client.js";
import { layoutKey, qualityFlags, rankLayouts } from "../src/db/layout.js";
import { runSql } from "./supabase-load.js";

const PAGE = 2000;
const UPDATE_BATCH = 2000;

type Row = Pick<FloorPlan, "plan_id" | "total_area_m2" | "bathrooms" | "adjacency_graph"> & { source: string };

async function main() {
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!ref) {
    console.error("usage: SUPABASE_PROJECT_REF=<ref> npx tsx scripts/supabase-layouts.ts [--apply]");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");

  const rows: Row[] = [];
  let after = "";
  for (;;) {
    const page = (await runSql(ref,
      `select plan_id, total_area_m2::float8 as total_area_m2, bathrooms::float8 as bathrooms, adjacency_graph, source
       from public.floor_plans where plan_id > '${after.replace(/'/g, "''")}' order by plan_id limit ${PAGE};`)) as Row[];
    rows.push(...page);
    process.stdout.write(`\rread ${rows.length}`);
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.plan_id;
  }
  console.log();

  const ranks = rankLayouts(rows);
  const bySource = new Map<string, { plans: number; shown: number; flagged: number }>();
  let biggest = { key: "", copies: 0, example: "" };
  for (const r of rows) {
    const info = ranks.get(r.plan_id)!;
    const s = bySource.get(r.source) ?? { plans: 0, shown: 0, flagged: 0 };
    s.plans++;
    if (info.quality_flags.length) s.flagged++;
    else if (info.layout_rank === 1) s.shown++;
    bySource.set(r.source, s);
    if (info.layout_copies > biggest.copies) biggest = { key: info.layout_key, copies: info.layout_copies, example: r.plan_id };
  }
  for (const [source, s] of bySource) {
    console.log(`${source}: ${s.plans} plans → ${s.shown} distinct layouts served, ${s.plans - s.shown - s.flagged} repeats hidden, ${s.flagged} flagged`);
  }
  const copies = [...ranks.values()].filter((i) => i.layout_rank === 1 && !i.quality_flags.length).map((i) => i.layout_copies);
  const hist = new Map<string, number>();
  for (const c of copies) {
    const bucket = c === 1 ? "1" : c <= 3 ? "2-3" : c <= 10 ? "4-10" : "11+";
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
  console.log("layouts by copy count:", Object.fromEntries([...hist].sort()));
  console.log(`most repeated: ${biggest.copies} copies (e.g. ${biggest.example})`);
  console.log("flagged:", rows.filter((r) => ranks.get(r.plan_id)!.quality_flags.length).map((r) => r.plan_id).join(", ") || "none");
  if (!apply) return console.log("report only; pass --apply to write");

  const updates = rows.map((r) => ({ plan_id: r.plan_id, layout_key: layoutKey(r), quality_flags: qualityFlags(r) }));
  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const json = JSON.stringify(updates.slice(i, i + UPDATE_BATCH));
    await runSql(ref,
      `update public.floor_plans f set layout_key = x.layout_key, quality_flags = x.quality_flags
       from jsonb_to_recordset($j$${json}$j$::jsonb) as x(plan_id text, layout_key text, quality_flags text[])
       where f.plan_id = x.plan_id;`);
    process.stdout.write(`\rwritten ${Math.min(i + UPDATE_BATCH, updates.length)}/${updates.length}`);
  }
  console.log();
  const changed = (await runSql(ref, "select public.refresh_layout_ranks() as changed;")) as { changed: number }[];
  console.log(`ranks updated: ${changed[0]?.changed ?? 0}`);
  await runSql(ref, "refresh materialized view public.catalogue_stats;");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
