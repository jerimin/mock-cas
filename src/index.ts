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

// ---------- email detailed report ----------
async function emailReport(request: Request, env: Env): Promise<Response> {
  if (!env.SMTP2GO_API_KEY) {
    return j({ ok: false, error: "Email service not configured on this deployment." }, 503);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return j({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const email = (body?.email || "").toString().trim().toLowerCase();
  const report = body?.report;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return j({ ok: false, error: "Invalid email address." }, 400);
  }
  if (!report || typeof report !== "object") {
    return j({ ok: false, error: "Missing report payload." }, 400);
  }

  const html = renderEmailHtml(report);
  const text = renderEmailText(report);

  const senderEmail = env.SENDER_EMAIL || "do-not-reply@mymine.space";
  const senderName = env.SENDER_NAME || "GB0-713 Mock Exam";
  const payload = {
    api_key: env.SMTP2GO_API_KEY,
    to: [email],
    sender: `${senderName} <${senderEmail}>`,
    subject: `Your GB0-713 mock exam detailed report — ${report.score}/${report.total} (${report.pct}%)`,
    html_body: html,
    text_body: text,
  };

  const res = await fetch("https://api.smtp2go.com/v3/email/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    return j({ ok: false, error: `Email provider returned ${res.status}`, detail: errText.slice(0, 400) }, 502);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (data?.data?.succeeded >= 1) {
    return j({ ok: true });
  }
  return j({ ok: false, error: "Email rejected by provider.", detail: data }, 502);
}

// ---------- email renderers ----------
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function renderEmailHtml(r: any): string {
  const sections = (r.perSection || []) as Array<{ section: string; correct: number; partial: number; incorrect: number; total: number; pct: number }>;
  const weak = (r.weakest || []) as Array<{ section: string; pct: number; advice: string }>;
  const items = (r.items || []) as Array<{ idx: number; section: string; question: string; options: string[]; correctLetters: string[]; pickedLetters: string[]; status: string; explanation: string }>;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GB0-713 detailed report</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#1d2233;">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(15,20,38,.08);">
  <div style="border-bottom:1px solid #e2e6ef;padding-bottom:16px;margin-bottom:24px;">
    <div style="display:inline-block;background:linear-gradient(135deg,#F38020,#FAAD3F);color:#fff;font-weight:700;padding:6px 12px;border-radius:6px;font-size:12px;letter-spacing:.04em;">GB0-713 MOCK</div>
    <h1 style="margin:12px 0 4px;font-size:24px;">Your detailed report</h1>
    <p style="margin:0;color:#5a6276;font-size:14px;">H3CNE-Cloud · Deploy and Manage the H3C CAS Virtualization Platform</p>
  </div>

  <div style="background:${r.passed ? "#e3f6ec" : "#fbe6e4"};border:1px solid ${r.passed ? "#94d4af" : "#e6a7a1"};color:${r.passed ? "#1f9c5b" : "#d6443b"};padding:18px 20px;border-radius:8px;margin-bottom:24px;">
    <div style="font-size:36px;font-weight:700;line-height:1;">${r.score} <span style="color:#5a6276;font-size:18px;font-weight:500;">/ ${r.total}</span></div>
    <div style="margin-top:6px;font-size:18px;">${r.pct}% — ${r.passed ? "Pass (≥60%)" : "Below pass mark (60%)"}</div>
    <div style="margin-top:4px;font-size:13px;color:#5a6276;">Took ${r.tookFmt} · ${r.correctCount} correct · ${r.partialCount} partial · ${r.incorrectCount} incorrect · ${r.skippedCount} skipped</div>
  </div>

  <h2 style="font-size:18px;margin:24px 0 12px;">Recommendations</h2>
  ${weak.length === 0
    ? `<p style="color:#5a6276;">Strong across all sections — keep reviewing weak distractors to lock in.</p>`
    : `<ul style="padding-left:20px;color:#1d2233;">${weak.map((w) => `<li style="margin-bottom:8px;"><strong>${escapeHtml(w.section)}</strong> (${w.pct}%) — ${escapeHtml(w.advice)}</li>`).join("")}</ul>`}

  <h2 style="font-size:18px;margin:24px 0 12px;">Section breakdown</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead><tr style="text-align:left;color:#5a6276;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">
      <th style="padding:8px 12px;border-bottom:1px solid #e2e6ef;">Section</th>
      <th style="padding:8px 12px;border-bottom:1px solid #e2e6ef;text-align:right;">Correct</th>
      <th style="padding:8px 12px;border-bottom:1px solid #e2e6ef;text-align:right;">Partial</th>
      <th style="padding:8px 12px;border-bottom:1px solid #e2e6ef;text-align:right;">Wrong</th>
      <th style="padding:8px 12px;border-bottom:1px solid #e2e6ef;text-align:right;">%</th>
    </tr></thead>
    <tbody>
    ${sections.map((s) => `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f2f8;">${escapeHtml(s.section)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f2f8;text-align:right;">${s.correct}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f2f8;text-align:right;">${s.partial}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f2f8;text-align:right;">${s.incorrect}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f2f8;text-align:right;font-weight:600;">${s.pct}%</td>
    </tr>`).join("")}
    </tbody>
  </table>

  <h2 style="font-size:18px;margin:24px 0 12px;">Question-by-question review</h2>
  ${items.map((it) => {
    const statusColor = it.status === "correct" ? "#1f9c5b" : it.status === "partial" ? "#c98a16" : it.status === "incorrect" ? "#d6443b" : "#5a6276";
    const statusBg = it.status === "correct" ? "#e3f6ec" : it.status === "partial" ? "#fbf2dc" : it.status === "incorrect" ? "#fbe6e4" : "#f0f2f8";
    return `<div style="border:1px solid #e2e6ef;border-radius:8px;padding:16px 18px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;color:#5a6276;">
        <span style="text-transform:uppercase;letter-spacing:.04em;font-weight:600;">${it.idx}. ${escapeHtml(it.section)}</span>
        <span style="background:${statusBg};color:${statusColor};padding:3px 8px;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(it.status)}</span>
      </div>
      <div style="font-size:15px;margin-bottom:10px;">${escapeHtml(it.question)}</div>
      <div style="font-size:13px;color:#5a6276;margin-bottom:6px;">Correct: <strong style="color:#1d2233;">${escapeHtml(it.correctLetters.join(", "))}</strong> · You picked: <strong style="color:#1d2233;">${escapeHtml(it.pickedLetters.join(", ") || "—")}</strong></div>
      <div style="background:#f6f7fb;border-left:3px solid #F38020;padding:10px 12px;font-size:13px;color:#5a6276;border-radius:4px;">${escapeHtml(it.explanation)}</div>
    </div>`;
  }).join("")}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e6ef;color:#5a6276;font-size:12px;">
    Independent study tool · Not affiliated with or endorsed by H3C. Reply is not monitored.
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
    if (url.pathname === "/api/email-report" && request.method === "POST") return emailReport(request, env);
    if (url.pathname.startsWith("/api/")) return j({ ok: false, error: "Unknown endpoint" }, 404);
    return env.ASSETS.fetch(request);
  },
};
