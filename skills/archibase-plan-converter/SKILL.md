---
name: archibase-plan-converter
description: Convert a floor plan (scan, photo, PDF, drawing, CAD/IFC export, or a written description) into Archibase's format: a metric room graph plus room/door/window geometry, checked by a validator. Use when asked to digitise, trace, vectorise or convert a floor plan, to produce Archibase plan records, or to check Archibase plan JSON.
---

# Archibase plan converter

Archibase is a corpus of real floor plans as **room graphs and metric geometry**. This skill turns a plan into that format. You do the part that needs eyes (reading the drawing and writing down room outlines in metres); the bundled script does the parts that need care (areas, which rooms connect, window counts, the rules a record must meet) and refuses output that would be rejected.

Needs Node 18+. No other dependencies. All commands run from this folder.

## 0. Check you may convert it (do this first)

Only convert a plan whose licence lets it be shared and sold: **public domain** (for example US HABS/HAER drawings, works published before 1931 in the US), **CC0**, **CC BY 4.0** (keep the attribution line), or a plan **the requester owns or has written rights to**. Do not convert a plan scraped from a listing, brochure or copyrighted book. If the rights are unclear, stop and ask. The licence goes in `provenance` and the validator enforces the rules (details in `references/format.md`).

## 1. Fix the scale before anything else

Everything is in **metres**, +x to the right, +y up (flip image y). A wrong scale ruins every number, so find it from something reliable, in this order:
1. A printed scale bar or a stated scale (convert imperial: 1 ft = 0.3048 m).
2. Printed room dimensions. Use the largest ones for accuracy.
3. Standard sizes: interior doors about 0.8-0.9 m, front doors about 0.9-1.0 m, bedrooms 9-18 m², a bath 3-6 m².

Write down how you got the scale (`transcription.scale_basis`). The validator warns if the median door isn't 0.7-1.1 m.

## 2. Trace

Write one JSON file (the "trace") using `examples/two-bed.trace.json` as the pattern. Full guidance is in `references/tracing.md`. The essentials:

- **Rooms are the inside faces of the walls.** Leave a gap (0.1-0.3 m) where a wall stands between two rooms. Rooms that touch with no gap are treated as open to each other (an open kitchen, an arch).
- One polygon per room, corners in order, any direction, any origin. Add `holes` for courtyards or columns you want excluded.
- **Doors and windows are lines drawn across the wall** (`from`, `to`), as wide as the opening. A door goes in the gap between two rooms; an `entrance_door` sits in the outer wall of the room you enter from outside. A window line sits in the outer wall.
- Use real room types (`bedroom`, `bathroom` = has a bath or shower, `toilet` = WC only, `kitchen`, `living`, `dining`, `hallway`, `balcony`, `stairs`, `storage`, ...). If the drawing doesn't say, use `room`, never guess "bedroom". Set `inferred_use` only on `room`.
- Balconies, terraces and porches are rooms of those types: drawn, but not counted in the floor area.
- **Several levels:** give each room a `level` (1, 2, ...). Stairs: a room of type `stairs` on the lower level, a room with `"stairwell": true` where it arrives, and a `stairs` entry linking them (see the format reference).

## 3. Build, then read what it says

```bash
node scripts/archibase.mjs build my-plan.trace.json --out out/
```

It writes `out/<plan_id>.record.json` (the graph and counts) and `out/<plan_id>.vector.json` (the geometry), prints the links it found, and lists errors and warnings. **Errors must be fixed.** Read every warning: each one is usually a real mistake (a door that isn't between two rooms, a window outside every room, rooms overlapping, a wrong scale).

## 4. Check it against the source, not just the validator

The validator can't know if you traced the wrong room. Look at the result:

```bash
node scripts/archibase.mjs render out/<plan_id>.vector.json --record out/<plan_id>.record.json   # writes an .svg
node scripts/archibase.mjs render out/<plan_id>.vector.json --ascii                              # a text picture
```

Compare with the original: same number of rooms, same shapes, doors and windows in the right walls, total area plausible for the building, the printed dimensions of at least two rooms match the areas in the record. Fix the trace and rebuild until it matches. For a multi-level plan, render each level with `--level N`.

## 5. Deliver

Hand back `<plan_id>.record.json` and `<plan_id>.vector.json`, plus a short note: where the scale came from, anything you were unsure of (set `transcription.confidence` to `high`, `medium` or `low` honestly), and the licence and source. `node scripts/archibase.mjs validate record.json vector.json` re-checks files made by anyone.

If the person wants the plan in the Archibase catalogue, they should send the two files with the source and licence to the contact on https://archibase.dev. Only plans with clear rights are accepted.

## Common mistakes

- **Wrong scale**: check against two printed dimensions.
- **Tracing outer wall lines, not inside faces**: rooms then overlap and the floor area is overstated.
- **Doors drawn along a wall instead of across it**: the script finds no (or the wrong) rooms; draw the line from one side of the opening to the other.
- **Calling every unlabelled room a bedroom**: use `room`.
- **Counting a balcony in the area**: use type `balcony`.
- **Skipping rooms**: closets, halls and stairs are rooms too; the room areas should add up to about 85-100% of the plan's footprint.
- **Putting coordinates in feet or pixels**: metres only.

## Files

- `scripts/archibase.mjs`: `build`, `validate`, `render`. One file, no dependencies.
- `references/format.md`: the record and geometry formats, vocabularies and licence rules.
- `references/tracing.md`: step-by-step tracing guide for raster plans, with how to handle angles, curves, stairs and levels.
- `examples/two-bed.trace.json`: a complete worked trace.
