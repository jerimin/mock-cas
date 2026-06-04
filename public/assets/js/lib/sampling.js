// Stratified sampling — weighted by H3C CAS syllabus coverage.

import { shuffle } from "./util.js";

export const SECTIONS = Object.freeze([
  "Virtualization Introduction",
  "Virtualized Infrastructure",
  "Deploying Virtualization Platform",
  "Basic Functions",
  "Advanced Functions",
  "Maintenance",
]);

/** Syllabus-aligned module weights — must sum to 1.0. Tweak only after re-baselining tests. */
export const WEIGHTS = Object.freeze({
  "Virtualization Introduction":        0.10,
  "Virtualized Infrastructure":         0.20,
  "Deploying Virtualization Platform":  0.15,
  "Basic Functions":                    0.20,
  "Advanced Functions":                 0.20,
  "Maintenance":                        0.15,
});

/**
 * Compute the per-section target counts for an attempt of the given size.
 * Rounds with drift fixed by adjusting the heaviest-weighted section.
 *
 * @param {number} attemptSize
 * @returns {Record<string, number>}
 */
export function computeTargets(attemptSize) {
  const sections = Object.keys(WEIGHTS);
  const targets = {};
  let assigned = 0;
  for (const s of sections) {
    targets[s] = Math.round(WEIGHTS[s] * attemptSize);
    assigned += targets[s];
  }
  if (assigned !== attemptSize) {
    const diff = attemptSize - assigned;
    const heaviest = sections.reduce((a, b) => (WEIGHTS[a] >= WEIGHTS[b] ? a : b));
    targets[heaviest] += diff;
  }
  return targets;
}

/**
 * Pick `attemptSize` questions from `bank`, stratified by WEIGHTS, shuffled within section and across.
 *
 * @param {Array<{section: string}>} bank
 * @param {number} attemptSize
 * @returns {Array<{section: string}>}
 */
export function stratifiedPick(bank, attemptSize) {
  const targets = computeTargets(attemptSize);
  const picks = [];
  for (const s of Object.keys(WEIGHTS)) {
    const pool = bank.filter((q) => q.section === s);
    picks.push(...shuffle(pool).slice(0, targets[s]));
  }
  return shuffle(picks);
}
