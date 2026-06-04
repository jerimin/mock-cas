/* Mock exam engine v3 — GB0-713 policy (50Q / 60min / 60% pass)
   Schema: { id, section, format, question, options[], correctIndices[], explanation }
   Sampling: stratified by module weights (full mode)
   Scoring: 1.0 / partial (0..1) for multi / 0 incorrect / 0 skipped
   States: setup -> running -> review
*/
(() => {
  const STORAGE_KEY = "mock-cas-state-v4";
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
    // If resuming an in-progress attempt, reset qEnteredAt so closed-tab time isn't charged to the current question
    if (state && !state.submittedAt) {
      state.qEnteredAt = Date.now();
      // back-fill timing fields if loading older state schema
      state.qTime = state.qTime || {};
      state.qVisits = state.qVisits || {};
      state.qFirstSeenAt = state.qFirstSeenAt || {};
      state.qChangeCount = state.qChangeCount || {};
      saveState();
    }
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
    const now = Date.now();
    const firstQid = order[0];
    state = {
      mode: modeKey,
      sectionFilter,
      startedAt: now,
      durationSec: mode.durationSec,
      order,
      optionOrder,
      answers: {},
      marked: {},
      currentIdx: 0,
      submittedAt: null,
      // behaviour-analysis instrumentation
      qTime: {},                    // qid -> cumulative ms on the question
      qVisits: { [firstQid]: 1 },   // qid -> visit count
      qFirstSeenAt: { [firstQid]: now },
      qChangeCount: {},             // qid -> times the answer was changed
      qEnteredAt: now,              // when current qid was entered (rolling)
    };
    saveState();
    renderRunning();
  };

  const flushQTime = () => {
    if (!state || !state.qEnteredAt) return;
    const qid = state.order[state.currentIdx];
    const now = Date.now();
    state.qTime[qid] = (state.qTime[qid] || 0) + (now - state.qEnteredAt);
    state.qEnteredAt = now;
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
        const prev = state.answers[q.id] || [];
        let sel = prev.slice();
        if (multi) {
          if (sel.includes(pos)) sel = sel.filter((p) => p !== pos);
          else sel.push(pos);
        } else {
          sel = [pos];
        }
        if (sel.length === 0) delete state.answers[q.id];
        else state.answers[q.id] = sel;
        // count an "answer change" only when the new selection differs from previous
        if (!setsEqual(prev, sel)) {
          state.qChangeCount[q.id] = (state.qChangeCount[q.id] || 0) + 1;
        }
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
    if (idx === state.currentIdx) return;
    flushQTime();
    state.currentIdx = idx;
    const qid = state.order[idx];
    state.qVisits[qid] = (state.qVisits[qid] || 0) + 1;
    if (!state.qFirstSeenAt[qid]) state.qFirstSeenAt[qid] = Date.now();
    state.qEnteredAt = Date.now();
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
    flushQTime();
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

  // ---- behaviour analysis ---------------------------------------------------
  const computeBehaviour = (items, perSection) => {
    const totalMs = state.submittedAt - state.startedAt;
    const budgetMs = state.durationSec * 1000;
    const pctOfBudget = Math.round((totalMs / budgetMs) * 100);
    let pace, paceDetail;
    if (state.autoSubmit) {
      pace = "Ran out of time";
      paceDetail = "Auto-submitted at the timer zero — consider pacing more aggressively next time.";
    } else if (pctOfBudget < 50) {
      pace = "Finished early";
      paceDetail = "Used less than half the budget — verify you didn't rush on multi-answer questions.";
    } else if (pctOfBudget < 80) {
      pace = "Steady pace";
      paceDetail = "Comfortable use of the time budget.";
    } else {
      pace = "Last-moment finish";
      paceDetail = "Cut it close to the deadline — practise time management on the next attempt.";
    }

    const times = state.order.map((qid) => state.qTime[qid] || 0);
    const totalQTime = times.reduce((a, b) => a + b, 0);
    const avgMs = totalQTime / times.length;
    const sorted = times.slice().sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)] || 0;

    const withTimes = items.map((it) => ({
      qid: it.q.id,
      section: it.q.section,
      idx: it.i + 1,
      ms: state.qTime[it.q.id] || 0,
      status: it.status,
    }));
    const slowest = withTimes.slice().sort((a, b) => b.ms - a.ms).slice(0, 3);
    const rushedWrong = withTimes
      .filter((x) => (x.status === "incorrect" || x.status === "partial") && x.ms < avgMs * 0.5 && x.ms > 0)
      .slice(0, 3);

    // per-section time
    const secTime = {};
    for (const x of withTimes) {
      if (!secTime[x.section]) secTime[x.section] = { totalMs: 0, count: 0 };
      secTime[x.section].totalMs += x.ms;
      secTime[x.section].count++;
    }
    const sectionTimings = Object.entries(secTime).map(([sec, t]) => ({
      section: sec,
      avgMs: t.count ? t.totalMs / t.count : 0,
      pct: perSection[sec] ? Math.round((perSection[sec].score / perSection[sec].total) * 100) : 0,
    }));

    const struggleAreas = sectionTimings
      .filter((s) => s.pct < 70 && s.avgMs > avgMs * 1.15)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3);
    const comfortableAreas = sectionTimings
      .filter((s) => s.pct >= 80 && s.avgMs < avgMs)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3);
    const rushedSections = sectionTimings
      .filter((s) => s.pct < 60 && s.avgMs < avgMs * 0.7)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3);

    // answer changes
    const totalChanges = Object.values(state.qChangeCount || {}).reduce((a, b) => a + b, 0);
    const questionsChanged = Object.values(state.qChangeCount || {}).filter((c) => c > 1).length;

    // mark-for-review accuracy
    const marked = Object.keys(state.marked || {});
    const markedItems = items.filter((it) => marked.includes(it.q.id));
    const markedCorrect = markedItems.filter((it) => it.status === "correct").length;
    const markedNotCorrect = markedItems.length - markedCorrect;

    // revisits
    const revisitedCount = Object.values(state.qVisits || {}).filter((v) => v > 1).length;

    return {
      pace,
      paceDetail,
      totalSec: Math.round(totalMs / 1000),
      budgetSec: state.durationSec,
      pctOfBudget,
      avgQSec: Math.round(avgMs / 1000),
      medianQSec: Math.round(medianMs / 1000),
      slowest: slowest.map((s) => ({ ...s, sec: Math.round(s.ms / 1000) })),
      rushedWrong: rushedWrong.map((s) => ({ ...s, sec: Math.round(s.ms / 1000) })),
      sectionTimings: sectionTimings.map((s) => ({ section: s.section, avgQSec: Math.round(s.avgMs / 1000), pct: s.pct })),
      struggleAreas: struggleAreas.map((s) => ({ section: s.section, avgQSec: Math.round(s.avgMs / 1000), pct: s.pct })),
      comfortableAreas: comfortableAreas.map((s) => ({ section: s.section, avgQSec: Math.round(s.avgMs / 1000), pct: s.pct })),
      rushedSections: rushedSections.map((s) => ({ section: s.section, avgQSec: Math.round(s.avgMs / 1000), pct: s.pct })),
      totalChanges,
      questionsChanged,
      markedTotal: marked.length,
      markedCorrect,
      markedNotCorrect,
      revisitedCount,
    };
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
    const beh = computeBehaviour(items, perSection);

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
            <p class="muted" id="emailLede">Enter your email — we'll send a 6-digit code to verify, then deliver the full review.</p>
            <div id="emailSteps"></div>
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

          <div class="card behaviour-card">
            <h2>Behaviour analysis</h2>
            <div class="b-grid">
              <div class="b-stat"><div class="b-label">Pace</div><div class="b-value">${escapeHtml(beh.pace)}</div><div class="b-sub">${fmtTime(beh.totalSec)} of ${fmtTime(beh.budgetSec)} · ${beh.pctOfBudget}%</div></div>
              <div class="b-stat"><div class="b-label">Avg / Q</div><div class="b-value">${beh.avgQSec}s</div><div class="b-sub">Median ${beh.medianQSec}s</div></div>
              <div class="b-stat"><div class="b-label">Marked</div><div class="b-value">${beh.markedCorrect}<span class="b-of">/${beh.markedTotal}</span></div><div class="b-sub">right vs flagged</div></div>
              <div class="b-stat"><div class="b-label">Changes</div><div class="b-value">${beh.totalChanges}</div><div class="b-sub">${beh.questionsChanged} Qs revised</div></div>
            </div>
            ${beh.struggleAreas.length > 0 ? `
              <div class="b-insight b-weak">
                <span class="b-tag">Struggled most</span>
                <ul>${beh.struggleAreas.map((s) => `<li>${escapeHtml(s.section)} — ${s.pct}%, ${s.avgQSec}s/Q (vs ${beh.avgQSec}s avg)</li>`).join("")}</ul>
              </div>` : ""}
            ${beh.rushedSections.length > 0 ? `
              <div class="b-insight b-rushed">
                <span class="b-tag">Rushed through</span>
                <ul>${beh.rushedSections.map((s) => `<li>${escapeHtml(s.section)} — ${s.pct}%, only ${s.avgQSec}s/Q (vs ${beh.avgQSec}s avg)</li>`).join("")}</ul>
              </div>` : ""}
            ${beh.comfortableAreas.length > 0 ? `
              <div class="b-insight b-strong">
                <span class="b-tag">Comfortable on</span>
                <ul>${beh.comfortableAreas.map((s) => `<li>${escapeHtml(s.section)} — ${s.pct}%, ${s.avgQSec}s/Q</li>`).join("")}</ul>
              </div>` : ""}
            ${beh.struggleAreas.length === 0 && beh.rushedSections.length === 0 && beh.comfortableAreas.length === 0 ? `
              <p class="muted" style="margin-top:8px;">${escapeHtml(beh.paceDetail)}</p>` : ""}
          </div>
        </div>
      </div>
    `;

    // wire email verification flow
    const reportPayload = buildReportPayload(items, perSection, tally, scoreSum, scoreRounded, total, pct, passed, elapsedSec, recs, beh);
    const emailFlow = { email: "", step: "init" };
    renderEmailStep("init", emailFlow, reportPayload);

    $("#newBtn").addEventListener("click", () => { clearState(); renderSetup(); });
    $("#exitBtn").addEventListener("click", () => { clearState(); window.location.href = "/"; });
  };

  const maskEmail = (e) => {
    const [name, domain] = e.split("@");
    if (!name || !domain) return e;
    const masked = name.length <= 2 ? name[0] + "*" : name[0] + "***" + name[name.length - 1];
    return `${masked}@${domain}`;
  };

  const renderEmailStep = (step, flow, reportPayload) => {
    const lede = $("#emailLede");
    const stepsEl = $("#emailSteps");
    const status = $("#emailStatus");
    status.textContent = ""; status.className = "email-status";
    if (step === "init") {
      lede.textContent = "Enter your email — we'll send a 6-digit code to verify, then deliver the full review.";
      stepsEl.innerHTML = `
        <form class="email-form" id="initForm">
          <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required value="${escapeAttr(flow.email)}">
          <button class="btn btn-primary" type="submit">Send code</button>
        </form>
      `;
      $("#initForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = $("#initForm input[name=email]").value.trim().toLowerCase();
        const btn = $("#initForm button");
        btn.disabled = true; btn.textContent = "Sending…";
        try {
          const res = await fetch("/api/email-verify-init", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, report: reportPayload }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) {
            flow.email = email;
            flow.step = "code";
            renderEmailStep("code", flow, reportPayload);
          } else {
            status.textContent = data.error || `Could not send code (${res.status}).`;
            status.classList.add("err");
            btn.disabled = false; btn.textContent = "Send code";
          }
        } catch {
          status.textContent = "Network error — try again.";
          status.classList.add("err");
          btn.disabled = false; btn.textContent = "Send code";
        }
      });
    } else if (step === "code") {
      lede.innerHTML = `Code sent to <strong>${escapeHtml(maskEmail(flow.email))}</strong>. Check your inbox (and spam folder), then enter the 6-digit code.`;
      stepsEl.innerHTML = `
        <form class="email-form code-form" id="codeForm">
          <input type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" name="code" placeholder="123456" required autocomplete="one-time-code" autofocus>
          <button class="btn btn-primary" type="submit">Verify &amp; send report</button>
        </form>
        <div style="margin-top:8px;font-size:12px;">
          <a href="#" id="changeEmail">Use a different email</a>
        </div>
      `;
      $("#codeForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = $("#codeForm input[name=code]").value.trim();
        const btn = $("#codeForm button");
        btn.disabled = true; btn.textContent = "Verifying…";
        try {
          const res = await fetch("/api/email-verify-confirm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: flow.email, code }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) {
            flow.step = "done";
            renderEmailStep("done", flow, reportPayload);
          } else {
            status.textContent = data.error || `Could not verify (${res.status}).`;
            status.classList.add("err");
            btn.disabled = false; btn.textContent = "Verify & send report";
            if (res.status === 410 || res.status === 429) {
              setTimeout(() => { flow.step = "init"; renderEmailStep("init", flow, reportPayload); }, 1500);
            }
          }
        } catch {
          status.textContent = "Network error — try again.";
          status.classList.add("err");
          btn.disabled = false; btn.textContent = "Verify & send report";
        }
      });
      $("#changeEmail").addEventListener("click", (e) => {
        e.preventDefault();
        flow.step = "init";
        renderEmailStep("init", flow, reportPayload);
      });
    } else if (step === "done") {
      lede.textContent = "Verified. Your detailed report is on the way.";
      stepsEl.innerHTML = `
        <div class="email-success">
          <strong>Sent to ${escapeHtml(maskEmail(flow.email))}</strong>
          <p>Check your inbox (and spam folder). The detailed report has a section breakdown, recommendations, and every question with the correct answer and explanation.</p>
        </div>
      `;
    }
  };

  const buildReportPayload = (items, perSection, tally, scoreSum, scoreRounded, total, pct, passed, elapsedSec, recs, behaviour) => {
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
      behaviour,
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
