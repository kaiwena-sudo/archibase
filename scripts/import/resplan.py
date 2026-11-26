"""
Convert ResPlan (Abouagour & Garyfallidis, CC BY 4.0, https://zenodo.org/records/20061236)
into Archibase plan records and vector files.

    python3 -m venv .venv-resplan && .venv-resplan/bin/pip install shapely networkx numpy
    .venv-resplan/bin/python -I scripts/import/resplan.py <ResPlan.pkl> <out-dir> [--limit N]

Writes <out-dir>/plans-0001.json ... (5,000 records each) and <out-dir>/vectors/<plan_id>.json,
the same layout as the Swiss importer, for `npm run supabase:load`.

Safety: ResPlan ships as a pickle, and unpickling can run arbitrary code. SafeUnpickler only
allows the Shapely/NetworkX/NumPy classes the file is known to contain (found with pickletools,
without loading it) and refuses anything else.

Scale: ResPlan coordinates are normalised to a ~256-unit image grid, not metres, and the stated
net_area is missing on ~5,400 plans and unreliable on others. The listing's gross area is
reliable, so each plan's scale is s = sqrt(gross / (inner + walls + balconies)) in m per unit.
That gives a median wall thickness of 0.21 m and door width of 0.91 m (realistic for 9-inch
brick construction), so lengths are good to roughly ±2%.

Plans failing plausibility checks (wall 0.08-0.5 m, net 15-1,000 m², bedrooms 4-60 m², rooms
covering 70-115% of the net area) are skipped, slivers under 0.1 m² are dropped, as are IDs in resplan-takedowns.json (the authors run a takedown process; we honour it).
"""
import json
import math
import os
import pickle
import sys
from collections import Counter

ALLOWED = {
    ("shapely.io", "from_wkb"),
    ("numpy._core.multiarray", "scalar"), ("numpy.core.multiarray", "scalar"), ("numpy", "dtype"),
    ("networkx.classes.graph", "Graph"),
    ("networkx.classes.reportviews", "NodeView"), ("networkx.classes.reportviews", "EdgeView"),
    ("networkx.classes.coreviews", "AdjacencyView"),
}


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) not in ALLOWED:
            raise pickle.UnpicklingError(f"blocked {module}.{name}")
        return super().find_class(module, name)


SOURCE_URL = "https://zenodo.org/records/20061236"
ATTRIBUTION = (
    "ResPlan by M. Abouagour and E. Garyfallidis (Indiana University), CC BY 4.0, "
    f"{SOURCE_URL}. Modified: converted by Archibase (metric scale recovered from the listed "
    "gross area, room graph relabelled, open adjacencies detected from geometry)."
)
DERIVATION = (
    "Derived from ResPlan: room polygons and typed graph edges from the dataset; via_door -> door, "
    "direct -> opening, via_window -> window, front door -> entrance_door. Source adjacencies become "
    "opening where the outlines touch with no wall between (>= 0.6 m), and are otherwise dropped, "
    "except for rooms with no other link, where they are kept as adjacent (touching; no door or "
    "opening recorded). Scale recovered per plan from the listed gross area (about "
    "±2% in length). Bathrooms are not split into full baths and toilets in the source. Region: "
    "South Asian residential listings."
)
CRS = "plan-local metres; +x right, +y up as drawn (compass orientation unknown); scale from listed gross area, about ±2%"

EDGE_MAP = {"via_door": "door", "direct": "opening", "via_window": "window"}
LEVEL = 1
CHUNK = 5000

# plausibility bounds
WALL_M = (0.08, 0.5)
NET_M2 = (15, 1000)
BEDROOM_M2 = (4, 60)
ROOM_COVERAGE = (0.7, 1.15)  # interior room areas / net area; same band as src/db/validate.ts
SLIVER_M2 = 0.1
OPEN_SHARED_M = 0.6  # rooms touching (no wall between) along at least this much = an opening  # polygons smaller than this are digitising debris, not rooms


def geoms(g):
    if g is None or g.is_empty:
        return []
    return list(getattr(g, "geoms", [g]))


def area_of(g):
    return 0.0 if g is None or g.is_empty else g.area


def scale_for(d):
    footprint = area_of(d["inner"]) + area_of(d["wall"]) + area_of(d.get("balcony"))
    gross = d.get("area")
    if not gross or footprint <= 0:
        return None
    return math.sqrt(float(gross) / footprint)


class Frame:
    """Unit coords -> metres, y flipped so +y is up, origin at the plan's bottom-left."""

    def __init__(self, d, s):
        xs, ys = [], []
        for key in ("inner", "wall", "balcony", "door", "window", "front_door"):
            for g in geoms(d.get(key)):
                minx, miny, maxx, maxy = g.bounds
                xs += [minx, maxx]
                ys += [miny, maxy]
        self.minx, self.maxy, self.s = min(xs), max(ys), s

    def pt(self, x, y):
        return [round((x - self.minx) * self.s, 3), round((self.maxy - y) * self.s, 3)]

    def ring(self, coords):
        return [self.pt(x, y) for x, y in coords]

    def polys(self, g):
        return [[self.ring(p.exterior.coords)] + [self.ring(h.coords) for h in p.interiors] for p in geoms(g)]


def convert(d, takedowns):
    pid = f"rp-{d['id']}"
    if d["id"] in takedowns:
        return None, "takedown"
    s = scale_for(d)
    if s is None:
        return None, "no_scale"
    wall_m = d["wall_depth"] * s
    net = area_of(d["inner"]) * s * s
    if not (WALL_M[0] <= wall_m <= WALL_M[1]):
        return None, "wall_thickness"
    if not (NET_M2[0] <= net <= NET_M2[1]):
        return None, "net_area"

    g = d["graph"]
    frame = Frame(d, s)
    ids, counters = {}, Counter()
    rooms = []  # (src_id, our_id, type, geometry)
    for n, attrs in g.nodes(data=True):
        t = attrs.get("type")
        if t == "front_door":
            ids[n] = "outside"
            continue
        geom = attrs.get("geometry")
        if geom is None or geom.is_empty or geom.area * s * s < SLIVER_M2:
            continue
        counters[t] += 1
        ids[n] = f"{t}_{counters[t]}"
        rooms.append((n, ids[n], t, geom))
    if not rooms:
        return None, "no_rooms"

    bedroom_areas = [geom.area * s * s for _, _, t, geom in rooms if t == "bedroom"]
    if any(not (BEDROOM_M2[0] <= a <= BEDROOM_M2[1]) for a in bedroom_areas):
        return None, "bedroom_size"
    interior = sum(geom.area for _, _, t, geom in rooms if t != "balcony") * s * s
    if not (ROOM_COVERAGE[0] <= interior / net <= ROOM_COVERAGE[1]):
        return None, "room_coverage"

    # windows: each window goes to the nearest interior room within reach, else the nearest balcony
    reach = d["wall_depth"] * 1.5
    window_count = Counter()
    for w in geoms(d.get("window")):
        near = sorted((geom.distance(w), oid, t) for _, oid, t, geom in rooms if geom.distance(w) <= reach)
        indoor = [x for x in near if x[2] != "balcony"]
        pick = (indoor or near or [None])[0]
        if pick:
            window_count[pick[1]] += 1

    nodes = []
    for _, oid, t, geom in rooms:
        node = {"id": oid, "type": t, "area": round(geom.area * s * s, 2), "windows": window_count[oid]}
        if t == "balcony":
            node["exterior"] = True
        nodes.append(node)

    geom_of = {oid: geom for _, oid, _, geom in rooms}
    touch_tol = d["wall_depth"] * 0.25

    def open_between(a, b):
        """No wall between the two outlines along a usable width (same rule as the Swiss importer)."""
        ga, gb = geom_of[a], geom_of[b]
        if ga.distance(gb) > touch_tol:
            return False
        shared = ga.buffer(touch_tol).intersection(gb.buffer(touch_tol))
        # a strip of width ~2*tol along the shared boundary: its length ~ area / width
        return shared.area / (2 * touch_tol) * s >= OPEN_SHARED_M

    edges, seen, has_outside, walls_only = [], set(), False, []
    for u, v, et in g.edges(data="type"):
        a, b = ids.get(u), ids.get(v)
        if not a or not b or a == b:
            continue
        if "outside" in (a, b):
            conn, has_outside = "entrance_door", True
        elif et == "adjacency":
            if not open_between(a, b):
                walls_only.append((a, b))
                continue
            conn = "opening"
        else:
            conn = EDGE_MAP.get(et)
        if not conn:
            continue
        key = tuple(sorted((a, b)))
        if key in seen:
            continue
        seen.add(key)
        edges.append({"from": a, "to": b, "connection": conn})
    # A room the source links only by shared walls would otherwise float free: keep those links,
    # marked "adjacent" (touching; the source records no door or opening).
    linked = {x for e in edges for x in (e["from"], e["to"])}
    for a, b in walls_only:
        if (a not in linked or b not in linked) and tuple(sorted((a, b))) not in seen:
            seen.add(tuple(sorted((a, b))))
            edges.append({"from": a, "to": b, "connection": "adjacent"})
    if has_outside:
        nodes.append({"id": "outside", "type": "outside", "exterior": True})

    bedrooms = sum(1 for n in nodes if n["type"] == "bedroom")
    bathrooms = sum(1 for n in nodes if n["type"] == "bathroom")
    plan = {
        "plan_id": pid,
        "style": "unspecified",
        "total_area_m2": round(net, 2),
        "bedrooms": bedrooms,
        "bedrooms_inferred": 0,
        "bathrooms": bathrooms,
        "adjacency_graph": {
            "units": "m2",
            "nodes": nodes,
            "edges": edges,
            "derivation": DERIVATION,
            "source_ids": {"resplan_id": int(d["id"])},
        },
        "provenance": {
            "source": "dataset",
            "built": True,
            "license": "CC-BY-4.0",
            "author": "M. Abouagour, E. Garyfallidis",
            "source_url": SOURCE_URL,
            "attribution": ATTRIBUTION,
        },
    }
    vector = {
        "plan_id": pid,
        "schema_version": 1,
        "units": "m",
        "crs": CRS,
        "attribution": ATTRIBUTION,
        "rooms": [{"id": oid, "type": t, "level": LEVEL, "polygon": frame.polys(geom)} for _, oid, t, geom in rooms],
        "doors": [{"type": "door", "level": LEVEL, "polygon": frame.polys(x)} for x in geoms(d.get("door"))]
        + [{"type": "entrance_door", "level": LEVEL, "polygon": frame.polys(x)} for x in geoms(d.get("front_door"))],
        "windows": [{"level": LEVEL, "polygon": frame.polys(x)} for x in geoms(d.get("window"))],
        "stairs": [
            {"id": oid, "level": LEVEL, "room": oid, "polygon": frame.polys(geom)}
            for _, oid, t, geom in rooms
            if t == "stair"
        ],
    }
    return (plan, vector), None


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit("usage: resplan.py <ResPlan.pkl> <out-dir> [--limit N]")
    src, out = args[0], args[1]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "resplan-takedowns.json")) as f:
        takedowns = set(json.load(f)["removed_ids"])
    with open(src, "rb") as f:
        data = SafeUnpickler(f).load()
    if limit:
        data = data[:limit]

    os.makedirs(os.path.join(out, "vectors"), exist_ok=True)
    plans, skipped, chunk = [], Counter(), 0

    def flush():
        nonlocal plans, chunk
        if plans:
            chunk += 1
            with open(os.path.join(out, f"plans-{chunk:04d}.json"), "w") as f:
                json.dump(plans, f, separators=(",", ":"))
            plans = []

    for d in data:
        res, why = convert(d, takedowns)
        if why:
            skipped[why] += 1
            continue
        plan, vector = res
        plans.append(plan)
        with open(os.path.join(out, "vectors", f"{plan['plan_id']}.json"), "w") as f:
            json.dump(vector, f, separators=(",", ":"))
        if len(plans) >= CHUNK:
            flush()
    flush()
    converted = len(data) - sum(skipped.values())
    print(f"{len(data)} plans read, {converted} converted, skipped: {dict(skipped)}")


if __name__ == "__main__":
    main()
