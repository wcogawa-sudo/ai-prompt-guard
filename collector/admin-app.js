// Admin dashboard client. Served as a separate file so the page can use a
// strict Content-Security-Policy with no inline scripts.
"use strict";
(() => {
  const OUTCOME_COLORS = ["--s1", "--s2", "--s3", "--s4", "--s5"]; // fixed order, never cycled
  const state = { days: 7, view: "exec", user: "", site: "", data: null, feedRows: 15 };
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const nf = new Intl.NumberFormat("en-ZA");
  const compact = (n) => n >= 10000 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n) : nf.format(n);

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  };

  function deltaText(pct, prev, label) {
    if (pct === null) return prev === 0 ? `no data for the previous ${label}` : "";
    const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "→";
    return `${arrow} ${Math.abs(pct)}% vs previous ${label}`;
  }
  const periodLabel = () => state.days === 1 ? "day" : `${state.days} days`;

  async function api(path, extra) {
    const qs = new URLSearchParams({ days: state.days, user: state.user, site: state.site, ...(extra || {}) });
    const res = await fetch(`/admin/api/${path}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- drill-down ----------
  // Makes any element open the detail panel on click / Enter / Space.
  function clickable(node, spec) {
    if (!spec) return node;
    node.classList.add("clickable");
    if (!node.hasAttribute("tabindex") && !/^(BUTTON|A)$/.test(node.tagName)) node.setAttribute("tabindex", "0");
    if (node.namespaceURI !== "http://www.w3.org/2000/svg" && node.tagName !== "BUTTON") node.setAttribute("role", "button");
    node.addEventListener("click", (e) => { e.stopPropagation(); openDrill(spec); });
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrill(spec); }
    });
    return node;
  }

  let lastFocus = null;
  let drillSpec = null;
  function refreshDrill() { if (drillSpec && !$("drill").hidden) openDrill(drillSpec, true); }
  async function openDrill(spec, keepFocus) {
    drillSpec = spec;
    if (!keepFocus) lastFocus = document.activeElement;
    const panel = $("drill");
    $("drill-title").textContent = spec.title;
    $("drill-sub").textContent = "Loading…";
    $("drill-users").replaceChildren();
    $("drill-events").replaceChildren();
    panel.hidden = false;
    $("drill-backdrop").hidden = false;
    if (!keepFocus) $("drill-close").focus();
    const q = { kind: spec.kind || "violations" };
    for (const k of ["outcome", "day", "category"]) if (spec[k]) q[k] = spec[k];
    if (spec.site) q.site = spec.site;
    if (spec.user) q.user = spec.user;
    try {
      const d = await api("drill", q);
      const range = spec.day ? "" : ` · ${state.days === 1 ? "today" : `last ${state.days} days`}`; // a day is already in the title
      $("drill-sub").textContent = `${nf.format(d.total)} event${d.total === 1 ? "" : "s"}${range}` +
        (state.user && !spec.user ? ` · user ${state.user}` : "") + (state.site && !spec.site ? ` · ${state.site}` : "");
      $("drill-users").replaceChildren(d.users.length ? tableView(d.users, [
        { label: "User", fmt: (r) => clickable(el("button", { class: "user-link" }, r.user), { ...spec, user: r.user, title: `${spec.title} · ${r.user}` }) },
        { label: "Count", key: "count", num: true },
        { label: "AI sites", fmt: (r) => r.sites.join(", ") },
      ]) : el("div", { class: "empty" }, "Nobody, nothing in this selection."));
      $("drill-events").replaceChildren(d.events.length ? tableView(d.events, [
        { label: "Time", fmt: (e) => timeText(e["@timestamp"]) },
        { label: "User", fmt: (e) => e["user.name"] || "?" },
        { label: "Site", fmt: (e) => e["ai.site"] || "" },
        { label: "What happened", fmt: (e) => {
          const span = el("span", {}, ACTION_TEXT[e["event.action"]] || e["event.action"]);
          const w = whatText(e);
          if (w) span.append(el("div", { class: "muted small" }, w));
          if (e["evidence.present"]) span.append(el("div", { class: "muted small" }, `evidence ${e["evidence.id"]}`));
          if (e["override.justification"]) span.append(el("div", { class: "muted small" }, `reason: ${e["override.justification"]}`));
          return span;
        } },
        { label: "Prompt", fmt: (e) => { const c = promptCell(e); if (e["evidence.present"]) c.dataset.evidenceId = e["evidence.id"]; return c; } },
      ]) : el("div", { class: "empty" }, "No events."));
      $("drill-events").querySelectorAll("td:last-child").forEach((td) => td.classList.add("prompt"));
      if (d.total > d.events.length) $("drill-events").append(el("div", { class: "muted small", style: "margin-top:8px" }, `Showing the latest ${d.events.length} of ${nf.format(d.total)}.`));
    } catch (err) {
      $("drill-sub").textContent = `Couldn't load: ${err.message}`;
    }
  }
  function closeDrill() {
    $("drill").hidden = true;
    $("drill-backdrop").hidden = true;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }
  $("drill-close").addEventListener("click", closeDrill);
  $("drill-backdrop").addEventListener("click", closeDrill);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drill").hidden) closeDrill(); });

  // ---------- charts ----------

  // Clean axis: step from 1/2/5 x 10^n, about 4 intervals, max a whole number of steps.
  function niceScale(v) {
    const raw = Math.max(1, v) / 4;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
    const s = Math.max(1, step);
    return { max: s * Math.max(1, Math.ceil(v / s)), step: s };
  }
  const dayLabel = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }); };

  function frame(container, rows) {
    container.replaceChildren();
    // Draw at the container's real width so text stays 11px on any screen.
    const W = Math.max(280, Math.round(container.clientWidth || 560));
    const H = W < 420 ? 200 : 220, M = { l: 36, r: 8, t: 8, b: 26 };
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    const tip = el("div", { class: "tooltip", hidden: "" });
    container.append(svg, tip);
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const band = iw / Math.max(1, rows.length);
    const xAt = (i) => M.l + band * i + band / 2;
    return { svg, tip, W, H, M, iw, ih, band, xAt };
  }

  function axes(f, rows, scale) {
    const { svg, M, iw, ih } = f;
    const max = scale.max;
    for (let v = 0; v <= max + 1e-9; v += scale.step) {
      const y = M.t + ih - (ih * v) / max;
      const i = v;
      svg.append(svgEl("line", { x1: M.l, x2: M.l + iw, y1: y, y2: y, stroke: i ? css("--grid") : css("--axis"), "stroke-width": 1 }));
      const t = svgEl("text", { x: M.l - 6, y: y + 4, "text-anchor": "end", "font-size": 11, fill: css("--muted"), style: "font-variant-numeric: tabular-nums" });
      t.textContent = nf.format(Math.round(v));
      svg.append(t);
    }
    // Date labels: evenly spaced, always the last day, never two labels colliding.
    const slots = Math.max(2, Math.floor(iw / 64));
    const every = Math.max(1, Math.ceil(rows.length / slots));
    const last = rows.length - 1;
    rows.forEach((r, i) => {
      const regular = i % every === 0 && last - i >= every * 0.75;
      if (!regular && i !== last) return;
      const t = svgEl("text", { x: f.xAt(i), y: M.t + ih + 18, "text-anchor": "middle", "font-size": 11, fill: css("--muted") });
      t.textContent = dayLabel(r.day);
      svg.append(t);
    });
  }

  function showTip(f, container, x, head, rows) {
    const { tip } = f;
    tip.replaceChildren(el("div", { class: "t-head" }, head));
    for (const r of rows) {
      const key = el("span", { class: "key", style: `background:${r.color}` });
      const b = el("b", {}, nf.format(r.value));
      tip.append(el("div", { class: "row" }, key, b, el("span", {}, r.label)));
    }
    tip.hidden = false;
    const box = container.getBoundingClientRect();
    const px = (x / f.W) * box.width;
    tip.style.left = `${Math.min(Math.max(0, px + 12), box.width - tip.offsetWidth)}px`;
    tip.style.top = "8px";
  }

  // Single-series line with crosshair tooltip (snaps to nearest day).
  function lineChart(container, rows, key, label) {
    const f = frame(container, rows);
    const sc = niceScale(Math.max(1, ...rows.map((r) => r[key])));
    const max = sc.max;
    axes(f, rows, sc);
    const y = (v) => f.M.t + f.ih - (f.ih * v) / max;
    const pts = rows.map((r, i) => [f.xAt(i), y(r[key])]);
    const color = css("--s1");
    const area = svgEl("path", { d: `M${pts[0][0]},${y(0)} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length - 1][0]},${y(0)} Z`, fill: color, "fill-opacity": 0.1 });
    const line = svgEl("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" "), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
    f.svg.append(area, line);
    const last = pts[pts.length - 1];
    f.svg.append(svgEl("circle", { cx: last[0], cy: last[1], r: 4, fill: color, stroke: css("--surface"), "stroke-width": 2 }));
    const cross = svgEl("line", { y1: f.M.t, y2: f.M.t + f.ih, stroke: css("--axis"), "stroke-width": 1, visibility: "hidden" });
    const dot = svgEl("circle", { r: 4, fill: color, stroke: css("--surface"), "stroke-width": 2, visibility: "hidden" });
    f.svg.append(cross, dot);
    const hit = svgEl("rect", { x: f.M.l, y: f.M.t, width: f.iw, height: f.ih, fill: "transparent", tabindex: 0 });
    f.svg.append(hit);
    const at = (i) => {
      const [x, yy] = pts[i];
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x); dot.setAttribute("cy", yy); dot.setAttribute("visibility", "visible");
      showTip(f, container, x, dayLabel(rows[i].day), [{ color, value: rows[i][key], label }]);
    };
    const nearest = (evt) => {
      const box = f.svg.getBoundingClientRect();
      const x = ((evt.clientX - box.left) / box.width) * f.W;
      return Math.max(0, Math.min(rows.length - 1, Math.round((x - f.M.l - f.band / 2) / f.band)));
    };
    hit.addEventListener("pointermove", (e) => at(nearest(e)));
    hit.classList.add("clickable");
    hit.addEventListener("click", (e) => { const i = nearest(e); openDrill({ kind: "prompts", day: rows[i].day, title: `Prompts · ${dayLabel(rows[i].day)}` }); });
    hit.addEventListener("pointerleave", () => { f.tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
    let fi = rows.length - 1;
    hit.addEventListener("focus", () => at(fi));
    hit.addEventListener("blur", () => { f.tip.hidden = true; });
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { fi = Math.max(0, fi - 1); at(fi); }
      if (e.key === "ArrowRight") { fi = Math.min(rows.length - 1, fi + 1); at(fi); }
      if (e.key === "Enter") openDrill({ kind: "prompts", day: rows[fi].day, title: `Prompts · ${dayLabel(rows[fi].day)}` });
    });
    f.svg.setAttribute("aria-label", `${label} per day`);
  }

  // Stacked columns; each segment is its own hover target. 2px surface gaps.
  function stackedChart(container, rows, defs) {
    const f = frame(container, rows);
    const totals = rows.map((r) => defs.reduce((s, d) => s + r[d.key], 0));
    const sc = niceScale(Math.max(1, ...totals));
    const max = sc.max;
    axes(f, rows, sc);
    const bw = Math.min(24, f.band * 0.6);
    const scale = (v) => (f.ih * v) / max;
    rows.forEach((r0, i) => {
      let yTop = f.M.t + f.ih;
      const segs = defs.map((d, k) => ({ ...d, k, v: r0[d.key] })).filter((s) => s.v > 0);
      segs.forEach((s, j) => {
        // Segment j spans [top, bottom]; a 2px surface gap separates it from the one below.
        const h = scale(s.v);
        const top = yTop - h;
        const gapBelow = j ? 2 : 0;
        const hgt = Math.max(1, h - gapBelow);
        const x = f.xAt(i) - bw / 2;
        const isTop = j === segs.length - 1;
        const r = isTop && hgt > 4 ? 4 : 0; // 4px rounded data-end, square at the baseline
        const path = r
          ? `M${x},${top + hgt} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + bw - r},${top} Q${x + bw},${top} ${x + bw},${top + r} L${x + bw},${top + hgt} Z`
          : `M${x},${top} h${bw} v${hgt} h${-bw} Z`;
        const seg = svgEl("path", { d: path, fill: css(OUTCOME_COLORS[s.k]), tabindex: 0 });
        seg.setAttribute("aria-label", `${s.label}, ${dayLabel(r0.day)}: ${s.v}`);
        clickable(seg, { kind: "violations", outcome: s.key, day: r0.day, title: `${s.label} · ${dayLabel(r0.day)}` });
        const show = () => {
          seg.setAttribute("fill-opacity", 0.8);
          showTip(f, container, f.xAt(i), dayLabel(r0.day), segs.slice().reverse().map((q) => ({ color: css(OUTCOME_COLORS[q.k]), value: q.v, label: q.label })));
        };
        const hide = () => { seg.setAttribute("fill-opacity", 1); f.tip.hidden = true; };
        seg.addEventListener("pointermove", show);
        seg.addEventListener("pointerleave", hide);
        seg.addEventListener("focus", show);
        seg.addEventListener("blur", hide);
        f.svg.append(seg);
        yTop = top;
      });
    });
    f.svg.setAttribute("aria-label", "Violations per day by outcome");
    if (!totals.some(Boolean)) {
      const t = svgEl("text", { x: f.W / 2, y: f.H / 2, "text-anchor": "middle", "font-size": 13, fill: css("--muted") });
      t.textContent = "No sensitive data detected in this period";
      f.svg.append(t);
    }
  }

  function legend(target, defs) {
    target.replaceChildren(...defs.map((d, k) => clickable(
      el("button", { type: "button", title: `See all: ${d.label}` }, el("i", { style: `background:var(${OUTCOME_COLORS[k]})` }), d.label),
      { kind: "violations", outcome: d.key, title: d.label })));
  }

  function tableView(rows, cols) {
    const t = el("table", {});
    t.append(el("thead", {}, el("tr", {}, ...cols.map((c) => el("th", { class: c.num ? "num" : "" }, c.label)))));
    const tb = el("tbody", {});
    for (const r of rows) tb.append(el("tr", {}, ...cols.map((c) => el("td", { class: c.num ? "num" : "", "data-label": c.label }, c.fmt ? c.fmt(r) : String(r[c.key])))));
    t.append(tb);
    return el("div", { class: "table-wrap" }, t);
  }

  // "Show table" toggles: replace the chart with its data table and back.
  const tables = {};
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-table]");
    if (!b) return;
    const id = b.dataset.table;
    tables[id] = !tables[id];
    b.textContent = tables[id] ? "Show chart" : "Show table";
    render();
  });

  function bars(target, items, empty) {
    target.replaceChildren();
    const max = Math.max(1, ...items.map((i) => i.value));
    if (!items.length) { target.append(el("div", { class: "empty" }, empty)); return; }
    for (const it of items) {
      const fill = el("div", { class: "fill", style: `width:${(it.value / max) * 100}%` });
      target.append(clickable(el("div", { class: "bar-row" },
        el("div", {}, it.label, it.sub ? el("div", { class: "muted small" }, it.sub) : null),
        el("div", { class: "track", title: `${it.label}: ${it.value}` }, fill),
        el("div", { class: "num", style: "text-align:right;font-variant-numeric:tabular-nums" }, nf.format(it.value))), it.drill));
    }
  }

  function tile(label, value, delta, drill) {
    return clickable(el("div", { class: "card tile" },
      el("div", { class: "label" }, label),
      el("div", { class: "value" }, value),
      delta ? el("div", { class: "delta" }, delta) : null), drill);
  }

  // Placeholders highlighted, everything else as plain text (never innerHTML).
  function promptNode(text) {
    const span = el("span", {});
    for (const part of String(text || "").split(/(\[[A-Z_]+_\d+\])/g)) {
      span.append(/^\[[A-Z_]+_\d+\]$/.test(part) ? el("span", { class: "ph" }, part) : part);
    }
    return span;
  }

  // ---------- originals (decrypted in this browser only) ----------
  const unlock = { key: null, analyst: "", reason: "", lastUse: 0, revealed: new Map(), pending: null };
  const AUTO_LOCK_MS = 10 * 60 * 1000;

  // Original text with the sensitive values highlighted.
  function originalNode(plain) {
    const span = el("span", {});
    const vals = [...new Set((plain.values || []).map((v) => v.value).filter(Boolean))].sort((a, b) => b.length - a.length);
    const text = String(plain.original_text || "");
    if (!vals.length) { span.append(text); return span; }
    const re = new RegExp(vals.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    let last = 0;
    for (const m of text.matchAll(re)) {
      span.append(text.slice(last, m.index), el("mark", { class: "orig" }, m[0]));
      last = m.index + m[0].length;
    }
    span.append(text.slice(last));
    return span;
  }

  // Prompt cell: redacted by default; "Show original" when an encrypted original exists.
  function promptCell(e) {
    const wrap = el("span", {});
    const id = e["evidence.id"];
    const shown = id && unlock.key && unlock.revealed.get(id);
    if (shown) {
      wrap.append(el("div", { class: "orig-label" }, "ORIGINAL"), originalNode(shown));
      wrap.append(el("div", {}, el("button", { class: "link orig-toggle", onclick: () => { unlock.revealed.delete(id); render(); refreshDrill(); } }, "Hide original")));
    } else {
      wrap.append(promptNode(e["prompt.redacted"]));
      if (e["evidence.present"] && id) {
        wrap.append(el("div", {}, el("button", { class: "link orig-toggle", onclick: () => reveal([id]) }, "Show original")));
      }
    }
    return wrap;
  }

  async function reveal(ids) {
    if (!unlock.key) { unlock.pending = ids; openUnlock(); return; }
    unlock.lastUse = Date.now();
    for (const id of ids) {
      if (unlock.revealed.has(id)) continue;
      try {
        const res = await fetch("/admin/api/evidence/reveal", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, analyst: unlock.analyst, reason: unlock.reason }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const rec = await res.json();
        unlock.revealed.set(id, await PGAdminCrypto.decryptEvidence(rec, unlock.key));
      } catch (err) {
        $("updated").textContent = `Couldn't show original: ${err.message === "The operation failed for an operation-specific reason" ? "this original was encrypted with a different key" : err.message}`;
      }
    }
    render();
    refreshDrill();
  }

  function lock() {
    unlock.key = null; // drop the only reference to the key
    unlock.revealed.clear();
    unlock.pending = null;
    $("unlocked").hidden = true;
    $("unlock-btn").hidden = false;
    render();
    refreshDrill();
  }

  function openUnlock() {
    $("u-msg").textContent = "";
    $("u-msg").className = "muted small";
    $("u-pass").value = "";
    $("unlock-dialog").hidden = false;
    $("unlock-backdrop").hidden = false;
    ($("u-analyst").value ? $("u-reason").value ? $("u-key") : $("u-reason") : $("u-analyst")).focus();
  }
  function closeUnlock() {
    $("unlock-dialog").hidden = true;
    $("unlock-backdrop").hidden = true;
    $("u-pass").value = "";
  }

  async function doUnlock() {
    const msg = $("u-msg");
    const fail = (t) => { msg.textContent = t; msg.className = "small bad"; };
    const analyst = $("u-analyst").value.trim();
    const reason = $("u-reason").value.trim();
    const file = $("u-key").files[0];
    const pass = $("u-pass").value;
    if (!analyst) return fail("Enter your name.");
    if (reason.length < 10) return fail("Enter a reason of at least 10 characters (e.g. a ticket number).");
    if (!file) return fail("Choose your private key file (.key).");
    if (!pass) return fail("Enter the passphrase.");
    msg.className = "muted small";
    msg.textContent = "Unlocking… (about a second)";
    $("u-ok").disabled = true;
    try {
      unlock.key = await PGAdminCrypto.openKeyFile(await file.text(), pass);
      unlock.analyst = analyst;
      unlock.reason = reason;
      unlock.lastUse = Date.now();
      closeUnlock();
      $("unlock-btn").hidden = true;
      $("unlocked").hidden = false;
      const pending = unlock.pending;
      unlock.pending = null;
      if (pending) await reveal(pending); else { render(); refreshDrill(); }
    } catch (err) {
      fail(err.message || "Couldn't open the key file.");
    } finally {
      $("u-ok").disabled = false;
      $("u-pass").value = "";
    }
  }

  $("unlock-btn").addEventListener("click", () => openUnlock());
  $("lock-btn").addEventListener("click", lock);
  $("u-cancel").addEventListener("click", () => { unlock.pending = null; closeUnlock(); });
  $("unlock-backdrop").addEventListener("click", () => { unlock.pending = null; closeUnlock(); });
  $("u-ok").addEventListener("click", doUnlock);
  $("unlock-dialog").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doUnlock();
    if (e.key === "Escape") { e.stopPropagation(); unlock.pending = null; closeUnlock(); }
  });
  $("reveal-all").addEventListener("click", () => {
    const visible = [...document.querySelectorAll("[data-evidence-id]")].map((x) => x.dataset.evidenceId);
    if (unlock.revealed.size && visible.every((id) => unlock.revealed.has(id))) { unlock.revealed.clear(); render(); refreshDrill(); return; }
    reveal([...new Set(visible)]);
  });
  setInterval(() => {
    if (!unlock.key) return;
    const left = AUTO_LOCK_MS - (Date.now() - unlock.lastUse);
    if (left <= 0) { lock(); $("updated").textContent = "Originals locked after 10 minutes of inactivity."; return; }
    $("unlock-timer").textContent = `auto-locks in ${Math.ceil(left / 60000)} min`;
    $("reveal-all").textContent = unlock.revealed.size ? "Hide all" : "Show all on screen";
  }, 1000);
  document.addEventListener("pointerdown", () => { if (unlock.key) unlock.lastUse = Date.now(); });

  const ACTION_TEXT = {
    prompt_sent: "Sent", prompt_sent_redacted: "Sent redacted", prompt_blocked: "Blocked", prompt_cancelled: "Cancelled by user",
    prompt_sent_unredacted: "Sent unredacted (override)", redaction_failed: "Redaction failed, not sent",
    paste_redacted: "Paste redacted", paste_blocked: "Paste blocked", paste_cancelled: "Paste cancelled", paste_unredacted: "Pasted unredacted (override)",
    file_blocked: "File upload blocked", file_attached: "File uploaded", false_positive_report: "False positive reported",
    adapter_degraded: "Site layout changed (fallback)",
  };
  const TYPE_TEXT = {
    SA_ID_NUMBER: "ID number", CREDIT_CARD: "card number", API_SECRET: "password / API key", EMAIL: "email",
    PHONE_NUMBER: "phone number", KEYWORD: "confidential term", PASSPORT: "passport", BANK_ACCOUNT: "bank account",
    TAX_NUMBER: "tax number", MEMBER_NUMBER: "member / policy number", DATE_OF_BIRTH: "date of birth",
    IP_ADDRESS: "IP address", ADDRESS: "street address", PERSON_NAME: "name", LONG_NUMBER: "long number",
  };
  const whatText = (e) => (e.detections || []).map((d) => `${d.count} ${TYPE_TEXT[d.type] || d.type}${d.count > 1 ? "s" : ""}`).join(", ");
  const localDayOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const timeText = (ts) => new Date(ts).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });

  // ---------- views ----------

  function renderExec(d, events) {
    const t = d.totals;
    const prevented = d.outcomes.redacted + d.outcomes.warned + d.outcomes.cancelled + d.outcomes.blocked;
    const sitesTxt = d.sites.length ? `${d.sites.length} AI tool${d.sites.length > 1 ? "s" : ""}` : "AI tools";
    const per = state.days === 1 ? "Today" : `In the last ${state.days} days`;
    let s = `${per}, staff sent ${nf.format(t.prompts)} prompt${t.prompts === 1 ? "" : "s"} to ${sitesTxt}. `;
    if (!t.violations) s += "None contained sensitive data.";
    else {
      s += `${nf.format(t.violations)} contained sensitive data`;
      s += d.outcomes.override ? ` and ${nf.format(prevented)} of those were stopped or redacted before reaching the AI.` : ", and all of it was stopped or redacted before reaching the AI.";
      if (d.outcomes.override) s += ` ${nf.format(d.outcomes.override)} ${d.outcomes.override === 1 ? "was" : "were"} sent unredacted by an approved override.`;
    }
    $("exec-summary").textContent = s;
    $("hero-value").textContent = compact(prevented);
    if (!$("hero-value").dataset.wired) {
      $("hero-value").dataset.wired = "1";
      clickable($("hero-value"), { kind: "violations", title: "Sensitive-data leaks prevented" });
    }
    $("hero-delta").textContent = deltaText(t.violationsDeltaPct, t.violationsPrev, periodLabel());

    const attention = events.filter((e) => e["alert.soc"] || e.bulk || /unredacted|redaction_failed/.test(e["event.action"]));
    const topSite = d.sites.slice().sort((a, b) => b.prompts - a.prompts)[0];
    const share = topSite && t.prompts ? Math.round((topSite.prompts / t.prompts) * 100) : 0;
    $("exec-tiles").replaceChildren(
      tile("Prompts sent to AI", compact(t.prompts), deltaText(t.promptsDeltaPct, t.promptsPrev, periodLabel()), { kind: "prompts", title: "All prompts" }),
      tile("Prompts with sensitive data", compact(t.violations), t.prompts ? `${Math.round((t.violations / t.prompts) * 100)}% of all prompts` : "", { kind: "violations", title: "Prompts with sensitive data" }),
      tile("Needs attention", nf.format(attention.length), attention.length ? "see list below" : "nothing to review", { kind: "attention", title: "Needs attention" }),
      tile("Most-used AI tool", topSite ? topSite.site : "–", topSite ? `${share}% of prompts` : "", topSite ? { kind: "all", site: topSite.site, title: topSite.site } : null));

    legend($("exec-legend"), d.outcomeDefs);
    if (tables["exec-chart"]) {
      $("exec-chart").replaceChildren(tableView(d.daily, [{ label: "Day", fmt: (r) => dayLabel(r.day) },
        ...d.outcomeDefs.map((o) => ({ label: o.label, key: o.key, num: true }))]));
    } else stackedChart($("exec-chart"), d.daily, d.outcomeDefs);

    const att = $("exec-attention");
    att.replaceChildren();
    if (!attention.length) att.append(el("div", { class: "status ok" }, "✓ ", "Nothing needs attention in this period"));
    else {
      const ul = el("ul", { class: "attention" });
      for (const e of attention.slice(0, 6)) {
        const what = whatText(e) || (e["file.count"] ? `${e["file.count"]} file(s)` : "sensitive data");
        const verb = ACTION_TEXT[e["event.action"]] || e["event.action"];
        ul.append(clickable(el("li", {}, el("b", {}, verb), ` · ${what} · ${e["ai.site"] || ""}`, el("span", { class: "muted small" }, ` · ${timeText(e["@timestamp"])}`)),
          { kind: "attention", day: e["@timestamp"] ? localDayOf(e["@timestamp"]) : "", title: `Needs attention · ${dayLabel(localDayOf(e["@timestamp"]))}` }));
      }
      att.append(ul);
      if (attention.length > 6) att.append(clickable(el("div", { class: "muted small" }, `+ ${attention.length - 6} more (click to see all)`), { kind: "attention", title: "Needs attention" }));
    }

    bars($("exec-sites"), d.sites.map((x) => ({ label: x.site, value: x.prompts, sub: x.violations ? `${nf.format(x.violations)} with sensitive data` : "no sensitive data",
      drill: { kind: "all", site: x.site, title: x.site } })), "No AI use recorded in this period");
    bars($("exec-categories"), Object.entries(d.categories).filter(([, v]) => v).map(([k, v]) => ({ label: k, value: v,
      drill: { kind: "violations", category: k, title: k } })), "Nothing stopped in this period");
  }

  function renderAnalyst(d, events, auditData) {
    const t = d.totals;
    const browsers = Object.entries(d.browsers).sort((a, b) => b[1] - a[1]);
    const btotal = browsers.reduce((s, [, v]) => s + v, 0);
    $("an-tiles").replaceChildren(
      tile("Prompts", compact(t.prompts), deltaText(t.promptsDeltaPct, t.promptsPrev, periodLabel()), { kind: "prompts", title: "All prompts" }),
      tile("Violations", compact(t.violations), deltaText(t.violationsDeltaPct, t.violationsPrev, periodLabel()), { kind: "violations", title: "All violations" }),
      ...d.outcomeDefs.map((o) => tile(o.label, nf.format(d.outcomes[o.key]), null, { kind: "violations", outcome: o.key, title: o.label })),
      tile("Top browser", browsers.length ? `${Math.round((browsers[0][1] / btotal) * 100)}%` : "–",
        browsers.map(([b, v]) => `${b} ${Math.round((v / btotal) * 100)}%`).join(" · ")));

    if (tables["an-prompts"]) $("an-prompts").replaceChildren(tableView(d.daily, [{ label: "Day", fmt: (r) => dayLabel(r.day) }, { label: "Prompts", key: "prompts", num: true }]));
    else lineChart($("an-prompts"), d.daily, "prompts", "Prompts");
    legend($("an-legend"), d.outcomeDefs);
    if (tables["an-violations"]) {
      $("an-violations").replaceChildren(tableView(d.daily, [{ label: "Day", fmt: (r) => dayLabel(r.day) },
        ...d.outcomeDefs.map((o) => ({ label: o.label, key: o.key, num: true }))]));
    } else stackedChart($("an-violations"), d.daily, d.outcomeDefs);

    const sites = $("an-sites");
    sites.replaceChildren(d.sites.length ? tableView(d.sites, [
      { label: "AI site", fmt: (r) => clickable(el("button", { class: "user-link" }, r.site), { kind: "all", site: r.site, title: r.site }) },
      { label: "Violation types", fmt: (r) => {
        const span = el("span", {});
        for (const [c, n] of Object.entries(r.categories)) {
          span.append(clickable(el("span", { class: "chip" }, el("span", { class: "dot", style: "background:var(--ink-2)" }), `${c} (${n})`),
            { kind: "violations", site: r.site, category: c, title: `${c} · ${r.site}` }));
        }
        return span.childNodes.length ? span : "–";
      } },
      { label: "Prompts", key: "prompts", num: true },
      { label: "Violations", key: "violations", num: true },
    ]) : el("div", { class: "empty" }, "No AI use recorded in this period"));

    const feed = $("an-feed");
    const shown = events.slice(0, state.feedRows);
    feed.replaceChildren(events.length ? tableView(shown, [
      { label: "Time", fmt: (e) => timeText(e["@timestamp"]) },
      { label: "User", fmt: (e) => `${e["user.name"] || "?"}` },
      { label: "Site", fmt: (e) => e["ai.site"] || "" },
      { label: "What happened", fmt: (e) => {
        const span = el("span", {}, ACTION_TEXT[e["event.action"]] || e["event.action"]);
        if (e["alert.soc"]) span.append(el("span", { class: "chip", style: "color:var(--critical);border-color:var(--critical);margin-left:6px" }, "⚑ SOC"));
        if (e["evidence.present"]) span.append(el("div", { class: "muted small" }, `evidence ${e["evidence.id"]}`));
        const w = whatText(e);
        if (w) span.append(el("div", { class: "muted small" }, w));
        return span;
      } },
      { label: "Prompt", fmt: (e) => { const c = promptCell(e); if (e["evidence.present"]) c.dataset.evidenceId = e["evidence.id"]; return c; } },
    ]) : el("div", { class: "empty" }, "No activity in this period"));
    feed.querySelectorAll("td:last-child").forEach((td) => td.classList.add("prompt"));
    if (events.length > shown.length) {
      feed.append(el("button", { class: "link", style: "margin-top:10px", onclick: () => { state.feedRows += 25; render(); } },
        `Show more (${events.length - shown.length} older)`));
    }

    const chain = auditData.chain;
    $("an-chain").replaceChildren(chain.ok
      ? el("span", { class: "status ok" }, "✓ ", `Access log intact (${chain.entries} entr${chain.entries === 1 ? "y" : "ies"})`)
      : el("span", { class: "status bad" }, "⚠ ", `Access log TAMPERED at entry ${chain.brokenAt}`));
    $("an-audit").replaceChildren(auditData.entries.length ? tableView(auditData.entries.slice(0, 50), [
      { label: "When", fmt: (e) => timeText(e.at) },
      { label: "Analyst", key: "analyst" },
      { label: "Reason", key: "reason" },
      { label: "Whose data", fmt: (e) => e.subject_user || "" },
      { label: "Evidence", key: "evidence_id" },
    ]) : el("div", { class: "empty" }, "No originals have been viewed."));
  }

  function fillChoices(select, values, current) {
    const keep = select.firstElementChild;
    select.replaceChildren(keep, ...values.map((v) => el("option", { value: v }, v)));
    select.value = current;
  }

  let cache = null;
  function render() {
    if (!cache) return;
    const [d, events, auditData] = cache;
    fillChoices($("f-user"), d.choices.users, state.user);
    fillChoices($("f-site"), d.choices.sites, state.site);
    if (state.view === "exec") renderExec(d, events); else renderAnalyst(d, events, auditData);
  }

  async function load() {
    const main = document.querySelector("main");
    main.classList.add("fade");
    try {
      cache = await Promise.all([api("summary"), api("events", { limit: 200 }), api("audit")]);
      $("updated").textContent = `Updated ${new Date().toLocaleTimeString("en-ZA", { timeStyle: "short" })}`;
      render();
    } catch (err) {
      $("updated").textContent = `Couldn't load data: ${err.message}`;
    } finally {
      main.classList.remove("fade");
    }
  }

  document.querySelectorAll(".presets button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".presets button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state.days = +b.dataset.days;
    load();
  }));
  $("f-user").addEventListener("change", (e) => { state.user = e.target.value; load(); });
  $("f-site").addEventListener("change", (e) => { state.site = e.target.value; load(); });

  function setView(v) {
    state.view = v;
    $("tab-exec").setAttribute("aria-selected", String(v === "exec"));
    $("tab-analyst").setAttribute("aria-selected", String(v === "analyst"));
    $("view-exec").hidden = v !== "exec";
    $("view-analyst").hidden = v !== "analyst";
    document.querySelectorAll(".analyst-only").forEach((x) => { x.hidden = v !== "analyst"; });
    if (v === "exec") { state.user = ""; state.site = ""; } // exec view is always org-wide
    load();
  }
  $("tab-exec").addEventListener("click", () => setView("exec"));
  $("tab-analyst").addEventListener("click", () => setView("analyst"));

  // Live refresh in the analyst view (activity monitor); exec view every minute.
  let ticks = 0;
  setInterval(() => { ticks++; if (state.view === "analyst" || ticks % 12 === 0) load(); }, 5000);
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 150); });
  load();
})();
