// Pure utilities — usable in browser, Node (Vitest), and Worker.

/** Fisher-Yates in-place-ish shuffle, returns a new array. */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Set equality on two arrays of primitives. Order-independent, duplicate-tolerant. */
export function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/** Normalise a stem for duplicate detection — collapses whitespace, lower-cases, strips trailing punctuation. */
export function normaliseStem(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!?;:,]+$/, "");
}
