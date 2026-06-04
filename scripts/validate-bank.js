#!/usr/bin/env node
// CLI: validate the bank file. Exit non-zero on any ERROR.
// Pass --warn-as-error to also fail on WARN-level issues.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateBank, SEVERITY } from "../public/assets/js/lib/schema.js";

const args = process.argv.slice(2);
const warnAsError = args.includes("--warn-as-error");
const bankPath = resolve(process.cwd(), args.find((a) => !a.startsWith("--")) || "public/assets/data/bank.json");

const RESET = "\x1b[0m";
const RED   = "\x1b[31m";
const YEL   = "\x1b[33m";
const GRN   = "\x1b[32m";
const DIM   = "\x1b[2m";

function fmtIssue(i) {
  const tag = i.severity === SEVERITY.ERROR ? `${RED}ERROR${RESET}` : `${YEL}WARN ${RESET}`;
  const id = i.id ? `${DIM}[${i.id}]${RESET} ` : "";
  return `  ${tag} ${id}${i.message}`;
}

let bank;
try {
  bank = JSON.parse(readFileSync(bankPath, "utf8"));
} catch (e) {
  console.error(`${RED}Failed to read bank at ${bankPath}:${RESET} ${e.message}`);
  process.exit(2);
}

const { errors, warnings, summary } = validateBank(bank);

console.log(`Bank: ${bankPath}`);
console.log(`Total questions: ${summary.total}`);
console.log(`Format mix: single=${summary.byFormat.single} multi=${summary.byFormat.multi} negative=${summary.byFormat.negative}`);
console.log(`Per section:`);
for (const [s, n] of Object.entries(summary.bySection)) console.log(`  ${s}: ${n}`);
console.log("");

if (errors.length === 0 && warnings.length === 0) {
  console.log(`${GRN}OK — no issues.${RESET}`);
  process.exit(0);
}

if (errors.length) {
  console.log(`${RED}${errors.length} error${errors.length === 1 ? "" : "s"}:${RESET}`);
  for (const i of errors) console.log(fmtIssue(i));
  console.log("");
}
if (warnings.length) {
  console.log(`${YEL}${warnings.length} warning${warnings.length === 1 ? "" : "s"}:${RESET}`);
  for (const i of warnings) console.log(fmtIssue(i));
  console.log("");
}

if (errors.length > 0) process.exit(1);
if (warnAsError && warnings.length > 0) process.exit(1);
process.exit(0);
