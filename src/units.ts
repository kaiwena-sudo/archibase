/**
 * Units. Archibase stores everything metric (areas in m², geometry in metres);
 * imperial is a presentation option applied to API responses only.
 */
import type { FloorPlan } from "./db/client.js";

/** Exact: 1 ft = 0.3048 m, so 1 m² = 1 / 0.3048² ft². */
export const SQFT_PER_M2 = 1 / (0.3048 * 0.3048);

export const UNIT_SYSTEMS = ["metric", "imperial"] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

const round2 = (n: number) => Math.round(n * 100) / 100;

export const sqftToM2 = (sqft: number) => sqft / SQFT_PER_M2;
export const m2ToSqft = (m2: number) => m2 * SQFT_PER_M2;
/** Stored precision for areas: centimetre-square-ish, 2 decimals of m². */
export const roundM2 = round2;

/** Imperial view of a stored (metric) plan: total_sqft and room areas in whole sqft. */
export interface ImperialFloorPlan extends Omit<FloorPlan, "total_area_m2"> {
  total_sqft: number;
}

export function toImperial(plan: FloorPlan): ImperialFloorPlan {
  const { total_area_m2, adjacency_graph, ...rest } = plan;
  return {
    ...rest,
    total_sqft: Math.round(m2ToSqft(total_area_m2)),
    adjacency_graph: {
      ...adjacency_graph,
      units: "sqft",
      nodes: adjacency_graph.nodes.map((n) =>
        n.area === undefined ? n : { ...n, area: Math.round(m2ToSqft(n.area)) },
      ),
    },
  };
}

export function present(plan: FloorPlan, units: UnitSystem): FloorPlan | ImperialFloorPlan {
  return units === "imperial" ? toImperial(plan) : plan;
}
