// ---------------- state ----------------
const state = {
  members: [],
  testTypes: [],
  activeMember: null,
  view: "overview",
  search: "",
  collapsed: {},
  statusFilter: null,
};

state.history = [];

function navigateTo(view, extras = {}) {
  // Ignore redundant clicks on the current view/member
  if (state.view === view && (extras.activeMember === undefined || extras.activeMember === state.activeMember)) {
    return;
  }

  const entry = {
    view: state.view,
    activeMember: state.activeMember,
    search: state.search,
    statusFilter: state.statusFilter,
    _detail: state._detail ? { ...state._detail } : null,
    _doc: state._doc ? { ...state._doc } : null,
    _reviewDoc: state._reviewDoc ? { ...state._reviewDoc } : null,
    _report: state._report ? { ...state._report } : null
  };
  
  state.history.push(entry);
  
  state.view = view;
  Object.assign(state, extras);
  render();
}

function navigateBack() {
  if (state.history.length > 0) {
    const prev = state.history.pop();
    state.view = prev.view;
    state.activeMember = prev.activeMember;
    state.search = prev.search;
    state.statusFilter = prev.statusFilter;
    state._detail = prev._detail;
    state._doc = prev._doc;
    state._reviewDoc = prev._reviewDoc;
    state._report = prev._report;
    render();
  } else {
    state.view = "household";
    render();
  }
}


const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
// A non-detect ("<0.01") must never render as a bare measurement — keep the
// comparator the lab printed.
const fmtVal = (n, qualifier) => (n == null ? "—" : (qualifier ? qualifier : "") + fmtNum(n));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);

function ageOf(dob) {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b)) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return a;
}
function memberMeta(m) {
  const parts = [];
  const a = ageOf(m.dob);
  if (a != null) parts.push(`${a} yrs`);
  if (m.sex) parts.push(m.sex);
  return parts.join(" · ");
}

// ---------------- charts (hand-drawn SVG) ----------------
function sparkline(points, w = 240, h = 44) {
  if (points.length === 0) return el("div");
  const vals = points.map((p) => p.value_canonical);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 4;
  const xs = (i) => pad + (points.length === 1 ? (w - 2 * pad) / 2 : (i / (points.length - 1)) * (w - 2 * pad));
  const ys = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.value_canonical).toFixed(1)}`).join(" ");
  const svg = svgNode("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, class: "spark" });
  svg.append(svgNode("path", { d, class: "series-line" }));
  const last = points[points.length - 1];
  svg.append(svgNode("circle", { cx: xs(points.length - 1), cy: ys(last.value_canonical), r: 3.5, class: "pt" + (last.flag ? " pt-" + last.flag : "") }));
  return svg;
}

function svgNode(tag, attrs = {}) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Compact inline sparkline from a plain array of numbers (dense list rows).
function miniSpark(values, flag) {
  const w = 84, h = 26, pad = 3;
  const svg = svgNode("svg", { viewBox: `0 0 ${w} ${h}`, class: "row-spark", preserveAspectRatio: "none" });
  if (!values || !values.length) return svg;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const xs = (i) => pad + (values.length === 1 ? (w - 2 * pad) / 2 : (i / (values.length - 1)) * (w - 2 * pad));
  const ys = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  if (values.length > 1) {
    const d = values.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
    svg.append(svgNode("path", { d, class: "series-line", "stroke-width": "1.6" }));
  }
  const li = values.length - 1;
  svg.append(svgNode("circle", { cx: xs(li).toFixed(1), cy: ys(values[li]).toFixed(1), r: 2.6, class: "pt" + (flag ? " pt-" + flag : "") }));
  return svg;
}

// ---------------- theme ----------------
function initTheme() {
  try { localStorage.removeItem("labtracker-theme"); } catch {}
  document.documentElement.removeAttribute("data-theme");
}

// A "nice" axis step (1/2/2.5/5/10 x10^n) so ticks land on round numbers
// instead of arbitrary fractions of the data range (120.96, 114.48, …).
function niceStep(span, count) {
  const raw = (span || 1) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return Number((mult * mag).toPrecision(12));
}
// Decimals implied by the step itself: a step of 5 needs none, 0.5 needs one.
// This is what keeps a lymphocyte count on whole numbers while HbA1c keeps its
// tenths — the precision follows the scale rather than a fixed guess.
function decimalsFor(step) {
  const m = String(step).match(/\.(\d+)/);
  return m ? Math.min(6, m[1].length) : 0;
}
const fmtTick = (v, dec) => Number(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });

function trendChart(points, opts) {
  // opts: { unit, zones (canonical), convert }
  const W = 720, H = 300, m = { t: 24, r: 64, b: 34, l: 58 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const conv = opts.convert;
  const vals = points.map((p) => conv(p.value_canonical));
  // Work in display units throughout, zone boundaries included.
  const dz = opts.zones ? opts.zones.map((z) => ({ c: z.c, label: z.label, to: z.to == null ? null : conv(z.to) })) : null;

  let lo = Math.min(...vals), hi = Math.max(...vals);
  // Pull in the boundaries of the band the latest value sits in, so the chart
  // always shows the value *in context* rather than floating in one flat colour.
  if (dz) {
    const az = zoneOf(vals[vals.length - 1], dz);
    const i = dz.indexOf(az);
    for (const edge of [i > 0 ? dz[i - 1].to : null, az.to]) {
      if (edge != null) { lo = Math.min(lo, edge); hi = Math.max(hi, edge); }
    }
  }
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const padv = (hi - lo) * 0.15;
  lo -= padv; hi += padv;
  const step = niceStep(hi - lo, 5);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (Math.min(...vals) >= 0 && lo < 0) lo = 0;   // lab values don't go negative
  const dec = decimalsFor(step);
  const span = hi - lo || 1;

  const times = points.map((p) => new Date(p.taken_at).getTime());
  const tmin = Math.min(...times), tmax = Math.max(...times);
  const tspan = tmax - tmin || 1;
  const xs = (t) => m.l + (points.length === 1 ? iw / 2 : ((t - tmin) / tspan) * iw);
  const ys = (v) => m.t + ih - ((v - lo) / span) * ih;
  const clampY = (y) => Math.max(m.t, Math.min(m.t + ih, y));

  const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: "max-width:100%" });

  // Zone bands — the same green / amber / red story as the range bar.
  if (dz) {
    let prev = null;
    for (const z of dz) {
      const top = clampY(ys(z.to == null ? hi : z.to));
      const bot = clampY(ys(prev == null ? lo : prev));
      if (bot - top > 0.5) {
        svg.append(svgNode("rect", { x: m.l, y: top, width: iw, height: bot - top, class: "zband " + z.c }));
      }
      if (z.to != null && z.to > lo && z.to < hi) {
        svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: ys(z.to), y2: ys(z.to), class: "zbound" }));
      }
      prev = z.to;
    }
  }

  // y gridlines + ticks on round values
  for (let v = lo; v <= hi + step * 1e-9; v += step) {
    const y = ys(v);
    svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: "grid-line" }));
    const t = svgNode("text", { x: m.l - 8, y: y + 4, "text-anchor": "end", class: "tick" });
    t.textContent = fmtTick(v, dec);
    svg.append(t);
  }
  svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "axis-line" }));

  // unit caption, so the scale is readable without the legend
  if (opts.unit) {
    const u = svgNode("text", { x: m.l - 8, y: m.t - 9, "text-anchor": "end", class: "tick axis-unit" });
    u.textContent = opts.unit;
    svg.append(u);
  }

  // x ticks
  const nx = Math.min(points.length, 5);
  for (let i = 0; i < nx; i++) {
    const t = points.length === 1 ? tmin : tmin + (tspan * i) / (nx - 1);
    const lbl = svgNode("text", { x: xs(t), y: H - 12, "text-anchor": "middle", class: "tick" });
    lbl.textContent = new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    svg.append(lbl);
  }

  // dotted connector between readings (only meaningful with more than one)
  if (points.length > 1) {
    const d = "M" + points.map((p, i) => `${xs(times[i]).toFixed(1)},${ys(vals[i]).toFixed(1)}`).join(" L");
    svg.append(svgNode("path", { d, class: "series-line dotted" }));
  }

  // points, coloured by the band they land in
  points.forEach((p, i) => {
    const isLast = i === points.length - 1;
    const cx = xs(times[i]), cy = ys(vals[i]);
    const zc = dz ? zoneOf(vals[i], dz).c : "green";
    if (isLast) svg.append(svgNode("circle", { cx, cy, r: 11, class: "pt-halo " + zc }));
    const c = svgNode("circle", { cx, cy, r: isLast ? 6 : 4, class: "pt " + zc + (isLast ? " latest" : "") });
    const title = svgNode("title");
    title.textContent = `${fmtDate(p.taken_at)}: ${fmtVal(conv(p.value_canonical), p.qualifier)} ${opts.unit}`
      + (dz ? ` — ${zoneOf(vals[i], dz).label}` : "")
      + `\nreported: ${fmtVal(p.value, p.qualifier)} ${p.unit}`;
    c.append(title);
    svg.append(c);
    // Label the current reading so you never have to hunt for "where am I now".
    if (isLast) {
      const lx = Math.min(cx + 12, W - 4);
      const lbl = svgNode("text", { x: lx, y: cy - 12, "text-anchor": cx > m.l + iw - 40 ? "end" : "start", class: "pt-label " + zc });
      lbl.textContent = `${fmtVal(conv(p.value_canonical), p.qualifier)}${opts.unit ? " " + opts.unit : ""}`;
      svg.append(lbl);
    }
  });
  return svg;
}

// unit conversion for a test type in the frontend (from canonical to display unit)
function converter(testType, displayUnit) {
  const conv = testType.conversions || {};
  const canon = testType.canonical_unit;
  if (!displayUnit || norm(displayUnit) === norm(canon)) return (v) => v;
  // find spec: canonical = raw*f + o  ->  raw = (canonical - o)/f
  for (const [u, spec] of Object.entries(conv)) {
    if (norm(u) === norm(displayUnit)) {
      const f = spec.factor ?? 1, o = spec.offset ?? 0;
      return (v) => (v - o) / f;
    }
  }
  return (v) => v;
}
const norm = (u) => (u || "").toLowerCase().replace(/[µμ]/g, "u").replace(/\s/g, "");
function unitOptions(t) {
  const set = new Set([t.canonical_unit, ...Object.keys(t.conversions || {})]);
  return [...set];
}

// Commit results, but if the server reports duplicates (same date + value
// already on file), ask the user before forcing them in. Returns the final
// commit response, or {cancelled:true} if the user declined the override.
async function commitResults(body) {
  let res = await api("/results/commit", { method: "POST", body });
  if (res.needs_confirmation) {
    const d = res.duplicates || [];
    const preview = d.slice(0, 6).map((x) => `• ${x.name}: ${fmtNum(x.value)} ${x.unit || ""} on ${fmtDate(x.date)}`).join("\n");
    const more = d.length > 6 ? `\n…and ${d.length - 6} more` : "";
    const ok = confirm(
      `${d.length} of these result${d.length > 1 ? "s are" : " is"} already on file with the same date and value:\n\n${preview}${more}\n\nSave anyway and create duplicate${d.length > 1 ? "s" : ""}?`
    );
    if (!ok) return { cancelled: true };
    res = await api("/results/commit", { method: "POST", body: { ...body, force: true } });
  }
  return res;
}

// ---------------- data loading ----------------
async function loadCore() {
  [state.members, state.testTypes] = await Promise.all([api("/members"), api("/test-types")]);
  if (!state.activeMember && state.members.length) state.activeMember = state.members[0].id;
}

// ---------------- rendering ----------------
const initials = (name) => (name || "?").trim().slice(0, 1).toUpperCase();

function renderSidebar() {
  const nav = $("#member-nav");
  nav.innerHTML = "";
  for (const m of state.members) {
    nav.append(el("button", {
      class: "member-item" + (m.id === state.activeMember && state.view === "overview" ? " active" : ""),
      onclick: () => { navigateTo("overview", { activeMember: m.id }); },

    }, [el("span", { class: "avatar", style: `background:${m.color || "#2f6fe0"}` }, initials(m.name)), m.name]));
  }
}

function render() {
  renderSidebar();
  const main = $("#main");
  main.innerHTML = "";
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  if (state.view === "household") renderHousehold(main);
  else if (state.view === "overview") renderOverview(main);
  else if (state.view === "detail") renderDetail(main);
  else if (state.view === "upload") renderUpload(main);
  else if (state.view === "documents") renderDocuments(main);
  else if (state.view === "review-doc") renderReviewDoc(main);
  else if (state.view === "settings") renderSettings(main);
  else if (state.view === "report") renderReport(main);
}

async function renderOverview(main) {
  if (!state.activeMember) {
    main.append(el("div", { class: "card empty-card empty" }, [
      el("span", { class: "empty-icon" }, "👋"),
      el("div", {}, "No family members yet."),
      el("div", { style: "margin-top:14px" }, el("button", { class: "btn btn-primary", onclick: openAddMember }, "＋ Add your first member")),
    ]));
    return;
  }
  const member = state.members.find((m) => m.id === state.activeMember);
  const meta = memberMeta(member);
  main.append(el("div", { class: "page-head" }, [
    el("div", {}, [
      el("h1", { class: "page-title" }, member.name),
      el("p", { class: "page-sub" }, "Lab results overview" + (meta ? " · " + meta : "")),
    ]),
    el("div", { class: "head-actions" }, [
      el("button", { class: "btn", onclick: () => openEditMember(member) }, "✎ Edit"),
      el("button", { class: "btn", onclick: () => { navigateTo("report", { _report: { member } }); } }, "🖨 Doctor report"),
      el("button", { class: "btn", onclick: () => { navigateTo("upload"); } }, "＋ Add results"),
      el("button", { class: "btn btn-primary", onclick: () => openAsk(member) }, "✨ Ask AI"),
    ]),
  ]));

  const summary = await api(`/members/${member.id}/summary`);

  if (!summary.length) {
    main.append(el("div", { class: "card empty-card empty" }, [
      el("span", { class: "empty-icon" }, "🧫"),
      el("div", {}, `No results for ${member.name} yet.`),
      el("div", { style: "margin-top:6px;font-size:13.5px" }, "Upload a lab report and AI will extract the values — or type results in manually."),
      el("div", { style: "margin-top:16px" }, el("button", { class: "btn btn-primary", onclick: () => { navigateTo("upload"); } }, "＋ Add results")),
    ]));
    return;
  }
  // Search on top.
  const search = el("input", { type: "text", placeholder: "Search biomarkers…", value: state.search || "" });
  search.addEventListener("input", () => { state.search = search.value; paint(); });
  main.append(el("div", { class: "toolbar" }, el("div", { class: "search-box" }, [el("span", { class: "mag" }, "⌕"), search])));

  // Overall status filter below — same pill UI as the category indicators.
  const totals = { red: 0, amber: 0, green: 0 };
  for (const s of summary) { const st = statusOf(s); if (totals[st] != null) totals[st]++; }
  const summaryStrip = el("div", { class: "status-summary" });
  const chip = (key, cls, text) => el("button", {
    class: `filter-pill ${cls}` + (state.statusFilter === key ? " active" : ""),
    onclick: () => { state.statusFilter = state.statusFilter === key ? null : key; paint(); },
  }, text);
  main.append(summaryStrip);

  const listMount = el("div");
  main.append(listMount);

  function paint() {
    // Repaint the filter pills (active state) each time; hide zero counts.
    summaryStrip.innerHTML = "";
    if (totals.red) summaryStrip.append(chip("red", "out", `${totals.red} out of range`));
    if (totals.amber) summaryStrip.append(chip("amber", "borderline", `${totals.amber} borderline`));
    if (totals.green) summaryStrip.append(chip("green", "in", `${totals.green} in range`));

    listMount.innerHTML = "";
    const q = (state.search || "").trim().toLowerCase();
    const flt = state.statusFilter;
    let rows = q ? summary.filter((s) => s.name.toLowerCase().includes(q)) : summary.slice();
    if (flt) rows = rows.filter((s) => statusOf(s) === flt);
    if (!rows.length) {
      const msg = flt ? `No biomarkers are ${{ red: "out of range", amber: "borderline", green: "in range" }[flt]}${q ? " matching your search" : ""}.` : "No biomarkers match your search.";
      listMount.append(el("div", { class: "overview-empty-cat" }, msg));
      return;
    }

    const byCat = {};
    for (const s of rows) (byCat[s.category || "Other"] ||= []).push(s);
    const cats = Object.keys(byCat).sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b));

    for (const cat of cats) {
      const items = byCat[cat].sort((a, b) => a.name.localeCompare(b.name));
      const outN = items.filter((s) => statusOf(s) === "red").length;
      const borderN = items.filter((s) => statusOf(s) === "amber").length;
      const inN = items.filter((s) => statusOf(s) === "green").length;
      // Default: categories with an out-of-range result start expanded (review
      // first) — except the "Other" catch-all, which stays collapsed so it never
      // dumps a wall of ungrouped biomarkers.
      if (state.collapsed[cat] === undefined) state.collapsed[cat] = outN === 0 || cat === "Other";
      // A search or a status filter forces every matching group open.
      const open = q || flt ? true : !state.collapsed[cat];

      const header = el("button", { class: "cat-header" + (open ? " open" : ""), onclick: () => { state.collapsed[cat] = !state.collapsed[cat]; paint(); } }, [
        el("span", { class: "chev" }, "▶"),
        el("span", { class: "cat-name" }, cat),
        el("span", { class: "cat-count" }, `(${items.length} biomarker${items.length > 1 ? "s" : ""})`),
        el("span", { class: "spacer" }),
        outN ? el("span", { class: "count-pill out" }, `${outN} out of range`) : null,
        borderN ? el("span", { class: "count-pill borderline" }, `${borderN} borderline`) : null,
        inN ? el("span", { class: "count-pill in" }, `${inN} in range`) : null,
      ]);
      const group = el("div", { class: "cat-group" }, header);
      if (open) {
        const body = el("div", { class: "cat-body" });
        items.forEach((s) => body.append(bioCard(member, s)));
        group.append(body);
      }
      listMount.append(group);
    }
  }
  paint();
}



// ---------------- member edit ----------------
const MEMBER_PALETTE = ["#2a78d6", "#1baf7a", "#eda100", "#e34948", "#4a3aa7", "#e87ba4", "#eb6834"];

function openEditMember(member) {
  const name = el("input", { type: "text", value: member.name });
  const dob = el("input", { type: "date", value: member.dob || "" });
  const sex = el("select", {}, [["", "—"], ["female", "Female"], ["male", "Male"], ["other", "Other"]]
    .map(([v, l]) => el("option", { value: v, ...(v === (member.sex || "") ? { selected: "" } : {}) }, l)));
  let color = member.color || MEMBER_PALETTE[0];
  const swatches = el("div", { class: "swatches" });
  for (const c of MEMBER_PALETTE) {
    const b = el("button", { class: "swatch" + (c === color ? " on" : ""), style: `background:${c}`, onclick: () => {
      color = c;
      swatches.querySelectorAll(".swatch").forEach((s) => s.classList.remove("on"));
      b.classList.add("on");
    } });
    swatches.append(b);
  }
  openModal(`Edit ${member.name}`, [
    el("div", { class: "field" }, [el("label", {}, "Name"), name]),
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Date of birth"), dob]),
      el("div", { class: "field" }, [el("label", {}, "Sex"), sex]),
    ]),
    el("div", { class: "field" }, [el("label", {}, "Color"), swatches]),
  ], [
    el("button", { class: "btn btn-danger", style: "margin-right:auto", onclick: async () => {
      if (confirm(`Delete ${member.name} and ALL their results? This cannot be undone.`)) {
        await api(`/members/${member.id}`, { method: "DELETE" });
        await loadCore();
        closeModal();
        navigateTo("overview", { activeMember: state.members[0]?.id || null });
        toast("Member deleted");
      }
    } }, "Delete member"),
    el("button", { class: "btn", onclick: closeModal }, "Cancel"),
    el("button", { class: "btn btn-primary", onclick: async () => {
      if (!name.value.trim()) return toast("Name required");
      await api(`/members/${member.id}`, { method: "PUT", body: {
        name: name.value.trim(), dob: dob.value || null, sex: sex.value || null, color,
      } });
      await loadCore(); closeModal(); render();
      toast("Saved");
    } }, "Save"),
  ]);
}

// The server resolves ONE range per marker (the report's own range whole, else
// the catalog range for this member's sex/age). Never re-blend the two here.
const rangeLow = (s) => s.ref_low;
const rangeHigh = (s) => s.ref_high;

// Interpretation bands: the marker's own multi-zone bands if defined, else a
// simple in/out band derived from the effective reference range.
function effectiveZones(s) {
  const lo = rangeLow(s), hi = rangeHigh(s);
  let zones = (Array.isArray(s.zones) && s.zones.length) ? s.zones : null;
  if (!zones) {
    if (lo != null && hi != null) zones = [{ to: lo, c: "red", label: "Low" }, { to: hi, c: "green", label: "In range" }, { to: null, c: "red", label: "High" }];
    else if (hi != null) zones = [{ to: hi, c: "green", label: "In range" }, { to: null, c: "red", label: "High" }];
    else if (lo != null) zones = [{ to: lo, c: "red", label: "Low" }, { to: null, c: "green", label: "In range" }];
    else return null;
  }
  return reconcileZones(zones, lo, hi);
}

// A curated band must never contradict the lab's own reference range: a "green"
// (optimal) zone that lies entirely beyond the lab's normal range is downgraded
// to amber, so a value the lab flagged out-of-range can never read as green.
function reconcileZones(zones, lo, hi) {
  if (lo == null && hi == null) return zones;
  return zones.map((z, i) => {
    if (z.c !== "green") return z;
    const zLo = i === 0 ? -Infinity : zones[i - 1].to;
    const zHi = z.to == null ? Infinity : z.to;
    const aboveHi = hi != null && zLo >= hi;
    const belowLo = lo != null && zHi <= lo;
    return (aboveHi || belowLo) ? { ...z, c: "amber", label: z.label } : z;
  });
}
function zoneOf(value, zones) {
  for (const z of zones) if (z.to == null || value < z.to) return z;
  return zones[zones.length - 1];
}
// A result is qualitative when the lab reported text ("Negative") instead of a
// number. It has no scale, so no zones and no chart — only the lab's own flag
// can mark it abnormal.
const isQualitative = (s) => s?.latest?.value_text != null && s?.latest?.value_canonical == null;

// status color: "green" | "amber" | "red" | "na"
function statusOf(s) {
  if (isQualitative(s)) return s.latest.flag ? "red" : "na";
  const v = s.latest?.value_canonical;
  const zones = effectiveZones(s);
  if (v == null || !zones) return "na";
  return zoneOf(v, zones).c;
}
const BADGE_CLASS = { green: "ok", amber: "warn", red: "bad", na: "na" };

// ---------------- household (everyone at a glance) ----------------
async function renderHousehold(main) {
  $(`[data-view="household"]`)?.classList.add("active");
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Household"),
    el("p", { class: "page-sub" }, "Everyone at a glance — who needs a closer look."),
  ])));

  if (!state.members.length) {
    main.append(el("div", { class: "card empty-card empty" }, [
      el("span", { class: "empty-icon" }, "👋"),
      el("div", {}, "No family members yet."),
      el("div", { style: "margin-top:14px" }, el("button", { class: "btn btn-primary", onclick: openAddMember }, "＋ Add your first member")),
    ]));
    return;
  }

  const mount = el("div", { class: "household-grid" });
  main.append(mount);
  mount.append(el("div", { class: "empty" }, [el("span", { class: "spinner" }), " Loading household…"]));

  // One summary per member; a household is small, so parallel is fine and this
  // reuses the exact same status logic the dashboard uses.
  let summaries;
  try {
    summaries = await Promise.all(state.members.map((m) => api(`/members/${m.id}/summary`)));
  } catch (e) {
    mount.innerHTML = "";
    mount.append(el("div", { class: "warn" }, "Couldn't load household: " + e.message));
    return;
  }
  mount.innerHTML = "";

  state.members.forEach((m, i) => {
    const summary = summaries[i] || [];
    const red = summary.filter((s) => statusOf(s) === "red");
    const amber = summary.filter((s) => statusOf(s) === "amber");
    const green = summary.filter((s) => statusOf(s) === "green");
    const attention = [...red, ...amber];
    const latest = summary.reduce((a, s) => (!a || (s.latest_at || "") > a ? (s.latest_at || "") : a), "");

    const card = el("div", { class: "hh-card" }, [
      el("div", { class: "hh-head", onclick: () => { navigateTo("overview", { activeMember: m.id }); } }, [
        el("span", { class: "avatar", style: `background:${m.color || "#2f6fe0"}` }, initials(m.name)),
        el("div", { style: "min-width:0" }, [
          el("div", { class: "hh-name" }, m.name),
          el("div", { class: "hh-meta" }, summary.length
            ? `${summary.length} biomarkers · last ${fmtDate(latest)}`
            : "No results yet"),
        ]),
        el("span", { class: "spacer" }),
        el("span", { class: "row-chev" }, "›"),
      ]),
    ]);

    if (!summary.length) {
      card.append(el("div", { class: "hh-empty" }, "Upload a report to start tracking."));
      mount.append(card);
      return;
    }

    card.append(el("div", { class: "hh-pills" }, [
      red.length ? el("span", { class: "count-pill out" }, `${red.length} out of range`) : null,
      amber.length ? el("span", { class: "count-pill borderline" }, `${amber.length} borderline`) : null,
      green.length ? el("span", { class: "count-pill in" }, `${green.length} in range`) : null,
    ].filter(Boolean)));

    if (!attention.length) {
      card.append(el("div", { class: "hh-allclear" }, "✓ Nothing out of range"));
    } else {
      const list = el("div", { class: "hh-list" });
      attention.slice(0, 6).forEach((s) => {
        const c = statusOf(s);
        list.append(el("button", {
          class: "hh-item",
          onclick: () => { state.activeMember = m.id; openDetail(m, s.test_type_id); },
        }, [
          el("span", { class: "hh-dot " + c }),
          el("span", { class: "hh-item-name" }, s.name),
          el("span", { class: "spacer" }),
          el("span", { class: "hh-item-val " + c }, isQualitative(s)
            ? s.latest.value_text
            : `${fmtVal(s.latest?.value_canonical, s.latest?.qualifier)} ${s.canonical_unit || ""}`),
        ]));
      });
      if (attention.length > 6) {
        list.append(el("div", { class: "hh-more" }, `+ ${attention.length - 6} more`));
      }
      card.append(list);
    }
    mount.append(card);
  });
}

function bioCard(member, s) {
  const qual = isQualitative(s);
  const v = s.latest?.value_canonical;
  const zones = qual ? null : effectiveZones(s);
  const z = !qual && v != null && zones ? zoneOf(v, zones) : null;
  const c = qual ? statusOf(s) : (z ? z.c : "na");
  const badgeText = qual
    ? (s.latest.flag === "H" ? "Abnormal" : s.latest.flag === "L" ? "Abnormal" : "Recorded")
    : (z ? z.label : "No range");
  return el("div", { class: "bio-card", onclick: () => openDetail(member, s.test_type_id) }, [
    el("div", { class: "bio-card-head" }, [
      el("div", {}, [
        el("div", { class: "bio-name" }, s.name),
        el("div", { class: "bio-date" }, fmtDate(s.latest_at)),
      ]),
      el("div", { class: "bio-right" }, [
        el("div", { class: "bio-value " + c }, qual
          ? [s.latest.value_text]
          : [fmtVal(v, s.latest?.qualifier), s.canonical_unit ? el("span", { class: "u" }, s.canonical_unit) : null]),
        el("span", { class: "status-badge " + BADGE_CLASS[c] }, badgeText),
      ]),
    ]),
    // A qualitative result has no scale to place it on.
    qual ? null : rangeBar(v, zones),
  ]);
}

// Multi-zone range bar: each interpretation band is a colored segment (green /
// amber / red) on a continuous scale, with a value marker and breakpoint labels.
function rangeBar(value, zones) {
  if (value == null || !zones) {
    return el("div", { class: "rbar" }, el("div", { class: "rbar-none" }, "No reference range on file"));
  }
  const brks = zones.map((z) => z.to).filter((t) => t != null);
  let d0, d1;
  if (brks.length) {
    const loB = Math.min(...brks), hiB = Math.max(...brks);
    const span = (hiB - loB) || Math.abs(hiB) || 1;
    const pad = span * 0.45;
    d0 = loB - pad; d1 = hiB + pad;
    // If the lowest band isn't a "low/red" one, the scale can start at its edge.
    if (d0 < 0 && loB >= 0 && zones[0].c !== "red") d0 = 0;
  } else { d0 = value - 1; d1 = value + 1; }
  const m = (d1 - d0) * 0.08;
  if (value < d0) d0 = value - m;
  if (value > d1) d1 = value + m;
  const span = (d1 - d0) || 1;
  const pos = (x) => Math.max(0, Math.min(100, ((x - d0) / span) * 100));
  const fill = { green: "var(--range-in)", amber: "var(--range-warn)", red: "var(--range-out)" };

  const track = el("div", { class: "rbar-track" });
  let prev = d0;
  for (const z of zones) {
    const to = z.to == null ? d1 : z.to;
    const l = pos(prev), r = pos(to);
    if (r > l) track.append(el("div", { class: "rbar-seg", style: `left:${l.toFixed(1)}%;width:${(r - l).toFixed(1)}%;background:${fill[z.c]}` }));
    prev = to;
  }
  
  const wrap = el("div", { style: "position: relative;" });
  wrap.append(track);
  const vz = zoneOf(value, zones);
  wrap.append(el("div", { class: "rbar-marker " + vz.c, style: `left:${pos(value).toFixed(1)}%` }, fmtNum(value)));

  const labels = el("div", { class: "rbar-labels" });
  const seen = new Set();
  for (const z of zones) if (z.to != null && !seen.has(z.to)) { seen.add(z.to); labels.append(el("span", { style: `left:${pos(z.to).toFixed(1)}%` }, fmtNum(z.to))); }
  return el("div", { class: "rbar" }, [wrap, labels]);

}

async function openDetail(member, testTypeId) {
  navigateTo("detail", { _detail: { member, testTypeId } });
}

async function renderDetail(main) {
  const { member, testTypeId } = state._detail;
  const t = state.testTypes.find((x) => x.id === testTypeId);
  const [rows, summary] = await Promise.all([
    api(`/results?member_id=${member.id}&test_type_id=${testTypeId}`),
    api(`/members/${member.id}/summary`),
  ]);
  state._detail.unit = state._detail.unit || t.canonical_unit;
  state._detail.tab = state._detail.tab || "results";

  main.append(el("div", { class: "detail-head" }, [
    el("button", { class: "back", onclick: () => { navigateBack(); } }, "← Back"),
  ]));

  const last = rows[rows.length - 1];
  // eff_ref_* is the server-reconciled range for this result (report range whole,
  // else the catalog range for this member's sex/age at that draw).
  const pseudo = {
    zones: t.zones,
    ref_low: last ? last.eff_ref_low : t.ref_low,
    ref_high: last ? last.eff_ref_high : t.ref_high,
    latest: last ? { value_canonical: last.value_canonical, value_text: last.value_text, flag: last.flag } : null,
  };
  const qual = isQualitative(pseudo);
  const zones = qual ? null : effectiveZones(pseudo);
  const z = !qual && last && zones ? zoneOf(last.value_canonical, zones) : null;
  const c = qual ? statusOf(pseudo) : (z ? z.c : "na");
  const badgeText = qual
    ? (last.flag ? "Abnormal" : "Recorded")
    : (z ? z.label : "No range");

  main.append(el("div", { class: "page-head" }, [
    el("div", {}, [
      el("h1", { class: "page-title" }, [t.name, " ", el("span", { class: "status-badge " + BADGE_CLASS[c], style: "vertical-align:middle;font-size:13px" }, badgeText)]),
      el("p", { class: "page-sub" }, `${member.name} · ${rows.length} result${rows.length !== 1 ? "s" : ""}${t.category ? " · " + t.category : ""}`),
    ]),
    el("div", { class: "head-actions", style: "align-items:flex-end" }, [
      el("button", { class: "btn", onclick: () => openQuickAdd(member, t) }, "＋ Add result"),
      unitToggle(t),
    ]),
  ]));

function zoneLegend(zones, value, canonical_unit) {
  const wrap = el("div", { style: "display: flex; gap: 16px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); flex-wrap: wrap;" });
  let prev = null;
  const activeZone = zoneOf(value, zones);
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const to = z.to;
    let rangeText = "";
    if (prev === null) {
      rangeText = to != null ? `< ${fmtNum(to)}` : "All values";
    } else if (to == null) {
      rangeText = `> ${fmtNum(prev)}`;
    } else {
      rangeText = `${fmtNum(prev)} – ${fmtNum(to)}`;
    }
    prev = to;

    const fill = { green: "var(--good)", amber: "var(--low)", red: "var(--high)" };
    const isActive = (z === activeZone);
    const activeStyle = isActive ? "font-weight: 750; color: var(--text-primary);" : "font-weight: 500; color: var(--text-secondary);";
    const dotStyle = `width: 7px; height: 7px; border-radius: 50%; background: ${fill[z.c]}; display: inline-block; transition: all 0.15s ease; ${isActive ? "transform: scale(1.4); box-shadow: 0 0 4px " + fill[z.c] + ";" : ""}`;

    wrap.append(el("div", { style: `display: flex; align-items: center; gap: 6px; font-size: 12px; ${activeStyle}` }, [
      el("span", { style: dotStyle }),
      el("span", {}, z.label),
      el("span", { style: "color: var(--muted); font-size: 11px;" }, `(${rangeText} ${canonical_unit || ""})`)
    ]));
  }
  return wrap;
}

  // headline value + multi-zone bar
  if (last) {
    const headlineCard = el("div", { class: "card", style: "margin-bottom:20px" }, [
      el("div", { class: "bio-value " + c, style: "font-size:26px" }, qual
        ? [last.value_text]
        : [fmtVal(last.value_canonical, last.qualifier), t.canonical_unit ? el("span", { class: "u" }, t.canonical_unit) : null]),
      el("div", { class: "bio-date", style: "margin-bottom:2px" }, `Latest · ${fmtDate(last.taken_at)}`),
      qual ? null : rangeBar(last.value_canonical, zones),
    ]);
    if (!qual && zones && zones.length) {
      headlineCard.append(zoneLegend(zones, last.value_canonical, t.canonical_unit));
    }
    main.append(headlineCard);
  }


  const displayUnit = state._detail.unit;
  const convert = converter(t, displayUnit);

  // trend chart — only for numeric markers; text results have nothing to plot.
  const numericRows = rows.filter((r) => r.value_canonical != null);
  const card = el("div", { class: "card" });
  if (qual || !numericRows.length) {
    card.append(el("div", { class: "empty" }, qual
      ? "This is a qualitative result — see the history below."
      : "No data points."));
  } else if (numericRows.length) {
    const wrap = el("div", { class: "chart-wrap" });
    // Same zones as the range bar, so the chart tells the identical story.
    wrap.append(trendChart(numericRows, { unit: displayUnit, zones, convert }));
    card.append(wrap);
  }
  main.append(card);

  // AI Generated Summary (above the tabs)
  if (last) {
    main.append(aiSummaryBlock(t, member));
  }

  // tabs
  state._detail.tab = state._detail.tab || "description";
  const tabNames = [["description", "Description"], ["results", "Your Results"], ["family", "Family"], ["related", "Related Tests"]];
  const tabContent = el("div", { style: "margin-top:18px" });
  const tabs = el("div", { class: "tabs" }, tabNames.map(([key, label]) =>
    el("button", { class: "tab" + (state._detail.tab === key ? " active" : ""), onclick: () => { state._detail.tab = key; paintTab(); tabs.querySelectorAll(".tab").forEach((b, i) => b.classList.toggle("active", tabNames[i][0] === key)); } }, label)
  ));
  main.append(el("div", { style: "margin-top:22px" }, [tabs, tabContent]));

  function paintTab() {
    tabContent.innerHTML = "";
    if (state._detail.tab === "description") tabContent.append(descriptionSection(t));
    else if (state._detail.tab === "related") tabContent.append(relatedSection(member, summary, t));
    else if (state._detail.tab === "family") tabContent.append(familySection(t, displayUnit, convert));
    else tabContent.append(resultsSection(t, rows, convert, displayUnit));
  }
  paintTab();
}



function resultsSection(t, rows, convert, displayUnit) {
  if (!rows.length) return el("div", { class: "empty" }, "No results yet.");
  const table = el("table");
  table.append(el("thead", {}, el("tr", {}, [
    el("th", {}, "Date"), el("th", {}, `Value (${displayUnit})`), el("th", {}, "As reported"),
    el("th", {}, "Flag"), el("th", {}, ""),
  ])));
  const tb = el("tbody");
  [...rows].reverse().forEach((r) => {
    tb.append(el("tr", {}, [
      el("td", {}, fmtDate(r.taken_at)),
      el("td", { class: "num" }, r.value_text != null ? r.value_text : fmtVal(convert(r.value_canonical), r.qualifier)),
      el("td", {}, r.value_text != null ? r.value_text : `${fmtVal(r.value, r.qualifier)} ${r.unit}`),
      el("td", {}, r.flag ? el("span", { class: "pill pill-" + r.flag }, r.flag === "H" ? "HIGH" : "LOW") : "—"),
      el("td", {}, el("button", { class: "btn btn-sm btn-danger", onclick: async () => {
        if (confirm("Delete this result?")) { await api(`/results/${r.id}`, { method: "DELETE" }); render(); }
      } }, "Delete")),
    ]));
  });
  table.append(tb);
  return el("div", { class: "card" }, table);
}

function sanitizeDescText(text, label) {
  if (!text) return "";
  let clean = text.trim();
  const prefixes = [
    label.toLowerCase() + ":",
    label.toLowerCase(),
    "description:",
    "high:",
    "low:",
    "age related details:",
    "related tests:",
    "age-related details:",
    "related-tests:"
  ];
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const p of prefixes) {
      if (clean.toLowerCase().startsWith(p)) {
        clean = clean.slice(p.length).trim();
        stripped = true;
      }
    }
  }
  clean = clean.replace(/^[:\-\s\u2013\u2014]+/, "").trim();
  return clean;
}

function renderDescriptionTabContent(container, descObj) {
  const descText = sanitizeDescText(descObj.description, "Description");
  if (descText && descText !== "N/A" && descText !== "none") {
    container.append(el("div", { class: "desc-block desc-hero" }, [
      el("div", { class: "desc-label" }, [
        el("span", { class: "desc-icon" }, "📋"),
        el("span", { class: "desc-title" }, "What this biomarker measures")
      ]),
      el("p", { class: "desc-body-text" }, descText)
    ]));
  }

  const grid = el("div", { class: "desc-grid" });

  const lowText = sanitizeDescText(descObj.low, "Low");
  if (lowText && lowText !== "N/A" && lowText !== "none") {
    grid.append(el("div", { class: "desc-block low" }, [
      el("div", { class: "desc-label" }, [
        el("span", { class: "desc-icon" }, "▼"),
        el("span", { class: "desc-title" }, "Low levels")
      ]),
      el("p", { class: "desc-body-text" }, lowText)
    ]));
  }

  const highText = sanitizeDescText(descObj.high, "High");
  if (highText && highText !== "N/A" && highText !== "none") {
    grid.append(el("div", { class: "desc-block high" }, [
      el("div", { class: "desc-label" }, [
        el("span", { class: "desc-icon" }, "▲"),
        el("span", { class: "desc-title" }, "High levels")
      ]),
      el("p", { class: "desc-body-text" }, highText)
    ]));
  }

  const ageText = sanitizeDescText(descObj.age_related, "Age Related Details");
  if (ageText && ageText !== "N/A" && ageText !== "none") {
    grid.append(el("div", { class: "desc-block info" }, [
      el("div", { class: "desc-label" }, [
        el("span", { class: "desc-icon" }, "🎂"),
        el("span", { class: "desc-title" }, "Age Related Details")
      ]),
      el("p", { class: "desc-body-text" }, ageText)
    ]));
  }

  container.append(grid);
}

function renderAiSummary(container, descObj) {
  const relatedText = sanitizeDescText(descObj.related_tests, "Related Tests");
  if (relatedText && relatedText !== "N/A" && relatedText !== "none") {
    container.append(el("div", { class: "desc-block related", style: "border-left: 4px solid var(--accent); background: var(--panel-2);" }, [
      el("div", { class: "desc-label" }, [
        el("span", { class: "desc-icon", style: "color: var(--accent);" }, "🧪"),
        el("span", { class: "desc-title", style: "color: var(--accent);" }, "Clinical Summary & Panel Relations")
      ]),
      el("p", { class: "desc-body-text" }, relatedText)
    ]));
  } else {
    container.append(el("div", { class: "empty" }, "No dynamic panel summary available."));
  }
}

function aiSummaryBlock(t, member) {
  const container = el("div", { class: "ai-summary-container", style: "margin-bottom: 24px;" });
  const head = el("div", { style: "display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;" }, [
    el("h2", { style: "margin: 0; font-size: 14px; font-weight: 750; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.05em;" }, "AI Generated Summary"),
    el("div", { style: "display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted);" }, [
      el("span", { id: "ai-generated-time" }, "Checking cache..."),
      el("button", { 
        class: "btn btn-sm ghost-btn", 
        style: "padding: 3px 8px; font-size: 11px; display: flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 6px;",
        onclick: () => fetchSummary(true)
      }, [el("span", {}, "🔄"), "Regenerate"])
    ])
  ]);
  container.append(head);

  const body = el("div", { id: "ai-summary-body" });
  container.append(body);

  function fetchSummary(force = false) {
    body.innerHTML = "";
    body.append(el("p", { class: "desc-text" }, [el("span", { class: "spinner" }), " Analyzing biomarkers & generating summary…"]));
    
    const timeSpan = head.querySelector("#ai-generated-time");
    if (timeSpan) timeSpan.textContent = "...";

    const url = `/test-types/${t.id}/describe?member_id=${member.id}` + (force ? "&force_refresh=true" : "");
    api(url, { method: "POST", body: {} })
      .then((res) => {
        state._detail.description = res.description;
        state._detail.generated_at = res.generated_at;
        
        body.innerHTML = "";
        renderAiSummary(body, res.description);
        
        if (timeSpan) {
          const dt = res.generated_at ? new Date(res.generated_at + "Z").toLocaleString() : "just now";
          timeSpan.textContent = `Generated: ${dt}`;
        }
        
        // Repaint Description tab if currently viewing it to stay in sync
        const activeTabContent = document.querySelector(".tabs .tab.active");
        if (activeTabContent && activeTabContent.textContent.trim() === "Description") {
          const tabContentDiv = document.querySelector(".tabs").nextSibling;
          if (tabContentDiv) {
            tabContentDiv.innerHTML = "";
            tabContentDiv.append(descriptionSection(t));
          }
        }
      })
      .catch((e) => {
        body.innerHTML = "";
        body.append(el("p", { class: "warn" }, "Couldn't generate summary: " + e.message));
        if (timeSpan) timeSpan.textContent = "Error";
      });
  }

  fetchSummary(false);
  return container;
}

function descriptionSection(t) {
  const container = el("div", { style: "display: flex; flex-direction: column; gap: 14px;" });
  if (state._detail.description) {
    renderDescriptionTabContent(container, state._detail.description);
    return container;
  }
  const loadingCard = el("div", { class: "card", id: "desc-body" }, [
    el("p", { class: "desc-text" }, [el("span", { class: "spinner" }), " Generating clinical reference…"])
  ]);
  container.append(loadingCard);
  
  const { member } = state._detail;
  api(`/test-types/${t.id}/describe?member_id=${member.id}`, { method: "POST", body: {} })
    .then((res) => {
      state._detail.description = res.description;
      state._detail.generated_at = res.generated_at;
      const b = container.querySelector("#desc-body");
      if (b) b.remove();
      renderDescriptionTabContent(container, res.description);
      
      const timeSpan = document.getElementById("ai-generated-time");
      if (timeSpan) {
        const dt = res.generated_at ? new Date(res.generated_at + "Z").toLocaleString() : "just now";
        timeSpan.textContent = `Generated: ${dt}`;
      }
      const topBody = document.getElementById("ai-summary-body");
      if (topBody) {
        topBody.innerHTML = "";
        renderAiSummary(topBody, res.description);
      }
    })
    .catch((e) => {
      const b = container.querySelector("#desc-body");
      if (b) b.innerHTML = `<p class="warn">Couldn't generate description: ${e.message}</p>`;
    });
  return container;
}





function relatedSection(member, summary, t) {
  const related = summary.filter((s) => s.test_type_id !== t.id && (s.category || "Other") === (t.category || "Other")).slice(0, 8);
  if (!related.length) return el("div", { class: "empty" }, `No other ${t.category || "related"} biomarkers on file yet.`);
  const wrap = el("div", { class: "cat-body", style: "margin-top:2px" });
  related.forEach((s) => wrap.append(bioCard(member, s)));
  return wrap;
}

// Overlay one biomarker across every family member — hereditary patterns
// (cholesterol, glucose, thyroid) show up side by side.
function familySection(t, displayUnit, convert) {
  const card = el("div", { class: "card" });
  card.append(el("p", { class: "page-sub", style: "margin:0 0 12px" },
    `How ${t.name} compares across the family.`));
  const mount = el("div");
  mount.append(el("span", { class: "spinner" }));
  card.append(mount);
  api(`/results?test_type_id=${t.id}`).then((rows) => {
    mount.innerHTML = "";
    const groups = {};
    for (const r of rows) (groups[r.member_id] ||= []).push(r);
    const series = state.members
      .filter((m) => (groups[m.id] || []).length)
      .map((m) => ({ name: m.name, color: m.color || "#2f6fe0", points: groups[m.id] }));
    if (series.length < 2) {
      mount.append(el("div", { class: "empty", style: "padding:36px 20px" },
        series.length ? `Only ${series[0].name} has ${t.name} results so far. Add results for other family members to compare.` : "No results yet."));
      return;
    }
    const wrap = el("div", { class: "chart-wrap" });
    wrap.append(multiTrendChart(series, { unit: displayUnit, refLow: t.ref_low, refHigh: t.ref_high, convert }));
    mount.append(wrap);
    mount.append(el("div", { class: "legend" }, [
      ...series.map((s) => legendItem(s.color, s.name)),
      (t.ref_low != null || t.ref_high != null) ? legendItem("var(--good)", `Reference range${refText(t, displayUnit, convert)}`) : null,
    ].filter(Boolean)));
  }).catch((e) => { mount.innerHTML = ""; mount.append(el("div", { class: "warn" }, "Couldn't load family data: " + e.message)); });
  return card;
}

function multiTrendChart(series, opts) {
  const W = 720, H = 320, m = { t: 16, r: 20, b: 34, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const conv = opts.convert;
  const all = series.flatMap((s) => s.points);
  const vals = all.map((p) => conv(p.value_canonical));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (opts.refLow != null) lo = Math.min(lo, conv(opts.refLow));
  if (opts.refHigh != null) hi = Math.max(hi, conv(opts.refHigh));
  const vpad = (hi - lo) * 0.12 || Math.abs(hi) * 0.12 || 1;
  lo -= vpad; hi += vpad;
  // Round the scale to a nice step so ticks read 30/32/34, not 30.6/32.44/34.28.
  const vstep = niceStep(hi - lo, 4);
  lo = Math.floor(lo / vstep) * vstep;
  hi = Math.ceil(hi / vstep) * vstep;
  if (Math.min(...vals) >= 0 && lo < 0) lo = 0;
  const vdec = decimalsFor(vstep);
  const span = hi - lo || 1;
  const times = all.map((p) => new Date(p.taken_at).getTime());
  const tmin = Math.min(...times), tmax = Math.max(...times);
  const tspan = tmax - tmin || 1;
  const xs = (t) => m.l + (tspan === 1 && tmax === tmin ? iw / 2 : ((t - tmin) / tspan) * iw);
  const ys = (v) => m.t + ih - ((v - lo) / span) * ih;

  const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: "max-width:100%" });

  if (opts.refLow != null || opts.refHigh != null) {
    const yTop = ys(opts.refHigh != null ? conv(opts.refHigh) : hi);
    const yBot = ys(opts.refLow != null ? conv(opts.refLow) : lo);
    svg.append(svgNode("rect", { x: m.l, y: yTop, width: iw, height: Math.max(0, yBot - yTop), class: "ref-band" }));
    if (opts.refHigh != null) svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: yTop, y2: yTop, class: "ref-line" }));
    if (opts.refLow != null) svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: yBot, y2: yBot, class: "ref-line" }));
  }

  for (let v = lo; v <= hi + vstep * 1e-9; v += vstep) {
    const y = ys(v);
    svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: "grid-line" }));
    const tx = svgNode("text", { x: m.l - 8, y: y + 4, "text-anchor": "end", class: "tick" });
    tx.textContent = fmtTick(v, vdec);
    svg.append(tx);
  }
  svg.append(svgNode("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "axis-line" }));

  const nx = Math.min(all.length, 5);
  for (let i = 0; i < nx; i++) {
    const t = nx === 1 ? tmin : tmin + (tspan * i) / (nx - 1);
    const lbl = svgNode("text", { x: xs(t), y: H - 12, "text-anchor": "middle", class: "tick" });
    lbl.textContent = new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    svg.append(lbl);
  }

  for (const s of series) {
    const pts = s.points.map((p) => [xs(new Date(p.taken_at).getTime()), ys(conv(p.value_canonical))]);
    if (pts.length > 1) {
      const d = "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
      svg.append(svgNode("path", { d, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    s.points.forEach((p, i) => {
      const c = svgNode("circle", { cx: pts[i][0], cy: pts[i][1], r: 4.5, fill: s.color, stroke: "var(--panel)", "stroke-width": 2 });
      const title = svgNode("title");
      title.textContent = `${s.name} · ${fmtDate(p.taken_at)}: ${fmtNum(conv(p.value_canonical))} ${opts.unit}${p.flag ? " (" + (p.flag === "H" ? "high" : "low") + ")" : ""}`;
      c.append(title);
      svg.append(c);
    });
  }
  return svg;
}

// Quick manual entry of a single result from the biomarker detail page — for
// home readings (glucose meter) or a value phoned in by the clinic.
function openQuickAdd(member, t) {
  const dateInput = el("input", { type: "date", value: today() });
  const valInput = el("input", { type: "number", step: "any", placeholder: "Value" });
  const unitSel = el("select", {}, unitOptions(t).map((u) => el("option", { value: u }, u)));
  const note = el("input", { type: "text", placeholder: "Optional note, e.g. fasting, home meter" });
  openModal(`Add ${t.name} result for ${member.name}`, [
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Date"), dateInput]),
      el("div", { class: "field" }, [el("label", {}, "Value"), valInput]),
      el("div", { class: "field" }, [el("label", {}, "Unit"), unitSel]),
    ]),
    el("div", { class: "field" }, [el("label", {}, "Note"), note]),
  ], [
    el("button", { class: "btn", onclick: closeModal }, "Cancel"),
    el("button", { class: "btn btn-primary", onclick: async () => {
      const v = Number(valInput.value);
      if (valInput.value.trim() === "" || isNaN(v)) return toast("Enter a numeric value");
      const res = await commitResults({
        member_id: member.id, taken_at: dateInput.value,
        items: [{ test_type_id: t.id, value: v, unit: unitSel.value, note: note.value.trim() || null }],
      });
      if (res.cancelled) return toast("Cancelled — nothing saved");
      if (!res.created) return toast("Couldn't save: " + (res.skipped[0]?.reason || "unknown error"));
      toast("Result saved");
      closeModal(); render();
    } }, "Save"),
  ]);
}

function refText(t, unit, conv) {
  const parts = [];
  if (t.ref_low != null) parts.push(`≥ ${fmtNum(conv(t.ref_low))}`);
  if (t.ref_high != null) parts.push(`≤ ${fmtNum(conv(t.ref_high))}`);
  return parts.length ? ` (${parts.join(", ")} ${unit})` : "";
}
function legendItem(color, label) {
  const box = el("span", { class: "legend-item" });
  box.append(el("span", { style: `width:12px;height:3px;border-radius:2px;background:${color};display:inline-block` }), label);
  return box;
}
function unitToggle(t) {
  const opts = unitOptions(t);
  if (opts.length <= 1) return el("div");
  const sel = el("select", { onchange: (e) => { state._detail.unit = e.target.value; render(); } });
  for (const u of opts) sel.append(el("option", { value: u, ...(u === state._detail.unit ? { selected: "" } : {}) }, u));
  return el("div", { class: "field", style: "flex:none;margin:0" }, [el("label", {}, "Display unit"), sel]);
}

// ---------------- upload / extract / review ----------------
function renderUpload(main) {
  $(`[data-view="upload"]`)?.classList.add("active");
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Add results"),
    el("p", { class: "page-sub" }, "Upload a lab report for AI extraction, or type values in manually — home meter readings, paper records, values from a phone call."),
  ])));

  const mode = state._addMode || "upload";
  main.append(el("div", { class: "tabs", style: "max-width:440px;margin-bottom:20px" }, [
    ["upload", "📄 Upload report"], ["manual", "✍️ Manual entry"],
  ].map(([k, l]) => el("button", { class: "tab" + (mode === k ? " active" : ""), onclick: () => { state._addMode = k; render(); } }, l))));

  if (mode === "manual") return renderManualEntry(main);

  const memberSel = el("select");
  for (const m of state.members) memberSel.append(el("option", { value: m.id, ...(m.id === state.activeMember ? { selected: "" } : {}) }, m.name));

  const fileInput = el("input", { type: "file", accept: "image/*,application/pdf" });
  const status = el("div", { style: "margin-top:12px" });
  const reviewMount = el("div", { style: "margin-top:20px" });

  const card = el("div", { class: "card" }, [
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Family member"), memberSel]),
      el("div", { class: "field" }, [el("label", {}, "Lab report file"), fileInput]),
    ]),
    el("button", { class: "btn btn-primary", onclick: async () => {
      if (!fileInput.files[0]) return toast("Choose a file first");
      if (!memberSel.value) return toast("Add a family member first");
      status.innerHTML = ""; reviewMount.innerHTML = "";
      status.append(el("span", {}, [el("span", { class: "spinner" }), " Uploading…"]));
      const fd = new FormData();
      fd.append("file", fileInput.files[0]);
      fd.append("member_id", memberSel.value);
      try {
        const doc = await api("/documents", { method: "POST", body: fd });
        status.innerHTML = ""; status.append(el("span", {}, [el("span", { class: "spinner" }), " Extracting with AI… this can take ~20s"]));
        const result = await api(`/documents/${doc.id}/extract`, { method: "POST", body: {} });
        status.innerHTML = "";
        renderReview(reviewMount, doc, Number(memberSel.value), result);
      } catch (e) {
        status.innerHTML = ""; status.append(el("div", { class: "warn" }, "Error: " + e.message));
      }
    } }, "Upload & extract"),
    status,
  ]);
  main.append(card, reviewMount);
}

// ---------------- manual entry (no AI, no document) ----------------
function renderManualEntry(main) {
  const memberSel = el("select");
  for (const m of state.members) memberSel.append(el("option", { value: m.id, ...(m.id === state.activeMember ? { selected: "" } : {}) }, m.name));
  const dateInput = el("input", { type: "date", value: today() });

  const sorted = [...state.testTypes].sort((a, b) => a.name.localeCompare(b.name));
  const rowsMount = el("div");
  const rows = [];

  function addRow() {
    const typeSel = el("select");
    typeSel.append(el("option", { value: "" }, "— choose test —"));
    for (const t of sorted) typeSel.append(el("option", { value: t.id }, t.name + (t.canonical_unit ? ` (${t.canonical_unit})` : "")));
    typeSel.append(el("option", { value: "__new__" }, "➕ New test…"));
    const nameInput = el("input", { type: "text", placeholder: "New test name", style: "display:none;margin-top:6px" });
    const valInput = el("input", { type: "number", step: "any", placeholder: "Value" });
    const unitMount = el("div");
    let unitField = el("input", { type: "text", placeholder: "Unit" });
    unitMount.append(unitField);
    typeSel.addEventListener("change", () => {
      const isNew = typeSel.value === "__new__";
      nameInput.style.display = isNew ? "" : "none";
      unitMount.innerHTML = "";
      const t = state.testTypes.find((x) => String(x.id) === typeSel.value);
      if (t && unitOptions(t).filter(Boolean).length) {
        unitField = el("select", {}, unitOptions(t).map((u) => el("option", { value: u }, u || "—")));
      } else {
        unitField = el("input", { type: "text", placeholder: "Unit" });
      }
      unitMount.append(unitField);
    });
    const row = { typeSel, nameInput, valInput, unit: () => unitField.value, rowEl: null };
    row.rowEl = el("div", { class: "manual-row" }, [
      el("div", {}, [typeSel, nameInput]),
      valInput, unitMount,
      el("button", { class: "btn btn-sm btn-danger", onclick: () => {
        rows.splice(rows.indexOf(row), 1);
        row.rowEl.remove();
      } }, "✕"),
    ]);
    rows.push(row);
    rowsMount.append(row.rowEl);
  }
  addRow();

  const saveBtn = el("button", { class: "btn btn-primary", onclick: async () => {
    if (!memberSel.value) return toast("Add a family member first");
    const active = rows.filter((r) => r.typeSel.value);
    if (!active.length) return toast("Choose at least one test");
    saveBtn.disabled = true;
    try {
      const items = [];
      for (const r of active) {
        const v = Number(r.valInput.value);
        if (r.valInput.value.trim() === "" || isNaN(v)) throw new Error("Every row needs a numeric value");
        let typeId;
        if (r.typeSel.value === "__new__") {
          const nm = r.nameInput.value.trim();
          if (!nm) throw new Error("New tests need a name");
          const created = await api("/test-types", { method: "POST", body: { name: nm, canonical_unit: r.unit().trim() } });
          typeId = created.id;
        } else {
          typeId = Number(r.typeSel.value);
        }
        items.push({ test_type_id: typeId, value: v, unit: r.unit().trim(), note: null });
      }
      const res = await commitResults({
        member_id: Number(memberSel.value), taken_at: dateInput.value, items,
      });
      if (res.cancelled) { toast("Cancelled — nothing saved"); return; }
      let msg = `Saved ${res.created} result${res.created !== 1 ? "s" : ""}`;
      if (res.skipped?.length) msg += ` · skipped ${res.skipped.length} (${res.skipped[0].reason})`;
      toast(msg);
      if (res.created) {
        await loadCore();
        navigateTo("overview", { activeMember: Number(memberSel.value) });
      }
    } catch (e) {
      toast("Error: " + e.message);
    } finally {
      saveBtn.disabled = false;
    }
  } }, "Save results");

  main.append(el("div", { class: "card" }, [
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Family member"), memberSel]),
      el("div", { class: "field" }, [el("label", {}, "Collection date"), dateInput]),
    ]),
    el("div", { class: "manual-row manual-head" }, [el("div", {}, "Test"), el("div", {}, "Value"), el("div", {}, "Unit"), el("div", {}, "")]),
    rowsMount,
    el("div", { style: "margin-top:12px" }, el("button", { class: "ghost-btn", style: "width:auto", onclick: addRow }, "＋ Add another test")),
    el("div", { style: "margin-top:16px" }, saveBtn),
  ]));
}

function renderReview(mount, doc, memberId, result) {
  mount.innerHTML = "";
  const dateInput = el("input", { type: "date", value: (result.report_date || "").slice(0, 10) || new Date().toISOString().slice(0, 10) });
  const rows = [];

  const head = el("div", { class: "review-row review-head" }, [
    el("div", {}, "Test"), el("div", {}, "Value"), el("div", {}, "Unit"), el("div", {}, "Flag"), el("div", {}, ""),
  ]);
  const body = el("div");
  result.items.forEach((item) => {
    const matchSel = el("select");
    matchSel.append(el("option", { value: "__new__" }, `➕ Track as new: ${item.test_name}`));
    for (const t of state.testTypes) matchSel.append(el("option", { value: String(t.id) }, `Merge into: ${t.name}`));
    matchSel.append(el("option", { value: "" }, "— skip (don't save) —"));
    // Default: matched → merge into that type; otherwise track it as a new test.
    matchSel.value = item.matched_test_type_id ? String(item.matched_test_type_id) : "__new__";
    // A qualitative row ("Negative") is edited as text; there's no number to step.
    const isQual = item.value == null && item.value_text != null;
    const valInput = isQual
      ? el("input", { type: "text", value: item.value_text })
      : el("input", { type: "number", step: "any", value: item.value });
    const unitInput = el("input", { type: "text", value: item.unit, style: "width:100%", ...(isQual ? { placeholder: "—", disabled: "" } : {}) });
    const flagInput = el("input", { type: "text", value: item.flag || "", placeholder: "—", style: "width:100%" });
    const warn = el("div", { class: "warn", style: "grid-column:1/-1", html: "" });
    const rowEl = el("div", { class: "review-row" }, [
      el("div", {}, [el("div", { style: "font-size:13px;color:var(--muted)" }, item.test_name), matchSel]),
      valInput, unitInput, flagInput,
      el("div", {}, ""),
    ]);
    body.append(rowEl, warn);
    rows.push({ matchSel, valInput, unitInput, flagInput, warn, item, isQual });
  });

  const commitBtn = el("button", { class: "btn btn-primary", onclick: async () => {
    commitBtn.disabled = true;
    const original = commitBtn.textContent;
    commitBtn.textContent = "Saving…";
    try {
      const items = [];
      for (const r of rows) {
        const sel = r.matchSel.value;
        if (sel === "") continue; // explicitly skipped
        let typeId;
        if (sel === "__new__") {
          const created = await api("/test-types", { method: "POST", body: {
            name: r.item.test_name,
            canonical_unit: r.unitInput.value.trim(),
            ref_low: r.item.ref_low ?? null,
            ref_high: r.item.ref_high ?? null,
          } });
          typeId = created.id;
        } else {
          typeId = Number(sel);
        }
        items.push(r.isQual ? {
          test_type_id: typeId,
          value: null,
          value_text: r.valInput.value.trim(),
          unit: "",
          flag: r.flagInput.value.trim() || null,
          note: null,
        } : {
          test_type_id: typeId,
          value: Number(r.valInput.value),
          unit: r.unitInput.value.trim(),
          qualifier: r.item.qualifier ?? null,
          ref_low: r.item.ref_low ?? null,
          ref_high: r.item.ref_high ?? null,
          note: null,
        });
      }
      if (!items.length) { toast("Nothing to save — every row is set to skip"); return; }
      const mid = typeof memberId === "function" ? memberId() : memberId;
      if (!mid) { toast("Choose a family member first"); return; }
      const res = await commitResults({
        member_id: mid, taken_at: dateInput.value, document_id: doc.id, items,
      });
      if (res.cancelled) { toast("Cancelled — nothing saved"); return; }
      const nSkip = (res.skipped || []).length;
      let msg = `Saved ${res.created} result${res.created !== 1 ? "s" : ""}`;
      if (nSkip) msg += ` · skipped ${nSkip} (${res.skipped[0].reason})`;
      toast(msg);
      await loadCore();
      navigateTo("overview", { activeMember: mid });
    } catch (e) {
      toast("Error: " + e.message);
    } finally {
      commitBtn.disabled = false; commitBtn.textContent = original;
    }
  } }, "Save results");

  mount.append(el("div", { class: "card" }, [
    el("h3", { style: "margin-top:0" }, "Review extracted results"),
    el("p", { class: "page-sub", style: "margin-bottom:6px" }, `From ${result.lab_name || doc.filename}${result.patient_name ? " · patient: " + result.patient_name : ""} · extracted by ${result.provider}/${result.model}`),
    el("p", { class: "page-sub", style: "margin:0 0 14px" }, "Every test is tracked by default. Use a row's dropdown to merge it into an existing test (so units line up on one chart) or skip it."),
    el("div", { class: "field", style: "max-width:220px" }, [el("label", {}, "Collection date"), dateInput]),
    head, body,
    el("div", { style: "margin-top:16px" }, commitBtn),
  ]));
}

// Move a whole import (report + its saved results) to another member — for a
// report uploaded under the wrong person.
function openReassignDoc(doc) {
  const sel = el("select");
  for (const m of state.members) sel.append(el("option", { value: m.id, ...(m.id === doc.member_id ? { selected: "" } : {}) }, m.name));
  const n = doc.result_count;
  openModal(`Move "${doc.filename}"`, [
    el("p", { class: "page-sub", style: "margin:0 0 14px" },
      `Reassigns this report${n ? ` and its ${n} saved result${n !== 1 ? "s" : ""}` : ""} to another family member.`),
    el("div", { class: "field" }, [el("label", {}, "Move to"), sel]),
  ], [
    el("button", { class: "btn", onclick: closeModal }, "Cancel"),
    el("button", { class: "btn btn-primary", onclick: async () => {
      const res = await api(`/documents/${doc.id}/reassign`, { method: "POST", body: { member_id: Number(sel.value) } });
      const to = state.members.find((m) => m.id === Number(sel.value));
      toast(`Moved ${res.moved} result${res.moved !== 1 ? "s" : ""} to ${to ? to.name : "member"}`);
      closeModal();
      await loadCore(); render();
    } }, "Move"),
  ]);
}

// Delete an entire import: the report and every result saved from it.
async function deleteImport(doc) {
  const n = doc.result_count;
  const msg = n
    ? `Delete "${doc.filename}" and the ${n} result${n !== 1 ? "s" : ""} saved from it? This can't be undone.`
    : `Delete "${doc.filename}"? This can't be undone.`;
  if (!confirm(msg)) return;
  const res = await api(`/documents/${doc.id}`, { method: "DELETE" });
  toast(`Import deleted · ${res.deleted_results} result${res.deleted_results !== 1 ? "s" : ""} removed`);
  await loadCore(); render();
}

// ---------------- documents ----------------
async function renderDocuments(main) {
  $(`[data-view="documents"]`)?.classList.add("active");
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Documents"),
    el("p", { class: "page-sub" }, "Every uploaded report is kept locally as a backup you can reopen anytime."),
  ])));
  const docs = await api("/documents");
  if (!docs.length) { main.append(el("div", { class: "empty" }, "No documents uploaded yet.")); return; }
  const pending = docs.filter((d) => d.status !== "committed" && d.result_count === 0);
  if (pending.length) {
    main.append(el("div", { class: "banner" }, [
      el("span", {}, `⏳ ${pending.length} report${pending.length > 1 ? "s were" : " was"} uploaded but never saved. Click Review to finish adding ${pending.length > 1 ? "their" : "its"} results.`),
    ]));
  }
  const table = el("table");
  table.append(el("thead", {}, el("tr", {}, ["File", "Member", "Date", "Results", "Status", ""].map((h) => el("th", {}, h)))));
  const tb = el("tbody");
  for (const d of docs) {
    const needsReview = d.status !== "committed" && d.result_count === 0;
    const actions = el("div", { style: "display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap" }, [
      needsReview ? el("button", { class: "btn btn-sm btn-primary", onclick: () => openReview(d) }, "Review →") : null,
      state.members.length > 1 ? el("button", { class: "btn btn-sm", onclick: () => openReassignDoc(d) }, "Reassign") : null,
      el("a", { class: "btn btn-sm", href: `/api/documents/${d.id}/file`, target: "_blank" }, "Open"),
      el("button", { class: "btn btn-sm btn-danger", onclick: () => deleteImport(d) }, "Delete"),
    ].filter(Boolean));
    tb.append(el("tr", {}, [
      el("td", {}, d.filename),
      el("td", {}, d.member_name || "—"),
      el("td", {}, fmtDate(d.report_date || d.created_at)),
      el("td", {}, String(d.result_count)),
      el("td", {}, el("span", { class: "pill " + (d.status === "committed" ? "pill-ok" : "pill-L") }, needsReview ? "needs review" : d.status)),
      el("td", {}, actions),
    ]));
  }
  table.append(tb);
  main.append(el("div", { class: "card" }, table));
}

// Resume a document that was uploaded/extracted but never committed. Uses the
// saved extraction when present (free, instant); otherwise runs extraction.
function openReview(doc) {
  navigateTo("review-doc", { _reviewDoc: doc });
}

async function renderReviewDoc(main) {
  const doc = state._reviewDoc;
  main.append(el("div", { class: "detail-head" }, [
    el("button", { class: "back", onclick: () => { navigateBack(); } }, "← Back to documents"),
  ]));
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Review results"),
    el("p", { class: "page-sub" }, doc.filename),
  ])));

  // Member selector — defaults to the document's member, editable if unassigned.
  const memberSel = el("select");
  for (const m of state.members) memberSel.append(el("option", { value: m.id, ...(m.id === (doc.member_id || state.activeMember) ? { selected: "" } : {}) }, m.name));
  main.append(el("div", { class: "card", style: "margin-bottom:18px;max-width:320px" },
    el("div", { class: "field", style: "margin:0" }, [el("label", {}, "Family member"), memberSel])));

  const mount = el("div");
  const status = el("div", { style: "margin-bottom:14px" }, [el("span", { class: "spinner" }), " Loading extracted results…"]);
  main.append(status, mount);

  const showExtractButton = (msg) => {
    status.innerHTML = "";
    status.append(
      el("div", { class: "page-sub", style: "margin-bottom:10px" }, msg),
      el("button", { class: "btn btn-primary", onclick: async () => {
        status.innerHTML = ""; status.append(el("span", {}, [el("span", { class: "spinner" }), " Extracting with AI… this can take ~20s"]));
        try {
          const result = await api(`/documents/${doc.id}/extract`, { method: "POST", body: {} });
          status.innerHTML = "";
          renderReview(mount, doc, () => Number(memberSel.value), result);
        } catch (e) { status.innerHTML = ""; status.append(el("div", { class: "warn" }, "Error: " + e.message)); }
      } }, "Extract with AI"),
    );
  };

  try {
    const result = await api(`/documents/${doc.id}/extraction`);
    status.innerHTML = "";
    renderReview(mount, doc, () => Number(memberSel.value), result);
  } catch (e) {
    // No saved extraction yet (older upload) — offer to run it.
    showExtractButton("This report hasn't been read by AI yet.");
  }
}

// ---------------- doctor-visit report (printable) ----------------
function refRangeText(s) {
  const lo = rangeLow(s), hi = rangeHigh(s);
  if (lo == null && hi == null) return "—";
  if (lo != null && hi != null) return `${fmtNum(lo)} – ${fmtNum(hi)}`;
  return hi != null ? `≤ ${fmtNum(hi)}` : `≥ ${fmtNum(lo)}`;
}
function statusCellOf(s) {
  const v = s.latest?.value_canonical;
  const zones = effectiveZones(s);
  if (v == null || !zones) return el("span", { class: "status-badge na" }, "No range");
  const z = zoneOf(v, zones);
  return el("span", { class: "status-badge " + BADGE_CLASS[z.c] }, z.label);
}

async function renderReport(main) {
  const { member } = state._report;
  const summary = await api(`/members/${member.id}/summary`);

  main.append(el("div", { class: "no-print", style: "display:flex;gap:10px;margin-bottom:20px;align-items:center" }, [
    el("button", { class: "back", style: "padding:0", onclick: () => { navigateBack(); } }, "← Back"),
    el("span", { class: "spacer" }),
    el("a", { class: "btn", href: `/api/members/${member.id}/export.csv` }, "⬇ Export CSV"),
    el("button", { class: "btn btn-primary", onclick: () => window.print() }, "🖨 Print / Save PDF"),
  ]));

  const rep = el("div", { class: "card report" });
  const meta = [
    member.dob ? `Born ${fmtDate(member.dob)} (${ageOf(member.dob)} yrs)` : null,
    member.sex || null,
    `Generated ${fmtDate(new Date().toISOString())}`,
    `${summary.length} biomarkers on file`,
  ].filter(Boolean).join(" · ");
  rep.append(
    el("div", { class: "report-brand" }, "🧪 LabTracker · Health summary"),
    el("h1", { class: "page-title", style: "font-size:26px" }, member.name),
    el("p", { class: "page-sub", style: "margin-bottom:8px" }, meta),
  );

  const attention = summary.filter((s) => ["red", "amber"].includes(statusOf(s)));
  const mkTable = (items, withPrev) => {
    const table = el("table");
    table.append(el("thead", {}, el("tr", {}, [
      el("th", {}, "Biomarker"), el("th", {}, "Latest"), withPrev ? el("th", {}, "Previous") : null,
      el("th", {}, "Reference"), el("th", {}, "Status"), el("th", {}, "Last tested"),
    ].filter(Boolean))));
    const tb = el("tbody");
    for (const s of items) {
      const prev = s.spark && s.spark.length > 1 ? s.spark[s.spark.length - 2] : null;
      tb.append(el("tr", {}, [
        el("td", {}, s.name),
        el("td", { class: "num" }, `${fmtVal(s.latest?.value_canonical, s.latest?.qualifier)} ${s.canonical_unit || ""}`),
        withPrev ? el("td", { class: "num" }, prev != null ? fmtNum(prev) : "—") : null,
        el("td", {}, refRangeText(s)),
        el("td", {}, statusCellOf(s)),
        el("td", {}, fmtDate(s.latest_at)),
      ].filter(Boolean)));
    }
    table.append(tb);
    return table;
  };

  if (attention.length) {
    rep.append(el("div", { class: "category-label", style: "margin-top:22px" }, "Needs attention"));
    rep.append(mkTable(attention, true));
  }

  const byCat = {};
  for (const s of summary) (byCat[s.category || "Other"] ||= []).push(s);
  const cats = Object.keys(byCat).sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b));
  for (const cat of cats) {
    rep.append(el("div", { class: "category-label", style: "margin-top:22px" }, cat));
    rep.append(mkTable(byCat[cat].sort((a, b) => a.name.localeCompare(b.name)), true));
  }

  rep.append(el("div", { class: "report-footer" },
    "Values shown in each biomarker's canonical unit; reference ranges are from the most recent lab report when available, otherwise catalog defaults. Personal record only — not medical advice."));
  main.append(rep);
}

// ---------------- settings ----------------
async function renderSettings(main) {
  $(`[data-view="settings"]`)?.classList.add("active");
  const s = await api("/settings");
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Settings"),
    el("p", { class: "page-sub" }, "Choose your AI provider and keys. Keys are stored locally in your database and never displayed back."),
  ])));

  const providerSel = el("select");
  const activeProvider = s.ai_provider || (s.has_key_gemini ? "gemini" : (s.has_key_openai ? "openai" : "anthropic"));
  for (const p of ["anthropic", "openai", "gemini"]) providerSel.append(el("option", { value: p, ...(activeProvider === p ? { selected: "" } : {}) }, p[0].toUpperCase() + p.slice(1)));


  const fields = {};
  const mk = (label, key, ph) => {
    const inp = el("input", { type: "text", placeholder: ph });
    fields[key] = inp;
    return el("div", { class: "field" }, [el("label", {}, label), inp]);
  };

  const card = el("div", { class: "card", style: "max-width:560px" }, [
    el("div", { class: "field" }, [el("label", {}, "Active provider"), providerSel]),
    el("div", { class: "category-label", style: "margin-top:20px" }, "API Keys"),
    mk(`Anthropic key ${s.has_key_anthropic ? "✓ set" : ""}`, "ai_key_anthropic", s.has_key_anthropic ? "•••••• (leave blank to keep)" : "sk-ant-..."),
    mk(`OpenAI key ${s.has_key_openai ? "✓ set" : ""}`, "ai_key_openai", s.has_key_openai ? "•••••• (leave blank to keep)" : "sk-..."),
    mk(`Gemini key ${s.has_key_gemini ? "✓ set" : ""}`, "ai_key_gemini", s.has_key_gemini ? "•••••• (leave blank to keep)" : "AIza..."),
    el("div", { class: "category-label", style: "margin-top:20px" }, "Models (optional overrides)"),
    (() => { const i = el("input", { type: "text", value: s.ai_model_anthropic || "", placeholder: "claude-opus-4-8" }); fields.ai_model_anthropic = i; return el("div", { class: "field" }, [el("label", {}, "Anthropic model"), i]); })(),
    (() => { const i = el("input", { type: "text", value: s.ai_model_openai || "", placeholder: "gpt-4o" }); fields.ai_model_openai = i; return el("div", { class: "field" }, [el("label", {}, "OpenAI model"), i]); })(),
    (() => { const i = el("input", { type: "text", value: s.ai_model_gemini || "", placeholder: "gemini-2.0-flash" }); fields.ai_model_gemini = i; return el("div", { class: "field" }, [el("label", {}, "Gemini model"), i]); })(),
    el("button", { class: "btn btn-primary", style: "margin-top:8px", onclick: async () => {
      const body = { ai_provider: providerSel.value };
      for (const [k, inp] of Object.entries(fields)) if (inp.value.trim()) body[k] = inp.value.trim();
      await api("/settings", { method: "PUT", body });
      toast("Settings saved");
      render();
    } }, "Save settings"),
  ]);
  
  if (s.commit_sha) {
    card.append(
      el("div", { style: "margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 6px;" }, [
        "Last Deployed Build:",
        el("a", {
          href: `https://github.com/kdvlr/labtracker/commit/${s.commit_sha}`,
          target: "_blank",
          style: "font-family: monospace; font-weight: 600; text-decoration: underline; color: var(--accent);"
        }, s.commit_sha.slice(0, 7))
      ])
    );
  }

  main.append(card);

  // PWA Add to Home Screen card
  if (window.deferredPrompt) {
    const installCard = el("div", { class: "card", style: "max-width:560px; margin-top:20px; border-left:5px solid var(--accent); background:var(--accent-soft)" }, [
      el("div", { class: "hh-name" }, "✨ Install LabTracker App"),
      el("p", { class: "desc-text", style: "margin:8px 0 16px; color:var(--text-secondary); font-size:15px;" }, "Install this application on your device for fast access directly from your home screen and improved offline support."),
      el("button", { class: "btn btn-primary", onclick: async () => {
        const promptEvent = window.deferredPrompt;
        if (!promptEvent) return;
        promptEvent.prompt();
        const { outcome } = await promptEvent.userChoice;
        console.log(`User response to the install prompt: ${outcome}`);
        window.deferredPrompt = null;
        render();
      } }, "Add to Home Screen"),
    ]);
    main.append(installCard);
  }
}


// ---------------- ask AI modal ----------------
async function openAsk(member) {
  const summary = await api(`/members/${member.id}/summary`);
  const selected = new Set();
  const chips = el("div", { class: "chips" });
  if (!summary.length) { toast("No results to ask about yet"); return; }
  for (const s of summary) {
    const chip = el("button", { class: "chip", onclick: () => {
      if (selected.has(s.test_type_id)) { selected.delete(s.test_type_id); chip.classList.remove("on"); }
      else { selected.add(s.test_type_id); chip.classList.add("on"); }
    } }, s.name);
    chips.append(chip);
  }
  const q = el("textarea", { rows: 3, placeholder: "e.g. How has my cholesterol trended over the last 3 years? Anything concerning?" });
  const answer = el("div");

  const modal = openModal(`Ask AI about ${member.name}'s results`, [
    el("p", { class: "page-sub" }, "Select which tests to include as context:"),
    chips,
    el("div", { class: "field" }, [el("label", {}, "Your question"), q]),
    answer,
  ], [
    el("button", { class: "btn", onclick: closeModal }, "Close"),
    el("button", { class: "btn btn-primary", onclick: async () => {
      if (!q.value.trim()) return toast("Type a question");
      const ids = selected.size ? [...selected] : summary.map((s) => s.test_type_id);
      answer.innerHTML = ""; answer.append(el("div", { class: "ask-answer" }, [el("span", { class: "spinner" }), " Thinking…"]));
      try {
        const res = await api("/ask", { method: "POST", body: { member_id: member.id, test_type_ids: ids, question: q.value.trim() } });
        answer.innerHTML = ""; answer.append(el("div", { class: "ask-answer" }, res.answer));
      } catch (e) { answer.innerHTML = ""; answer.append(el("div", { class: "ask-answer warn" }, "Error: " + e.message + "\n\nCheck your AI provider & key in Settings.")); }
    } }, "Ask"),
  ]);
}

// ---------------- modal + member creation ----------------
function openModal(title, bodyChildren, actions) {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) closeModal(); } });
  const modal = el("div", { class: "modal" }, [el("h3", {}, title), ...bodyChildren, el("div", { class: "modal-actions" }, actions)]);
  backdrop.append(modal);
  $("#modal-root").append(backdrop);
  return modal;
}
function closeModal() { $("#modal-root").innerHTML = ""; }

function openAddMember() {
  const name = el("input", { type: "text", placeholder: "e.g. Priya" });
  const dob = el("input", { type: "date" });
  const sex = el("select", {}, [el("option", { value: "" }, "—"), el("option", { value: "female" }, "Female"), el("option", { value: "male" }, "Male"), el("option", { value: "other" }, "Other")]);
  const color = MEMBER_PALETTE[state.members.length % MEMBER_PALETTE.length];
  openModal("Add family member", [
    el("div", { class: "field" }, [el("label", {}, "Name"), name]),
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Date of birth"), dob]),
      el("div", { class: "field" }, [el("label", {}, "Sex"), sex]),
    ]),
  ], [
    el("button", { class: "btn", onclick: closeModal }, "Cancel"),
    el("button", { class: "btn btn-primary", onclick: async () => {
      if (!name.value.trim()) return toast("Name required");
      const m = await api("/members", { method: "POST", body: { name: name.value.trim(), dob: dob.value || null, sex: sex.value || null, color } });
      await loadCore(); closeModal(); navigateTo("overview", { activeMember: m.id });
    } }, "Add"),
  ]);
}

// ---------------- boot ----------------
initTheme();
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => { navigateTo(b.dataset.view); }));
$("#add-member").addEventListener("click", openAddMember);

const brand = document.querySelector(".brand");
if (brand) {
  brand.addEventListener("click", () => { navigateTo("household"); });
}

// PWA Install Prompts
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
  if (state.view === "settings") {
    render();
  }
});
window.addEventListener("appinstalled", () => {
  window.deferredPrompt = null;
  toast("LabTracker added to Home Screen successfully!");
  if (state.view === "settings") {
    render();
  }
});

// Service Worker Registration
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then((reg) => console.log("ServiceWorker registered: ", reg.scope))
      .catch((err) => console.error("ServiceWorker registration failed: ", err));
  });
}

loadCore().then(render).catch((e) => {
  $("#main").append(el("div", { class: "empty" }, "Failed to load: " + e.message));
});
