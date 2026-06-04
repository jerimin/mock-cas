// Scoring logic — single source of truth for per-question scoring.
// Used by both the exam engine (browser) and the Vitest scoring tests.
//
// Scoring rule:
//   - empty selection                                  -> { score: 0, status: "skipped"   }
//   - correctPositions.length === 1 (single/single-neg):
//       exact match                                    -> { score: 1, status: "correct"   }
//       any mismatch                                   -> { score: 0, status: "incorrect" }
//   - correctPositions.length >= 2 (multi/multi-neg):
//       partial = max(0, (correctPicks - wrongPicks) / totalCorrect)
//       partial === 1                                  -> "correct"
//       partial > 0  && partial < 1                    -> "partial"
//       partial === 0                                  -> "incorrect"

import { setsEqual } from "./util.js";

export const STATUS = Object.freeze({
  CORRECT:   "correct",
  PARTIAL:   "partial",
  INCORRECT: "incorrect",
  SKIPPED:   "skipped",
});

/**
 * @param {number[]} selectedPositions  — option positions the user picked (post-shuffle)
 * @param {number[]} correctPositions   — option positions that are correct (post-shuffle)
 * @returns {{score: number, status: string}}
 */
export function scoreQuestion(selectedPositions, correctPositions) {
  if (!Array.isArray(selectedPositions) || selectedPositions.length === 0) {
    return { score: 0, status: STATUS.SKIPPED };
  }
  if (!Array.isArray(correctPositions) || correctPositions.length === 0) {
    // Defensive: a question with zero correct answers is malformed — treat as skipped.
    return { score: 0, status: STATUS.SKIPPED };
  }

  if (correctPositions.length === 1) {
    const ok = setsEqual(selectedPositions, correctPositions);
    return { score: ok ? 1 : 0, status: ok ? STATUS.CORRECT : STATUS.INCORRECT };
  }

  const correctSet = new Set(correctPositions);
  const correctPicked = selectedPositions.filter((p) => correctSet.has(p)).length;
  const wrongPicked = selectedPositions.length - correctPicked;
  const raw = (correctPicked - wrongPicked) / correctPositions.length;
  const score = Math.max(0, Math.min(1, raw));
  let status;
  if (score === 1) status = STATUS.CORRECT;
  else if (score === 0) status = STATUS.INCORRECT;
  else status = STATUS.PARTIAL;
  return { score, status };
}
