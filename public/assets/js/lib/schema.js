// Bank schema + content validators.
// Pure functions, no I/O — the CLI runner and tests do the file reading.

import { normaliseStem } from "./util.js";
import { SECTIONS, WEIGHTS } from "./sampling.js";

export const VALID_FORMATS = Object.freeze(["single", "multi", "negative"]);
export const REQUIRED_KEYS = Object.freeze([
  "id", "section", "format", "question", "options", "correctIndices", "explanation",
]);

/** Severity levels — the CLI converts these to exit codes (any "error" = non-zero). */
export const SEVERITY = Object.freeze({
  ERROR: "error",
  WARN:  "warn",
});

const VAGUE_STEM = /\b(best describes?|in your opinion|how do you feel|favorite|favourite)\b/i;
const ABSURD_DISTRACTOR = /\b(color scheme|colour scheme|ignoring security|user satisfaction|interface looks|magical|coffee)\b/i;

/**
 * Source-leak detector — flags any reference that hints at private course/PDF
 * material. The public-facing site must not betray that questions were derived
 * from internal study material.
 *
 * Allowed technical false-positives are explicitly excluded via lookahead:
 *   - "the reference port" / "the reference architecture" / "the reference design"
 */
const SOURCE_LEAK = new RegExp(
  "\\b(?:" +
    "the\\s+(?:CAS\\s+)?course" +
    "|the\\s+PDF" +
    "|the\\s+module|the\\s+chapter" +
    "|the\\s+slide(?!\\s+exactly)" +
    "|the\\s+page|the\\s+manual|the\\s+textbook|the\\s+syllabus" +
    "|the\\s+document(?:ed|s)?" +
    "|the\\s+reference(?!\\s+(?:port|architecture|implementation|design|configuration|model|table|guide|number))" +
    "|page\\s+(?:lists?|enumerates?|states?|defines?|shows?)" +
    "|slide\\s+(?:lists?|enumerates?|states?|defines?|shows?)" +
    "|in\\s+the\\s+(?:course|PDF|module|chapter|slide|page|figure|table|syllabus|document|manual|textbook)" +
    "|per\\s+the\\s+(?:course|PDF|module|chapter|slide|page|figure|table|syllabus|document|manual|textbook)" +
    "|according\\s+to\\s+the\\s+(?:course|PDF|module|chapter|slide|page|figure|table|syllabus|document|manual|textbook)" +
    "|(?:listed|described|defined|stated|presented|shown)\\s+in\\s+the\\s+(?:course|PDF|module|chapter|slide|page|figure|table|syllabus|document|manual|textbook)" +
  ")\\b",
  "i"
);

// --- per-question validators -------------------------------------------------

/** Returns an array of issue objects for a single question. */
export function validateQuestion(q, ctx = {}) {
  const issues = [];
  const push = (severity, message) => issues.push({ id: q?.id || "?", severity, message });

  // Required keys
  for (const k of REQUIRED_KEYS) {
    if (!(k in (q || {}))) push(SEVERITY.ERROR, `missing key "${k}"`);
  }
  if (!q || typeof q !== "object") return issues;

  // Section
  if (!SECTIONS.includes(q.section)) push(SEVERITY.ERROR, `unknown section "${q.section}"`);

  // Format
  if (!VALID_FORMATS.includes(q.format)) push(SEVERITY.ERROR, `format must be one of ${VALID_FORMATS.join("/")} (got "${q.format}")`);

  // Options
  if (!Array.isArray(q.options)) push(SEVERITY.ERROR, "options is not an array");
  else {
    if (q.options.length < 4 || q.options.length > 5) {
      push(SEVERITY.ERROR, `options count must be 4 or 5 (got ${q.options.length})`);
    }
    q.options.forEach((o, i) => {
      if (typeof o !== "string" || o.trim().length === 0) push(SEVERITY.ERROR, `option ${i} is not a non-empty string`);
      if (typeof o === "string" && ABSURD_DISTRACTOR.test(o)) push(SEVERITY.WARN, `option ${i} looks absurd: "${o.slice(0, 60)}"`);
    });
  }

  // correctIndices
  if (!Array.isArray(q.correctIndices)) push(SEVERITY.ERROR, "correctIndices is not an array");
  else {
    if (q.correctIndices.length === 0) push(SEVERITY.ERROR, "correctIndices is empty");
    for (const i of q.correctIndices) {
      if (!Number.isInteger(i)) push(SEVERITY.ERROR, `correctIndices contains non-integer ${JSON.stringify(i)}`);
      else if (Array.isArray(q.options) && (i < 0 || i >= q.options.length)) push(SEVERITY.ERROR, `correctIndices ${i} out of range [0,${q.options?.length || 0})`);
    }
    // unique
    const uniq = new Set(q.correctIndices);
    if (uniq.size !== q.correctIndices.length) push(SEVERITY.ERROR, "correctIndices has duplicate entries");
  }

  // Format-vs-indices consistency
  if (VALID_FORMATS.includes(q.format) && Array.isArray(q.correctIndices)) {
    const n = q.correctIndices.length;
    if (q.format === "single" && n !== 1) push(SEVERITY.ERROR, `format=single requires exactly 1 correctIndex (got ${n})`);
    if (q.format === "multi" && n < 2)   push(SEVERITY.ERROR, `format=multi requires >=2 correctIndices (got ${n})`);
    // negative can be either single-negative (1) or multi-negative (2+) — only check that it's >=1, already done above
  }

  // Question stem quality
  if (typeof q.question === "string") {
    if (q.question.trim().length < 20) push(SEVERITY.WARN, `question stem is very short (${q.question.trim().length} chars)`);
    if (VAGUE_STEM.test(q.question)) push(SEVERITY.WARN, `vague stem phrasing — H3C voice prefers "Among the following descriptions of X, which is correct/incorrect"`);
    const m = SOURCE_LEAK.exec(q.question);
    if (m) push(SEVERITY.ERROR, `question leaks source material: "${m[0]}" — site is public, course/PDF references must be scrubbed`);
  }

  // Explanation
  if (typeof q.explanation === "string") {
    if (q.explanation.trim().length < 30) push(SEVERITY.WARN, `explanation is short (${q.explanation.trim().length} chars) — aim for >=30`);
    const m = SOURCE_LEAK.exec(q.explanation);
    if (m) push(SEVERITY.ERROR, `explanation leaks source material: "${m[0]}" — site is public, course/PDF references must be scrubbed`);
  }

  // Options — leak-scan each
  if (Array.isArray(q.options)) {
    q.options.forEach((o, i) => {
      if (typeof o !== "string") return;
      const m = SOURCE_LEAK.exec(o);
      if (m) push(SEVERITY.ERROR, `option ${i} leaks source material: "${m[0]}"`);
    });
  }

  return issues;
}

// --- bank-wide validators ----------------------------------------------------

/** Detects exact-stem duplicates after normalisation. */
export function findDuplicateStems(bank) {
  const seen = new Map();
  const dups = [];
  for (const q of bank) {
    const key = normaliseStem(q.question || "");
    if (seen.has(key)) dups.push({ id: q.id, dupOf: seen.get(key) });
    else seen.set(key, q.id);
  }
  return dups;
}

// Token-Jaccard near-duplicate detection — catches questions that re-test the
// same narrow topic even when the wording differs (e.g. a "which is correct"
// and a "which is incorrect" on the identical concept + option set).
const STEM_STOPWORDS = new Set(
  ("a an the of to in on for and or is are be as by with at from this that which following correct " +
   "incorrect statements statement about regarding among descriptions description option options select two")
    .split(" ")
);

function stemTokens(s) {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (w) => w.length > 2 && !STEM_STOPWORDS.has(w)
  );
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Returns pairs whose stem token-Jaccard >= threshold OR whose option sets
 * overlap heavily. These are likely-redundant questions even if not byte-identical.
 *
 * @param {Array<object>} bank
 * @param {object} [opts]
 * @param {number} [opts.stemThreshold=0.82]
 * @param {number} [opts.optOverlap=0.6]
 */
export function findNearDuplicateStems(bank, opts = {}) {
  const stemThreshold = opts.stemThreshold ?? 0.82;
  const optOverlap = opts.optOverlap ?? 0.6;
  const pre = bank.map((q) => ({
    id: q.id,
    tokens: stemTokens(q.question || ""),
    opts: new Set((q.options || []).map((o) => String(o).toLowerCase().trim())),
  }));
  const pairs = [];
  for (let i = 0; i < pre.length; i++) {
    for (let j = i + 1; j < pre.length; j++) {
      const js = jaccard(pre[i].tokens, pre[j].tokens);
      let ov = 0;
      if (pre[i].opts.size && pre[j].opts.size) {
        let inter = 0;
        for (const o of pre[i].opts) if (pre[j].opts.has(o)) inter++;
        ov = inter / Math.min(pre[i].opts.size, pre[j].opts.size);
      }
      if (js >= stemThreshold || ov >= optOverlap) {
        pairs.push({ a: pre[i].id, b: pre[j].id, stemJaccard: Math.round(js * 100) / 100, optOverlap: Math.round(ov * 100) / 100 });
      }
    }
  }
  return pairs;
}

/** Per-section count matches WEIGHTS proportions (within tolerance). */
export function checkSectionBalance(bank, opts = {}) {
  const tolerance = opts.tolerance ?? 0.04;
  const total = bank.length;
  const issues = [];
  const counts = {};
  for (const s of SECTIONS) counts[s] = 0;
  for (const q of bank) {
    if (q && typeof q.section === "string") counts[q.section] = (counts[q.section] || 0) + 1;
  }
  for (const s of SECTIONS) {
    const target = WEIGHTS[s];
    const actual = counts[s] / total;
    if (Math.abs(actual - target) > tolerance) {
      issues.push({
        severity: SEVERITY.WARN,
        message: `section "${s}" is ${(actual * 100).toFixed(1)}% (${counts[s]}/${total}); target ${(target * 100).toFixed(0)}% (tolerance ±${(tolerance * 100).toFixed(0)}%)`,
      });
    }
  }
  return issues;
}

/**
 * Canonical casing for H3C/CAS terms.
 * Returns WARN-level issues for non-canonical occurrences anywhere in the bank.
 *
 * - IQN: uppercase as an acronym, but the prefix in actual IQN strings is always lowercase ("iqn.YYYY-MM..."). The check excludes "iqn." (followed by a dot).
 * - K8s: mixed-case is canonical (Kubernetes shortform).
 * - qcow2 / qemu / qemu-img: lowercase canonical (file format / command names).
 */
export const CANONICAL_CASING = Object.freeze({
  CAS:     /\b(?:Cas|cas)\b/g,
  CVK:     /\b(?:Cvk|cvk)\b/g,
  CVM:     /\b(?:Cvm|cvm)\b/g,
  H3C:     /\b(?:H3c|h3c)\b/g,
  OCFS2:   /\b(?:Ocfs2|ocfs2)\b/g,
  TPS:     /\b(?:Tps|tps)\b/g,
  K8s:     /\b(?:K8S|k8s|k8S)\b/g,
  qcow2:   /\bQCOW2\b/g,
  qemu:    /\b(?:QEMU|Qemu)\b/g,
});

export function checkTerminologyCasing(bank) {
  const issues = [];
  for (const q of bank) {
    const fields = [
      ["question", q?.question || ""],
      ...(Array.isArray(q?.options) ? q.options.map((o, i) => [`option ${i}`, o || ""]) : []),
      ["explanation", q?.explanation || ""],
    ];
    for (const [field, text] of fields) {
      for (const [canon, pat] of Object.entries(CANONICAL_CASING)) {
        const re = new RegExp(pat.source, pat.flags);
        let m;
        while ((m = re.exec(text)) !== null) {
          // skip "iqn." inside IQN strings — not relevant here since IQN's pattern is only its acronym variant
          issues.push({ id: q?.id, severity: SEVERITY.WARN, message: `${field}: "${m[0]}" should be canonical "${canon}"` });
        }
      }
    }
  }
  return issues;
}

/** Per-format mix matches 40/30/30 (within tolerance). */
export function checkFormatBalance(bank, opts = {}) {
  const targets = opts.targets ?? { single: 0.40, multi: 0.30, negative: 0.30 };
  const tolerance = opts.tolerance ?? 0.05;
  const total = bank.length;
  const counts = { single: 0, multi: 0, negative: 0 };
  for (const q of bank) {
    if (q && typeof q.format === "string" && q.format in counts) counts[q.format]++;
  }
  const issues = [];
  for (const f of Object.keys(targets)) {
    const actual = counts[f] / total;
    if (Math.abs(actual - targets[f]) > tolerance) {
      issues.push({
        severity: SEVERITY.WARN,
        message: `format "${f}" is ${(actual * 100).toFixed(1)}% (${counts[f]}/${total}); target ${(targets[f] * 100).toFixed(0)}% (tolerance ±${(tolerance * 100).toFixed(0)}%)`,
      });
    }
  }
  return issues;
}

/** All-questions-unique check on ids. */
export function findDuplicateIds(bank) {
  const seen = new Set();
  const dups = [];
  for (const q of bank) {
    if (!q?.id) continue;
    if (seen.has(q.id)) dups.push(q.id);
    seen.add(q.id);
  }
  return dups;
}

// --- aggregate ---------------------------------------------------------------

/**
 * Validate the whole bank. Returns { errors, warnings, summary }.
 *
 * @param {Array<object>} bank
 * @param {object} [opts]
 * @returns {{ errors: Array<{id?:string,severity:string,message:string}>, warnings: Array<{id?:string,severity:string,message:string}>, summary: object }}
 */
export function validateBank(bank, opts = {}) {
  const errors = [];
  const warnings = [];
  const push = (issue) => (issue.severity === SEVERITY.ERROR ? errors : warnings).push(issue);

  if (!Array.isArray(bank)) {
    errors.push({ severity: SEVERITY.ERROR, message: "bank is not an array" });
    return { errors, warnings, summary: { total: 0 } };
  }

  // Per-question
  for (const q of bank) {
    for (const issue of validateQuestion(q)) push(issue);
  }

  // Duplicate ids
  for (const id of findDuplicateIds(bank)) {
    push({ id, severity: SEVERITY.ERROR, message: "duplicate id" });
  }

  // Duplicate stems (exact)
  for (const d of findDuplicateStems(bank)) {
    push({ id: d.id, severity: SEVERITY.ERROR, message: `duplicate stem of ${d.dupOf}` });
  }

  // Near-duplicate stems / option-sets (redundant topic coverage)
  for (const p of findNearDuplicateStems(bank, opts.nearDup)) {
    push({ id: p.a, severity: SEVERITY.WARN, message: `near-duplicate of ${p.b} (stem ${p.stemJaccard}, options ${p.optOverlap}) — verify they don't test the same narrow topic` });
  }

  // Balance
  for (const issue of checkSectionBalance(bank, opts.section)) push(issue);
  for (const issue of checkFormatBalance(bank, opts.format)) push(issue);

  // Terminology casing
  for (const issue of checkTerminologyCasing(bank)) push(issue);

  const summary = {
    total: bank.length,
    bySection: Object.fromEntries(SECTIONS.map((s) => [s, bank.filter((q) => q.section === s).length])),
    byFormat: { single: 0, multi: 0, negative: 0 },
  };
  for (const q of bank) {
    if (q && summary.byFormat[q.format] !== undefined) summary.byFormat[q.format]++;
  }

  return { errors, warnings, summary };
}
