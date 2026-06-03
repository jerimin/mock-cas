/* Mock exam engine v3 — GB0-713 policy (50Q / 60min / 60% pass)
   Schema: { id, section, format, question, options[], correctIndices[], explanation }
   Sampling: stratified by module weights (full mode)
   Scoring: 1.0 / partial (0..1) for multi / 0 incorrect / 0 skipped
   States: setup -> running -> review
*/
(() => {
  const STORAGE_KEY = "mock-cas-state-v3";
  const BANK_URL = "/assets/data/bank.json";
  const PASS_PCT = 60;

  const WEIGHTS = {
    "Virtualization Introduction": 0.10,
    "Virtualized Infrastructure": 0.20,
    "Deploying Virtualization Platform": 0.15,
    "Basic Functions": 0.20,
    "Advanced Functions": 0.20,
    "Maintenance": 0.15,
  };

  const STUDY_HINTS = {
    "Virtualization Introduction": "Re-read the cloud-computing basics (5 features, deployment models), the IaaS/PaaS/SaaS layering, and H3C's CAS/SDN/ONEStor product mapping.",
    "Virtualized Infrastructure": "Drill compute (CPU clock, RAID modes, FBWC/BBWC), storage (iSCSI 3260, FC ports, RAID 5/6 disk math, multi-path) and network (VLAN, static vs dynamic link aggregation).",
    "Deploying Virtualization Platform": "Lock down the 3-step deployment process, hardware prereqs (hardware-assisted virtualization), management vs business network port roles, and CASToolkit / template-vs-clone behavior.",
    "Basic Functions": "Practise the resource hierarchy (host pool/cluster/host/VM), CPU modes (Compatible/Host/Host-Passthrough), cache modes (writeback/writethrough/none/directsync), backup types and vFW/ACL precedence.",
    "Advanced Functions": "Memorise HA detection (CVK→shared storage) + 3-retry cycle, FT vs HA, DRS metrics (CPU/memory/network), DPM/SR-IOV prereqs, sync vs async replication, and Active-Active 5km/1ms limit.",
    "Maintenance": "Memorise the cha commands, ovs-vsctl/ovs-appctl flags, log paths (/var/log/libvirt/..., Ocfs2_shell_XX.log), alarm levels (Critical/Major/Minor/Warning), and CASToolkit + iService flow.",
  };

  const MODES = {
    full: { label: "Full mock exam", durationSec: 60 * 60, pickCount: 50, sectionFilter: null },
    section: { label: "Section practice", durationSec: 15 * 60, pickCount: 10, sectionFilter: null },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const fmtTime = (totalSec) => {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };

  const letter = (i) => String.fromCharCode(65 + i);

  const setsEqual = (a, b) => {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    for (const x of b) if (!sa.has(x)) return false;
    return true;
  };

  // ---- stratified pick ------------------------------------------------------
  const stratifiedPick = (bank, attemptSize) => {
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
    const picks = [];
    for (const s of sections) {
      const pool = bank.filter((q) => q.section === s);
      picks.push(...shuffle(pool).slice(0, targets[s]));
    }
    return shuffle(picks);
  };

  // ---- state ----------------------------------------------------------------
  let bank = null;
  let state = null;
  let timerId = null;

  const loadState = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.order || !parsed.startedAt) return null;
      return parsed;
    } catch { return null; }
  };
  const saveState = () => { if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); };
  const clearState = () => { localStorage.removeItem(STORAGE_KEY); state = null; };

  // ---- bootstrap ------------------------------------------------------------
  const init = async () => {
    try {
      const res = await fetch(BANK_URL, { cache: "no-store" });
      bank = await res.json();
    } catch (e) {
      $("#app").innerHTML = `<div class="card"><h2>Could not load question bank.</h2><p class="muted">${String(e)}</p></div>`;
      return;
    }
    state = loadState();
    route();
  };

  const route = () => {
    if (state && !state.submittedAt) renderRunning();
    else if (state && state.submittedAt) renderReview();
    else renderSetup();
  };

  // ---- setup ----------------------------------------------------------------
  const renderSetup = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
    const sections = Object.keys(WEIGHTS);
    const sectionOptions = sections.map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join("");
    const sectionRows = sections.map((s) => {
      const count = bank.filter((q) => q.section === s).length;
      const target = Math.round(WEIGHTS[s] * 50);
      return `<li><span>${escapeHtml(s)}</span><span class="count">${count} in bank · ${target}/50 picked</span></li>`;
    }).join("");
    $("#app").innerHTML = `
      <div class="hero">
        <h1>Start a <span class="accent">mock exam</span></h1>
        <p class="lede">GB0-713 (H3CNE-Cloud). Policy and format mirror the official syllabus. Pick a mode and go.</p>
        <div class="exam-meta">
          <div class="item"><span class="label">Questions</span><span class="value">50</span></div>
          <div class="item"><span class="label">Duration</span><span class="value">60 min</span></div>
          <div class="item"><span class="label">Pass mark</span><span class="value">60%</span></div>
          <div class="item"><span class="label">Format</span><span class="value">Single + multi</span></div>
          <div class="item"><span class="label">Scoring</span><span class="value">Partial credit</span></div>
        </div>
      </div>

      <div class="results-grid">
        <div class="col">
          <div class="card">
            <h2>Choose a mode</h2>
            <p class="muted">Full mock samples weighted across the six modules. Section practice drills one module.</p>
            <div class="toolbar">
              <label>
                Mode
                <select id="modeSel">
                  <option value="full">Full mock — 50 Q / 60 min</option>
                  <option value="section">Section practice — 10 Q / 15 min</option>
                </select>
              </label>
              <label id="sectionWrap" class="hidden">
                Section
                <select id="sectionSel">${sectionOptions}</select>
              </label>
              <button class="btn btn-primary" id="startBtn">Start exam</button>
            </div>
            <div class="notice">Order shuffled per attempt. Multi-answer = partial credit (correct − wrong picks ÷ total correct, floored at 0). Auto-submits at timer zero.</div>
          </div>
        </div>
        <div class="col">
          <div class="card">
            <h2>Full mock weighting</h2>
            <p class="muted">Every attempt covers every module by syllabus weight.</p>
            <ul class="section-list">${sectionRows}</ul>
          </div>
        </div>
      </div>
    `;
    const startFn = () => {
      const mode = $("#modeSel").value;
      const sectionFilter = mode === "section" ? $("#sectionSel").value : null;
      startExam(mode, sectionFilter);
    };
    $("#modeSel").addEventListener("change", (e) => {
      $("#sectionWrap").classList.toggle("hidden", e.target.value !== "section");
    });
    $("#startBtn").addEventListener("click", startFn);
  };

  const startExam = (modeKey, sectionFilter) => {
    const mode = MODES[modeKey];
    let pool;
    if (modeKey === "full") {
      pool = stratifiedPick(bank, mode.pickCount);
    } else {
      const sectionPool = bank.filter((q) => q.section === sectionFilter);
      pool = shuffle(sectionPool).slice(0, mode.pickCount);
    }
    const order = pool.map((q) => q.id);
    const optionOrder = {};
    for (const q of pool) optionOrder[q.id] = shuffle(q.options.map((_, i) => i));
    state = {
      mode: modeKey,
      sectionFilter,
      startedAt: Date.now(),
      durationSec: mode.durationSec,
      order,
      optionOrder,
      answers: {},
      marked: {},
      currentIdx: 0,
      submittedAt: null,
    };
    saveState();
    renderRunning();
  };

  // ---- running --------------------------------------------------------------
  const renderRunning = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
    $("#app").innerHTML = `
      <div class="exam-runner">
        <div class="exam-topbar">
          <div class="crumbs">
            <strong>${escapeHtml(MODES[state.mode].label)}</strong>${state.sectionFilter ? ` — ${escapeHtml(state.sectionFilter)}` : ""} · Q <span id="qpos"></span> / ${state.order.length}
          </div>
          <div class="controls">
            <div class="timer" id="timer">--:--</div>
            <button class="btn-danger" id="endBtn" title="Submit now and view results">End exam</button>
            <button class="btn btn-ghost" id="exitBtn" title="Abandon attempt, discard answers">Abandon</button>
          </div>
        </div>
        <div class="exam-shell">
          <div id="qpane"></div>
          <aside class="sidebar">
            <div class="card">
              <h3>Navigator</h3>
              <div class="legend">
                <div><span class="swatch sw-unanswered"></span> Unanswered</div>
                <div><span class="swatch sw-answered"></span> Answered</div>
                <div><span class="swatch sw-marked"></span> Marked</div>
              </div>
              <div class="qgrid" id="qgrid"></div>
              <div class="sidebar-actions">
                <button class="btn btn-primary" id="submitBtn">End exam &amp; see results</button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    `;
    renderQuestion();
    renderGrid();
    tickTimer();
    timerId = setInterval(tickTimer, 1000);

    $("#submitBtn").addEventListener("click", confirmEnd);
    $("#endBtn").addEventListener("click", confirmEnd);
    $("#exitBtn").addEventListener("click", () => {
      if (confirm("Abandon this attempt? Your answers will be cleared and no result will be saved.")) {
        clearState();
        renderSetup();
      }
    });
  };

  const currentQuestion = () => bank.find((q) => q.id === state.order[state.currentIdx]);

  const tickTimer = () => {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const remain = state.durationSec - elapsed;
    const el = $("#timer");
    if (!el) return;
    el.textContent = fmtTime(remain);
    el.classList.toggle("warn", remain <= 600 && remain > 120);
    el.classList.toggle("urgent", remain <= 120);
    if (remain <= 0) {
      clearInterval(timerId);
      timerId = null;
      submitExam(true);
    }
  };

  const correctPositionsFor = (q) => {
    const order = state.optionOrder[q.id];
    return q.correctIndices.map((origIdx) => order.indexOf(origIdx)).sort((a, b) => a - b);
  };

  const isMultiSelect = (q) => q.correctIndices.length > 1;

  const formatBadge = (q) => {
    if (q.format === "single") return null;
    if (q.format === "multi") return { text: "Select all that apply", cls: "badge-multi" };
    if (q.correctIndices.length > 1) return { text: "Select all incorrect statements", cls: "badge-negative" };
    return { text: "Pick the incorrect statement", cls: "badge-negative" };
  };

  const renderQuestion = () => {
    const q = currentQuestion();
    const order = state.optionOrder[q.id];
    const selected = state.answers[q.id] || [];
    const isMarked = !!state.marked[q.id];
    const multi = isMultiSelect(q);
    const badge = formatBadge(q);
    $("#qpos").textContent = String(state.currentIdx + 1);
    $("#qpane").innerHTML = `
      <div class="question">
        <div class="qhead">
          <span class="qsection">${escapeHtml(q.section)}</span>
          <label class="qmark"><input type="checkbox" id="markChk" ${isMarked ? "checked" : ""}> Mark for review</label>
        </div>
        <div class="qbody">
          ${badge ? `<div class="qbadge ${badge.cls}">${escapeHtml(badge.text)}</div>` : ""}
          <p class="qtext">${escapeHtml(q.question)}</p>
          <ul class="options" id="optList">
            ${order.map((origIdx, pos) => {
              const isSel = selected.includes(pos);
              return `
                <li>
                  <label class="option ${isSel ? "selected" : ""}" data-pos="${pos}">
                    <input type="${multi ? "checkbox" : "radio"}" name="opt" value="${pos}" ${isSel ? "checked" : ""}>
                    <span class="letter">${letter(pos)}.</span>
                    <span>${escapeHtml(q.options[origIdx])}</span>
                  </label>
                </li>
              `;
            }).join("")}
          </ul>
        </div>
        <div class="exam-nav">
          <button id="prevBtn" ${state.currentIdx === 0 ? "disabled" : ""}>&larr; Previous</button>
          <button class="btn btn-primary" id="nextBtn">${state.currentIdx === state.order.length - 1 ? "Review &amp; end" : "Next &rarr;"}</button>
        </div>
      </div>
    `;
    $("#markChk").addEventListener("change", (e) => {
      if (e.target.checked) state.marked[q.id] = true;
      else delete state.marked[q.id];
      saveState();
      renderGrid();
    });
    $$(".option").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const pos = Number(el.dataset.pos);
        let sel = (state.answers[q.id] || []).slice();
        if (multi) {
          if (sel.includes(pos)) sel = sel.filter((p) => p !== pos);
          else sel.push(pos);
        } else {
          sel = [pos];
        }
        if (sel.length === 0) delete state.answers[q.id];
        else state.answers[q.id] = sel;
        saveState();
        renderQuestion();
        renderGrid();
      });
    });
    $("#prevBtn").addEventListener("click", () => goTo(state.currentIdx - 1));
    $("#nextBtn").addEventListener("click", () => {
      if (state.currentIdx === state.order.length - 1) confirmEnd();
      else goTo(state.currentIdx + 1);
    });
  };

  const goTo = (idx) => {
    if (idx < 0 || idx >= state.order.length) return;
    state.currentIdx = idx;
    saveState();
    renderQuestion();
    renderGrid();
  };

  const renderGrid = () => {
    const grid = $("#qgrid");
    if (!grid) return;
    grid.innerHTML = state.order.map((id, i) => {
      const cls = [];
      const sel = state.answers[id];
      if (sel && sel.length > 0) cls.push("answered");
      if (state.marked[id]) cls.push("marked");
      if (i === state.currentIdx) cls.push("current");
      return `<button type="button" class="${cls.join(" ")}" data-idx="${i}">${i + 1}</button>`;
    }).join("");
    $$("#qgrid button").forEach((btn) => btn.addEventListener("click", () => goTo(Number(btn.dataset.idx))));
  };

  // ---- end / submit ---------------------------------------------------------
  const confirmEnd = () => {
    const answered = Object.values(state.answers).filter((a) => a && a.length > 0).length;
    const total = state.order.length;
    const unanswered = total - answered;
    showModal({
      title: "End exam now?",
      body: `${answered}/${total} answered · ${unanswered} skipped. Once you end, you'll see your score and a summary of areas to improve.`,
      confirmLabel: "End and see results",
      confirmCls: "btn-primary",
      onConfirm: () => submitExam(false),
    });
  };

  const submitExam = (auto) => {
    state.submittedAt = Date.now();
    state.autoSubmit = auto;
    saveState();
    renderReview();
  };

  // ---- scoring --------------------------------------------------------------
  const scoreQuestion = (q, selectedPositions, correctPositions) => {
    if (selectedPositions.length === 0) return { score: 0, status: "skipped" };
    const correctSet = new Set(correctPositions);
    const selSet = new Set(selectedPositions);
    const correctPicked = selectedPositions.filter((p) => correctSet.has(p)).length;
    const wrongPicked = selectedPositions.length - correctPicked;
    if (correctPositions.length === 1) {
      // single-pick: must be the exact one
      const ok = setsEqual(selectedPositions, correctPositions);
      return { score: ok ? 1 : 0, status: ok ? "correct" : "incorrect" };
    }
    // multi-pick: partial credit
    const raw = (correctPicked - wrongPicked) / correctPositions.length;
    const score = Math.max(0, Math.min(1, raw));
    let status;
    if (score === 1) status = "correct";
    else if (score === 0) status = "incorrect";
    else status = "partial";
    return { score, status };
  };

  // ---- recommendations ------------------------------------------------------
  const buildRecommendations = (perSection) => {
    const sorted = Object.entries(perSection)
      .map(([section, v]) => ({ section, ...v, pct: Math.round((v.score / v.total) * 100) }))
      .sort((a, b) => a.pct - b.pct);
    const weakest = sorted.filter((s) => s.pct < 70).slice(0, 3).map((s) => ({
      section: s.section,
      pct: s.pct,
      advice: STUDY_HINTS[s.section] || "Re-read this module and re-take section practice until consistently above 80%.",
    }));
    return weakest;
  };

  // ---- review ---------------------------------------------------------------
  const renderReview = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
    const total = state.order.length;
    let scoreSum = 0;
    const tally = { correct: 0, partial: 0, incorrect: 0, skipped: 0 };
    const perSection = {};

    const items = state.order.map((id, i) => {
      const q = bank.find((x) => x.id === id);
      const order = state.optionOrder[id];
      const selected = state.answers[id] || [];
      const correctPositions = correctPositionsFor(q);
      const { score, status } = scoreQuestion(q, selected, correctPositions);
      scoreSum += score;
      tally[status]++;
      const sec = q.section;
      if (!perSection[sec]) perSection[sec] = { score: 0, correct: 0, partial: 0, incorrect: 0, skipped: 0, total: 0 };
      perSection[sec].total++;
      perSection[sec].score += score;
      perSection[sec][status]++;
      return { i, q, order, selected, correctPositions, score, status };
    });

    const scoreRounded = Math.round(scoreSum * 10) / 10;
    const pct = Math.round((scoreSum / total) * 100);
    const passed = pct >= PASS_PCT;
    const elapsedSec = Math.round((state.submittedAt - state.startedAt) / 1000);
    const recs = buildRecommendations(perSection);

    $("#app").innerHTML = `
      <div class="results-grid">
        <div class="col">
          <div class="card score-card">
            <div class="scoreline"><span class="score">${scoreRounded}</span><span class="out-of">/${total}</span></div>
            <div class="pct-line">${pct}% — ${state.autoSubmit ? "auto-submitted" : "submitted"} · ${fmtTime(elapsedSec)}</div>
            <div class="verdict ${passed ? "pass" : "fail"}">${passed ? `Pass · ≥${PASS_PCT}%` : `Below pass · ${PASS_PCT}% required`}</div>
            <div class="tallies">
              <div class="tally correct"><div class="label">Correct</div><div class="value">${tally.correct}</div></div>
              <div class="tally partial"><div class="label">Partial</div><div class="value">${tally.partial}</div></div>
              <div class="tally incorrect"><div class="label">Wrong</div><div class="value">${tally.incorrect}</div></div>
              <div class="tally skipped"><div class="label">Skipped</div><div class="value">${tally.skipped}</div></div>
            </div>
            <div class="actions">
              <button class="btn btn-primary" id="newBtn">New attempt</button>
              <button class="btn" id="exitBtn">Back to start</button>
            </div>
          </div>

          <div class="card" id="emailCard">
            <h2>Email me the detailed report</h2>
            <p class="muted">Full question-by-question review with explanations, sent to your inbox. Not stored.</p>
            <form class="email-form" id="emailForm">
              <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>
              <button class="btn btn-primary" type="submit">Send</button>
            </form>
            <div class="email-status" id="emailStatus"></div>
          </div>
        </div>

        <div class="col">
          <div class="card breakdown">
            <h2>Section breakdown</h2>
            <table>
              <thead><tr><th>Section</th><th class="num">✓</th><th class="num">½</th><th class="num">✗</th><th class="num">%</th><th class="bar-cell"></th></tr></thead>
              <tbody>
                ${Object.entries(perSection).map(([s, v]) => {
                  const pp = Math.round((v.score / v.total) * 100);
                  const barCls = pp >= 80 ? "strong" : pp < 60 ? "weak" : "";
                  return `<tr>
                    <td>${escapeHtml(s)}</td>
                    <td class="num">${v.correct}</td>
                    <td class="num">${v.partial}</td>
                    <td class="num">${v.incorrect}</td>
                    <td class="num"><strong>${pp}%</strong></td>
                    <td class="bar-cell"><div class="bar ${barCls}"><span style="width:${pp}%"></span></div></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h2>Recommendations</h2>
            <div class="recs">
              ${recs.length === 0
                ? `<div class="rec strong"><h4>You're exam-ready</h4><p>Every module above 70%. Re-run a shuffled mock to verify consistency.</p></div>`
                : recs.map((r) => `<div class="rec ${r.pct < 50 ? "weak" : "medium"}"><h4>${escapeHtml(r.section)} — ${r.pct}%</h4><p>${escapeHtml(r.advice)}</p></div>`).join("")}
            </div>
          </div>
        </div>
      </div>
    `;

    // wire email form
    const reportPayload = buildReportPayload(items, perSection, tally, scoreSum, scoreRounded, total, pct, passed, elapsedSec, recs);
    $("#emailForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#emailForm input[name=email]").value.trim();
      const btn = $("#emailForm button");
      const status = $("#emailStatus");
      btn.disabled = true; btn.textContent = "Sending…";
      status.textContent = ""; status.className = "email-status";
      try {
        const res = await fetch("/api/email-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, report: reportPayload }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          status.textContent = `Sent to ${email}. Check your inbox (and spam folder).`;
          status.classList.add("ok");
          btn.textContent = "Sent";
        } else {
          status.textContent = data.error || `Could not send (${res.status}).`;
          status.classList.add("err");
          btn.disabled = false; btn.textContent = "Send detailed report";
        }
      } catch (err) {
        status.textContent = "Network error — try again.";
        status.classList.add("err");
        btn.disabled = false; btn.textContent = "Send detailed report";
      }
    });

    $("#newBtn").addEventListener("click", () => { clearState(); renderSetup(); });
    $("#exitBtn").addEventListener("click", () => { clearState(); window.location.href = "/"; });
  };

  const buildReportPayload = (items, perSection, tally, scoreSum, scoreRounded, total, pct, passed, elapsedSec, recs) => {
    const perSectionArr = Object.entries(perSection).map(([section, v]) => ({
      section,
      correct: v.correct,
      partial: v.partial,
      incorrect: v.incorrect,
      skipped: v.skipped,
      total: v.total,
      pct: Math.round((v.score / v.total) * 100),
    }));
    const detailedItems = items.map((it) => ({
      idx: it.i + 1,
      section: it.q.section,
      question: it.q.question,
      options: it.order.map((origIdx, pos) => `${letter(pos)}. ${it.q.options[origIdx]}`),
      correctLetters: it.correctPositions.map(letter),
      pickedLetters: it.selected.slice().sort((a, b) => a - b).map(letter),
      status: it.status,
      explanation: it.q.explanation,
    }));
    return {
      score: scoreRounded,
      total,
      pct,
      passed,
      tookFmt: fmtTime(elapsedSec),
      correctCount: tally.correct,
      partialCount: tally.partial,
      incorrectCount: tally.incorrect,
      skippedCount: tally.skipped,
      perSection: perSectionArr,
      weakest: recs,
      items: detailedItems,
    };
  };

  // ---- modal ----------------------------------------------------------------
  const showModal = ({ title, body, confirmLabel, confirmCls = "btn-primary", onConfirm }) => {
    const root = document.createElement("div");
    root.className = "modal-backdrop";
    root.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
        <div class="modal-actions">
          <button id="mCancel">Cancel</button>
          <button class="btn ${confirmCls}" id="mConfirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.querySelector("#mCancel").addEventListener("click", close);
    root.querySelector("#mConfirm").addEventListener("click", () => { close(); onConfirm(); });
    root.addEventListener("click", (e) => { if (e.target === root) close(); });
  };

  // ---- html escape ----------------------------------------------------------
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const escapeAttr = (s) => escapeHtml(s);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
