// End-to-end test: the live bank.json must pass validation with zero errors.
// This is the safety net — if a future merge introduces a schema break, a duplicate
// stem, a bad correctIndex, or an absurd distractor, this fails and blocks deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateBank, SEVERITY } from "../public/assets/js/lib/schema.js";
import { WEIGHTS } from "../public/assets/js/lib/sampling.js";

const here = dirname(fileURLToPath(import.meta.url));
const bankPath = resolve(here, "../public/assets/data/bank.json");
const bank = JSON.parse(readFileSync(bankPath, "utf8"));

describe("bank.json — sanity", () => {
  it("loads as a non-empty array", () => {
    expect(Array.isArray(bank)).toBe(true);
    expect(bank.length).toBeGreaterThan(0);
  });
  it("currently has 250 questions (locked at v1.0.0)", () => {
    expect(bank.length).toBe(250);
  });
});

describe("bank.json — validateBank() finds zero errors", () => {
  const { errors, warnings, summary } = validateBank(bank);

  it("zero errors", () => {
    if (errors.length > 0) {
      // Surface the first 10 errors for fast diagnosis
      const sample = errors.slice(0, 10).map((e) => `  - ${e.id ?? "?"}: ${e.message}`).join("\n");
      throw new Error(`${errors.length} validation errors:\n${sample}`);
    }
    expect(errors.length).toBe(0);
  });
  it("warnings (informational) under control", () => {
    // Tighter than this would be ideal; this is the v1.0.0 baseline. Loosen carefully.
    if (warnings.length > 30) {
      const sample = warnings.slice(0, 5).map((e) => `  - ${e.id ?? "?"}: ${e.message}`).join("\n");
      throw new Error(`${warnings.length} validation warnings (baseline 30):\n${sample}`);
    }
    expect(warnings.length).toBeLessThanOrEqual(30);
  });
  it("summary reports all 6 sections present and weighted", () => {
    for (const s of Object.keys(WEIGHTS)) {
      expect(summary.bySection[s], `section ${s}`).toBeGreaterThan(0);
    }
  });
  it("format mix near 40/30/30 (single/multi/negative)", () => {
    const total = summary.total;
    expect(summary.byFormat.single   / total).toBeGreaterThanOrEqual(0.35);
    expect(summary.byFormat.single   / total).toBeLessThanOrEqual(0.45);
    expect(summary.byFormat.multi    / total).toBeGreaterThanOrEqual(0.25);
    expect(summary.byFormat.multi    / total).toBeLessThanOrEqual(0.35);
    expect(summary.byFormat.negative / total).toBeGreaterThanOrEqual(0.25);
    expect(summary.byFormat.negative / total).toBeLessThanOrEqual(0.35);
  });
});

describe("bank.json — every option array is 4 or 5 (regression: intro-06)", () => {
  it("no question has 3 or 6+ options", () => {
    const offenders = bank.filter((q) => !Array.isArray(q.options) || q.options.length < 4 || q.options.length > 5);
    expect(offenders).toEqual([]);
  });
});

describe("bank.json — zero duplicate-stems (regression: deploy-27)", () => {
  it("no two questions share a normalised stem", () => {
    const seen = new Map();
    const dups = [];
    for (const q of bank) {
      const key = q.question.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!?;:,]+$/, "");
      if (seen.has(key)) dups.push({ id: q.id, dupOf: seen.get(key) });
      else seen.set(key, q.id);
    }
    expect(dups).toEqual([]);
  });
});
