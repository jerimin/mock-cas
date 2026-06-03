/* PDF detailed-report builder — pdf-lib, Worker-compatible.
   Layout: cover (score + tallies + section breakdown + recs) -> Q-by-Q review pages.
*/
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

type RGB = { r: number; g: number; b: number };
const Color = {
  ink:        { r: 0.06, g: 0.14, b: 0.29 },   // #0F2549
  muted:      { r: 0.35, g: 0.39, b: 0.46 },   // #5A6276
  subtle:     { r: 0.55, g: 0.58, b: 0.63 },   // #8B91A0
  border:     { r: 0.89, g: 0.91, b: 0.94 },   // #E4E7EB
  surface2:   { r: 0.96, g: 0.96, b: 0.98 },   // #F6F7FB
  accent:     { r: 0.95, g: 0.50, b: 0.13 },   // #F38020 — CF orange
  accentDark: { r: 0.85, g: 0.43, b: 0.08 },
  accentSoft: { r: 1.00, g: 0.91, b: 0.83 },
  success:    { r: 0.12, g: 0.61, b: 0.36 },   // #1F9C5B
  successSoft:{ r: 0.89, g: 0.96, b: 0.92 },
  danger:     { r: 0.84, g: 0.27, b: 0.23 },   // #D6443B
  dangerSoft: { r: 0.98, g: 0.90, b: 0.89 },
  warning:    { r: 0.79, g: 0.54, b: 0.09 },   // #C98A16
  warningSoft:{ r: 0.98, g: 0.95, b: 0.86 },
};

const toRgb = (c: RGB) => rgb(c.r, c.g, c.b);

const PAGE_W = 595.28; // A4 width pt
const PAGE_H = 841.89; // A4 height pt
const M = 40; // margin
const CONTENT_W = PAGE_W - 2 * M;

interface Report {
  score: number;
  total: number;
  pct: number;
  passed: boolean;
  tookFmt: string;
  correctCount: number;
  partialCount: number;
  incorrectCount: number;
  skippedCount: number;
  perSection: Array<{ section: string; correct: number; partial: number; incorrect: number; skipped: number; total: number; pct: number }>;
  weakest: Array<{ section: string; pct: number; advice: string }>;
  items: Array<{ idx: number; section: string; question: string; options: string[]; correctLetters: string[]; pickedLetters: string[]; status: string; explanation: string }>;
}

interface Ctx {
  pdf: PDFDocument;
  font: PDFFont;
  fontBold: PDFFont;
  page: PDFPage;
  y: number;
}

// ---- low-level helpers ----------------------------------------------------
const sanitize = (s: string): string => {
  // WinAnsi font can't render emoji/non-Latin → replace lookalikes
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[ ]/g, " ")
    .replace(/[…]/g, "...")
    .replace(/[→]/g, "->")
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[·]/g, "-")
    .replace(/[©]/g, "(c)")
    .replace(/[^\x00-\x7F]/g, "?");
};

const wrap = (font: PDFFont, text: string, size: number, maxW: number): string[] => {
  const lines: string[] = [];
  const paragraphs = sanitize(text).split("\n");
  for (const p of paragraphs) {
    const words = p.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const test = line + w;
      if (font.widthOfTextAtSize(test, size) <= maxW) {
        line = test;
      } else {
        if (line.trim()) lines.push(line.trimEnd());
        line = w.trimStart();
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
  }
  return lines;
};

const newPage = (ctx: Ctx) => {
  ctx.page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - M;
  drawRunningHeader(ctx);
};

const ensure = (ctx: Ctx, needHeight: number) => {
  if (ctx.y - needHeight < M + 30) newPage(ctx);
};

const drawText = (ctx: Ctx, text: string, x: number, y: number, opts: { size?: number; font?: PDFFont; color?: RGB; maxWidth?: number } = {}) => {
  const size = opts.size ?? 10;
  const font = opts.font ?? ctx.font;
  const color = opts.color ?? Color.ink;
  ctx.page.drawText(sanitize(text), { x, y, size, font, color: toRgb(color), maxWidth: opts.maxWidth });
};

const drawWrappedText = (ctx: Ctx, text: string, x: number, size: number, color: RGB, maxW: number, useBold = false, lineHeight = 1.35): number => {
  const font = useBold ? ctx.fontBold : ctx.font;
  const lines = wrap(font, text, size, maxW);
  const lh = size * lineHeight;
  for (const line of lines) {
    ensure(ctx, lh);
    drawText(ctx, line, x, ctx.y - size, { size, font, color });
    ctx.y -= lh;
  }
  return lines.length * lh;
};

const drawRect = (ctx: Ctx, x: number, y: number, w: number, h: number, fill?: RGB, stroke?: RGB, sw = 0.6) => {
  ctx.page.drawRectangle({
    x, y, width: w, height: h,
    color: fill ? toRgb(fill) : undefined,
    borderColor: stroke ? toRgb(stroke) : undefined,
    borderWidth: stroke ? sw : 0,
  });
};

// ---- header / footer ------------------------------------------------------
const drawRunningHeader = (ctx: Ctx) => {
  // brand mark
  drawRect(ctx, M, PAGE_H - M + 8, 22, 22, Color.accent);
  drawText(ctx, "CAS", M + 4, PAGE_H - M + 14, { size: 9, font: ctx.fontBold, color: { r: 1, g: 1, b: 1 } });
  drawText(ctx, "GB0-713 Mock — Detailed Report", M + 30, PAGE_H - M + 14, { size: 10, font: ctx.fontBold, color: Color.ink });
  // page number on right
  const pageNum = ctx.pdf.getPageCount();
  drawText(ctx, `Page ${pageNum}`, PAGE_W - M - 50, PAGE_H - M + 14, { size: 9, color: Color.subtle });
  // divider line
  ctx.page.drawLine({ start: { x: M, y: PAGE_H - M }, end: { x: PAGE_W - M, y: PAGE_H - M }, color: toRgb(Color.border), thickness: 0.5 });
};

// ---- sections -------------------------------------------------------------
const drawCover = (ctx: Ctx, r: Report) => {
  ctx.y -= 18;

  // Title
  drawText(ctx, "Your detailed report", M, ctx.y, { size: 22, font: ctx.fontBold, color: Color.ink });
  ctx.y -= 22;
  drawText(ctx, "H3CNE-Cloud · Deploy and Manage the H3C CAS Virtualization Platform", M, ctx.y, { size: 10, color: Color.muted });
  ctx.y -= 22;

  // Score banner
  const passColor = r.passed ? Color.successSoft : Color.dangerSoft;
  const passText = r.passed ? Color.success : Color.danger;
  const bannerH = 84;
  drawRect(ctx, M, ctx.y - bannerH, CONTENT_W, bannerH, passColor, passText, 1);
  // score
  const scoreStr = `${r.score}`;
  const totalStr = ` / ${r.total}`;
  const scoreSize = 34;
  drawText(ctx, scoreStr, M + 18, ctx.y - 36, { size: scoreSize, font: ctx.fontBold, color: Color.ink });
  const scoreW = ctx.fontBold.widthOfTextAtSize(scoreStr, scoreSize);
  drawText(ctx, totalStr, M + 18 + scoreW + 2, ctx.y - 36, { size: 18, color: Color.muted });
  drawText(ctx, `${r.pct}%  -  ${r.passed ? "Pass (>=60%)" : "Below pass mark (60%)"}`, M + 18, ctx.y - 58, { size: 12, font: ctx.fontBold, color: passText });
  drawText(ctx, `Took ${r.tookFmt}  -  ${r.correctCount} correct  -  ${r.partialCount} partial  -  ${r.incorrectCount} incorrect  -  ${r.skippedCount} skipped`, M + 18, ctx.y - 72, { size: 9, color: Color.muted });
  ctx.y -= bannerH + 22;

  // 4 tallies
  const cardW = (CONTENT_W - 30) / 4;
  const cardH = 56;
  const tallies = [
    { label: "CORRECT",   value: r.correctCount,   color: Color.success,  soft: Color.successSoft },
    { label: "PARTIAL",   value: r.partialCount,   color: Color.warning,  soft: Color.warningSoft },
    { label: "INCORRECT", value: r.incorrectCount, color: Color.danger,   soft: Color.dangerSoft  },
    { label: "SKIPPED",   value: r.skippedCount,   color: Color.muted,    soft: Color.surface2    },
  ];
  for (let i = 0; i < 4; i++) {
    const x = M + i * (cardW + 10);
    drawRect(ctx, x, ctx.y - cardH, cardW, cardH, tallies[i].soft, Color.border, 0.6);
    // colored bar on left
    drawRect(ctx, x, ctx.y - cardH, 3, cardH, tallies[i].color);
    drawText(ctx, tallies[i].label, x + 12, ctx.y - 16, { size: 8, font: ctx.fontBold, color: Color.subtle });
    drawText(ctx, String(tallies[i].value), x + 12, ctx.y - 42, { size: 22, font: ctx.fontBold, color: tallies[i].color });
  }
  ctx.y -= cardH + 22;

  // Section breakdown
  ensure(ctx, 30 + r.perSection.length * 18);
  drawText(ctx, "Section breakdown", M, ctx.y, { size: 14, font: ctx.fontBold, color: Color.ink });
  ctx.y -= 18;
  // Header row
  const colX = [M, M + 240, M + 280, M + 320, M + 360, M + 410];
  const headers = ["Section", "OK", "1/2", "X", "%", ""];
  for (let i = 0; i < headers.length; i++) {
    drawText(ctx, headers[i], colX[i], ctx.y, { size: 8, font: ctx.fontBold, color: Color.subtle });
  }
  ctx.y -= 14;
  ctx.page.drawLine({ start: { x: M, y: ctx.y + 4 }, end: { x: PAGE_W - M, y: ctx.y + 4 }, color: toRgb(Color.border), thickness: 0.5 });
  ctx.y -= 4;
  for (const s of r.perSection) {
    ensure(ctx, 20);
    drawText(ctx, s.section, colX[0], ctx.y - 8, { size: 10, color: Color.ink });
    drawText(ctx, String(s.correct), colX[1], ctx.y - 8, { size: 10, color: Color.ink });
    drawText(ctx, String(s.partial), colX[2], ctx.y - 8, { size: 10, color: Color.ink });
    drawText(ctx, String(s.incorrect), colX[3], ctx.y - 8, { size: 10, color: Color.ink });
    drawText(ctx, `${s.pct}%`, colX[4], ctx.y - 8, { size: 10, font: ctx.fontBold, color: Color.ink });
    // bar
    const barW = 130;
    const filledW = (barW * Math.max(0, Math.min(100, s.pct))) / 100;
    const barColor = s.pct >= 80 ? Color.success : s.pct < 60 ? Color.danger : Color.accent;
    drawRect(ctx, colX[5], ctx.y - 7, barW, 5, Color.surface2);
    drawRect(ctx, colX[5], ctx.y - 7, filledW, 5, barColor);
    ctx.y -= 16;
  }
  ctx.y -= 12;

  // Recommendations
  ensure(ctx, 30 + r.weakest.length * 40);
  drawText(ctx, "Recommendations", M, ctx.y, { size: 14, font: ctx.fontBold, color: Color.ink });
  ctx.y -= 16;
  if (r.weakest.length === 0) {
    drawWrappedText(ctx, "Strong across every module - keep practising to lock in.", M, 10, Color.muted, CONTENT_W);
  } else {
    for (const w of r.weakest) {
      const barColor = w.pct < 50 ? Color.danger : Color.warning;
      ensure(ctx, 56);
      const startY = ctx.y;
      // background card
      drawRect(ctx, M, ctx.y - 50, CONTENT_W, 50, Color.surface2, Color.border, 0.5);
      // left accent bar
      drawRect(ctx, M, ctx.y - 50, 3, 50, barColor);
      drawText(ctx, `${w.section} - ${w.pct}%`, M + 12, ctx.y - 14, { size: 11, font: ctx.fontBold, color: Color.ink });
      ctx.y -= 18;
      const usedH = drawWrappedText(ctx, w.advice, M + 12, 9, Color.muted, CONTENT_W - 18);
      // ensure card height covers content
      ctx.y = Math.min(ctx.y, startY - 50);
      ctx.y -= 6;
    }
  }
};

// ---- per-question review --------------------------------------------------
const drawQuestionReview = (ctx: Ctx, r: Report) => {
  newPage(ctx);
  ctx.y -= 18;
  drawText(ctx, "Question-by-question review", M, ctx.y, { size: 18, font: ctx.fontBold, color: Color.ink });
  ctx.y -= 8;
  drawText(ctx, `${r.items.length} questions - your answer, the correct answer, and an explanation`, M, ctx.y - 8, { size: 10, color: Color.muted });
  ctx.y -= 28;

  for (const it of r.items) {
    const statusMeta = (() => {
      switch (it.status) {
        case "correct":   return { label: "CORRECT",   bg: Color.successSoft, fg: Color.success };
        case "partial":   return { label: "PARTIAL",   bg: Color.warningSoft, fg: Color.warning };
        case "incorrect": return { label: "INCORRECT", bg: Color.dangerSoft,  fg: Color.danger  };
        default:          return { label: "SKIPPED",   bg: Color.surface2,    fg: Color.muted   };
      }
    })();

    // approx height check
    const stemH = wrap(ctx.font, it.question, 10, CONTENT_W - 20).length * 14;
    const optsH = it.options.length * 14;
    const explH = wrap(ctx.font, it.explanation, 9, CONTENT_W - 20).length * 12;
    const cardH = 20 + stemH + 10 + optsH + 10 + explH + 16;
    ensure(ctx, cardH + 10);

    const topY = ctx.y;
    // card bg
    drawRect(ctx, M, topY - cardH, CONTENT_W, cardH, { r: 1, g: 1, b: 1 }, Color.border, 0.6);
    // status pill
    const pillW = 70;
    drawRect(ctx, PAGE_W - M - pillW - 12, topY - 24, pillW, 16, statusMeta.bg);
    drawText(ctx, statusMeta.label, PAGE_W - M - pillW - 12 + 10, topY - 20, { size: 8, font: ctx.fontBold, color: statusMeta.fg });
    // section + idx
    drawText(ctx, `${it.idx}. ${it.section}`.toUpperCase(), M + 12, topY - 18, { size: 8, font: ctx.fontBold, color: Color.subtle });
    ctx.y = topY - 32;
    // stem
    drawWrappedText(ctx, it.question, M + 12, 10, Color.ink, CONTENT_W - 24, true, 1.4);
    ctx.y -= 4;
    // options
    for (let i = 0; i < it.options.length; i++) {
      const letter = String.fromCharCode(65 + i);
      const isCorrect = it.correctLetters.includes(letter);
      const isPicked = it.pickedLetters.includes(letter);
      const lineColor = isCorrect ? Color.success : (isPicked && !isCorrect) ? Color.danger : Color.ink;
      const marker = isCorrect ? "[OK] " : (isPicked && !isCorrect) ? "[X] " : "    ";
      drawWrappedText(ctx, marker + it.options[i], M + 18, 9, lineColor, CONTENT_W - 30, false, 1.4);
    }
    ctx.y -= 4;
    // your picks line
    const yourPicks = it.pickedLetters.length ? it.pickedLetters.join(", ") : "-";
    const correctAns = it.correctLetters.join(", ");
    drawText(ctx, `Correct: ${correctAns}    Your pick: ${yourPicks}`, M + 12, ctx.y - 8, { size: 9, font: ctx.fontBold, color: Color.muted });
    ctx.y -= 14;
    // explanation
    drawText(ctx, "Why:", M + 12, ctx.y - 8, { size: 8, font: ctx.fontBold, color: Color.subtle });
    ctx.y -= 12;
    drawWrappedText(ctx, it.explanation, M + 12, 9, Color.muted, CONTENT_W - 24, false, 1.4);
    // close card by jumping to bottom
    ctx.y = topY - cardH - 10;
  }
};

// ---- main entry -----------------------------------------------------------
export async function buildReportPdf(report: Report): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("GB0-713 Mock — Detailed Report");
  pdf.setCreator("mock.mymine.space");
  pdf.setProducer("pdf-lib");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { pdf, font, fontBold, page: pdf.addPage([PAGE_W, PAGE_H]), y: PAGE_H - M };
  drawRunningHeader(ctx);
  drawCover(ctx, report);
  drawQuestionReview(ctx, report);
  return await pdf.save();
}

// ---- base64 helper --------------------------------------------------------
export function uint8ToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(s);
}
