import { describe, expect, it } from "vitest";
import { WEIGHTS, SECTIONS, computeTargets, stratifiedPick } from "../public/assets/js/lib/sampling.js";

describe("WEIGHTS / SECTIONS", () => {
  it("WEIGHTS sums to 1.0", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
  it("SECTIONS matches WEIGHTS keys 1:1", () => {
    expect([...SECTIONS].sort()).toEqual(Object.keys(WEIGHTS).sort());
  });
});

describe("computeTargets — drift correction", () => {
  it("50Q stratified mirrors syllabus weighting; +1 rounding drift absorbed by first 20%-weighted section", () => {
    // Math.round(7.5) === 8 in JS, so Deploy + Maintenance both round UP to 8 each.
    // Naive sum = 5+10+8+10+10+8 = 51 → drift = -1 → goes to Infra (first heaviest).
    const t = computeTargets(50);
    expect(t).toEqual({
      "Virtualization Introduction":        5,
      "Virtualized Infrastructure":         9,   // 10 → 9 absorbing drift
      "Deploying Virtualization Platform":  8,   // round-up of 7.5
      "Basic Functions":                    10,
      "Advanced Functions":                 10,
      "Maintenance":                        8,   // round-up of 7.5
    });
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    expect(total).toBe(50);
  });
  it("100Q -> 10/20/15/20/20/15 exactly", () => {
    expect(computeTargets(100)).toEqual({
      "Virtualization Introduction":        10,
      "Virtualized Infrastructure":         20,
      "Deploying Virtualization Platform":  15,
      "Basic Functions":                    20,
      "Advanced Functions":                 20,
      "Maintenance":                        15,
    });
  });
  it("any size -> targets sum to size", () => {
    for (const n of [10, 30, 47, 50, 75, 120, 250]) {
      const t = computeTargets(n);
      const sum = Object.values(t).reduce((a, b) => a + b, 0);
      expect(sum, `attemptSize=${n}`).toBe(n);
    }
  });
});

describe("stratifiedPick", () => {
  const makeBank = () => {
    const b = [];
    for (const s of SECTIONS) {
      for (let i = 0; i < 20; i++) b.push({ id: `${s}-${i}`, section: s });
    }
    return b;
  };

  it("picks exactly attemptSize items", () => {
    const picks = stratifiedPick(makeBank(), 50);
    expect(picks.length).toBe(50);
  });
  it("per-section counts match computeTargets", () => {
    const picks = stratifiedPick(makeBank(), 50);
    const counts = {};
    for (const p of picks) counts[p.section] = (counts[p.section] || 0) + 1;
    const targets = computeTargets(50);
    for (const s of SECTIONS) expect(counts[s] || 0, s).toBe(targets[s]);
  });
  it("every attempt covers every section (when targets > 0)", () => {
    const picks = stratifiedPick(makeBank(), 50);
    const sectionsHit = new Set(picks.map((p) => p.section));
    expect(sectionsHit.size).toBe(SECTIONS.length);
  });
});
