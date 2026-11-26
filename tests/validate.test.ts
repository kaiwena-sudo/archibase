import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePlan } from "../src/db/validate.js";
import { JsonPlanStore } from "../src/db/client.js";
import { checkRecords, writeToJsonFile } from "../scripts/seed.js";
import { TEST_INCOMING, TEST_PLANS } from "./data.js";

const base = () => structuredClone(TEST_PLANS[0]) as any;
const errorsOf = (rec: unknown) => validatePlan(rec).errors.join(" | ");

describe("validatePlan", () => {
  it("accepts every bundled sample record", () => {
    for (const rec of TEST_PLANS) expect(validatePlan(rec).errors, (rec as any).plan_id).toEqual([]);
  });

  it("requires provenance", () => {
    const r = base();
    delete r.provenance;
    expect(errorsOf(r)).toMatch(/provenance is required/);
  });

  it.each(["CC-BY-NC-4.0", "all-rights-reserved", "CC-BY-SA-4.0", undefined])("rejects licence %s", (license) => {
    const r = base();
    r.provenance.license = license;
    expect(errorsOf(r)).toMatch(/does not allow resale/);
  });

  it("requires attribution for CC-BY", () => {
    const r = base();
    r.provenance = { source: "dataset", built: false, license: "CC-BY-4.0", source_url: "https://example.org/ds" };
    expect(errorsOf(r)).toMatch(/attribution is required/);
    r.provenance.attribution = "Plans © Example Lab, CC BY 4.0";
    expect(validatePlan(r).errors).toEqual([]);
  });

  it("forbids built: true for synthetic and AI-generated plans", () => {
    for (const source of ["synthetic", "ai_generated"]) {
      const r = base();
      r.provenance = { source, built: true, license: "owned" };
      expect(errorsOf(r)).toMatch(/cannot be built: true/);
    }
  });

  it("requires a signed-agreement reference and author for commissioned work", () => {
    const r = base();
    r.provenance = { source: "commissioned", built: false, license: "owned" };
    expect(errorsOf(r)).toMatch(/rights_ref/);
    expect(errorsOf(r)).toMatch(/author/);
  });

  it("requires HABS records to be built, public domain, with a loc.gov link", () => {
    const r = base();
    r.provenance = { source: "habs", built: false, license: "CC0-1.0" };
    const e = errorsOf(r);
    expect(e).toMatch(/built must be true/);
    expect(e).toMatch(/public-domain/);
    expect(e).toMatch(/source_url/);
  });

  it("catches graph errors: dangling edges, self-loops, duplicate ids, bedroom mismatch", () => {
    const r = base();
    r.adjacency_graph.edges.push({ from: "living", to: "ghost", connection: "door" });
    r.adjacency_graph.edges.push({ from: "hall", to: "hall", connection: "door" });
    r.adjacency_graph.nodes.push({ id: "bed2", type: "bedroom" });
    const e = errorsOf(r);
    expect(e).toMatch(/unknown room "ghost"/);
    expect(e).toMatch(/to itself/);
    expect(e).toMatch(/duplicate node id "bed2"/);
    expect(e).toMatch(/bedrooms is 2 but the graph has 3/);
  });

  it("rejects imperial or unit-less records", () => {
    const r = base();
    r.total_sqft = 1000;
    r.adjacency_graph.units = "sqft";
    const e = errorsOf(r);
    expect(e).toMatch(/total_sqft is not stored/);
    expect(e).toMatch(/units must be "m2"/);
  });

  it("warns (not errors) when room areas don't add up to total_area_m2", () => {
    const r = base();
    r.total_area_m2 = 500;
    const { errors, warnings } = validatePlan(r);
    expect(errors).toEqual([]);
    expect(warnings[0]).toMatch(/room areas sum/);
  });
});

describe("seed", () => {
  it("accepts records with allowed rights and rejects a non-commercial licence", () => {
    const report = checkRecords(TEST_INCOMING);
    expect(report.accepted.map((r) => r.plan_id)).toEqual(["habs-example-cottage-0001", "cm-student-courtyard-0001"]);
    expect(report.rejected.map((r) => r.plan_id)).toEqual(["bad-scraped-0001"]);
  });

  it("flags duplicate plan_ids within a batch", () => {
    const report = checkRecords([TEST_PLANS[0]!, TEST_PLANS[0]!]);
    expect(report.rejected[0]!.errors).toContain("duplicate plan_id in this batch");
  });

  it("merges into the JSON store and keeps rights_ref out of the served file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archibase-seed-"));
    const path = join(dir, "plans.json");
    await writeFile(path, JSON.stringify(TEST_PLANS));

    const { accepted } = checkRecords(TEST_INCOMING.slice(0, 2));
    expect(await writeToJsonFile(path, accepted)).toEqual({ added: 2, updated: 0 });
    expect(await writeToJsonFile(path, accepted)).toEqual({ added: 0, updated: 2 });

    const served = await readFile(path, "utf8");
    expect(JSON.parse(served)).toHaveLength(TEST_PLANS.length + 2);
    expect(served).not.toContain("rights_ref");
    expect(JSON.parse(await readFile(join(dir, "rights.json"), "utf8"))).toEqual({
      "cm-student-courtyard-0001": "AGREEMENT-EXAMPLE",
    });

    const store = new JsonPlanStore(path);
    expect((await store.searchPlans({ built: true })).map((p) => p.plan_id)).toEqual(["habs-example-cottage-0001"]);
    expect((await store.searchPlans({ source: "commissioned" })).map((p) => p.plan_id)).toEqual(["cm-student-courtyard-0001"]);
  });

  it("strips rights_ref even if one ends up in the served JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archibase-leak-"));
    const path = join(dir, "plans.json");
    await writeFile(path, JSON.stringify([{ ...TEST_PLANS[0], rights_ref: "AGREEMENT-TEST" }]));
    const [plan] = await new JsonPlanStore(path).searchPlans({});
    expect(plan).not.toHaveProperty("rights_ref");
  });
});

const hasCorpus = existsSync("data/plans.json");

describe.skipIf(!hasCorpus)("live data file", () => {
  it("every record in data/plans.json passes validation", async () => {
    const live = JSON.parse(await readFile("data/plans.json", "utf8")) as unknown[];
    const report = checkRecords(live);
    expect(report.rejected).toEqual([]);
  });
});

describe.skipIf(!hasCorpus)("live geometry files", () => {
  it("every vector file's rooms match its record's graph nodes (ids and types)", async () => {
    const { readdir } = await import("node:fs/promises");
    const live = new Map((JSON.parse(await readFile("data/plans.json", "utf8")) as any[]).map((p) => [p.plan_id, p]));
    const files = (await readdir("data/vectors")).filter((f) => f.endsWith(".json") && f !== "index.json");
    const index = JSON.parse(await readFile("data/vectors/index.json", "utf8")) as string[];
    expect(index.sort()).toEqual(files.map((f) => f.slice(0, -5)).sort());
    for (const f of files) {
      const v = JSON.parse(await readFile(`data/vectors/${f}`, "utf8"));
      const plan = live.get(v.plan_id);
      expect(plan, v.plan_id).toBeDefined();
      const nodes = new Map((plan.adjacency_graph.nodes as any[]).filter((n) => n.id !== "building_access").map((n) => [n.id, n.type]));
      expect(new Map(v.rooms.map((r: any) => [r.id, r.type])), v.plan_id).toEqual(nodes);
    }
  });
});

describe("Hong Kong CSDI licence and building types", () => {
  it("accepts HK-CSDI-TOU only with attribution, and checks building_type", async () => {
    const { validatePlan } = await import("../src/db/validate.js");
    const base = {
      plan_id: "hk-test-0", style: "unspecified", building_type: "transport", total_area_m2: 50, bedrooms: 0, bathrooms: 0,
      adjacency_graph: { units: "m2", nodes: [{ id: "corridor_1", type: "corridor", area: 50 }], edges: [] },
      provenance: { source: "dataset", built: true, license: "HK-CSDI-TOU", source_url: "https://portal.csdi.gov.hk/x", attribution: "Lands Department" },
    };
    expect(validatePlan(base).errors).toEqual([]);
    expect(validatePlan({ ...base, provenance: { ...base.provenance, attribution: undefined } }).errors.join()).toMatch(/attribution is required/);
    expect(validatePlan({ ...base, building_type: "castle" }).errors.join()).toMatch(/building_type must be one of/);
  });
});
