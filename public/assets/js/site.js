/* Site-wide bootstrap — theme toggle, live counters, anonymous visit tracking */
(() => {
  const THEME_KEY = "mock-cas-theme";

  // ---- theme ----------------------------------------------------------------
  const applyTheme = (theme) => {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  };

  const init = () => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) applyTheme(saved);

    const btn = document.querySelector(".theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        let next;
        if (current === "dark") next = "light";
        else if (current === "light") next = "dark";
        else next = window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark";
        applyTheme(next);
        localStorage.setItem(THEME_KEY, next);
      });
    }

    bootCounters();
    track();
  };

  // ---- counters -------------------------------------------------------------
  const fmtN = (n) => {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  };

  const renderCounters = (data) => {
    const setT = (sel, val) => {
      const el = document.querySelector(sel);
      if (el) el.textContent = fmtN(val);
    };
    setT("[data-counter='active']", data.active || 0);
    setT("[data-counter='unique']", data.unique || 0);
    setT("[data-counter='total']", data.total || 0);
  };

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (res.ok) renderCounters(await res.json());
    } catch { /* silent */ }
  };

  const bootCounters = () => {
    if (!document.querySelector(".counters")) return;
    fetchStats();
    setInterval(fetchStats, 30_000);
  };

  // ---- track ----------------------------------------------------------------
  const track = () => {
    try { fetch("/api/track", { method: "POST", keepalive: true }); } catch { /* silent */ }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
