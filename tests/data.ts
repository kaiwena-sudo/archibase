/** Deterministic synthetic plans and vectors, written to temporary files for file-store tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FloorPlan } from "../src/db/client.js";
import type { PlanVector } from "../src/db/vectors.js";

type PlanSpec = Pick<FloorPlan, "plan_id" | "style" | "total_area_m2" | "bedrooms">;

const specs: PlanSpec[] = [
  { plan_id: "ab-modern-2br-0001", style: "modern", total_area_m2: 109.63, bedrooms: 2 },
  { plan_id: "ab-industrial-loft-0002", style: "industrial", total_area_m2: 126.35, bedrooms: 2 },
  { plan_id: "ab-craftsman-3br-0003", style: "craftsman", total_area_m2: 178.37, bedrooms: 3 },
  { plan_id: "ab-modern-3br-0004", style: "modern", total_area_m2: 208.1, bedrooms: 3 },
  { plan_id: "ab-industrial-2br-0005", style: "industrial", total_area_m2: 134.71, bedrooms: 2 },
  { plan_id: "ab-farmhouse-4br-0006", style: "farmhouse", total_area_m2: 245, bedrooms: 4 },
];

function makePlan(spec: PlanSpec): FloorPlan {
  const nodes = [
    { id: "living", type: "living_room", area: spec.total_area_m2 - 17 - spec.bedrooms * 12 },
    { id: "kitchen", type: "kitchen", area: 10 },
    { id: "bath", type: "bathroom", area: 6 },
    { id: "hall", type: "hallway", area: 1 },
    ...Array.from({ length: spec.bedrooms }, (_, i) => ({ id: `bed${i + 1}`, type: "bedroom", area: 12 })),
  ];
  const edges = [
    { from: "living", to: "kitchen", connection: "door" },
    { from: "living", to: "bath", connection: "door" },
    { from: "living", to: "hall", connection: "opening" },
    ...Array.from({ length: spec.bedrooms }, (_, i) => ({ from: "hall", to: `bed${i + 1}`, connection: "door" })),
  ];
  return {
    ...spec,
    bathrooms: 1,
    adjacency_graph: { units: "m2", nodes, edges },
    provenance: { source: "synthetic", built: false, license: "CC0-1.0" },
  };
}

export const TEST_PLANS: FloorPlan[] = specs.map(makePlan);

export const TEST_VECTOR: PlanVector = {
  plan_id: "ab-modern-3br-0004",
  schema_version: 1,
  units: "m",
  crs: "site-local; +x east, +y north",
  attribution: "Synthetic test geometry",
  rooms: [
    { id: "living", type: "living_room", level: 1, polygon: [[[[0, 0], [10, 0], [10, 4.4594], [0, 4.4594], [0, 0]]]] },
    { id: "kitchen", type: "kitchen", level: 1, polygon: [[[[10, 0], [15, 0], [15, 4.4594], [10, 4.4594], [10, 0]]]] },
  ],
  doors: [{ type: "door", level: 1, polygon: [[[[9.9, 1], [10.1, 1], [10.1, 2], [9.9, 2], [9.9, 1]]]] }],
  windows: [],
};

const tempRoot = mkdtempSync(join(tmpdir(), "archibase-test-inputs-"));
export const TEST_PLAN_FILE = join(tempRoot, "plans.json");
export const TEST_VECTOR_DIR = join(tempRoot, "vectors");
mkdirSync(TEST_VECTOR_DIR);
writeFileSync(TEST_PLAN_FILE, JSON.stringify(TEST_PLANS));
writeFileSync(join(TEST_VECTOR_DIR, `${TEST_VECTOR.plan_id}.json`), JSON.stringify(TEST_VECTOR));
process.once("exit", () => rmSync(tempRoot, { recursive: true, force: true }));

const habs = makePlan({ plan_id: "habs-example-cottage-0001", style: "vernacular", total_area_m2: 91.04, bedrooms: 2 });
habs.provenance = { source: "habs", built: true, license: "public-domain", source_url: "https://www.loc.gov/item/example/" };

const commissioned = makePlan({ plan_id: "cm-student-courtyard-0001", style: "modern", total_area_m2: 125, bedrooms: 2 });
commissioned.provenance = { source: "commissioned", built: false, license: "owned", author: "Example Studio" };
(commissioned as FloorPlan & { rights_ref: string }).rights_ref = "AGREEMENT-EXAMPLE";

const rejected = {
  ...makePlan({ plan_id: "bad-scraped-0001", style: "modern", total_area_m2: 82, bedrooms: 1 }),
  provenance: {
    source: "dataset",
    built: false,
    license: "CC-BY-NC-4.0",
    source_url: "https://example.org/dataset",
  },
};

export const TEST_INCOMING: unknown[] = [habs, commissioned, rejected];
