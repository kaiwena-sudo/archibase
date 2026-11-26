/**
 * Record validation and rights rules for floor plans.
 *
 * Every record served by the API must say where it came from and under what
 * licence. The seed script refuses records that fail these checks, so nothing
 * enters the database without documented rights to sell it.
 */
import type { FloorPlan } from "./client.js";

/** Where a plan came from. */
export const SOURCES = [
  "synthetic", //     hand-made sample/demo data
  "habs", //          Library of Congress HABS/HAER/HALS measured drawings (built, public domain)
  "commissioned", //  paid work from students or firms under a written rights agreement
  "dataset", //       third-party dataset under an open licence that allows commercial use
  "ai_generated", //  produced by Archibase's own generative models
] as const;
export type PlanSource = (typeof SOURCES)[number];

/** What the building is used for. Records without the field are residential. */
export const BUILDING_TYPES = [
  "residential", "office", "retail", "transport", "government", "sports", "hospitality",
  "healthcare", "cultural", "education", "industrial", "mixed", "other",
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

/**
 * Licences under which a plan may be resold. Anything else (CC-BY-NC, "all rights
 * reserved", unknown) is rejected. Share-alike licences are deliberately excluded
 * until reviewed, because they bind how buyers can reuse the data.
 */
export const COMMERCIAL_LICENSES = {
  "public-domain": { attribution: false },
  "CC0-1.0": { attribution: false },
  "CC-BY-4.0": { attribution: true },
  // Hong Kong Government data from the CSDI Portal (https://portal.csdi.gov.hk/csdi-webpage/doc/TNC):
  // commercial use free of charge if the Government and the CSDI Portal are named as the source and
  // their IP ownership acknowledged (the attribution text does both). Data is provided as is.
  "HK-CSDI-TOU": { attribution: true },
  // Archibase holds the rights: own work, or copyright assigned / exclusively
  // licensed in writing (keep the signed agreement on file; see rights_ref).
  "owned": { attribution: false },
} as const;
export type PlanLicense = keyof typeof COMMERCIAL_LICENSES;

export interface Provenance {
  source: PlanSource;
  /** True only for plans of buildings that were actually constructed. */
  built: boolean;
  license: PlanLicense;
  author?: string;
  source_url?: string;
  /** Required credit line for licences that demand attribution (e.g. CC-BY). */
  attribution?: string;
}

/**
 * Internal-only fields accepted by the seed script but never served by the API
 * (they're stripped before storage in the public JSON and live in a separate
 * column in Supabase).
 */
export interface InternalRights {
  /** Contract / agreement reference for commissioned or owned work. */
  rights_ref?: string;
}

export const PLAN_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const BEDROOM_TYPES = new Set(["bedroom", "primary_bedroom"]);
/** For type "room" (a room the source didn't label): what the evidence suggests it is. */
export const INFERRED_USES = new Set(["bedroom", "entry", "unknown"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown, max = 200): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isHttpsUrl = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

export interface ValidationResult {
  errors: string[];
  /** Plausibility issues worth a human look, not blocking. */
  warnings: string[];
}

export function validatePlan(record: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(record)) return { errors: ["record must be an object"], warnings };
  const r = record as Partial<FloorPlan> & InternalRights & Record<string, unknown>;

  // ---- core fields ----
  if (typeof r.plan_id !== "string" || !PLAN_ID.test(r.plan_id)) {
    errors.push("plan_id must be 3-80 chars of lowercase letters, digits and hyphens");
  }
  if (typeof r.style !== "string" || !/^[a-z][a-z \-]{0,63}$/.test(r.style)) {
    errors.push("style must be lowercase letters, spaces or hyphens");
  }
  if (r.building_type !== undefined && !(BUILDING_TYPES as readonly string[]).includes(r.building_type as string)) {
    errors.push(`building_type must be one of ${BUILDING_TYPES.join(", ")}`);
  }
  if (typeof r.total_area_m2 !== "number" || !(r.total_area_m2 > 0) || r.total_area_m2 > 100_000) {
    errors.push("total_area_m2 must be a positive number of square metres <= 100000");
  }
  if ("total_sqft" in r) errors.push("total_sqft is not stored; records are metric (total_area_m2)");
  if (!Number.isInteger(r.bedrooms) || (r.bedrooms as number) < 0 || (r.bedrooms as number) > 20) {
    errors.push("bedrooms must be an integer 0-20");
  }
  if (typeof r.bathrooms !== "number" || r.bathrooms < 0 || r.bathrooms > 20 || !Number.isInteger(r.bathrooms * 2)) {
    errors.push("bathrooms must be a multiple of 0.5 between 0 and 20");
  }
  if ("vector_schema_url" in r) {
    errors.push("vector_schema_url is assigned by the API from the vector store; don't store it");
  }

  // ---- adjacency graph ----
  const g = r.adjacency_graph;
  if (!isObj(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    errors.push("adjacency_graph must have nodes[] and edges[]");
  } else {
    if (g.units !== "m2") errors.push('adjacency_graph.units must be "m2" (room areas in square metres)');
    const ids = new Set<string>();
    let bedroomNodes = 0;
    let inferredBedrooms = 0;
    let areaSum = 0;
    for (const [i, n] of (g.nodes as unknown[]).entries()) {
      if (!isObj(n) || !isNonEmptyString(n.id, 64) || !isNonEmptyString(n.type, 64)) {
        errors.push(`adjacency_graph.nodes[${i}] needs string id and type`);
        continue;
      }
      if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
      ids.add(n.id);
      if (BEDROOM_TYPES.has(n.type)) bedroomNodes++;
      if (n.inferred_use !== undefined) {
        if (n.type !== "room") errors.push(`node "${n.id}": inferred_use is only for type "room" (unlabelled rooms)`);
        else if (!INFERRED_USES.has(n.inferred_use as string)) {
          errors.push(`node "${n.id}": inferred_use must be one of ${[...INFERRED_USES].join(", ")}`);
        } else if (n.inferred_use === "bedroom") inferredBedrooms++;
      }
      if (n.windows !== undefined && !(Number.isInteger(n.windows) && (n.windows as number) >= 0)) {
        errors.push(`node "${n.id}": windows must be a non-negative integer`);
      }
      if (n.area !== undefined) {
        if (typeof n.area !== "number" || n.area <= 0) errors.push(`node "${n.id}" area must be a positive number`);
        else if (!n.exterior) areaSum += n.area;
      }
    }
    if (ids.size === 0) errors.push("adjacency_graph has no rooms");
    for (const [i, e] of (g.edges as unknown[]).entries()) {
      if (!isObj(e) || typeof e.from !== "string" || typeof e.to !== "string" || !isNonEmptyString(e.connection, 64)) {
        errors.push(`adjacency_graph.edges[${i}] needs from, to and connection`);
        continue;
      }
      if (!ids.has(e.from)) errors.push(`edge ${i} references unknown room "${e.from}"`);
      if (!ids.has(e.to)) errors.push(`edge ${i} references unknown room "${e.to}"`);
      if (e.from === e.to) errors.push(`edge ${i} connects "${e.from}" to itself`);
    }
    // Catches extraction mistakes (e.g. an AI tracer missing a room).
    // bedrooms = labelled bedroom nodes + rooms inferred as bedrooms, and the split is declared.
    if (Number.isInteger(r.bedrooms) && bedroomNodes + inferredBedrooms !== r.bedrooms) {
      errors.push(
        `bedrooms is ${r.bedrooms} but the graph has ${bedroomNodes} bedroom node(s)` +
          (inferredBedrooms ? ` + ${inferredBedrooms} room(s) inferred as bedrooms` : ""),
      );
    }
    if ((r.bedrooms_inferred ?? 0) !== inferredBedrooms) {
      errors.push(`bedrooms_inferred is ${r.bedrooms_inferred ?? 0} but ${inferredBedrooms} room(s) have inferred_use "bedroom"`);
    }
    if (areaSum > 0 && typeof r.total_area_m2 === "number") {
      const ratio = areaSum / r.total_area_m2;
      if (ratio < 0.7 || ratio > 1.15) {
        const sum = Math.round(areaSum * 100) / 100;
        warnings.push(`room areas sum to ${sum} m² vs total_area_m2 ${r.total_area_m2} (${Math.round(ratio * 100)}%)`);
      }
    }
  }

  // ---- provenance & rights ----
  const p = r.provenance as Partial<Provenance> | undefined;
  if (!isObj(p)) {
    errors.push("provenance is required (source, built, license)");
  } else {
    if (!SOURCES.includes(p.source as PlanSource)) errors.push(`provenance.source must be one of ${SOURCES.join(", ")}`);
    if (typeof p.built !== "boolean") errors.push("provenance.built must be true or false");
    const lic = COMMERCIAL_LICENSES[p.license as PlanLicense];
    if (!lic) {
      errors.push(
        `provenance.license "${String(p.license)}" does not allow resale; accepted: ${Object.keys(COMMERCIAL_LICENSES).join(", ")}`,
      );
    } else if (lic.attribution && !isNonEmptyString(p.attribution, 500)) {
      errors.push(`provenance.attribution is required for ${p.license}`);
    }
    if (p.author !== undefined && !isNonEmptyString(p.author)) errors.push("provenance.author must be a non-empty string");
    if (p.source_url !== undefined && !isHttpsUrl(p.source_url)) errors.push("provenance.source_url must be an https URL");

    // Source-specific rules.
    if ((p.source === "synthetic" || p.source === "ai_generated") && p.built) {
      errors.push(`a ${p.source} plan cannot be built: true`);
    }
    if (p.source === "habs") {
      if (p.built !== true) errors.push("HABS/HAER/HALS drawings document built structures; built must be true");
      if (p.license !== "public-domain") errors.push('habs records must use license "public-domain"');
      if (!isHttpsUrl(p.source_url)) errors.push("habs records need source_url (the loc.gov item)");
    }
    if (p.source === "commissioned") {
      if (p.license !== "owned") errors.push('commissioned records must use license "owned" (rights assigned in writing)');
      if (!isNonEmptyString(r.rights_ref)) errors.push("commissioned records need rights_ref (the signed agreement)");
      if (!isNonEmptyString(p.author)) errors.push("commissioned records need provenance.author");
    }
    if (p.source === "dataset" && !isHttpsUrl(p.source_url)) {
      errors.push("dataset records need source_url pointing at the dataset and its licence");
    }
  }

  return { errors, warnings };
}

/** The public record: strips internal-only fields such as rights_ref. */
export function toPublicPlan(record: FloorPlan & InternalRights): FloorPlan {
  const { rights_ref: _internal, ...pub } = record;
  return pub;
}
