/**
 * Live catalogue figures for the site (landing page, docs, llms.txt).
 *
 * Counts come from the plan store (Supabase view public.catalogue_stats, or computed in memory for
 * the JSON store), so the site never shows stale numbers after a load. Source names, descriptions
 * and licences are keyed by plan_id prefix here, because they are editorial, not data.
 */

/** One row of public.catalogue_stats: plans per id prefix and building type. */
export interface StatsRow {
  prefix: string;
  building_type: string;
  /** Distinct layouts served by search (canonical copy, not flagged). */
  served: number;
  /** All stored plans, repeats included. */
  stored: number;
}

export interface SourceStats {
  key: string;
  name: string;
  detail: string;
  license: string;
  by: string;
  layouts: number;
}

export interface Catalogue {
  distinctLayouts: number;
  storedPlans: number;
  sources: SourceStats[];
  byBuildingType: { type: string; layouts: number }[];
}

/** Editorial info per plan_id prefix. Add an entry when a new source is imported. */
export const SOURCE_INFO: Record<string, Omit<SourceStats, "key" | "layouts">> = {
  sd: { name: "Swiss Dwellings", detail: "Apartments in built Swiss buildings", license: "CC BY 4.0", by: "Archilyse AG" },
  rp: { name: "ResPlan", detail: "South Asian homes and apartments from real-estate listings", license: "CC BY 4.0", by: "Abouagour & Garyfallidis" },
  hk: {
    name: "Hong Kong 3D Indoor Map",
    detail: "Floors of offices, industrial buildings, stations, malls and public buildings",
    license: "HK Gov. CSDI terms",
    by: "Lands Department, HKSAR",
  },
  habs: { name: "HABS", detail: "Historic US houses, measured drawings", license: "Public domain", by: "Library of Congress" },
};
const OTHER = { name: "Other", detail: "Sample and other records", license: "Varies", by: "See each record" };

/** Shown only if the store can't be reached: snapshot of public.catalogue_stats on 2026-11-15. */
export const FALLBACK_STATS: StatsRow[] = [
  { prefix: "habs", building_type: "residential", served: 3, stored: 3 },
  { prefix: "hk", building_type: "cultural", served: 8, stored: 8 },
  { prefix: "hk", building_type: "government", served: 607, stored: 632 },
  { prefix: "hk", building_type: "healthcare", served: 12, stored: 12 },
  { prefix: "hk", building_type: "hospitality", served: 162, stored: 185 },
  { prefix: "hk", building_type: "industrial", served: 1_494, stored: 1_603 },
  { prefix: "hk", building_type: "mixed", served: 781, stored: 966 },
  { prefix: "hk", building_type: "office", served: 2_960, stored: 3_245 },
  { prefix: "hk", building_type: "other", served: 26, stored: 26 },
  { prefix: "hk", building_type: "retail", served: 519, stored: 560 },
  { prefix: "hk", building_type: "sports", served: 212, stored: 212 },
  { prefix: "hk", building_type: "transport", served: 343, stored: 343 },
  { prefix: "rp", building_type: "residential", served: 16_454, stored: 16_784 },
  { prefix: "sd", building_type: "residential", served: 24_935, stored: 44_946 },
];

export function buildCatalogue(rows: StatsRow[]): Catalogue {
  const bySource = new Map<string, number>();
  const byType = new Map<string, number>();
  let distinct = 0, stored = 0;
  for (const r of rows) {
    const served = Number(r.served) || 0;
    distinct += served;
    stored += Number(r.stored) || 0;
    const key = SOURCE_INFO[r.prefix] ? r.prefix : "other";
    bySource.set(key, (bySource.get(key) ?? 0) + served);
    byType.set(r.building_type, (byType.get(r.building_type) ?? 0) + served);
  }
  const sources = [...bySource.entries()]
    .filter(([, n]) => n > 0)
    .map(([key, layouts]) => ({ key, layouts, ...(SOURCE_INFO[key] ?? OTHER) }))
    .sort((a, b) => b.layouts - a.layouts);
  const byBuildingType = [...byType.entries()]
    .filter(([, n]) => n > 0)
    .map(([type, layouts]) => ({ type, layouts }))
    .sort((a, b) => b.layouts - a.layouts);
  return { distinctLayouts: distinct, storedPlans: stored, sources, byBuildingType };
}

/** Cache the figures per isolate; on failure fall back without caching the failure for long. */
export function catalogueProvider(load: (() => Promise<StatsRow[]>) | undefined, ttlMs = 5 * 60_000): () => Promise<Catalogue> {
  let cached: { expires: number; value: Catalogue } | undefined;
  return async () => {
    if (cached && Date.now() < cached.expires) return cached.value;
    try {
      const rows = load ? await load() : FALLBACK_STATS;
      cached = { expires: Date.now() + ttlMs, value: buildCatalogue(rows.length ? rows : FALLBACK_STATS) };
    } catch (err) {
      console.error("[catalogue] stats unavailable, using fallback:", err);
      // Don't hold a failure for the full TTL: retry within 30 s.
      cached = { expires: Date.now() + Math.min(ttlMs, 30_000), value: buildCatalogue(FALLBACK_STATS) };
    }
    return cached.value;
  };
}
