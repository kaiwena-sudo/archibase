/**
 * Layout fingerprints and quality flags.
 *
 * Datasets like Swiss Dwellings repeat the same apartment on every floor of a building. Buyers
 * paying per search don't want ten copies of one layout, so each plan gets a `layout_key`: a hash
 * of its room graph (room types, sizes to 0.1 m², windows, fixtures, and how rooms connect), with
 * node ids ignored because they are just labels. Plans that share a key are the same layout;
 * the one with the lowest plan_id is canonical (layout_rank 1) and search shows only canonical
 * plans unless asked for duplicates. Mirrored copies share a key: the graph is identical.
 *
 * Quality flags mark records that are probably wrong rather than merely unusual. Flagged plans are
 * kept in the database but never returned by search.
 *
 * Pure JS (no node:crypto) so it runs on Cloudflare Workers too.
 */
import type { AdjacencyGraph, AdjacencyNode } from "./client.js";

export const QUALITY_FLAGS = ["multi_unit_suspect"] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

/** 3+ kitchens in one "apartment" means the source merged several units (seen in Swiss Dwellings). */
export const MULTI_UNIT_KITCHENS = 3;

interface LayoutInput {
  total_area_m2: number;
  bathrooms: number;
  adjacency_graph: AdjacencyGraph;
}

function nodeSignature(n: AdjacencyNode): string {
  const area = typeof n.area === "number" ? n.area.toFixed(1) : "";
  const fixtures = Array.isArray(n.fixtures) ? [...(n.fixtures as string[])].sort().join("+") : "";
  return [n.type, n.inferred_use ?? "", area, n.windows ?? "", fixtures, n.level ?? "", n.exterior ? "x" : ""].join("|");
}

/** Canonical text of a layout, independent of node ids and list order. */
export function layoutSignature(plan: LayoutInput): string {
  const nodes = plan.adjacency_graph?.nodes ?? [];
  const edges = plan.adjacency_graph?.edges ?? [];
  const sig = new Map(nodes.map((n) => [n.id, nodeSignature(n)]));
  const nodeSigs = [...sig.values()].sort();
  const edgeSigs = edges
    .map((e) => {
      const [a, b] = [sig.get(e.from) ?? `?${e.from}`, sig.get(e.to) ?? `?${e.to}`].sort();
      return `${a}>${b}>${e.connection}`;
    })
    .sort();
  return [plan.total_area_m2.toFixed(1), String(plan.bathrooms), nodeSigs.join(";"), edgeSigs.join(";")].join("#");
}

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex chars. Collisions are negligible at our scale. */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

export function layoutKey(plan: LayoutInput): string {
  return fnv1a64(layoutSignature(plan));
}

export function qualityFlags(plan: LayoutInput): QualityFlag[] {
  const kitchens = (plan.adjacency_graph?.nodes ?? []).filter((n) => n.type === "kitchen").length;
  return kitchens >= MULTI_UNIT_KITCHENS ? ["multi_unit_suspect"] : [];
}

export interface LayoutInfo {
  layout_key: string;
  /** 1 = canonical copy (lowest plan_id among identical layouts). */
  layout_rank: number;
  /** How many plans share this layout, this one included. */
  layout_copies: number;
  quality_flags: QualityFlag[];
}

/** Rank a whole collection in memory (JSON / bundled stores). Mirrors the SQL in db/schema.sql. */
export function rankLayouts<T extends LayoutInput & { plan_id: string }>(plans: readonly T[]): Map<string, LayoutInfo> {
  // Flagged plans are ranked 1 of 1 and kept out of the groups, so they never hide a good copy.
  const groups = new Map<string, string[]>();
  const info = new Map<string, { key: string; flags: QualityFlag[] }>();
  for (const p of plans) {
    const key = layoutKey(p);
    const flags = qualityFlags(p);
    info.set(p.plan_id, { key, flags });
    if (flags.length) continue;
    const g = groups.get(key);
    if (g) g.push(p.plan_id);
    else groups.set(key, [p.plan_id]);
  }
  for (const ids of groups.values()) ids.sort();
  const out = new Map<string, LayoutInfo>();
  for (const p of plans) {
    const { key, flags } = info.get(p.plan_id)!;
    const ids = flags.length ? [p.plan_id] : groups.get(key)!;
    out.set(p.plan_id, {
      layout_key: key,
      layout_rank: ids.indexOf(p.plan_id) + 1,
      layout_copies: ids.length,
      quality_flags: flags,
    });
  }
  return out;
}
