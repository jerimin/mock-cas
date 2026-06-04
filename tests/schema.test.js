import { describe, expect, it } from "vitest";
import {
  validateQuestion,
  validateBank,
  findDuplicateStems,
  SEVERITY,
  VALID_FORMATS,
} from "../public/assets/js/lib/schema.js";

// Regression tests targeting the specific bugs that escaped initial verification.

const goodSingle = () => ({
  id: "intro-01",
  section: "Virtualization Introduction",
  format: "single",
  question: "Among the following descriptions of CAS virtualization mode, which is correct?",
  options: ["Hyper-V", "Para-virtualization", "Hardware-assisted virtualization", "Emulation"],
  correctIndices: [2],
  explanation: "CAS uses hardware-assisted virtualization (KVM) per the CAS Introduction module.",
});
const goodMulti = () => ({
  id: "infra-01",
  section: "Virtualized Infrastructure",
  format: "multi",
  question: "Which of the following are features of RAID 5?",
  options: [
    "Parity is evenly distributed across all disks",
    "Requires at least 3 disks",
    "Usable space is (N-1)/N",
    "A dedicated disk stores parity (RAID 4 behaviour)",
  ],
  correctIndices: [0, 1, 2],
  explanation: "RAID 5 distributes parity across all members and needs N>=3 with usable (N-1)/N capacity.",
});
const goodNegative = () => ({
  id: "deploy-01",
  section: "Deploying Virtualization Platform",
  format: "negative",
  question: "Among the following descriptions of HA, which is incorrect?",
  options: ["HA needs shared storage", "Cluster nodes mount the same FS", "HA survives shared-FS failure", "Failover host has restrictions"],
  correctIndices: [2],
  explanation: "HA cannot survive simultaneous host and shared-FS failure per the Advanced Functions module.",
});

describe("validateQuestion — regression: intro-06 had 6 options", () => {
  it("flags 6-option as ERROR", () => {
    const q = goodMulti();
    q.options = [...q.options, "fifth option", "sixth option"];
    q.correctIndices = [0, 1, 2];
    const issues = validateQuestion(q);
    const errs = issues.filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /options count must be 4 or 5/.test(i.message))).toBe(true);
  });
  it("accepts 4 options", () => {
    expect(validateQuestion(goodSingle()).filter((i) => i.severity === SEVERITY.ERROR)).toEqual([]);
  });
  it("accepts 5 options on multi", () => {
    const q = goodMulti();
    q.options = [...q.options, "fifth option"];
    expect(validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR)).toEqual([]);
  });
});

describe("validateQuestion — regression: format-vs-indices mismatch", () => {
  it("format=single + 2 indices = ERROR", () => {
    const q = goodSingle();
    q.correctIndices = [1, 2];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /format=single requires exactly 1/.test(i.message))).toBe(true);
  });
  it("format=multi + 1 index = ERROR", () => {
    const q = goodMulti();
    q.correctIndices = [0];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /format=multi requires >=2/.test(i.message))).toBe(true);
  });
  it("format=negative + 1 index OK (single-negative)", () => {
    expect(validateQuestion(goodNegative()).filter((i) => i.severity === SEVERITY.ERROR)).toEqual([]);
  });
  it("format=negative + 3 indices OK (multi-negative)", () => {
    const q = goodNegative();
    q.options = [...q.options, "fifth option"];
    q.correctIndices = [0, 2, 4];
    expect(validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR)).toEqual([]);
  });
});

describe("validateQuestion — correctIndices range + integrity", () => {
  it("OOB index = ERROR", () => {
    const q = goodSingle();
    q.correctIndices = [7];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /out of range/.test(i.message))).toBe(true);
  });
  it("negative index = ERROR", () => {
    const q = goodSingle();
    q.correctIndices = [-1];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /out of range/.test(i.message))).toBe(true);
  });
  it("non-integer index = ERROR", () => {
    const q = goodSingle();
    q.correctIndices = [1.5];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /non-integer/.test(i.message))).toBe(true);
  });
  it("duplicate index = ERROR", () => {
    const q = goodMulti();
    q.correctIndices = [0, 0, 1];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /duplicate entries/.test(i.message))).toBe(true);
  });
  it("empty correctIndices = ERROR", () => {
    const q = goodSingle();
    q.correctIndices = [];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /correctIndices is empty/.test(i.message))).toBe(true);
  });
});

describe("validateQuestion — vague + absurd warnings", () => {
  it("'best describes' stem = WARN", () => {
    const q = goodSingle();
    q.question = "Which of the following best describes server virtualization?";
    const warns = validateQuestion(q).filter((i) => i.severity === SEVERITY.WARN);
    expect(warns.some((i) => /vague stem/.test(i.message))).toBe(true);
  });
  it("absurd 'color scheme' distractor = WARN", () => {
    const q = goodMulti();
    q.options = [q.options[0], q.options[1], q.options[2], "color scheme of the interface"];
    const warns = validateQuestion(q).filter((i) => i.severity === SEVERITY.WARN);
    expect(warns.some((i) => /looks absurd/.test(i.message))).toBe(true);
  });
});

describe("findDuplicateStems — regression: deploy-27 dup of deploy-12", () => {
  it("flags exact-stem duplicate (whitespace + case insensitive)", () => {
    const bank = [
      { id: "a", section: "Virtualization Introduction", format: "single", question: "Which of the following are correct CAS performance specifications?", options: ["a","b","c","d"], correctIndices: [0], explanation: "..." },
      { id: "b", section: "Virtualized Infrastructure", format: "single", question: "  WHICH OF THE FOLLOWING ARE CORRECT CAS PERFORMANCE SPECIFICATIONS?  ", options: ["a","b","c","d"], correctIndices: [0], explanation: "..." },
    ];
    const dups = findDuplicateStems(bank);
    expect(dups).toEqual([{ id: "b", dupOf: "a" }]);
  });
  it("non-duplicate stems pass", () => {
    const dups = findDuplicateStems([goodSingle(), goodMulti(), goodNegative()]);
    expect(dups).toEqual([]);
  });
});

describe("validateBank — aggregate", () => {
  it("returns no errors on a clean bank", () => {
    const { errors, warnings, summary } = validateBank([goodSingle(), goodMulti(), goodNegative()]);
    expect(errors).toEqual([]);
    expect(summary.total).toBe(3);
  });
  it("returns errors when bank has duplicate ids", () => {
    const q1 = goodSingle();
    const q2 = goodMulti();
    q2.id = q1.id;
    const { errors } = validateBank([q1, q2]);
    expect(errors.some((e) => /duplicate id/.test(e.message))).toBe(true);
  });
});

describe("VALID_FORMATS — exhaustive", () => {
  it("only single / multi / negative are allowed", () => {
    expect(VALID_FORMATS).toEqual(["single", "multi", "negative"]);
  });
});

describe("validateQuestion — source-leak detection", () => {
  // Note: "the official syllabus" is intentionally allowed — it's how the SITE
  // communicates the real H3C exam policy (50Q/60min/60% pass), not a private source.
  const leakStems = [
    "Per the course, which is correct?",
    "Among the items listed in the PDF, which is incorrect?",
    "According to the module, which is true?",
    "Which of the following is shown in the slide?",
    "Which statement appears in the table?",
    "Which is defined in the textbook?",
  ];
  for (const stem of leakStems) {
    it(`flags "${stem}" as ERROR`, () => {
      const q = goodSingle();
      q.question = stem;
      const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
      expect(errs.some((i) => /leaks source material/.test(i.message))).toBe(true);
    });
  }
  it("flags explanation leaks", () => {
    const q = goodSingle();
    q.explanation = "The course states that vMotion needs no shared storage.";
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /leaks source material/.test(i.message))).toBe(true);
  });
  it("flags option leaks", () => {
    const q = goodSingle();
    q.options = [q.options[0], q.options[1], "as listed in the course", q.options[3]];
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /option \d+ leaks source material/.test(i.message))).toBe(true);
  });
  it('allows legitimate "the reference port" (LACP term)', () => {
    const q = goodSingle();
    q.explanation = "In static aggregation, the reference port is selected by criteria including priority and ID.";
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /leaks source material/.test(i.message))).toBe(false);
  });
  it('allows "the reference architecture"', () => {
    const q = goodSingle();
    q.explanation = "The reference architecture for HA requires shared storage and at least two CVK hosts.";
    const errs = validateQuestion(q).filter((i) => i.severity === SEVERITY.ERROR);
    expect(errs.some((i) => /leaks source material/.test(i.message))).toBe(false);
  });
});
