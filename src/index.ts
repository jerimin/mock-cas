import { buildReportPdf, uint8ToBase64 } from "./pdf";

export interface Env {
  ASSETS: Fetcher;
  STATS_KV: KVNamespace;
  SMTP2GO_API_KEY?: string;          // set as secret in CF dashboard (shared with clouddigit-site)
  SENDER_EMAIL?: string;             // default do-not-reply@mymine.space (DKIM-verified)
  SENDER_NAME?: string;              // default "GB0-713 Mock Exam"
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const j = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, "cache-control": "no-store" },
  });

// ---------- visitor identity (privacy-friendly, no IP stored) ----------
const todayUTC = () => new Date().toISOString().slice(0, 10);
const minuteBucketUTC = () => {
  const d = new Date();
  return `${d.toISOString().slice(0, 16)}`; // YYYY-MM-DDTHH:MM
};

async function hash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function visitorId(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || "0";
  const ua = request.headers.get("user-agent") || "";
  // hash IP+UA so we don't store raw IPs anywhere
  return hash(`${ip}|${ua}`);
}

// ---------- track endpoint ----------
async function track(request: Request, env: Env): Promise<Response> {
  const id = await visitorId(request);
  const now = Date.now();
  const day = todayUTC();
  const minute = minuteBucketUTC();

  // Active (last 5 min): write key per (minute, visitor) with TTL 5min
  await env.STATS_KV.put(`a:${minute}:${id}`, "1", { expirationTtl: 5 * 60 });

  // Unique per day: write key per (day, visitor) with TTL 36h (covers UTC rollover)
  const dayKey = `u:${day}:${id}`;
  const existing = await env.STATS_KV.get(dayKey);
  let newUnique = false;
  if (!existing) {
    await env.STATS_KV.put(dayKey, "1", { expirationTtl: 36 * 60 * 60 });
    newUnique = true;
  }

  // Total visits: only increment for new unique-per-day to count "visitors", not page hits
  if (newUnique) {
    const cur = parseInt((await env.STATS_KV.get("total")) || "0", 10);
    await env.STATS_KV.put("total", String(cur + 1));
  }

  return j({ ok: true, t: now });
}

// ---------- stats endpoint ----------
async function stats(env: Env): Promise<Response> {
  // active: count active keys across the last 5 minute buckets
  const now = new Date();
  const buckets: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(now.getTime() - i * 60 * 1000);
    buckets.push(d.toISOString().slice(0, 16));
  }
  const activeIds = new Set<string>();
  for (const b of buckets) {
    const list = await env.STATS_KV.list({ prefix: `a:${b}:` });
    for (const k of list.keys) {
      const id = k.name.split(":").pop();
      if (id) activeIds.add(id);
    }
  }

  // unique today
  const day = todayUTC();
  const uniqueList = await env.STATS_KV.list({ prefix: `u:${day}:` });
  const unique = uniqueList.keys.length;

  // total
  const total = parseInt((await env.STATS_KV.get("total")) || "0", 10);

  return j({ active: activeIds.size, unique, total, ts: Date.now() });
}

// ---------- email send helper (SMTP2GO REST) ----------
interface Attachment { filename: string; fileblob: string; mimetype: string; }
async function sendEmail(env: Env, to: string, subject: string, html: string, text: string, attachments?: Attachment[]): Promise<{ ok: true } | { ok: false; status: number; error: string; detail?: any }> {
  if (!env.SMTP2GO_API_KEY) return { ok: false, status: 503, error: "Email service not configured on this deployment." };
  const senderEmail = env.SENDER_EMAIL || "do-not-reply@mymine.space";
  const senderName = env.SENDER_NAME || "GB0-713 Mock Exam";
  const payload: Record<string, any> = {
    api_key: env.SMTP2GO_API_KEY,
    to: [to],
    sender: `${senderName} <${senderEmail}>`,
    subject,
    html_body: html,
    text_body: text,
  };
  if (attachments && attachments.length) payload.attachments = attachments;
  const res = await fetch("https://api.smtp2go.com/v3/email/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, status: 502, error: `Email provider returned ${res.status}`, detail: errText.slice(0, 400) };
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (data?.data?.succeeded >= 1) return { ok: true };
  return { ok: false, status: 502, error: "Email rejected by provider.", detail: data };
}

// ---------- 6-digit verification code ----------
const CODE_TTL_SEC = 10 * 60;    // 10 minutes
const CODE_MAX_ATTEMPTS = 5;

function generateCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(100000 + (n % 900000));
}

function vcKey(email: string): string { return `vc:${email}`; }

function emailValid(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// POST /api/email-verify-init { email, report }
async function emailVerifyInit(request: Request, env: Env): Promise<Response> {
  if (!env.SMTP2GO_API_KEY) return j({ ok: false, error: "Email service not configured on this deployment." }, 503);
  let body: any;
  try { body = await request.json(); } catch { return j({ ok: false, error: "Invalid JSON body." }, 400); }
  const email = (body?.email || "").toString().trim().toLowerCase();
  const report = body?.report;
  if (!emailValid(email)) return j({ ok: false, error: "Invalid email address." }, 400);
  if (!report || typeof report !== "object") return j({ ok: false, error: "Missing report payload." }, 400);

  const code = generateCode();
  const record = { code, report, attempts: 0, createdAt: Date.now() };
  await env.STATS_KV.put(vcKey(email), JSON.stringify(record), { expirationTtl: CODE_TTL_SEC });

  const send = await sendEmail(
    env,
    email,
    `Your GB0-713 mock — verification code ${code}`,
    renderCodeEmailHtml(code),
    renderCodeEmailText(code),
  );
  if (!send.ok) return j({ ok: false, error: send.error, detail: (send as any).detail }, send.status);

  return j({ ok: true, ttl: CODE_TTL_SEC });
}

// POST /api/email-verify-confirm { email, code }
async function emailVerifyConfirm(request: Request, env: Env): Promise<Response> {
  if (!env.SMTP2GO_API_KEY) return j({ ok: false, error: "Email service not configured on this deployment." }, 503);
  let body: any;
  try { body = await request.json(); } catch { return j({ ok: false, error: "Invalid JSON body." }, 400); }
  const email = (body?.email || "").toString().trim().toLowerCase();
  const code = (body?.code || "").toString().trim();
  if (!emailValid(email)) return j({ ok: false, error: "Invalid email address." }, 400);
  if (!/^\d{6}$/.test(code)) return j({ ok: false, error: "Code must be 6 digits." }, 400);

  const raw = await env.STATS_KV.get(vcKey(email));
  if (!raw) return j({ ok: false, error: "No active verification. Request a new code." }, 410);

  let record: any;
  try { record = JSON.parse(raw); } catch { record = null; }
  if (!record || !record.code || !record.report) {
    await env.STATS_KV.delete(vcKey(email));
    return j({ ok: false, error: "Verification record corrupted. Request a new code." }, 500);
  }

  if (record.attempts >= CODE_MAX_ATTEMPTS) {
    await env.STATS_KV.delete(vcKey(email));
    return j({ ok: false, error: "Too many failed attempts. Request a new code." }, 429);
  }

  if (record.code !== code) {
    record.attempts = (record.attempts || 0) + 1;
    const remaining = CODE_MAX_ATTEMPTS - record.attempts;
    if (remaining <= 0) {
      await env.STATS_KV.delete(vcKey(email));
      return j({ ok: false, error: "Too many failed attempts. Request a new code." }, 429);
    }
    // re-store with bumped attempt count; keep TTL roughly equal to original window
    const ageSec = Math.floor((Date.now() - (record.createdAt || Date.now())) / 1000);
    const remainTtl = Math.max(60, CODE_TTL_SEC - ageSec);
    await env.STATS_KV.put(vcKey(email), JSON.stringify(record), { expirationTtl: remainTtl });
    return j({ ok: false, error: `Wrong code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.` }, 401);
  }

  // Match — generate PDF, send colorful summary email with PDF attached, consume the code
  const report = record.report;
  let pdfAttachment: Attachment | undefined;
  try {
    const pdfBytes = await buildReportPdf(report);
    pdfAttachment = {
      filename: `gb0-713-mock-report-${report.score}-of-${report.total}.pdf`,
      fileblob: uint8ToBase64(pdfBytes),
      mimetype: "application/pdf",
    };
  } catch (e: any) {
    // PDF generation failure shouldn't block the email — log and continue with HTML-only
    console.log("pdf gen failed:", e?.message || e);
  }

  const html = renderSummaryHtml(report, !!pdfAttachment);
  const text = renderEmailText(report);
  const send = await sendEmail(
    env,
    email,
    `Your GB0-713 mock exam result — ${report.score}/${report.total} (${report.pct}%)`,
    html,
    text,
    pdfAttachment ? [pdfAttachment] : undefined,
  );
  // delete regardless to prevent replay
  await env.STATS_KV.delete(vcKey(email));
  if (!send.ok) return j({ ok: false, error: send.error, detail: (send as any).detail }, send.status);

  return j({ ok: true });
}

// ---------- verification-code email body ----------
function renderCodeEmailHtml(code: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Your verification code</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;margin:0;padding:32px;color:#1d2233;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(15,20,38,.08);text-align:center;">
  <div style="display:inline-block;background:linear-gradient(135deg,#F38020,#FAAD3F);color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;font-size:12px;letter-spacing:.04em;margin-bottom:18px;">GB0-713 MOCK</div>
  <h1 style="margin:0 0 8px;font-size:20px;">Verify your email</h1>
  <p style="margin:0 0 24px;color:#5a6276;font-size:14px;">Enter this 6-digit code on the mock exam results page to receive your detailed report.</p>
  <div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:44px;font-weight:700;letter-spacing:0.18em;padding:18px 28px;background:#f6f7fb;border:1px solid #e4e7eb;border-radius:10px;color:#0f2549;">${code}</div>
  <p style="margin:24px 0 0;color:#8b91a0;font-size:12px;">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
</div>
</body></html>`;
}

function renderCodeEmailText(code: string): string {
  return [
    "GB0-713 mock exam — verification code",
    "",
    `Your 6-digit code: ${code}`,
    "",
    "Enter this code on the results page to receive your detailed report.",
    "Expires in 10 minutes. If you didn't request this, ignore this email.",
  ].join("\n");
}

// ---------- email renderers ----------
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function renderSummaryHtml(r: any, hasPdf: boolean): string {
  const sections = (r.perSection || []) as Array<{ section: string; correct: number; partial: number; incorrect: number; total: number; pct: number }>;
  const weak = (r.weakest || []) as Array<{ section: string; pct: number; advice: string }>;
  const beh = r.behaviour || null;
  const passColor = r.passed ? "#1f9c5b" : "#d6443b";
  const passBg = r.passed ? "linear-gradient(135deg,#1f9c5b,#16a463)" : "linear-gradient(135deg,#d6443b,#b8392f)";
  const passLabel = r.passed ? "Pass" : "Below pass mark";
  const passEmoji = r.passed ? "" : "";

  const fmtMMSS = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60), ss = s % 60;
    return `${m}:${String(ss).padStart(2, "0")}`;
  };

  const behStat = (label: string, value: string, sub: string) =>
    `<td style="width:25%;padding:5px;"><div style="background:#f6f7fb;border:1px solid #e4e7eb;border-radius:8px;padding:10px 12px;text-align:left;"><div style="font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#8b91a0;font-weight:700;">${label}</div><div style="font-size:17px;font-weight:800;color:#0f2549;margin-top:2px;line-height:1.15;font-variant-numeric:tabular-nums;">${value}</div><div style="font-size:11px;color:#5a6276;margin-top:1px;">${sub}</div></div></td>`;

  const behInsight = (tag: string, fg: string, bg: string, items: any[]) => items.length === 0 ? "" :
    `<div style="margin-top:6px;background:${bg};border-radius:6px;padding:8px 12px;font-size:12px;color:#5a6276;">
      <span style="display:inline-block;background:${fg};color:#fff;font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:2px 8px;border-radius:99px;margin-right:6px;">${escapeHtml(tag)}</span>
      <ul style="margin:4px 0 0 18px;padding:0;line-height:1.5;">${items.map((s) => `<li>${escapeHtml(s.section)} - ${s.pct}%, ${s.avgQSec}s/Q</li>`).join("")}</ul>
    </div>`;

  const tally = (label: string, val: number, fg: string, bg: string) =>
    `<td style="width:25%;padding:6px;"><div style="background:${bg};border-radius:8px;padding:14px 10px;text-align:center;border:1px solid ${fg}33;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${fg};font-weight:700;">${label}</div><div style="font-size:26px;font-weight:800;color:${fg};margin-top:4px;line-height:1;">${val}</div></div></td>`;

  const sectionRow = (s: { section: string; correct: number; partial: number; incorrect: number; pct: number }) => {
    const barColor = s.pct >= 80 ? "#1f9c5b" : s.pct < 60 ? "#d6443b" : "#f38020";
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e7eb;font-size:13px;color:#0f2549;">${escapeHtml(s.section)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e7eb;font-size:12px;color:#1f9c5b;text-align:center;font-weight:700;">${s.correct}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e7eb;font-size:12px;color:#c98a16;text-align:center;font-weight:700;">${s.partial}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e7eb;font-size:12px;color:#d6443b;text-align:center;font-weight:700;">${s.incorrect}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e7eb;font-size:13px;color:#0f2549;text-align:right;font-weight:700;">${s.pct}%</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e7eb;width:120px;">
        <div style="height:6px;background:#f6f7fb;border-radius:99px;overflow:hidden;"><div style="height:100%;width:${Math.min(100,s.pct)}%;background:${barColor};border-radius:inherit;"></div></div>
      </td>
    </tr>`;
  };

  const recCard = (w: { section: string; pct: number; advice: string }) => {
    const barColor = w.pct < 50 ? "#d6443b" : "#c98a16";
    return `<div style="background:#f6f7fb;border-left:4px solid ${barColor};border-radius:8px;padding:14px 16px;margin-bottom:10px;">
      <div style="font-weight:700;font-size:14px;color:#0f2549;margin-bottom:4px;">${escapeHtml(w.section)} - ${w.pct}%</div>
      <div style="font-size:13px;color:#5a6276;line-height:1.5;">${escapeHtml(w.advice)}</div>
    </div>`;
  };

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GB0-713 mock — your result</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#0f2549;">
<div style="max-width:640px;margin:0 auto;">

  <!-- header / brand -->
  <div style="background:linear-gradient(135deg,#F38020,#FAAD3F);border-radius:14px 14px 0 0;padding:22px 28px;color:#fff;">
    <div style="display:inline-block;background:rgba(255,255,255,.18);padding:5px 12px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:.1em;">GB0-713 MOCK</div>
    <h1 style="margin:10px 0 2px;font-size:22px;font-weight:800;letter-spacing:-.01em;">Your result is in</h1>
    <p style="margin:0;font-size:13px;opacity:.95;">H3CNE-Cloud - Deploy and Manage the H3C CAS Virtualization Platform</p>
  </div>

  <!-- score banner -->
  <div style="background:${passBg};color:#fff;padding:24px 28px;border-radius:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;">
          <div style="font-size:54px;font-weight:800;line-height:1;letter-spacing:-.03em;">${r.score}<span style="color:rgba(255,255,255,.78);font-size:22px;font-weight:600;"> / ${r.total}</span></div>
          <div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,.92);">Took ${r.tookFmt}</div>
        </td>
        <td style="vertical-align:middle;text-align:right;">
          <div style="display:inline-block;background:rgba(255,255,255,.22);padding:8px 18px;border-radius:99px;font-size:14px;font-weight:700;letter-spacing:.02em;">${passLabel} - ${r.pct}%</div>
          <div style="margin-top:6px;font-size:11px;color:rgba(255,255,255,.78);">Pass mark: 60%</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- white card with tallies + breakdown + recs + footer -->
  <div style="background:#fff;border-radius:0 0 14px 14px;padding:24px 28px 28px;box-shadow:0 4px 24px rgba(15,20,38,.08);">

    <!-- tallies -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px;margin-bottom:8px;">
      <tr>
        ${tally("Correct",   r.correctCount,   "#1f9c5b", "#e3f6ec")}
        ${tally("Partial",   r.partialCount,   "#c98a16", "#fbf2dc")}
        ${tally("Incorrect", r.incorrectCount, "#d6443b", "#fbe6e4")}
        ${tally("Skipped",   r.skippedCount,   "#5a6276", "#f6f7fb")}
      </tr>
    </table>

    <!-- attachment notice -->
    ${hasPdf ? `<div style="margin-top:18px;padding:14px 16px;background:#fff7ec;border:1px solid #f3b070;border-radius:10px;display:flex;align-items:center;gap:12px;">
      <div style="background:#F38020;color:#fff;font-weight:700;font-size:11px;padding:5px 9px;border-radius:6px;letter-spacing:.05em;">PDF</div>
      <div style="font-size:13px;color:#0f2549;"><strong>Detailed report attached.</strong> Open the PDF for the full question-by-question review with correct answers and explanations.</div>
    </div>` : ""}

    <!-- section breakdown -->
    <h2 style="font-size:15px;margin:24px 0 10px;color:#0f2549;letter-spacing:-.01em;">Section breakdown</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
      <thead><tr style="text-align:left;color:#8b91a0;font-size:10px;text-transform:uppercase;letter-spacing:.07em;">
        <th style="padding:8px 12px;border-bottom:1px solid #e4e7eb;font-weight:700;">Section</th>
        <th style="padding:8px 12px;border-bottom:1px solid #e4e7eb;text-align:center;font-weight:700;">OK</th>
        <th style="padding:8px 12px;border-bottom:1px solid #e4e7eb;text-align:center;font-weight:700;">1/2</th>
        <th style="padding:8px 12px;border-bottom:1px solid #e4e7eb;text-align:center;font-weight:700;">X</th>
        <th style="padding:8px 12px;border-bottom:1px solid #e4e7eb;text-align:right;font-weight:700;">%</th>
        <th style="padding:8px 12px;border-bottom:1px solid #e4e7eb;font-weight:700;"></th>
      </tr></thead>
      <tbody>
        ${sections.map(sectionRow).join("")}
      </tbody>
    </table>

    <!-- recommendations -->
    <h2 style="font-size:15px;margin:24px 0 10px;color:#0f2549;letter-spacing:-.01em;">${weak.length === 0 ? "Recommendations" : "Focus areas before retaking"}</h2>
    ${weak.length === 0
      ? `<div style="background:#e3f6ec;border-left:4px solid #1f9c5b;border-radius:8px;padding:14px 16px;font-size:13px;color:#0f2549;"><strong>Strong across every module.</strong> Run another shuffled mock to verify consistency.</div>`
      : weak.map(recCard).join("")}

    ${beh ? `
    <!-- behaviour -->
    <h2 style="font-size:15px;margin:24px 0 10px;color:#0f2549;letter-spacing:-.01em;">Behaviour analysis</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:5px;">
      <tr>
        ${behStat("Pace", escapeHtml(beh.pace), `${fmtMMSS(beh.totalSec)} of ${fmtMMSS(beh.budgetSec)} - ${beh.pctOfBudget}%`)}
        ${behStat("Avg / Q", `${beh.avgQSec}s`, `Median ${beh.medianQSec}s`)}
        ${behStat("Marked", `${beh.markedCorrect}<span style="color:#8b91a0;font-size:13px;font-weight:500;"> / ${beh.markedTotal}</span>`, "right vs flagged")}
        ${behStat("Changes", String(beh.totalChanges), `${beh.questionsChanged} Qs revised`)}
      </tr>
    </table>
    ${behInsight("Struggled most", "#d6443b", "#fbe6e4", beh.struggleAreas || [])}
    ${behInsight("Rushed through", "#c98a16", "#fbf2dc", beh.rushedSections || [])}
    ${behInsight("Comfortable on", "#1f9c5b", "#e3f6ec", beh.comfortableAreas || [])}
    <div style="margin-top:8px;font-size:12px;color:#5a6276;line-height:1.5;">${escapeHtml(beh.paceDetail || "")}</div>
    ` : ""}

    <!-- footer -->
    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #e4e7eb;color:#8b91a0;font-size:11px;text-align:center;">
      Independent study tool - not affiliated with or endorsed by H3C. Reply is not monitored.
    </div>
  </div>
</div>
</body></html>`;
}

function renderEmailText(r: any): string {
  const lines: string[] = [];
  lines.push("GB0-713 mock exam — detailed report");
  lines.push("");
  lines.push(`Score: ${r.score} / ${r.total} (${r.pct}%) — ${r.passed ? "PASS" : "BELOW PASS"} (60% required)`);
  lines.push(`Took: ${r.tookFmt}`);
  lines.push(`Correct: ${r.correctCount} · Partial: ${r.partialCount} · Incorrect: ${r.incorrectCount} · Skipped: ${r.skippedCount}`);
  lines.push("");
  lines.push("Recommendations:");
  if (!r.weakest || r.weakest.length === 0) {
    lines.push("- Strong across all sections.");
  } else {
    for (const w of r.weakest) lines.push(`- ${w.section} (${w.pct}%): ${w.advice}`);
  }
  lines.push("");
  lines.push("Section breakdown:");
  for (const s of r.perSection || []) {
    lines.push(`- ${s.section}: ${s.pct}% (correct ${s.correct} · partial ${s.partial} · wrong ${s.incorrect} / ${s.total})`);
  }
  lines.push("");
  lines.push("Question review available in the HTML version.");
  return lines.join("\n");
}

// ---------- main router ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/api/track" && request.method === "POST") return track(request, env);
    if (url.pathname === "/api/stats" && request.method === "GET") return stats(env);
    if (url.pathname === "/api/email-verify-init" && request.method === "POST") return emailVerifyInit(request, env);
    if (url.pathname === "/api/email-verify-confirm" && request.method === "POST") return emailVerifyConfirm(request, env);
    if (url.pathname.startsWith("/api/")) return j({ ok: false, error: "Unknown endpoint" }, 404);
    return env.ASSETS.fetch(request);
  },
};
