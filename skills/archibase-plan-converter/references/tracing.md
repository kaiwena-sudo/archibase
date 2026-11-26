# Tracing a floor plan, step by step

For raster plans: scans, photographs, PDFs of drawings. If you have CAD/IFC data, use its room polygons directly and skip to step 5. If you only have a description, build the plan from the stated dimensions the same way.

## 1. Look before you trace

Read the whole sheet first. Note: the scale or printed dimensions, the room labels, the stairs and where they go, how many levels, which wall is the entrance, any angled walls. Decide your **origin and axes** now: pick the bottom-left corner of the building, +x right, +y up. Image coordinates have y pointing down, so flip it.

## 2. Calibrate

Choose two points far apart whose real distance you know (a scale bar, or a long room with a printed dimension). Metres per image unit = real distance / image distance. Use it for every coordinate. Check with a second printed dimension: if it's off by more than about 3%, redo the calibration.

If the drawing has no scale and no dimensions, anchor on doors (0.8-0.9 m wide) and say so in `transcription` with `"confidence": "low"`.

## 3. Rooms

Trace in this order: outer rooms first, then the ones inside them.

- Follow the **inside face** of each wall. Where a wall stands between two rooms, leave a gap of the wall's thickness (0.1 m for a partition, 0.2-0.3 m for a masonry wall; if the drawing shows thick walls, measure them).
- Where there is **no wall** (open kitchen, wide archway, a hall that runs into a living room) make the outlines **touch exactly**. The script then links them as `opening`.
- **Angled walls**: use the real corner points; polygons can have any angles.
- **Curves**: approximate with a polyline; an arc needs a point about every 15-20 degrees. Keep it under about 40 points.
- **Alcoves, bay windows, dormers**: include them in the room's polygon when they're part of the room's space.
- **Columns or a courtyard** inside a room: use `holes` only for a large void (a courtyard, a stairwell). Ignore small columns.
- **Built-ins** (a closet is a room; a wardrobe or counter inside a room is not).
- **Level changes**: each level is traced in its own coordinates, but keep the same origin so stairs line up.

Name rooms `type_n` (`bedroom_1`, `bathroom_2`) so the output is readable.

## 4. Doors, windows, stairs

- **Doors**: a line across the wall opening from one side to the other, in the gap between the two rooms. Swing arcs show where the doors are; draw the opening, not the arc. The **front door** is `"type": "entrance_door"`, in the outer wall, next to the room you enter. Sliding or French doors to a balcony are doors too.
- **Windows**: a line along the outer wall, as long as the glazing. Ribbon windows that span two rooms: one long line is fine (it counts for both). Skylights are not windows.
- **Garage or wide openings**: draw as doors.
- **Stairs**: draw the footprint as a `stairs` room; if it goes up, draw the arrival opening on the next level as a `stairwell` room and link them with a `stairs` entry (format reference). Use the printed number of risers; if the drawing shows an arrow, that's the direction (`start` bottom, `end` top).

## 5. Build and look

```bash
node scripts/archibase.mjs build trace.json --out out/
node scripts/archibase.mjs render out/<id>.vector.json --record out/<id>.record.json
```

Open the SVG. If you can't view images, use `--ascii`.

What to compare with the source:
1. Room count and rough shapes.
2. Each door is between the rooms it should link (the printed list of links matches how you'd walk through the home).
3. Windows are on the outer walls of the right rooms, with the right counts.
4. Two or three printed dimensions match the areas to within 3-5%.
5. The total area is plausible, and the rooms fill the footprint.

## 6. Fix what the script says

| Message | Usually means |
|---|---|
| `found 0 room within 0.35 m` for a door | the door line isn't in a wall gap between rooms. Move it to the gap, or the gap is wider than 0.7 m |
| `found 1 room ... expected 2` | one side of the door has no room (an unmapped hall) or the gap is too wide |
| `window ... isn't within 0.35 m of any room` | window line is too far outside the wall |
| `rooms ... overlap` | you traced outer wall faces; use inside faces |
| `median door width ... scale is probably wrong` | redo the calibration |
| `bedroom ... is N m²: implausible` | wrong scale, or the room isn't a bedroom |
| `room areas sum to ... vs total` | rooms are missing or drawn wrongly |

## 7. What good looks like

On real plans converted back from geometry the script reproduces the door and opening links and window counts almost exactly; the usual loss is in the trace, not the script. A good trace has: scale checked against two dimensions, every room present, doors in every wall gap that has one, 0 errors, and no unexplained warnings.
