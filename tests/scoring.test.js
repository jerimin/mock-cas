import { describe, expect, it } from "vitest";
import { scoreQuestion, STATUS } from "../public/assets/js/lib/scoring.js";

describe("scoreQuestion — empty / malformed", () => {
  it("empty selection -> skipped", () => {
    expect(scoreQuestion([], [1])).toEqual({ score: 0, status: STATUS.SKIPPED });
  });
  it("null selection -> skipped (defensive)", () => {
    expect(scoreQuestion(null, [1])).toEqual({ score: 0, status: STATUS.SKIPPED });
  });
  it("empty correct array -> skipped (defensive)", () => {
    expect(scoreQuestion([1], [])).toEqual({ score: 0, status: STATUS.SKIPPED });
  });
});

describe("scoreQuestion — single (and single-negative)", () => {
  it("exact match -> 1.0 / correct", () => {
    expect(scoreQuestion([2], [2])).toEqual({ score: 1, status: STATUS.CORRECT });
  });
  it("wrong pick -> 0 / incorrect", () => {
    expect(scoreQuestion([1], [2])).toEqual({ score: 0, status: STATUS.INCORRECT });
  });
  it("multi-pick on a single-correct question = incorrect (size mismatch)", () => {
    expect(scoreQuestion([1, 2], [2])).toEqual({ score: 0, status: STATUS.INCORRECT });
  });
});

describe("scoreQuestion — multi (partial credit)", () => {
  it("all correct, no wrong -> 1.0 / correct", () => {
    expect(scoreQuestion([0, 1, 2], [0, 1, 2])).toEqual({ score: 1, status: STATUS.CORRECT });
  });
  it("order-independent equality", () => {
    expect(scoreQuestion([2, 0, 1], [0, 1, 2])).toEqual({ score: 1, status: STATUS.CORRECT });
  });
  it("half correct (1 of 2 right, 0 wrong) -> 0.5 / partial", () => {
    expect(scoreQuestion([0], [0, 1])).toEqual({ score: 0.5, status: STATUS.PARTIAL });
  });
  it("one correct + one wrong cancels out -> 0 / incorrect", () => {
    expect(scoreQuestion([0, 3], [0, 1])).toEqual({ score: 0, status: STATUS.INCORRECT });
  });
  it("two correct + one wrong -> 1/2 partial (not negative)", () => {
    expect(scoreQuestion([0, 1, 3], [0, 1, 2])).toEqual({ score: 1 / 3, status: STATUS.PARTIAL });
  });
  it("all wrong -> floored at 0 / incorrect (never negative)", () => {
    const result = scoreQuestion([3, 4], [0, 1]);
    expect(result.score).toBe(0);
    expect(result.status).toBe(STATUS.INCORRECT);
  });
  it("more correct picked than required can't exceed 1.0", () => {
    // Shouldn't normally happen but defensive: 2 correct picks, 0 wrong, total 2 -> 1.0
    expect(scoreQuestion([0, 1], [0, 1])).toEqual({ score: 1, status: STATUS.CORRECT });
  });
});
