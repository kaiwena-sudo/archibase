import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, COMMERCIAL_LICENSES, SOURCES, validatePlan } from "../src/db/validate.js";
import { makeApp } from "./helpers.js";

const SKILL = "skills/archibase-plan-converter";
const SCRIPT = `${SKILL}/scripts/archibase.mjs`;
const TRACE = JSON.parse(readFileSync(`${SKILL}/examples/two-bed.trace.json`, "utf8"));
const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "skill-"));
const write = (dir: string, name: string, v: unknown) => (writeFileSync(join(dir, name), JSON.stringify(v)), join(dir, name));

describe("archibase-plan-converter skill", () => {
  it("builds the worked example into a record the server's own validator accepts", () => {
    const dir = tmp();
    const r = run("build", `${SKILL}/examples/two-bed.trace.json`, "--out", dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("55.56 m², 2 bed, 1 bath, 7 nodes, 6 edges, 6 windows, 5 doors");
    const record = JSON.parse(readFileSync(join(dir, "example-two-bed-0001.record.json"), "utf8"));
    expect(validatePlan(record).errors).toEqual([]);
    expect(record).toMatchObject({ total_area_m2: 55.56, bedrooms: 2, bathrooms: 1 });
    const edges = record.adjacency_graph.edges.map((e: any) => `${e.from}-${e.connection}-${e.to}`).sort();
    expect(edges).toEqual([
      "hallway_1-door-bathroom_1", "hallway_1-door-bedroom_1", "hallway_1-door-bedroom_2", "living_1-door-hallway_1", "living_1-opening-kitchen_1", "outside-entrance_door-hallway_1",
    ].sort());
    const windows = Object.fromEntries(record.adjacency_graph.nodes.map((n: any) => [n.id, n.windows]));
    expect(windows).toMatchObject({ living_1: 2, kitchen_1: 1, bedroom_1: 1, bathroom_1: 1, bedroom_2: 1, hallway_1: 0 });
    // the geometry file validates against the record too
    expect(run("validate", join(dir, "example-two-bed-0001.record.json"), join(dir, "example-two-bed-0001.vector.json")).status).toBe(0);
  });

  it("shares its vocabulary and licence rules with the server (no drift)", async () => {
    const lib: any = await import(pathToFileURL(`${process.cwd()}/${SCRIPT}`).href);
    expect(lib.BUILDING_TYPES).toEqual([...BUILDING_TYPES]);
    expect(lib.SOURCES).toEqual([...SOURCES]);
    // the skill offers the licences a contributor can use: the server's list minus the Hong Kong government terms
    expect(Object.keys(lib.LICENSES).sort()).toEqual(Object.keys(COMMERCIAL_LICENSES).filter((l) => l !== "HK-CSDI-TOU").sort());
    for (const [name, rule] of Object.entries(COMMERCIAL_LICENSES)) if (name in lib.LICENSES) expect(lib.LICENSES[name]).toBe(rule.attribution);
  });

  it("refuses a record the server would refuse, with the same reasons", async () => {
    const lib: any = await import(pathToFileURL(`${process.cwd()}/${SCRIPT}`).href);
    const dir = tmp();
    run("build", `${SKILL}/examples/two-bed.trace.json`, "--out", dir);
    const good = JSON.parse(readFileSync(join(dir, "example-two-bed-0001.record.json"), "utf8"));
    const bad = [
      { ...good, bedrooms: 3 },
      { ...good, bathrooms: 1.3 },
      { ...good, plan_id: "No Spaces" },
      { ...good, total_sqft: 600 },
      { ...good, provenance: { ...good.provenance, license: "CC-BY-NC-4.0" } },
      { ...good, provenance: { source: "habs", built: true, license: "CC0-1.0", source_url: "https://loc.gov/x" } },
      { ...good, provenance: { source: "commissioned", built: true, license: "owned", author: "A" } },
      { ...good, provenance: { source: "dataset", built: true, license: "CC-BY-4.0" } },
      { ...good, adjacency_graph: { ...good.adjacency_graph, edges: [{ from: "living_1", to: "ghost", connection: "door" }] } },
    ];
    for (const b of bad) {
      const mine = lib.validateRecord(b).errors.length;
      const theirs = validatePlan(b).errors.length;
      expect(mine > 0, JSON.stringify(b).slice(0, 80)).toBe(true);
      expect(theirs > 0).toBe(true);
    }
    expect(lib.validateRecord(good).errors).toEqual([]);
  });

  it("catches the mistakes agents actually make", () => {
    const dir = tmp();
    const scaled = (k: number) => ({ ...TRACE, rooms: TRACE.rooms.map((r: any) => ({ ...r, polygon: r.polygon.map(([x, y]: number[]) => [x * k, y * k]) })) });
    // everything drawn at 40% size (a wrong scale): doors look 2.5x too wide... rooms look too small
    const small = run("build", write(dir, "small.json", { ...scaled(0.4), doors: TRACE.doors.map((d: any) => ({ ...d, from: d.from.map((v: number) => v * 0.4), to: d.to.map((v: number) => v * 0.4) })) }), "--out", dir);
    expect(small.stderr).toMatch(/median door width|implausible|sliver/);

    // outer-wall faces traced instead of inside faces: rooms overlap
    const grow = (poly: number[][]) => { const xs = poly.map((p) => p[0]!), ys = poly.map((p) => p[1]!); const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; return poly.map(([x, y]) => [x === x0 ? x! - 0.4 : x === x1 ? x! + 0.4 : x, y === y0 ? y! - 0.4 : y === y1 ? y! + 0.4 : y]); };
    const fat = { ...TRACE, rooms: TRACE.rooms.map((r: any) => ({ ...r, polygon: grow(r.polygon) })) };
    expect(run("build", write(dir, "fat.json", fat), "--out", dir).stderr).toMatch(/overlap/);

    // a door drawn in the middle of nowhere
    const lost = { ...TRACE, doors: [...TRACE.doors, { from: [20, 20], to: [20.8, 20] }] };
    const r = run("build", write(dir, "lost.json", lost), "--out", dir);
    expect(r.stderr).toMatch(/found 0 room within 0\.35 m/);
    expect(r.status).toBe(0); // a warning, not an error: the plan itself is fine

    // unsellable licence and missing provenance fail the build
    const nc = { ...TRACE, provenance: { ...TRACE.provenance, license: "CC-BY-NC-4.0" } };
    expect(run("build", write(dir, "nc.json", nc), "--out", dir).status).toBe(1);
    const { provenance: _p, ...noProv } = TRACE;
    expect(run("build", write(dir, "noprov.json", noProv), "--out", dir).status).toBe(1);

    // duplicate ids and a crossing outline
    const dup = { ...TRACE, rooms: [...TRACE.rooms, TRACE.rooms[0]] };
    expect(run("build", write(dir, "dup.json", dup), "--out", dir).stderr).toMatch(/duplicate id/);
    const bow = { ...TRACE, rooms: [{ id: "bow_1", type: "room", polygon: [[0, 0], [4, 4], [4, 0], [0, 4]] }], doors: [], windows: [] };
    expect(run("build", write(dir, "bow.json", bow), "--out", dir).stderr).toMatch(/crosses itself/);
  });

  it("handles two levels with stairs, and a basement-free duplex stays valid", () => {
    const dir = tmp();
    const two = {
      plan_id: "stair-test-0001", provenance: TRACE.provenance,
      rooms: [
        { id: "hall_1", type: "hallway", level: 1, polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] },
        { id: "stairs_1", type: "stairs", level: 1, polygon: [[3.2, 0], [4.2, 0], [4.2, 4], [3.2, 4]] },
        { id: "bedroom_1", type: "bedroom", level: 2, polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] },
        { id: "stairwell_2", type: "stairs", level: 2, stairwell: true, polygon: [[3.2, 0], [4.2, 0], [4.2, 4], [3.2, 4]] },
      ],
      doors: [{ from: [3.05, 1], to: [3.15, 1] }],
      stairs: [{ room: "stairs_1", arrival_room: "stairwell_2", risers: 14, start: [3.7, 0.2], end: [3.7, 3.8], run: 3.6, rise: 2.7 }],
    };
    const r = run("build", write(dir, "two.json", two), "--out", dir);
    const record = JSON.parse(readFileSync(join(dir, "stair-test-0001.record.json"), "utf8"));
    const vector = JSON.parse(readFileSync(join(dir, "stair-test-0001.vector.json"), "utf8"));
    expect(r.status, r.stderr).toBe(0);
    expect(record.adjacency_graph.edges).toContainEqual({ from: "stairs_1", to: "stairwell_2", connection: "stair" });
    expect(record.total_area_m2).toBe(12 + 4 + 12); // hall + stairs + bedroom; the stairwell opening has no area
    expect(vector.stairs).toHaveLength(2);
    expect(vector.stairs[0]).toMatchObject({ level: 1, to_level: 2, risers: 14 });
    expect(vector.stairs[1]).toMatchObject({ level: 2, from_level: 1 });
    expect(validatePlan(record).errors).toEqual([]);
  });

  it("renders SVG and a text picture", () => {
    const dir = tmp();
    run("build", `${SKILL}/examples/two-bed.trace.json`, "--out", dir);
    const vec = join(dir, "example-two-bed-0001.vector.json");
    const svg = join(dir, "out.svg");
    expect(run("render", vec, "--record", join(dir, "example-two-bed-0001.record.json"), "--out", svg).status).toBe(0);
    const text = readFileSync(svg, "utf8");
    expect(text).toMatch(/^<svg /);
    expect(text).toContain("living_1");
    expect(text).toContain("18.72 m²");
    const ascii = run("render", vec, "--ascii").stdout;
    expect(ascii).toContain("L = living_1");
    expect(ascii).toMatch(/@/); // entrance
    expect(run("render", vec, "--level", "7", "--ascii").status).not.toBe(0); // no such level
  });

  it("is a complete skill: frontmatter, the files it points at, and no dependencies", () => {
    const md = readFileSync(`${SKILL}/SKILL.md`, "utf8");
    expect(md).toMatch(/^---\r?\nname: archibase-plan-converter\r?\ndescription: .{40,}\r?\n---/);
    for (const f of md.matchAll(/`((?:scripts|references|examples)\/[\w./-]+)`/g)) expect(() => statSync(`${SKILL}/${f[1]}`), f[1]).not.toThrow();
    expect(readFileSync(`${SKILL}/scripts/archibase.mjs`, "utf8")).not.toMatch(/from "(?!node:)[^"]+"/);
  });
});

describe("serving the skill", () => {
  const app = makeApp();

  it("serves the bundle exactly as it is on disk (run `npm run build:skill` after editing skills/)", async () => {
    const { SKILLS } = await import("../src/site/skill-bundle.js");
    const dir = `${process.cwd()}/skills/archibase-plan-converter`;
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const onDisk = Object.fromEntries(walk(dir).map((f) => [relative(dir, f).split(sep).join("/"), readFileSync(f, "utf8").replace(/\r\n?/g, "\n")]));
    expect(SKILLS["archibase-plan-converter"]!.files).toEqual(onDisk);
  });

  it("lists the skill and serves its files and zip with the right types", async () => {
    const index = await (await app.request("/skills/index.json")).json();
    expect(index.skills[0]).toMatchObject({ name: "archibase-plan-converter", zip: "http://test.local/skills/archibase-plan-converter.zip" });
    const md = await app.request("/skills/archibase-plan-converter/SKILL.md");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("name: archibase-plan-converter");
    expect((await app.request("/skills/archibase-plan-converter/scripts/archibase.mjs")).headers.get("content-type")).toContain("text/javascript");
    const zip = await app.request("/skills/archibase-plan-converter.zip");
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toContain("archibase-plan-converter.zip");
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");
  });

  it("the zip unpacks to a working skill folder", () => {
    const dir = tmp();
    const python = process.platform === "win32" ? "python" : "python3";
    const code = `import base64,sys,zipfile,io\nfrom pathlib import Path\nimport json\nsrc=open(sys.argv[1]).read().split('"zip":"')[1].split('"')[0]\nzipfile.ZipFile(io.BytesIO(base64.b64decode(src))).extractall(sys.argv[2])`;
    const r = spawnSync(python, ["-I", "-c", code, "src/site/skill-bundle.ts", dir], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const built = spawnSync("node", [join(dir, "archibase-plan-converter/scripts/archibase.mjs"), "build", join(dir, "archibase-plan-converter/examples/two-bed.trace.json"), "--out", join(dir, "out")], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toContain("55.56");
  });

  it("refuses paths outside the bundle", async () => {
    for (const p of ["/skills/archibase-plan-converter/../../package.json", "/skills/archibase-plan-converter/%2e%2e/index.ts", "/skills/nope.zip", "/skills/archibase-plan-converter/nope.md", "/skills/__proto__/SKILL.md", "/skills/constructor.zip"]) {
      expect((await app.request(p)).status, p).toBe(404);
    }
  });

  it("serves a square SVG logo for directory listings", async () => {
    const r = await app.request("/logo.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(await r.text()).toContain('viewBox="0 0 512 512"');
  });

  it("has a page and is linked from the footer, docs and llms.txt", async () => {
    const page = await (await app.request("/skills")).text();
    expect(page).toContain("Download .zip");
    expect(page).toContain("~/.claude/skills");
    expect(await (await app.request("/docs")).text()).toContain('href="/skills"');
    expect(await (await app.request("/llms.txt")).text()).toContain("/skills/archibase-plan-converter.zip");
    expect(await (await app.request("/", { headers: { accept: "text/html" } })).text()).toContain('href="/skills"');
  });
});
