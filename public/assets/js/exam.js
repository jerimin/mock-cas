/* Mock exam engine v2 — vanilla JS, single-page state machine over exam.html
   Schema v2: { id, section, format: "single"|"multi"|"negative", question,
                options[], correctIndices[], explanation }
   Sampling: stratified by module weights (full mode) or single-section (section mode)
   Multi-answer: checkboxes + all-or-nothing scoring
   States: setup -> running -> review
   Persists in localStorage; refresh resumes in-progress attempt.
*/
(() => {
  const STORAGE_KEY = "mock-cas-state-v2";
  const BANK_URL = "/assets/data/bank.json";

  // ---- module weights for stratified sampling (full mock) -------------------
  const WEIGHTS = {
    "Virtualization Introduction": 0.10,
    "Virtualized Infrastructure": 0.20,
    "Deploying Virtualization Platform": 0.15,
    "Basic Functions": 0.20,
    "Advanced Functions": 0.20,
    "Maintenance": 0.15,
  };

  // ---- exam modes -----------------------------------------------------------
  const MODES = {
    full: {
      label: "Full mock exam",
      durationSec: 90 * 60,
      pickCount: 60,
      sectionFilter: null,
    },
    section: {
      label: "Section practice",
      durationSec: 15 * 60,
      pickCount: 10,
      sectionFilter: null,
    },
  };

  // ---- utilities ------------------------------------------------------------
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

  // ---- stratified sampling --------------------------------------------------
  const stratifiedPick = (bank, attemptSize) => {
    const sections = Object.keys(WEIGHTS);
    const targets = {};
    let assigned = 0;
    for (const s of sections) {
      targets[s] = Math.round(WEIGHTS[s] * attemptSize);
      assigned += targets[s];
    }
    // fix rounding drift by adjusting the largest-weight section
    if (assigned !== attemptSize) {
      const diff = attemptSize - assigned;
      const heaviest = sections.reduce((a, b) => WEIGHTS[a] >= WEIGHTS[b] ? a : b);
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
    } catch {
      return null;
    }
  };

  const saveState = () => {
    if (!state) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const clearState = () => {
    localStorage.removeItem(STORAGE_KEY);
    state = null;
  };

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
    if (state && !state.submittedAt) {
      renderRunning();
    } else if (state && state.submittedAt) {
      renderReview();
    } else {
      renderSetup();
    }
  };

  // ---- setup screen ---------------------------------------------------------
  const renderSetup = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
    const sections = Object.keys(WEIGHTS);
    const sectionOptions = sections.map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join("");
    const sectionRows = sections.map((s) => {
      const count = bank.filter((q) => q.section === s).length;
      const target = Math.round(WEIGHTS[s] * 60);
      return `<li><span>${escapeHtml(s)}</span><span class="count">${count} in bank · ${target}/60 picked</span></li>`;
    }).join("");
    $("#app").innerHTML = `
      <div class="hero">
        <h1>Start a mock exam</h1>
        <p class="lede">Timed multiple-choice practice for the H3C CAS GB0-713 (H3CNE-Cloud) syllabus. Single-correct, multi-correct, and negative-phrasing questions. Progress saved locally — close the tab and resume any time.</p>
      </div>
      <div class="card">
        <h2>Choose a mode</h2>
        <p class="muted">Full mock pulls questions from all six modules in syllabus-weighted proportions. Section practice drills one module at a time.</p>
        <div class="toolbar">
          <label>
            Mode
            <select id="modeSel">
              <option value="full">Full mock — 60 questions, 90 minutes</option>
              <option value="section">Section practice — 10 questions, 15 minutes</option>
            </select>
          </label>
          <label id="sectionWrap" class="hidden">
            Section
            <select id="sectionSel">${sectionOptions}</select>
          </label>
          <button class="btn-primary" id="startBtn">Start exam</button>
        </div>
        <div class="notice">Question order and option order are shuffled every attempt. Auto-submit fires when the timer hits zero. Multi-answer questions are scored all-or-nothing.</div>
      </div>

      <div class="card">
        <h2>Full mock weighting</h2>
        <p class="muted">Each attempt covers every module by weight. Repeats minimised by within-module shuffle.</p>
        <ul class="section-list">${sectionRows}</ul>
      </div>
    `;
    $("#modeSel").addEventListener("change", (e) => {
      $("#sectionWrap").classList.toggle("hidden", e.target.value !== "section");
    });
    $("#startBtn").addEventListener("click", () => {
      const mode = $("#modeSel").value;
      const sectionFilter = mode === "section" ? $("#sectionSel").value : null;
      startExam(mode, sectionFilter);
    });
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
    for (const q of pool) {
      optionOrder[q.id] = shuffle(q.options.map((_, i) => i));
    }
    state = {
      mode: modeKey,
      sectionFilter,
      startedAt: Date.now(),
      durationSec: mode.durationSec,
      order,
      optionOrder,
      answers: {},  // qid -> number[] (positions, post-shuffle)
      marked: {},
      currentIdx: 0,
      submittedAt: null,
    };
    saveState();
    renderRunning();
  };

  // ---- running screen -------------------------------------------------------
  const renderRunning = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
    $("#app").innerHTML = `
      <div class="exam-topbar">
        <div class="crumbs">
          <strong>${escapeHtml(MODES[state.mode].label)}</strong>${state.sectionFilter ? ` — ${escapeHtml(state.sectionFilter)}` : ""} · Question <span id="qpos"></span> of ${state.order.length}
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <div class="timer" id="timer">--:--</div>
          <button class="btn-ghost" id="exitBtn" title="Abandon attempt">Exit</button>
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
              <div><span class="swatch sw-marked"></span> Marked for review</div>
            </div>
            <div class="qgrid" id="qgrid"></div>
            <button class="btn-primary" style="width:100%;" id="submitBtn">Submit exam</button>
          </div>
        </aside>
      </div>
    `;
    renderQuestion();
    renderGrid();
    tickTimer();
    timerId = setInterval(tickTimer, 1000);

    $("#submitBtn").addEventListener("click", confirmSubmit);
    $("#exitBtn").addEventListener("click", () => {
      if (confirm("Abandon this attempt? Your progress will be cleared.")) {
        clearState();
        renderSetup();
      }
    });
  };

  const currentQuestion = () => {
    const id = state.order[state.currentIdx];
    return bank.find((q) => q.id === id);
  };

  const tickTimer = () => {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const remain = state.durationSec - elapsed;
    const el = $("#timer");
    if (!el) return;
    el.textContent = fmtTime(remain);
    el.classList.toggle("warn", remain <= 600 && remain > 60);
    el.classList.toggle("urgent", remain <= 60);
    if (remain <= 0) {
      clearInterval(timerId);
      timerId = null;
      submitExam(true);
    }
  };

  // map a question's correct ORIGINAL indices to current POSITIONS
  const correctPositionsFor = (q) => {
    const order = state.optionOrder[q.id];
    return q.correctIndices.map((origIdx) => order.indexOf(origIdx)).sort((a, b) => a - b);
  };

  const isMultiSelect = (q) => q.correctIndices.length > 1;

  const formatBadge = (q) => {
    if (q.format === "single") return null;
    if (q.format === "multi") return { text: "Select all that apply", cls: "badge-multi" };
    // negative
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
        <div class="exam-nav">
          <button id="prevBtn" ${state.currentIdx === 0 ? "disabled" : ""}>&larr; Previous</button>
          <button class="btn-primary" id="nextBtn">${state.currentIdx === state.order.length - 1 ? "Review &amp; submit" : "Next &rarr;"}</button>
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
      if (state.currentIdx === state.order.length - 1) confirmSubmit();
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
    $$("#qgrid button").forEach((btn) => {
      btn.addEventListener("click", () => goTo(Number(btn.dataset.idx)));
    });
  };

  // ---- submit ---------------------------------------------------------------
  const confirmSubmit = () => {
    const answered = Object.values(state.answers).filter((a) => a && a.length > 0).length;
    const total = state.order.length;
    const unanswered = total - answered;
    const marked = Object.keys(state.marked).length;
    showModal({
      title: "Submit exam?",
      body: `${answered}/${total} answered, ${unanswered} skipped, ${marked} marked for review. Once submitted you'll see your score and explanations.`,
      confirmLabel: "Submit",
      onConfirm: () => submitExam(false),
    });
  };

  const submitExam = (auto) => {
    state.submittedAt = Date.now();
    state.autoSubmit = auto;
    saveState();
    renderReview();
  };

  // ---- review screen --------------------------------------------------------
  const renderReview = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
    const total = state.order.length;
    let correct = 0;
    const perSection = {};
    const items = state.order.map((id, i) => {
      const q = bank.find((x) => x.id === id);
      const order = state.optionOrder[id];
      const selected = state.answers[id] || []; // positions
      const correctPositions = correctPositionsFor(q);
      const isCorrect = setsEqual(selected, correctPositions);
      const answered = selected.length > 0;
      if (isCorrect) correct++;
      const sec = q.section;
      if (!perSection[sec]) perSection[sec] = { correct: 0, total: 0 };
      perSection[sec].total++;
      if (isCorrect) perSection[sec].correct++;
      return { i, q, order, selected, correctPositions, isCorrect, answered };
    });
    const pct = Math.round((correct / total) * 100);
    const passed = pct >= 70;
    const elapsedSec = Math.round((state.submittedAt - state.startedAt) / 1000);

    $("#app").innerHTML = `
      <div class="card score-card">
        <div><span class="score">${correct}</span><span class="out-of">/${total}</span></div>
        <div class="muted">${pct}% — ${state.autoSubmit ? "auto-submitted at time-up" : "submitted"}, took ${fmtTime(elapsedSec)}</div>
        <div class="verdict ${passed ? "pass" : "fail"}">${passed ? "Pass (≥70%)" : "Below pass mark (70%)"}</div>
        <div style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button class="btn-primary" id="newBtn">New attempt</button>
          <button id="exitBtn">Back to start</button>
        </div>
      </div>

      <div class="card breakdown">
        <h2>Section breakdown</h2>
        <table>
          <thead><tr><th>Section</th><th class="num">Score</th><th class="num">%</th></tr></thead>
          <tbody>
            ${Object.entries(perSection).map(([s, v]) => `
              <tr>
                <td>${escapeHtml(s)}</td>
                <td class="num">${v.correct} / ${v.total}</td>
                <td class="num">${Math.round((v.correct / v.total) * 100)}%</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Review</h2>
        <p class="muted">Each question with your answer, the correct answer, and the explanation.</p>
        <div id="reviewList"></div>
      </div>
    `;

    $("#reviewList").innerHTML = items.map(({ i, q, order, selected, correctPositions, isCorrect, answered }) => {
      const status = !answered ? "skipped" : isCorrect ? "correct" : "incorrect";
      const statusLabel = !answered ? "Skipped" : isCorrect ? "Correct" : "Incorrect";
      const badge = formatBadge(q);
      return `
        <div class="review-q">
          <div class="qhead">
            <span class="qsection">${i + 1}. ${escapeHtml(q.section)}</span>
            <span class="qstatus ${status}">${statusLabel}</span>
          </div>
          ${badge ? `<div class="qbadge ${badge.cls}">${escapeHtml(badge.text)}</div>` : ""}
          <p class="qtext" style="font-size:16px;">${escapeHtml(q.question)}</p>
          <ul class="options">
            ${order.map((origIdx, pos) => {
              const isCorrectOpt = correctPositions.includes(pos);
              const isSelected = selected.includes(pos);
              const cls = [];
              if (isCorrectOpt) cls.push("correct");
              if (isSelected && !isCorrectOpt) cls.push("incorrect");
              return `<li><div class="option ${cls.join(" ")}"><span class="letter">${letter(pos)}.</span><span>${escapeHtml(q.options[origIdx])}</span>${isSelected ? '<span class="picked">your pick</span>' : ""}</div></li>`;
            }).join("")}
          </ul>
          <div class="explanation"><strong>Why:</strong> ${escapeHtml(q.explanation)}</div>
        </div>
      `;
    }).join("");

    $("#newBtn").addEventListener("click", () => {
      clearState();
      renderSetup();
    });
    $("#exitBtn").addEventListener("click", () => {
      clearState();
      window.location.href = "/";
    });
  };

  // ---- modal ----------------------------------------------------------------
  const showModal = ({ title, body, confirmLabel, onConfirm }) => {
    const root = document.createElement("div");
    root.className = "modal-backdrop";
    root.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
        <div class="modal-actions">
          <button id="mCancel">Cancel</button>
          <button class="btn-primary" id="mConfirm">${escapeHtml(confirmLabel)}</button>
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

  // ---- go -------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);
})();
