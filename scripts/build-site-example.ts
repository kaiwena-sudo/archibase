/**
 * Generate src/site/example.ts: SVG drawings of real plans plus a trimmed search record of the
 * first one, for the landing page. Re-run when the examples should change:
 *
 *   npx tsx scripts/build-site-example.ts <vector.json>:<plans.json>:<caption> [...more]
 *
 * The first plan is the featured example (drawing + JSON); all of them form the gallery.
 * Drawings are rotated to the plan's dominant wall direction (Swiss plans are stored at their
 * real-world orientation) and show one level (the one with the most rooms).
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { FloorPlan } from "../src/db/client.js";
import type { PlanVector } from "../src/db/vectors.js";

type Pt = [number, number];
type Poly = Pt[][];

const specs = process.argv.slice(2).map((s) => {
  const [vector, plans, ...caption] = s.split(":");
  if (!vector || !plans) throw new Error("usage: build-site-example.ts <vector.json>:<plans.json>:<caption> [...]");
  return { vector, plans, caption: caption.join(":") };
});
if (!specs.length) throw new Error("usage: build-site-example.ts <vector.json>:<plans.json>:<caption> [...]");

/** Room types to the page's colour classes. */
function colourClass(type: string): string {
  if (type === "bedroom" || type === "room") return "bedroom";
  // Non-residential spaces reuse the same palette: tenancies blue, circulation lilac, toilets green, cores grey.
  if (/^(unit|office|space|classroom|retail|food_service|meeting_room)$/.test(type)) return "bedroom";
  if (/^(corridor|lobby|platform|concourse)$/.test(type)) return "living";
  if (type === "restroom") return "bathroom";
  if (/^(stairs|elevator|escalator|steps|ramp|non_public|void)$/.test(type)) return "balcony";
  if (type === "bathroom" || type === "toilet") return "bathroom";
  if (type === "kitchen") return "kitchen";
  if (/living|dining|lounge|parlor|parlour/.test(type)) return "living";
  if (/balcony|loggia|terrace|porch|veranda|garden/.test(type)) return "balcony";
  return "other";
}

/** Angle (radians) of the dominant wall direction, folded into [0, 90°), weighted by edge length. */
function dominantAngle(polys: Poly[]): number {
  const bins = new Map<number, number>();
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i]!, [x1, y1] = ring[i + 1]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      let a = Math.atan2(y1 - y0, x1 - x0) % (Math.PI / 2);
      if (a < 0) a += Math.PI / 2;
      const bin = Math.round((a * 180) / Math.PI) % 90;
      bins.set(bin, (bins.get(bin) ?? 0) + len);
    }
  }
  const best = [...bins.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
  return (best * Math.PI) / 180;
}

function centroid(ring: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]!, [x1, y1] = ring[i + 1]!;
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  return Math.abs(a) < 1e-9 ? ring[0]! : [cx / (3 * a), cy / (3 * a)];
}

function draw(v: PlanVector, plan: FloorPlan): string {
  const levels = new Map<number, number>();
  for (const r of v.rooms) levels.set(r.level, (levels.get(r.level) ?? 0) + 1);
  const level = [...levels.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const rooms = v.rooms.filter((r) => r.level === level);
  const doors = v.doors.filter((d) => d.level === level);
  const windows = v.windows.filter((w) => w.level === level);

  const theta = -dominantAngle(rooms.flatMap((r) => r.polygon as unknown as Poly[]));
  const rot = ([x, y]: Pt): Pt => [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)];
  const tf = (polys: Poly[]): Poly[] => polys.map((poly) => poly.map((ring) => ring.map(rot)));

  const R = rooms.map((r) => ({ ...r, polys: tf(r.polygon as unknown as Poly[]) }));
  const D = doors.map((d) => ({ ...d, polys: tf(d.polygon as unknown as Poly[]) }));
  const Wn = windows.map((w) => ({ ...w, polys: tf(w.polygon as unknown as Poly[]) }));
  const pts = R.flatMap((r) => r.polys.flat(2)).concat(Wn.flatMap((w) => w.polys.flat(2)));
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));

  const k = 40, pad = 24; // 40 px per metre
  const W = Math.max((maxX - minX) * k + pad * 2, pad + 5 * k + 48);
  const H = (maxY - minY) * k + pad * 2 + 28;
  const P = (p: Pt) => `${(pad + (p[0] - minX) * k).toFixed(1)} ${(pad + (maxY - p[1]) * k).toFixed(1)}`;
  const path = (polys: Poly[]) => polys.map((poly) => poly.map((ring) => "M" + ring.map(P).join("L") + "Z").join("")).join("");
  const nodes = new Map(plan.adjacency_graph.nodes.map((n) => [n.id, n]));
  const label = (t: string) => t.replace(/_/g, " ");

  let svg = "";
  for (const r of R) svg += `<path class="room r-${colourClass(r.type)}" d="${path(r.polys)}"/>`;
  for (const d of D) svg += `<path class="${d.type === "entrance_door" ? "entrance" : "door"}" d="${path(d.polys)}"/>`;
  for (const w of Wn) svg += `<path class="window" d="${path(w.polys)}"/>`;
  for (const r of R) {
    const n = nodes.get(r.id);
    const biggest = r.polys.slice().sort((a, b) => Math.abs(area(b[0]!)) - Math.abs(area(a[0]!)))[0]!;
    if (Math.abs(area(biggest[0]!)) < 4) continue; // too small to label legibly
    const [x, y] = P(centroid(biggest[0]!)).split(" ").map(Number) as Pt;
    svg += `<text x="${x}" y="${y - 2}" class="lbl">${label(r.type)}</text>`;
    if (n?.area) svg += `<text x="${x}" y="${y + 12}" class="area">${n.area} m²</text>`;
  }
  const barY = H - 14;
  svg += `<path class="scale" d="M${pad} ${barY}h${5 * k}"/><text x="${pad + 5 * k + 6}" y="${barY + 4}" class="area" style="text-anchor:start">5 m</text>`;
  return `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Floor plan ${plan.plan_id}: ${plan.bedrooms} bedrooms, ${plan.total_area_m2} m²">${svg}</svg>`;
}

function area(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return a / 2;
}

function trimmedRecord(plan: FloorPlan): string {
  const record = {
    plan_id: plan.plan_id,
    total_area_m2: plan.total_area_m2,
    bedrooms: plan.bedrooms,
    bathrooms: plan.bathrooms,
    layout_copies: 1,
    adjacency_graph: {
      nodes: plan.adjacency_graph.nodes.slice(0, 4).map(({ id, type, area, windows }) => ({ id, type, area, windows })),
      edges: plan.adjacency_graph.edges.slice(0, 4),
    },
    provenance: { source: plan.provenance.source, built: plan.provenance.built, license: plan.provenance.license },
  };
  return JSON.stringify(record, null, 2)
    .replace(/\{\n\s+"id": ("[^"]+"),\n\s+"type": ("[^"]+"),\n\s+"area": ([\d.]+),\n\s+"windows": (\d+)\n\s+\}/g, '{ "id": $1, "type": $2, "area": $3, "windows": $4 }')
    .replace(/\{\n\s+"from": ("[^"]+"),\n\s+"to": ("[^"]+"),\n\s+"connection": ("[^"]+")\n\s+\}/g, '{ "from": $1, "to": $2, "connection": $3 }')
    .replace(/("nodes": \[[\s\S]*?)\n(\s+)\]/, `$1,\n$2  …\n$2]`)
    .replace(/("edges": \[[\s\S]*?)\n(\s+)\]/, `$1,\n$2  …\n$2]`);
}

const gallery = specs.map(({ vector, plans, caption }) => {
  const v = JSON.parse(readFileSync(vector, "utf8")) as PlanVector;
  const plan = (JSON.parse(readFileSync(plans, "utf8")) as FloorPlan[]).find((p) => p.plan_id === v.plan_id);
  if (!plan) throw new Error(`${v.plan_id} not found in ${plans}`);
  return { plan, svg: draw(v, plan), caption };
});

/** "3 bed · 2 bath · 116.47 m²"; plans without labelled bedrooms (historic surveys) count rooms instead. */
function summarise(plan: FloorPlan): string {
  const parts: string[] = [];
  if (plan.building_type && plan.building_type !== "residential") {
    const spaces = plan.adjacency_graph.nodes.filter((n) => !n.exterior && n.type !== "outside").length;
    return `${plan.building_type} · ${spaces} spaces · ${plan.total_area_m2} m²`;
  }
  if (plan.bedrooms > 0) parts.push(`${plan.bedrooms} bed`);
  else {
    const rooms = plan.adjacency_graph.nodes.filter((n) => !n.exterior && n.area && !/hall|corridor|stair|circulation|porch|storage/.test(n.type)).length;
    parts.push(`${rooms} rooms`);
  }
  if (plan.bathrooms > 0) parts.push(`${plan.bathrooms} bath`);
  parts.push(`${plan.total_area_m2} m²`);
  return parts.join(" · ");
}

const first = gallery[0]!;
writeFileSync(
  new URL("../src/site/example.ts", import.meta.url),
  `// Generated by scripts/build-site-example.ts. Do not edit by hand.\n` +
    `export const EXAMPLE_PLAN_ID = ${JSON.stringify(first.plan.plan_id)};\n` +
    `export const EXAMPLE_SVG = ${JSON.stringify(first.svg)};\n` +
    `export const EXAMPLE_JSON = ${JSON.stringify(trimmedRecord(first.plan))};\n` +
    `export const GALLERY: { plan_id: string; caption: string; summary: string; svg: string }[] = ${JSON.stringify(
      gallery.map((g) => ({
        plan_id: g.plan.plan_id,
        caption: g.caption,
        summary: summarise(g.plan),
        svg: g.svg,
      })),
      null,
      1,
    )};\n`,
);
console.log(`wrote src/site/example.ts: ${gallery.map((g) => g.plan.plan_id).join(", ")}`);
