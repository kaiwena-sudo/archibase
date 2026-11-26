import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../src/index.js";

describe("parseSearchQuery", () => {
  it("parses a full valid metric query", () => {
    expect(parseSearchQuery({ bedrooms: "3", m2_min: "140", m2_max: "230.5", style: " modern ", limit: "10" })).toEqual({
      ok: true,
      filters: { bedrooms: 3, areaMinM2: 140, areaMaxM2: 230.5, style: "modern", limit: 10 },
      units: "metric",
    });
  });

  it("converts sqft bounds to m²", () => {
    const r = parseSearchQuery({ sqft_min: "1000", sqft_max: "2000" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.areaMinM2).toBeCloseTo(92.903, 3);
      expect(r.filters.areaMaxM2).toBeCloseTo(185.806, 3);
    }
  });

  it("rejects mixing metric and imperial bounds", () => {
    expect(parseSearchQuery({ m2_min: "50", sqft_max: "2000" })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/either m2_min\/m2_max or sqft_min\/sqft_max/)],
    });
  });

  it("parses units and rejects unknown unit systems", () => {
    expect(parseSearchQuery({ units: "imperial" })).toMatchObject({ ok: true, units: "imperial" });
    expect(parseSearchQuery({ units: "cubits" })).toMatchObject({ ok: false });
  });

  it("accepts an empty query", () => {
    const r = parseSearchQuery({});
    expect(r.ok).toBe(true);
  });

  it("ignores empty values", () => {
    const r = parseSearchQuery({ bedrooms: "", style: "" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.filters).toEqual({});
  });

  const invalid: [string, Record<string, string>, RegExp][] = [
    ["unknown params", { foo: "1" }, /unknown parameter "foo"/],
    ["non-numeric bedrooms", { bedrooms: "two" }, /"bedrooms" must be an integer/],
    ["fractional bedrooms", { bedrooms: "2.5" }, /"bedrooms" must be an integer/],
    ["negative sqft", { sqft_min: "-1" }, /"sqft_min" must be >= 0/],
    ["sqft_min > sqft_max", { sqft_min: "3000", sqft_max: "1000" }, /"sqft_min" must be <= "sqft_max"/],
    ["m2_min > m2_max", { m2_min: "300", m2_max: "100" }, /"m2_min" must be <= "m2_max"/],
    ["negative m2", { m2_min: "-5" }, /"m2_min" must be >= 0/],
    ["style with bad chars", { style: "modern';drop" }, /"style" must be letters/],
    ["style too long", { style: "a".repeat(65) }, /"style" must be letters/],
    ["limit out of range", { limit: "1000" }, /"limit" must be <= 100/],
  ];
  it.each(invalid)("rejects %s", (_name, query, message) => {
    const r = parseSearchQuery(query);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(message);
  });

  it("reports every error at once", () => {
    const r = parseSearchQuery({ foo: "1", bedrooms: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });
});

describe("provenance filters", () => {
  it("parses built and source", () => {
    expect(parseSearchQuery({ built: "true", source: "habs" })).toEqual({
      ok: true,
      filters: expect.objectContaining({ built: true, source: "habs" }),
      units: "metric",
    });
    expect(parseSearchQuery({ built: "false" })).toMatchObject({ ok: true, filters: { built: false } });
  });

  it("rejects bad values", () => {
    const r = parseSearchQuery({ built: "yes", source: "scraped" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });
});
