// ---------------- state ----------------
const state = {
  members: [],
  testTypes: [],
  activeMember: null,
  view: "household",
  search: "",
  collapsed: {},
  statusFilter: null,
  access: { has_pin: false, unlocked: false },
  settingsUnlockToken: null,
};

state.pushCount = 0;

function isViewPrivate(view, activeMemberId) {
  if (view === "settings" && state.access.has_pin) return true;
  if (!activeMemberId) return false;
  const m = state.members.find(x => x.id === activeMemberId);
  return m ? !!m.private : false;
}

function getHashForState(s) {
  if (s.view === "household") return "#/household";
  if (s.view === "overview") return `#/overview?member=${s.activeMember}`;
  if (s.view === "detail") return `#/detail?member=${s.activeMember}&test_type=${s._detail?.id}`;
  if (s.view === "upload") return `#/upload?member=${s.activeMember}`;
  if (s.view === "documents") return "#/documents";
  if (s.view === "review-doc") return `#/review-doc?doc=${s._reviewDoc?.id}`;
  if (s.view === "settings") return "#/settings";
  if (s.view === "report") return `#/report?member=${s._report?.member?.id}`;
  return "#/household";
}

function getStateSnapshot() {
  return {
    view: state.view,
    activeMember: state.activeMember,
    search: state.search,
    statusFilter: state.statusFilter,
    _detail: state._detail ? { ...state._detail } : null,
    _doc: state._doc ? { ...state._doc } : null,
    _reviewDoc: state._reviewDoc ? { ...state._reviewDoc } : null,
    _report: state._report ? { ...state._report } : null
  };
}

let isPopStateNavigation = false;

window.addEventListener("popstate", async (e) => {
  if (!e.state) return;
  isPopStateNavigation = true;
  try {
    const targetState = e.state;
    const currentMemberId = state.activeMember;
    const currentPrivate = isViewPrivate(state.view, currentMemberId);
    const targetPrivate = isViewPrivate(targetState.view, targetState.activeMember);

    const targetSettings = (targetState.view === "settings");
    const isLocked = state.access.has_pin && (targetSettings ? !state.settingsUnlockToken : !state.access.unlocked);
    if (isLocked) {
      openUnlockModal(
        async () => {
          Object.assign(state, targetState);
          render();
        },
        () => {
          history.back();
        },
        targetSettings ? "settings" : "member"
      );
      return;
    }

    if (state.settingsUnlockToken && targetState.view !== "settings") {
      lockSettings();
    }

    if (state.access.unlocked && currentPrivate && !targetPrivate) {
      api("/lock", { method: "POST", token: getUnlockToken() }).catch(() => {});
      setUnlockToken(null);
      state.access.unlocked = false;
      await loadCore();
    }

    Object.assign(state, targetState);
    render();
  } finally {
    isPopStateNavigation = false;
  }
});

function handleInitialHash() {
  const hash = window.location.hash;
  if (!hash) {
    history.replaceState(getStateSnapshot(), "", "#/household");
    return;
  }
  
  const parts = hash.split("?");
  const route = parts[0];
  const params = new URLSearchParams(parts[1] || "");
  
  const view = route.replace("#/", "");
  const extras = {};
  
  if (view === "overview") {
    extras.activeMember = parseInt(params.get("member")) || null;
  } else if (view === "detail") {
    extras.activeMember = parseInt(params.get("member")) || null;
    const ttId = parseInt(params.get("test_type"));
    if (ttId) {
      extras._detail = state.testTypes.find(t => t.id === ttId) || null;
    }
  } else if (view === "upload") {
    extras.activeMember = parseInt(params.get("member")) || null;
  } else if (view === "review-doc") {
    const docId = parseInt(params.get("doc"));
    extras._reviewDoc = { id: docId };
  } else if (view === "report") {
    const memberId = parseInt(params.get("member"));
    extras._report = { member: state.members.find(m => m.id === memberId) || null };
  }
  
  state.view = view;
  Object.assign(state, extras);
  history.replaceState(getStateSnapshot(), "", hash);
}

function navigateTo(view, extras = {}) {
  // Ignore redundant clicks on the current view/member
  if (state.view === view && (extras.activeMember === undefined || extras.activeMember === state.activeMember)) {
    return;
  }

  const targetMemberId = extras.activeMember !== undefined ? extras.activeMember : state.activeMember;
  const targetPrivate = isViewPrivate(view, targetMemberId);

  const targetSettings = (view === "settings");
  const isLocked = state.access.has_pin && (targetSettings ? !state.settingsUnlockToken : !state.access.unlocked);
  if (isLocked) {
    openUnlockModal(
      async () => {
        navigateTo(view, extras);
      },
      () => {
      },
      targetSettings ? "settings" : "member"
    );
    return;
  }

  if (state.settingsUnlockToken && view !== "settings") {
    lockSettings();
  }

  // If we are currently unlocked, and navigating away to a public view, automatically lock!
  const currentMemberId = state.activeMember;
  const currentPrivate = isViewPrivate(state.view, currentMemberId);
  if (state.access.unlocked && currentPrivate && !targetPrivate) {
    api("/lock", { method: "POST", token: getUnlockToken() }).catch(() => {});
    setUnlockToken(null);
    state.access.unlocked = false;
    loadCore().then(() => {
      performNavigation(view, extras);
    });
    return;
  }

  performNavigation(view, extras);
}

function performNavigation(view, extras) {
  state.view = view;
  Object.assign(state, extras);
  
  if (!isPopStateNavigation) {
    const hash = getHashForState(state);
    history.pushState(getStateSnapshot(), "", hash);
    state.pushCount = (state.pushCount || 0) + 1;
  }
  
  render();
}

function navigateBack() {
  if ((state.pushCount || 0) > 0) {
    state.pushCount--;
    history.back();
  } else {
    // Fallback if local history stack is empty (e.g. loaded direct link)
    if (state.view === "detail") {
      navigateTo("overview", { activeMember: state.activeMember });
    } else if (state.view === "overview" || state.view === "documents" || state.view === "settings" || state.view === "review-doc") {
      navigateTo("household");
    } else {
      navigateTo("household");
    }
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

// A device that has entered the private PIN keeps that token in localStorage
// and resends it forever — this is the whole "no login" mechanism.
const UNLOCK_KEY = "rc-unlock-token";
const getUnlockToken = () => { try { return localStorage.getItem(UNLOCK_KEY); } catch { return null; } };
const setUnlockToken = (t) => { try { t ? localStorage.setItem(UNLOCK_KEY, t) : localStorage.removeItem(UNLOCK_KEY); } catch {} };

async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const isSettingsPath = path.startsWith("/settings") || 
                        (method !== "GET" && (
                          (path.startsWith("/members") && 
                           !path.includes("/analysis") && 
                           !path.includes("/summary") && 
                           !path.includes("/documents") && 
                           !path.includes("/results")) ||
                          (path.startsWith("/test-types") && 
                           !path.includes("/describe")) ||
                          path.startsWith("/access")
                        ));
  let tok = isSettingsPath ? state.settingsUnlockToken : getUnlockToken();
  if (opts.token !== undefined) {
    tok = opts.token;
  }
  const res = await fetch("/api" + path, {
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(tok ? { "X-Unlock": tok } : {}),
    },
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

// Charts render into an SVG viewBox; on a phone that box is scaled down, so the
// chart picks a narrower geometry rather than shrinking its own labels.
const isNarrow = () => window.matchMedia("(max-width: 860px)").matches;
// iPadOS reports as "MacIntel" but is touch-only, unlike a real Mac.
const isIOS = () => /iP(hone|od|ad)/.test(navigator.platform)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
// A non-detect ("<0.01") must never render as a bare measurement — keep the
// comparator the lab printed.
const fmtVal = (n, qualifier) => (n == null ? "—" : (qualifier ? qualifier : "") + fmtNum(n));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
// SQLite CURRENT_TIMESTAMP is UTC without a zone marker; append Z so it renders
// in the viewer's local time rather than as if it were already local.
const fmtDateTime = (s) => {
  if (!s) return "—";
  const iso = /Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d) ? s : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
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
  // On a phone the SVG is scaled down to fit, which shrinks its text with it —
  // a 720-wide chart squeezed onto a 360px screen renders 13px labels at ~7px.
  // Use a viewBox close to the real width there so the type stays readable.
  const narrow = isNarrow();
  const W = narrow ? 330 : 720, H = narrow ? 250 : 300;
  const m = narrow ? { t: 22, r: 46, b: 30, l: 46 } : { t: 24, r: 64, b: 34, l: 58 };
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

  const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "trend-svg" + (points.length > 4 ? " has-tooltips" : ""), style: "max-width:100%;height:auto;display:block" });

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

  // unit caption, so the scale is readable without the legend. Anchored to the
  // left edge — right-anchoring it to the axis pushed longer units (mg/dL) off
  // the canvas once the margins tightened on phones.
  if (opts.unit) {
    const u = svgNode("text", { x: 1, y: m.t - 9, "text-anchor": "start", class: "tick axis-unit" });
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
    
    // Create group for circle and interactive tooltip
    const ptGroup = svgNode("g", { class: "pt-group" });
    
    if (isLast) ptGroup.append(svgNode("circle", { cx, cy, r: 11, class: "pt-halo " + zc }));
    
    const c = svgNode("circle", { cx, cy, r: isLast ? 6 : 4, class: "pt " + zc + (isLast ? " latest" : "") });
    const title = svgNode("title");
    title.textContent = `${fmtDate(p.taken_at)}: ${fmtVal(conv(p.value_canonical), p.qualifier)} ${opts.unit}`
      + (dz ? ` — ${zoneOf(vals[i], dz).label}` : "")
      + `\nreported: ${fmtVal(p.value, p.qualifier)} ${p.unit}`;
    c.append(title);
    ptGroup.append(c);
    
    // Interactive tooltip popup inside the group
    const valStr = `${fmtVal(conv(p.value_canonical), p.qualifier)}${opts.unit ? " " + opts.unit : ""}`;
    const textLen = valStr.length;
    const rectW = Math.max(64, textLen * 7.5 + 12);
    const rectH = 22;
    const r = 4;
    const aw = 10;
    const ah = 4;
    const y0 = cy - 31;
    const xLeft = cx - rectW / 2;
    const xRight = cx + rectW / 2;
    
    const dPath = `M ${(xLeft + r).toFixed(1)} ${y0.toFixed(1)} ` +
                  `H ${(xRight - r).toFixed(1)} ` +
                  `A ${r} ${r} 0 0 1 ${xRight.toFixed(1)} ${(y0 + r).toFixed(1)} ` +
                  `V ${(y0 + rectH - r).toFixed(1)} ` +
                  `A ${r} ${r} 0 0 1 ${(xRight - r).toFixed(1)} ${(y0 + rectH).toFixed(1)} ` +
                  `H ${(cx + aw / 2).toFixed(1)} ` +
                  `L ${cx.toFixed(1)} ${(y0 + rectH + ah).toFixed(1)} ` +
                  `L ${(cx - aw / 2).toFixed(1)} ${(y0 + rectH).toFixed(1)} ` +
                  `H ${(xLeft + r).toFixed(1)} ` +
                  `A ${r} ${r} 0 0 1 ${xLeft.toFixed(1)} ${(y0 + rectH - r).toFixed(1)} ` +
                  `V ${(y0 + r).toFixed(1)} ` +
                  `A ${r} ${r} 0 0 1 ${(xLeft + r).toFixed(1)} ${y0.toFixed(1)} Z`;
                  
    const tooltipGroup = svgNode("g", { class: "chart-tooltip" });
    const bg = svgNode("path", { d: dPath, class: "tooltip-bg" });
    const txt = svgNode("text", { x: cx, y: y0 + 15, "text-anchor": "middle", class: "tooltip-text" });
    txt.textContent = valStr;
    tooltipGroup.append(bg, txt);
    ptGroup.append(tooltipGroup);
    
    svg.append(ptGroup);
    
    // Label the readings statically if there are 4 or fewer points.
    if (points.length <= 4) {
      const lx = cx > m.l + iw - 40 ? cx - 12 : cx + 12;
      const lbl = svgNode("text", { x: lx, y: cy - 12, "text-anchor": cx > m.l + iw - 40 ? "end" : "start", class: "pt-label " + zc });
      lbl.textContent = valStr;
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

function askDuplicateDecision(duplicates) {
  return new Promise((resolve) => {
    const d = duplicates || [];
    const listItems = d.map(x => el("li", {}, [
      el("strong", {}, x.name),
      `: ${fmtNum(x.value)} ${x.unit || ""} on `,
      el("span", { class: "muted-inline" }, fmtDate(x.date))
    ]));
    
    const bodyText = el("div", {}, [
      el("p", { class: "modal-lead" },
        `${d.length} result${d.length > 1 ? "s are" : " is"} already saved with the same date and value:`
      ),
      el("ul", { class: "modal-list" }, listItems),
      el("p", { class: "modal-lead" }, d.length > 1
        ? "You can skip them and save only the new results."
        : "You can skip it and save only the new results."),
    ]);

    // The safe action is the primary one and is what Enter/tap lands on. Saving a
    // second copy is possible but has to be chosen deliberately.
    const actions = [
      el("button", {
        class: "btn btn-quiet",
        onclick: () => { closeModal(); resolve("cancel"); }
      }, "Cancel"),
      el("button", {
        class: "btn btn-quiet",
        onclick: () => { closeModal(); resolve("duplicate"); }
      }, "Save a second copy"),
      el("button", {
        class: "btn btn-primary",
        onclick: () => { closeModal(); resolve("ignore"); }
      }, `Skip ${d.length > 1 ? "duplicates" : "duplicate"} and save the rest`),
    ];

    openModal("Some results are already saved", [bodyText], actions);
  });
}

// Commit results, but if the server reports duplicates (same date + value
// already on file), ask the user before forcing them in. Returns the final
// commit response, or {cancelled:true} if the user declined the override.
async function commitResults(body) {
  let res = await api("/results/commit", { method: "POST", body });
  if (res.needs_confirmation) {
    const decision = await askDuplicateDecision(res.duplicates);
    if (decision === "cancel") {
      return { cancelled: true };
    } else if (decision === "ignore") {
      res = await api("/results/commit", { method: "POST", body: { ...body, ignore_duplicates: true } });
    } else if (decision === "duplicate") {
      res = await api("/results/commit", { method: "POST", body: { ...body, force: true } });
    }
  }
  return res;
}

// ---------------- data loading ----------------
async function loadCore() {
  [state.members, state.testTypes, state.access] = await Promise.all([
    api("/members"), api("/test-types"), api("/access"),
  ]);
  // If the active member just disappeared (e.g. this device locked, or someone
  // else's device never had the PIN), fall back to the first visible member
  // rather than showing an empty page for a member that no longer resolves.
  if (!state.members.some((m) => m.id === state.activeMember)) {
    state.activeMember = state.members[0]?.id || null;
  }
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

    }, [el("span", { class: "avatar", style: `background:${m.color || "#5c554e"}` }, initials(m.name)), m.name]));
  }
}

// A single quiet chip, present only once a PIN exists anywhere in the household
// — never shown on a fresh install, so a device that will never unlock (a
// parent's phone) sees nothing extra at all until the day someone sets one up,
// and even then it's a one-line "Unlock" toggle, not a login wall.
function renderLockBtn() {
  const btn = document.getElementById("sidebar-lock-btn");
  if (!btn) return;
  
  if (!state.access.has_pin) {
    btn.style.setProperty("display", "none", "important");
    return;
  }
  
  btn.style.removeProperty("display");
  const locked = !state.access.unlocked;
  
  btn.innerHTML = "";
  const icoSpan = el("span", { class: "ico" }, locked ? "🔒" : "🔓");
  const textNode = document.createTextNode(locked ? " Unlock" : " Lock");
  btn.append(icoSpan, textNode);
  
  btn.onclick = (e) => {
    e.preventDefault();
    if (locked) {
      openUnlockModal();
    } else {
      lockDevice();
    }
  };
}

function render() {
  renderSidebar();
  renderLockBtn();
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

// ---------------- whole-member AI health analysis ----------------
const SEVERITY = {
  urgent: { cls: "sev-urgent", label: "Urgent", icon: "🔴" },
  monitor: { cls: "sev-monitor", label: "Monitor", icon: "🟡" },
  minor: { cls: "sev-minor", label: "Minor", icon: "⚪" },
};
const TREND = {
  worsening: { cls: "warn", arrow: "↘", label: "worsening" },
  improving: { cls: "good", arrow: "↗", label: "improving" },
  stable: { cls: "flat", arrow: "→", label: "stable" },
  new: { cls: "flat", arrow: "•", label: "new" },
  insufficient: { cls: "flat", arrow: "·", label: "not enough history" },
};
// A small labelled chip for one trend horizon; null when the direction is unknown.
function trendChip(horizon, dir) {
  const t = TREND[dir];
  if (!t) return null;
  return el("span", { class: "trend-chip trend-" + t.cls }, `${horizon}: ${t.arrow} ${t.label}`);
}

async function renderHealthAnalysis(mount, member) {
  mount.innerHTML = "";
  let data;
  try { data = await api(`/members/${member.id}/analysis`); }
  catch { return; }              // locked or error — stay quiet, not a blocker
  if (!data.has_data) return;

  const card = el("div", { class: "analysis-card" });
  mount.append(card);

  const generate = async () => {
    card.innerHTML = "";
    card.append(el("div", { class: "analysis-loading" }, [
      el("span", { class: "spinner" }),
      el("div", {}, [
        el("div", { style: "font-weight:600" }, "Analyzing the full picture…"),
        el("div", { class: "page-sub", style: "margin:4px 0 0" }, `Reviewing all ${data.marker_count || ""} biomarkers and their history. This can take up to a minute.`),
      ]),
    ]));
    try {
      const fresh = await api(`/members/${member.id}/analysis`, { method: "POST", body: {} });
      renderAnalysisBody(card, fresh, member, generate);
    } catch (e) {
      card.innerHTML = "";
      card.append(el("div", { class: "analysis-head" }, el("div", { class: "analysis-title" }, "🩺 Full Health Analysis")));
      card.append(el("div", { class: "warn", style: "margin-top:10px" }, "Couldn't generate the analysis: " + e.message));
      card.append(el("button", { class: "btn", style: "margin-top:12px", onclick: generate }, "Try again"));
    }
  };

  if (!data.analysis) {
    // Never generated — a clear one-tap call to action.
    card.append(
      el("div", { class: "analysis-head" }, el("div", { class: "analysis-title" }, "🩺 Full Health Analysis")),
      el("p", { class: "page-sub", style: "margin:6px 0 14px" }, "Let AI review every biomarker and its full history together — spotting trends, cross-marker patterns, and anything worth discussing with a doctor."),
      el("button", { class: "btn btn-primary", onclick: generate }, "✨ Analyze all results"),
    );
    return;
  }
  renderAnalysisBody(card, data, member, generate);
}

function renderAnalysisBody(card, data, member, regenerate) {
  card.innerHTML = "";
  const a = data.analysis || {};

  const genLabel = data.generated_at ? `Generated ${fmtDateTime(data.generated_at)}` : "";
  card.append(el("div", { class: "analysis-head" }, [
    el("div", {}, [
      el("div", { class: "analysis-title" }, "🩺 Full Health Analysis"),
      genLabel ? el("div", { class: "page-sub", style: "margin-top:2px;font-size:13px" }, genLabel) : null,
    ]),
    el("button", { class: "btn btn-sm", onclick: regenerate }, "↻ Regenerate"),
  ]));

  if (data.stale) {
    card.append(el("div", { class: "analysis-stale" }, [
      "New results have been added since this analysis. ",
      el("button", { class: "linkish", onclick: regenerate }, "Regenerate"),
    ]));
  }

  if (a.headline) card.append(el("p", { class: "analysis-headline" }, a.headline));

  // Problem areas — ranked, color-coded by severity.
  const problems = Array.isArray(a.problem_areas) ? a.problem_areas : [];
  if (problems.length) {
    card.append(el("div", { class: "analysis-section-label" }, "Areas to look at"));
    for (const p of problems) {
      const sev = SEVERITY[p.severity] || SEVERITY.minor;
      // New schema splits trend into recent/long-term; fall back to the old
      // single `trend` field for analyses cached before this change.
      const recent = p.recent_trend || p.trend;
      const longTerm = p.long_term_trend;
      const trendChips = [trendChip("Recent", recent), trendChip("Long-term", longTerm)].filter(Boolean);
      const block = el("div", { class: "problem-card " + sev.cls }, [
        el("div", { class: "problem-head" }, [
          el("span", { class: "problem-title" }, p.title || "Concern"),
          el("span", { class: "sev-pill" }, `${sev.icon} ${sev.label}`),
        ]),
        trendChips.length ? el("div", { class: "trend-chips" }, trendChips) : null,
        p.explanation ? el("p", { class: "problem-body" }, p.explanation) : null,
        p.trend_note ? el("p", { class: "trend-note" }, "📈 " + p.trend_note) : null,
        Array.isArray(p.markers) && p.markers.length
          ? el("div", { class: "problem-markers" }, p.markers.map((m) => el("span", { class: "marker-chip" }, m)))
          : null,
        Array.isArray(p.actions) && p.actions.length
          ? el("ul", { class: "problem-actions" }, p.actions.map((s) => el("li", {}, s)))
          : null,
      ].filter(Boolean));
      card.append(block);
    }
  } else {
    card.append(el("div", { class: "analysis-allclear" }, "✓ No specific concerns flagged in this review."));
  }

  // Trends — each marker gets a short-term and a long-term horizon (with
  // fallback to the pre-split `direction` field for older cached analyses).
  const trends = Array.isArray(a.trends) ? a.trends : [];
  if (trends.length) {
    card.append(el("div", { class: "analysis-section-label" }, "Trends over time (recent vs. long-term)"));
    const list = el("div", { class: "trend-list" });
    for (const t of trends) {
      const recent = t.recent_trend || t.direction;
      const chips = [trendChip("Recent", recent), trendChip("Long-term", t.long_term_trend)].filter(Boolean);
      list.append(el("div", { class: "trend-row" }, [
        el("div", { class: "trend-row-head" }, [
          el("strong", {}, t.marker || ""),
          ...chips,
        ]),
        t.detail ? el("div", { class: "trend-detail" }, t.detail) : null,
      ].filter(Boolean)));
    }
    card.append(list);
  }

  // Positives
  const positives = Array.isArray(a.positives) ? a.positives : [];
  if (positives.length) {
    card.append(el("div", { class: "analysis-section-label" }, "What's going well"));
    card.append(el("ul", { class: "positive-list" }, positives.map((s) => el("li", {}, s))));
  }

  // Doctor questions
  const dq = Array.isArray(a.doctor_questions) ? a.doctor_questions : [];
  if (dq.length) {
    card.append(el("div", { class: "analysis-section-label" }, "Questions for your doctor"));
    card.append(el("ul", { class: "doctor-list" }, dq.map((s) => el("li", {}, s))));
  }

  if (a.age_context) {
    card.append(el("div", { class: "analysis-section-label" }, "In the context of age"));
    card.append(el("p", { class: "problem-body", style: "margin:0" }, a.age_context));
  }

  card.append(el("p", { class: "analysis-disclaimer" }, a.disclaimer || "This is an automated summary, not a medical diagnosis. Always consult a clinician."));
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
  // Whole-member AI analysis — the "what does all of this mean together" card.
  const analysisMount = el("div");
  main.append(analysisMount);
  renderHealthAnalysis(analysisMount, member);

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

// ---------------- private profiles: unlock / lock ----------------
// Nothing here is shown to a device that has never unlocked and has no reason
// to: the lock affordance only appears once a PIN exists at all, and even then
// it's a single quiet icon, not a login wall.
function openUnlockModal(onSuccess = null, onCancel = null, scope = "member") {
  const pin = el("input", {
    type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "8",
    placeholder: "PIN", autocomplete: "off",
  });
  const err = el("p", { class: "modal-lead", style: "color:var(--high);display:none" });
  const submit = async () => {
    const v = pin.value.trim();
    if (!v) return;
    try {
      const res = await api("/unlock", { method: "POST", body: { pin: v, scope: scope } });
      if (scope === "settings") {
        state.settingsUnlockToken = res.token;
      } else {
        setUnlockToken(res.token);
      }
      closeModal();
      await loadCore();
      if (onSuccess) {
        onSuccess();
      } else {
        render();
        toast("Unlocked");
      }
    } catch (e) {
      err.textContent = e.message || "Incorrect PIN";
      err.style.display = "";
      pin.value = ""; pin.focus();
    }
  };
  pin.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  
  const leadMsg = scope === "settings"
    ? "Enter the PIN to manage settings on this device."
    : "Enter the PIN to see private profiles on this device.";

  openModal("Enter PIN", [
    el("p", { class: "modal-lead" }, leadMsg),
    el("div", { class: "field" }, pin),
    err,
  ], [
    el("button", { class: "btn btn-quiet", onclick: () => { closeModal(); if (onCancel) onCancel(); } }, "Cancel"),
    el("button", { class: "btn btn-primary", onclick: submit }, "Unlock"),
  ]);
  setTimeout(() => pin.focus(), 50);
}

async function lockDevice() {
  await api("/lock", { method: "POST", token: getUnlockToken() }).catch(() => {});
  setUnlockToken(null);
  await loadCore();
  if (state.view !== "household" && state.view !== "settings") navigateTo("household");
  else render();
  toast("Locked");
}

function lockSettings() {
  if (state.settingsUnlockToken) {
    api("/lock", { method: "POST", token: state.settingsUnlockToken }).catch(() => {});
    state.settingsUnlockToken = null;
  }
}

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
  // Only offer the private toggle when this device could actually act on it —
  // otherwise checking it would just 403. Setting up privacy in the first
  // place happens from Settings, where the PIN gets created.
  const canTogglePrivate = state.access.unlocked || !state.access.has_pin;
  let priv = !!member.private;
  const privField = canTogglePrivate ? el("div", { class: "field" }, [
    el("label", { class: "check-row" }, [
      el("input", { type: "checkbox", ...(priv ? { checked: "" } : {}), onchange: (e) => { priv = e.target.checked; } }),
      " Private — hidden unless the PIN is entered on this device",
    ]),
  ]) : null;
  openModal(`Edit ${member.name}`, [
    el("div", { class: "field" }, [el("label", {}, "Name"), name]),
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Date of birth"), dob]),
      el("div", { class: "field" }, [el("label", {}, "Sex"), sex]),
    ]),
    el("div", { class: "field" }, [el("label", {}, "Color"), swatches]),
    privField,
  ].filter(Boolean), [
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
        ...(canTogglePrivate ? { private: priv } : {}),
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
  document.querySelectorAll('[data-view="household"]').forEach((b) => b.classList.add("active"));
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Household"),
    el("p", { class: "page-sub" }, "Everyone at a glance — who needs a closer look."),
  ])));

  // Fetch documents for the waiting results banner
  let docs = [];
  try {
    docs = await api("/documents");
  } catch (e) {
    console.error("Failed fetching documents for banner", e);
  }
  const pending = docs.filter((d) => d.status === "needs_review");
  if (pending.length > 0) {
    main.append(el("div", { 
      class: "banner waiting-results-banner", 
      style: "margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; background: var(--low-soft); border: 1px solid var(--hairline); padding: 12px 16px; border-radius: var(--radius-sm); color: var(--text-primary);" 
    }, [
      el("div", { style: "display: flex; align-items: center; gap: 8px;" }, [
        el("span", { style: "font-size: 1.2rem;" }, "⏳"),
        el("span", { style: "font-weight: 500;" }, 
          `You have ${pending.length} document${pending.length > 1 ? "s" : ""} with extracted results waiting for review.`
        )
      ]),
      el("button", { 
        class: "btn btn-sm btn-primary", 
        style: "margin: 0;",
        onclick: () => navigateTo("documents") 
      }, "Review Documents")
    ]));
  }

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

  let summaries, counts;
  try {
    [summaries, counts] = await Promise.all([
      Promise.all(state.members.map((m) => api(`/members/${m.id}/summary`))),
      api("/members/analyses/counts")
    ]);
  } catch (e) {
    mount.innerHTML = "";
    mount.append(el("div", { class: "warn" }, "Couldn't load household: " + e.message));
    return;
  }
  mount.innerHTML = "";

  state.members.forEach((m, i) => {
    const summary = summaries[i] || [];
    const latest = summary.reduce((a, s) => (!a || (s.latest_at || "") > a ? (s.latest_at || "") : a), "");
    const mCounts = counts[String(m.id)] || { urgent: 0, monitor: 0, minor: 0 };

    const card = el("div", { class: "hh-card" }, [
      el("div", { class: "hh-head", onclick: () => { navigateTo("overview", { activeMember: m.id }); } }, [
        el("span", { class: "avatar", style: `background:${m.color || "#5c554e"}` }, initials(m.name)),
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

    const pills = [];
    if (mCounts.urgent) pills.push(el("span", { class: "count-pill out" }, `${mCounts.urgent} urgent`));
    if (mCounts.monitor) pills.push(el("span", { class: "count-pill borderline" }, `${mCounts.monitor} monitoring`));
    if (mCounts.minor) pills.push(el("span", { class: "count-pill minor" }, `${mCounts.minor} minor`));
    
    if (pills.length === 0) {
      pills.push(el("span", { class: "count-pill minor" }, "No concerns flagged"));
    }

    card.append(el("div", { class: "hh-pills", style: "margin-bottom: 0;" }, pills));
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
  const vz = zoneOf(value, zones) || { c: "green" };

  const track = el("div", { class: "rbar-track" });
  let prev = d0;
  for (const z of zones) {
    const to = z.to == null ? d1 : z.to;
    const l = pos(prev), r = pos(to);
    
    let color;
    if (z === vz) {
      if (z.c === "green") color = "var(--range-in)";
      else if (z.c === "amber") color = "var(--low)";
      else if (z.c === "red") color = "var(--high)";
    } else {
      if (z.c === "green") color = "var(--good-soft)";
      else if (z.c === "amber") color = "var(--range-warn)";
      else if (z.c === "red") color = "var(--range-out)";
    }

    if (r > l) track.append(el("div", { class: "rbar-seg", style: `left:${l.toFixed(1)}%;width:${(r - l).toFixed(1)}%;background:${color}` }));
    prev = to;
  }
  
  const wrap = el("div", { style: "position: relative;" });
  wrap.append(track);
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
  state._detail.tab = state._detail.tab || "description";

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
      .map((m) => ({ name: m.name, color: m.color || "#5c554e", points: groups[m.id] }));
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
  const narrow = isNarrow();
  const W = narrow ? 330 : 720, H = narrow ? 260 : 320;
  const m = narrow ? { t: 14, r: 16, b: 30, l: 44 } : { t: 16, r: 20, b: 34, l: 52 };
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

  const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: "max-width:100%;height:auto;display:block" });

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
  document.querySelectorAll('[data-view="upload"]').forEach((b) => b.classList.add("active"));
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

  const fileInput = el("input", { 
    type: "file", 
    accept: "image/*,application/pdf",
    style: "display:none;"
  });
  const fileStatusText = el("span", { style: "font-size: 14px; color: var(--muted); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;" }, "No file selected");
  const browseBtn = el("button", {
    type: "button",
    class: "btn btn-secondary",
    style: "display: inline-flex; align-items: center; gap: 8px; justify-content: center; height: 38px; padding: 0 16px; flex-shrink: 0;",
    onclick: () => fileInput.click()
  }, "📁 Browse Files");

  const status = el("div", { style: "margin-top:12px" });
  const reviewMount = el("div", { style: "margin-top:20px" });

  // iOS Safari's clipboard API only ever exposes images to a web page — never
  // a PDF or other file, regardless of which "Copy" produced it (in-chat or
  // the system share sheet; both were tested and neither works). That's a
  // WebKit sandboxing limit, not something fixable here, so the iOS copy is
  // scoped to what actually works: photos and screenshots.
  const ios = isIOS();
  const pasteInput = el("input", {
    type: "text",
    placeholder: ios ? "Tap here to paste a photo or screenshot…" : "Tap here to paste a copied file…",
    style: "width: 100%; padding: 12px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--panel); text-align: center; font-size: 15px; font-weight: 500; caret-color: transparent;"
  });

  pasteInput.addEventListener("paste", async (e) => {
    e.preventDefault();
    let file = null;

    // 1. Check e.clipboardData.files first (standard file paste)
    if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
      file = e.clipboardData.files[0];
    }

    // 2. Fallback to e.clipboardData.items iteration
    if (!file && e.clipboardData?.items) {
      for (const item of e.clipboardData.items) {
        if (item.kind === "file") {
          file = item.getAsFile();
          if (file) break;
        }
      }
    }

    // 3. Fallback to async navigator.clipboard.read() if available. Skip the
    // PDF search on iOS — Safari never exposes application/pdf this way, so
    // trying just costs a clipboard-permission prompt for nothing.
    if (!file && navigator.clipboard && navigator.clipboard.read) {
      try {
        const data = await navigator.clipboard.read();
        for (const item of data) {
          const pdfType = ios ? null : item.types.find(t => t === "application/pdf");
          const imgType = item.types.find(t => t.startsWith("image/"));
          const targetType = pdfType || imgType;
          if (targetType) {
            const blob = await item.getType(targetType);
            file = new File([blob], `pasted_file.${targetType.split("/")[1] || "bin"}`, { type: targetType });
            break;
          }
        }
      } catch (err) {
        console.warn("Async clipboard read failed:", err);
      }
    }

    if (file) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

      let name = file.name || "";
      if (!name) {
        const ext = file.type.split("/")[1] || "png";
        name = `clipboard_paste_${new Date().toISOString().slice(0, 10)}.${ext}`;
      }

      fileStatusText.textContent = `📋 Attached: ${name}`;
      pasteInput.value = `📋 Attached: ${name}`;
      toast("File pasted successfully!");
      return;
    }

    if (ios) {
      toast("No photo found in clipboard. iOS can't paste PDFs into an app — in WhatsApp, use Share → Save to Files, then tap Browse Files above.");
    } else {
      let clipDesc = "";
      if (e.clipboardData) {
        const types = Array.from(e.clipboardData.types || []);
        if (types.length > 0) clipDesc = ` (contains: ${types.join(", ")})`;
      }
      toast(`No file found in clipboard${clipDesc}.`);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) {
      const file = fileInput.files[0];
      fileStatusText.textContent = `📄 Attached: ${file.name}`;
      pasteInput.value = "";
    } else {
      fileStatusText.textContent = "No file selected";
    }
  });

  const card = el("div", { class: "card" }, [
    el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", {}, "Family member"), memberSel]),
      el("div", { class: "field" }, [
        el("label", {}, "Lab report file"),
        el("div", { style: "display: flex; align-items: center; gap: 12px; min-height: 48px;" }, [
          fileInput,
          browseBtn,
          fileStatusText
        ])
      ]),
    ]),
    el("div", { style: "text-align: center; margin: 10px 0 16px; color: var(--muted); font-size: 13.5px; font-weight: 600;" }, "— OR —"),
    el("div", { class: "field", style: "margin-bottom: 20px;" }, [
      el("label", {}, ios ? "Paste a photo or screenshot" : "Paste a copied file (Mac/Windows)"),
      pasteInput,
      // Persistent, not just a toast — a PDF sent over WhatsApp is the common
      // case here, and this is the one instruction that matters for it.
      ios ? el("p", { class: "modal-lead", style: "margin:8px 2px 0; font-size:13.5px" },
        "For a PDF from WhatsApp: tap Share → Save to Files, then use Browse Files above. Pasting only works for photos on iPhone/iPad.") : null,
    ].filter(Boolean)),
    el("button", { class: "btn btn-primary", onclick: async () => {
      if (!fileInput.files[0]) return toast("Choose or paste a file first");
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

  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("dragover");
  });
  card.addEventListener("dragleave", () => {
    card.classList.remove("dragover");
  });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("dragover");
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files;
      const file = e.dataTransfer.files[0];
      fileStatusText.textContent = `📋 Attached: ${file.name}`;
      pasteInput.value = `📋 Attached: ${file.name}`;
      toast("File dropped successfully!");
    }
  });

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

function createCollapsible(title, count, contentEl, defaultOpen = false) {
  const arrow = el("span", { style: "transition: transform 0.2s ease; margin-right: 8px; display: inline-block;" }, defaultOpen ? "▼" : "▶");
  const countBadge = el("span", { class: "pill", style: "background: var(--page-tint); color: var(--text-secondary); margin-left: auto;" }, String(count));
  
  const header = el("div", { 
    class: "card-header", 
    style: "display: flex; align-items: center; cursor: pointer; padding: 12px 16px; font-weight: bold; background: var(--panel-2); border-radius: var(--radius-sm);" 
  }, [
    arrow,
    el("span", { style: "font-family: var(--sans-display);" }, title),
    countBadge
  ]);
  
  contentEl.style.display = defaultOpen ? "block" : "none";
  
  const wrapper = el("div", { class: "card", style: "margin-bottom: 16px; overflow: hidden;" }, [
    header,
    contentEl
  ]);
  
  header.onclick = () => {
    const isVisible = contentEl.style.display !== "none";
    contentEl.style.display = isVisible ? "none" : "block";
    arrow.textContent = isVisible ? "▶" : "▼";
  };
  
  return wrapper;
}

function renderReview(mount, doc, memberId, result, main) {
  mount.innerHTML = "";
  const dateInput = el("input", { type: "date", value: (result.report_date || "").slice(0, 10) || new Date().toISOString().slice(0, 10) });
  
  // Categorize items
  const needsReviewItems = result.items.filter(it => it.status === "needs_review" || !it.status);
  const importedItems = result.items.filter(it => it.status === "imported");
  const skippedItems = result.items.filter(it => it.status === "skipped" || it.status === "failed");
  
  // 1. Needs Review Section
  const needsReviewContent = el("div");
  const rows = [];
  
  if (needsReviewItems.length === 0) {
    needsReviewContent.append(el("div", { class: "empty", style: "padding: 16px 0;" }, "No items remaining to review."));
  } else {
    const selectAllCb = el("input", { type: "checkbox", checked: "" });
    selectAllCb.addEventListener("change", () => {
      rows.forEach(r => {
        r.importCb.checked = selectAllCb.checked;
      });
    });

    const head = el("div", { class: "review-row review-head" }, [
      el("div", { style: "display: flex; align-items: center; justify-content: center;" }, selectAllCb),
      el("div", {}, "Test"), el("div", {}, "Value"), el("div", {}, "Unit"), el("div", {}, "Flag"),
    ]);
    const body = el("div");
    
    needsReviewItems.forEach((item) => {
      const matchSel = el("select", { style: "width:100%" });
      matchSel.append(el("option", { value: "__new__" }, `➕ Track as new: ${item.test_name}`));
      for (const t of state.testTypes) matchSel.append(el("option", { value: String(t.id) }, `Merge into: ${t.name}`));
      matchSel.append(el("option", { value: "" }, "— skip (don't save) —"));
      matchSel.value = item.matched_test_type_id ? String(item.matched_test_type_id) : "__new__";
      
      const isQual = item.value == null && item.value_text != null;
      const valInput = isQual
        ? el("input", { type: "text", value: item.value_text, style: "width:100%" })
        : el("input", { type: "number", step: "any", value: item.value, style: "width:100%" });
      const unitInput = el("input", { type: "text", value: item.unit, style: "width:100%", ...(isQual ? { placeholder: "—", disabled: "" } : {}) });
      const flagInput = el("input", { type: "text", value: item.flag || "", placeholder: "—", style: "width:100%" });
      const warn = el("div", { class: "warn", style: "grid-column:1/-1; display:none; margin-bottom:8px;" });
      
      // Page link helper
      const pageLink = item.page_number 
        ? el("a", { 
          href: `/api/documents/${doc.id}/file#page=${item.page_number}`, 
          target: "_blank", 
          class: "pill pill-ok", 
          style: "font-size: 11px; padding: 2px 6px; margin-left: 8px; text-decoration: none; display: inline-block;" 
        }, `Page ${item.page_number}`)
        : null;
        
      const rowLabel = el("div", {}, [
        el("div", { style: "font-size:13px;color:var(--muted); display:flex; align-items:center; flex-wrap:wrap; margin-bottom:4px;" }, [
          el("span", {}, item.test_name),
          pageLink
        ]),
        matchSel
      ]);
      
      const importCb = el("input", { type: "checkbox", checked: "" });
      
      const rowEl = el("div", { class: "review-row", style: "align-items: center;" }, [
        el("div", { style: "display: flex; align-items: center; justify-content: center;" }, importCb),
        rowLabel,
        valInput, unitInput, flagInput,
      ]);
      
      body.append(rowEl, warn);
      rows.push({ importCb, matchSel, valInput, unitInput, flagInput, warn, item, isQual });
    });
    
    const commitBtn = el("button", { class: "btn btn-primary", onclick: async () => {
      commitBtn.disabled = true;
      const original = commitBtn.textContent;
      commitBtn.textContent = "Saving…";
      try {
        const items = [];
        for (const r of rows) {
          if (!r.importCb.checked) continue; // user deselected this row
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
            document_item_id: r.item.id
          } : {
            test_type_id: typeId,
            value: Number(r.valInput.value),
            unit: r.unitInput.value.trim(),
            qualifier: r.item.qualifier ?? null,
            ref_low: r.item.ref_low ?? null,
            ref_high: r.item.ref_high ?? null,
            note: null,
            document_item_id: r.item.id
          });
        }
        if (!items.length) { toast("No items selected for import"); commitBtn.disabled = false; commitBtn.textContent = original; return; }
        const mid = typeof memberId === "function" ? memberId() : memberId;
        if (!mid) { toast("Choose a family member first"); commitBtn.disabled = false; commitBtn.textContent = original; return; }
        const res = await commitResults({
          member_id: mid, taken_at: dateInput.value, document_id: doc.id, items,
        });
        if (res.cancelled) { toast("Cancelled — nothing saved"); commitBtn.disabled = false; commitBtn.textContent = original; return; }
        const nSkip = (res.skipped || []).length;
        let msg = `Saved ${res.created} result${res.created !== 1 ? "s" : ""}`;
        if (nSkip) msg += ` · skipped ${nSkip} (${res.skipped[0].reason})`;
        toast(msg);
        await loadCore();
        navigateTo("overview", { activeMember: mid });
      } catch (e) {
        toast("Error: " + e.message);
        commitBtn.disabled = false; commitBtn.textContent = original;
      }
    } }, "Save remaining results");
    
    needsReviewContent.append(head, body, el("div", { style: "margin-top:16px" }, commitBtn));
  }
  
  // 2. Imported Results Section
  const importedContent = el("div");
  if (importedItems.length === 0) {
    importedContent.append(el("div", { class: "empty", style: "padding: 16px 0;" }, "No items have been imported yet."));
  } else {
    const list = el("div", { style: "display: flex; flex-direction: column; gap: 8px;" });
    importedItems.forEach(it => {
      const displayVal = it.value !== null ? String(it.value) : (it.value_text || "");
      list.append(el("div", { 
        style: "display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--page-tint); border-radius: var(--radius-sm);" 
      }, [
        el("span", { style: "font-weight: 600;" }, it.test_name),
        el("div", {}, [
          el("span", { style: "margin-right: 8px;" }, `${displayVal} ${it.unit || ""}`),
          it.flag ? el("span", { class: "pill pill-H" }, it.flag) : el("span", { class: "pill pill-ok" }, "Normal")
        ])
      ]));
    });
    importedContent.append(list);
  }
  
  // 3. Skipped / Failed Section
  const skippedContent = el("div");
  if (skippedItems.length === 0) {
    skippedContent.append(el("div", { class: "empty", style: "padding: 16px 0;" }, "No skipped or failed items."));
  } else {
    const list = el("div", { style: "display: flex; flex-direction: column; gap: 8px;" });
    skippedItems.forEach(it => {
      list.append(el("div", { 
        style: "display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--page-tint); border-radius: var(--radius-sm);" 
      }, [
        el("span", { style: "font-weight: 600; text-decoration: line-through; color: var(--muted);" }, it.test_name),
        el("span", { style: "font-size: 13px; color: var(--muted);" }, it.error_reason || "User skipped")
      ]));
    });
    skippedContent.append(list);
  }
  
  const colNeedsReview = createCollapsible("Items needing review", needsReviewItems.length, needsReviewContent, true);
  const colImported = createCollapsible("Successfully imported results", importedItems.length, importedContent, false);
  const colSkipped = createCollapsible("Skipped or failed items", skippedItems.length, skippedContent, false);

  mount.append(el("div", { class: "card", style: "padding: 16px; margin-bottom: 16px;" }, [
    el("h3", { style: "margin-top:0" }, "Review extracted results"),
    el("p", { class: "page-sub", style: "margin-bottom:6px" }, `From ${result.lab_name || doc.filename}${result.patient_name ? " · patient: " + result.patient_name : ""} · extracted by ${result.provider}/${result.model}`),
    el("p", { class: "page-sub", style: "margin:0 0 14px" }, "Every test is tracked by default. Use a row's dropdown to merge it into an existing test (so units line up on one chart) or skip it."),
    el("div", { class: "field", style: "max-width:220px; margin: 0;" }, [el("label", {}, "Collection date"), dateInput]),
  ]));
  
  mount.append(colNeedsReview, colImported, colSkipped);
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

function renderDocList(container, docs) {
  // Deprecated by new timeline system. Removed to keep codebase clean.
}

async function renderDocuments(main) {
  main.innerHTML = "";
  document.querySelectorAll('[data-view="documents"]').forEach((b) => b.classList.add("active"));
  
  if (!state.docFilter || state.docFilter.patient !== undefined) {
    // Overwrite legacy filter schema with new global filter model
    state.docFilter = {
      search: "",
      memberId: "",      // "" = Everyone, "unassigned", or member ID (string)
      statusGroup: "all", // "all", "needs_attention", "done"
      limit: 15,
      offset: 0
    };
  }

  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Documents"),
    el("p", { class: "page-sub" }, "Every uploaded report is kept locally as a backup you can reopen anytime."),
  ])));

  // 1. Pinned Needs Attention Strip
  const attentionContainer = el("div");
  main.append(attentionContainer);
  
  const loadAttentionStrip = async () => {
    try {
      const attentionDocs = await api("/documents?status_group=needs_attention");
      if (attentionDocs.length > 0) {
        const expandBtn = el("button", { 
          class: "btn btn-sm ghost-btn", 
          style: "margin: 0; padding: 2px 8px; font-size: 11px;" 
        });
        let expanded = false;
        const cardsContainer = el("div", { class: "attention-cards-container" });
        
        const renderAttentionCards = () => {
          cardsContainer.innerHTML = "";
          const visibleDocs = expanded ? attentionDocs : attentionDocs.slice(0, 5);
          visibleDocs.forEach(d => {
            const initialsStr = d.member_name ? d.member_name.trim().slice(0, 1).toUpperCase() : "?";
            const colorStr = d.member_name ? (state.members.find(m => m.id === d.member_id)?.color || "#5c554e") : "#a0a0a0";
            const statusTextMap = {
              "needs_review": "Needs review",
              "partially_imported": "Partially imported",
              "failed": "Failed extraction"
            };
            const pillClass = d.status === "failed" ? "pill-red" : "pill-amber";
            const buttonText = d.status === "failed" ? "Retry" : "Review →";
            
            const card = el("div", { class: "attention-card", onclick: () => openReview(d) }, [
              el("div", { class: "attention-card-title" }, d.filename),
              el("div", { class: "attention-card-meta" }, `${d.lab_name || "Unknown Lab"} · ${fmtDate(d.report_date || d.created_at)}`),
              el("div", { class: "attention-card-footer" }, [
                el("div", { style: "display: flex; align-items: center; gap: 6px;" }, [
                  el("span", { class: "avatar", style: `background:${colorStr}; width: 18px; height: 18px; font-size: 9px; line-height: 18px;` }, initialsStr),
                  el("span", { style: "font-size: 12px; font-weight: 500;" }, d.member_name || "Unassigned")
                ]),
                el("button", { 
                  class: "btn btn-sm btn-primary", 
                  style: "margin: 0; padding: 2px 8px; font-size: 11px;",
                  onclick: (e) => { e.stopPropagation(); openReview(d); }
                }, buttonText),
                el("span", { class: "pill " + pillClass, style: "font-size: 11px; padding: 2px 8px; margin-left: 8px;" }, statusTextMap[d.status] || d.status)
              ])
            ]);
            cardsContainer.append(card);
          });
          
          if (attentionDocs.length > 5) {
            expandBtn.textContent = expanded ? "Show less" : `+${attentionDocs.length - 5} more`;
          }
        };
        
        expandBtn.onclick = (e) => {
          e.stopPropagation();
          expanded = !expanded;
          renderAttentionCards();
        };
        
        renderAttentionCards();
        
        attentionContainer.innerHTML = "";
        attentionContainer.append(el("div", { class: "needs-attention-strip" }, [
          el("div", { class: "needs-attention-title", style: "display: flex; justify-content: space-between; align-items: center;" }, [
            el("span", {}, "⚠️ Needs Attention"),
            attentionDocs.length > 5 ? expandBtn : null
          ].filter(Boolean)),
          cardsContainer
        ]));
      }
    } catch (e) {
      console.error("Failed to load attention strip", e);
    }
  };
  
  loadAttentionStrip();

  // 2. Fetch overall document metadata once to calculate chip counts
  const allDocs = await api("/documents");
  
  // Patient Selector chips
  const patientPills = el("div", { class: "status-tallies", style: "margin-bottom: 12px; flex-wrap: wrap; gap: 8px;" });
  
  patientPills.append(el("button", {
    class: "status-tally-btn" + (state.docFilter.memberId === "" ? " active" : ""),
    onclick: () => { state.docFilter.memberId = ""; state.docFilter.offset = 0; refreshTimeline(); }
  }, ["Everyone", el("span", { class: "status-tally-count" }, String(allDocs.length))]));
  
  const unassignedCount = allDocs.filter(d => !d.member_name).length;
  if (unassignedCount > 0) {
    patientPills.append(el("button", {
      class: "status-tally-btn" + (state.docFilter.memberId === "unassigned" ? " active" : ""),
      onclick: () => { state.docFilter.memberId = "unassigned"; state.docFilter.offset = 0; refreshTimeline(); }
    }, ["Unassigned", el("span", { class: "status-tally-count" }, String(unassignedCount))]));
  }
  
  state.members.forEach(m => {
    const count = allDocs.filter(d => d.member_id === m.id).length;
    patientPills.append(el("button", {
      class: "status-tally-btn" + (state.docFilter.memberId === String(m.id) ? " active" : ""),
      onclick: () => { state.docFilter.memberId = String(m.id); state.docFilter.offset = 0; refreshTimeline(); }
    }, [m.name, el("span", { class: "status-tally-count" }, String(count))]));
  });

  // Status Selector chips
  const statusPills = el("div", { class: "status-tallies", style: "margin-bottom: 16px; flex-wrap: wrap; gap: 8px;" });
  
  statusPills.append(el("button", {
    class: "status-tally-btn" + (state.docFilter.statusGroup === "all" ? " active" : ""),
    onclick: () => { state.docFilter.statusGroup = "all"; state.docFilter.offset = 0; refreshTimeline(); }
  }, ["All", el("span", { class: "status-tally-count" }, String(allDocs.length))]));
  
  const needsCount = allDocs.filter(d => ["needs_review", "partially_imported", "failed"].includes(d.status)).length;
  statusPills.append(el("button", {
    class: "status-tally-btn" + (state.docFilter.statusGroup === "needs_attention" ? " active" : ""),
    onclick: () => { state.docFilter.statusGroup = "needs_attention"; state.docFilter.offset = 0; refreshTimeline(); }
  }, ["Needs Attention", el("span", { class: "status-tally-count" }, String(needsCount))]));
  
  const doneCount = allDocs.filter(d => ["fully_imported", "reviewed"].includes(d.status)).length;
  statusPills.append(el("button", {
    class: "status-tally-btn" + (state.docFilter.statusGroup === "done" ? " active" : ""),
    onclick: () => { state.docFilter.statusGroup = "done"; state.docFilter.offset = 0; refreshTimeline(); }
  }, ["Done", el("span", { class: "status-tally-count" }, String(doneCount))]));

  // Search Box
  const searchInput = el("input", {
    type: "search",
    placeholder: "Search by file name or lab...",
    class: "doc-search-input",
    style: "flex: 1; margin: 0;",
    value: state.docFilter.search,
    oninput: (e) => {
      state.docFilter.search = e.target.value;
      state.docFilter.offset = 0;
      refreshTimeline();
    }
  });

  const filterRow = el("div", { 
    style: "display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px;" 
  }, [
    el("div", { style: "display: flex; gap: 12px; align-items: center;" }, [
      el("div", { class: "doc-search-box", style: "flex: 1; margin: 0;" }, searchInput)
    ]),
    patientPills,
    statusPills
  ]);
  main.append(filterRow);

  // 3. Timeline Layout
  const timelineContent = el("div", { class: "timeline-main-content" });
  const yearRail = el("div", { class: "year-jump-rail" });
  
  const layoutContainer = el("div", { class: "timeline-layout-container" }, [
    timelineContent,
    yearRail
  ]);
  main.append(layoutContainer);

  let loadedDocs = [];

  const refreshTimeline = async () => {
    timelineContent.innerHTML = "";
    yearRail.innerHTML = "";
    loadedDocs = [];
    state.docFilter.offset = 0;
    
    patientPills.querySelectorAll(".status-tally-btn").forEach(btn => btn.classList.remove("active"));
    const activePatientBtn = Array.from(patientPills.children).find(btn => {
      const text = btn.textContent.toLowerCase();
      if (state.docFilter.memberId === "") return text.includes("everyone");
      if (state.docFilter.memberId === "unassigned") return text.includes("unassigned");
      const member = state.members.find(m => m.id === Number(state.docFilter.memberId));
      return member && text.includes(member.name.toLowerCase());
    });
    if (activePatientBtn) activePatientBtn.classList.add("active");
    
    statusPills.querySelectorAll(".status-tally-btn").forEach(btn => btn.classList.remove("active"));
    const activeStatusBtn = Array.from(statusPills.children).find(btn => {
      const text = btn.textContent.toLowerCase();
      if (state.docFilter.statusGroup === "all") return text.includes("all");
      if (state.docFilter.statusGroup === "needs_attention") return text.includes("needs attention");
      if (state.docFilter.statusGroup === "done") return text.includes("done");
    });
    if (activeStatusBtn) activeStatusBtn.classList.add("active");
    
    await loadNextPage();
  };

  const loadNextPage = async () => {
    const spinner = el("div", { class: "empty", style: "padding: 20px 0;" }, [el("span", { class: "spinner" }), " Loading history…"]);
    timelineContent.append(spinner);
    
    try {
      const params = new URLSearchParams({
        limit: state.docFilter.limit,
        offset: state.docFilter.offset,
        search: state.docFilter.search,
        status_group: state.docFilter.statusGroup
      });
      if (state.docFilter.memberId) {
        params.append("member_id", state.docFilter.memberId);
      }
      
      const newDocs = await api(`/documents?${params.toString()}`);
      spinner.remove();
      
      if (newDocs.length === 0 && loadedDocs.length === 0) {
        timelineContent.append(el("div", { class: "empty" }, "No documents match the active filters."));
        return;
      }
      
      const existingBtn = timelineContent.querySelector(".btn-load-more");
      if (existingBtn) existingBtn.remove();
      
      loadedDocs.push(...newDocs);
      renderTimelineList();
      
      if (newDocs.length === state.docFilter.limit) {
        const loadMoreBtn = el("button", {
          class: "btn btn-primary btn-sm btn-load-more",
          style: "display: block; margin: 24px auto 0 auto;",
          onclick: () => {
            state.docFilter.offset += state.docFilter.limit;
            loadNextPage();
          }
        }, "Load More");
        timelineContent.append(loadMoreBtn);
      }
    } catch (e) {
      spinner.remove();
      timelineContent.append(el("div", { class: "warn" }, "Error loading documents: " + e.message));
    }
  };

  const renderTimelineList = () => {
    timelineContent.innerHTML = "";
    yearRail.innerHTML = "";
    
    const monthGroups = {};
    const yearsSet = new Set();
    
    loadedDocs.forEach(d => {
      const dateStr = d.report_date || d.created_at || "";
      let monthLabel = "Unknown Month";
      let yearLabel = "Unknown Year";
      
      if (dateStr) {
        try {
          const dateObj = new Date(dateStr);
          if (!isNaN(dateObj.getTime())) {
            monthLabel = dateObj.toLocaleString("default", { month: "long", year: "numeric" });
            yearLabel = String(dateObj.getFullYear());
            yearsSet.add(yearLabel);
          }
        } catch (e) {}
      }
      
      if (!monthGroups[monthLabel]) {
        monthGroups[monthLabel] = {
          label: monthLabel,
          year: yearLabel,
          docs: []
        };
      }
      monthGroups[monthLabel].docs.push(d);
    });
    
    const monthKeys = Object.keys(monthGroups).sort((a, b) => {
      if (a.includes("Unknown")) return 1;
      if (b.includes("Unknown")) return -1;
      const dateA = new Date(a);
      const dateB = new Date(b);
      return dateB.getTime() - dateA.getTime();
    });
    
    monthKeys.forEach(monthKey => {
      const group = monthGroups[monthKey];
      const monthId = `month-${group.label.replace(/\s+/g, "-")}`;
      
      timelineContent.append(el("div", { class: "timeline-month-header", id: monthId }, group.label));
      
      const cardsDiv = el("div", { class: "doc-timeline-cards" });
      group.docs.forEach(d => {
        const initialsStr = d.member_name ? d.member_name.trim().slice(0, 1).toUpperCase() : "?";
        const colorStr = d.member_name ? (state.members.find(m => m.id === d.member_id)?.color || "#5c554e") : "#a0a0a0";
        
        const statusTextMap = {
          "needs_review": "Needs review",
          "fully_imported": "Done",
          "partially_imported": "Needs review",
          "reviewed": "Reviewed",
          "failed": "Failed"
        };
        const pillClass = {
          "needs_review": "pill-amber",
          "partially_imported": "pill-amber",
          "failed": "pill-red",
          "fully_imported": "pill-green",
          "reviewed": "pill-grey"
        }[d.status] || "pill-amber";
        
        const card = el("div", { class: "doc-timeline-card", onclick: () => openReview(d) }, [
          el("div", { class: "doc-card-info" }, [
            el("div", { class: "doc-card-title" }, d.filename),
            el("div", { class: "doc-card-meta" }, [
              el("div", { class: "doc-card-meta-item" }, [
                el("span", { class: "avatar", style: `background:${colorStr}; width: 18px; height: 18px; font-size: 9px; line-height: 18px;` }, initialsStr),
                el("span", { style: "font-weight: 500;" }, d.member_name || "Unassigned")
              ]),
              el("div", { class: "doc-card-meta-item" }, [
                el("span", {}, "🧪"),
                el("span", {}, d.lab_name || "Unknown Lab")
              ]),
              el("div", { class: "doc-card-meta-item" }, [
                el("span", {}, "📅"),
                el("span", {}, fmtDate(d.report_date || d.created_at))
              ])
            ])
          ]),
          el("div", { class: "doc-card-actions" }, [
            el("span", { class: "doc-card-count" }, `${d.result_count || 0} results`),
            el("span", { class: "pill " + pillClass }, statusTextMap[d.status] || d.status)
          ])
        ]);
        
        cardsDiv.append(card);
      });
      timelineContent.append(cardsDiv);
    });
    
    const sortedYears = Array.from(yearsSet).sort((a, b) => b.localeCompare(a));
    if (sortedYears.length > 1) {
      sortedYears.forEach(year => {
        const matchingMonthKey = monthKeys.find(k => monthGroups[k].year === year);
        if (matchingMonthKey) {
          const monthId = `month-${matchingMonthKey.replace(/\s+/g, "-")}`;
          const yearBtn = el("button", {
            class: "year-jump-btn",
            onclick: () => {
              const targetHeader = document.getElementById(monthId);
              if (targetHeader) {
                targetHeader.scrollIntoView({ behavior: "smooth", block: "start" });
                yearRail.querySelectorAll(".year-jump-btn").forEach(btn => btn.classList.remove("active"));
                yearBtn.classList.add("active");
              }
            }
          }, year);
          yearRail.append(yearBtn);
        }
      });
    }
  };

  refreshTimeline();
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

  // Document Actions Panel
  const memberSel = el("select", { style: "width:auto; margin: 0;" });
  for (const m of state.members) {
    memberSel.append(el("option", { value: m.id, ...(m.id === (doc.member_id || state.activeMember) ? { selected: "" } : {}) }, m.name));
  }
  
  const reassignBtn = el("button", { 
    class: "btn btn-sm btn-primary", 
    style: "margin: 0;",
    onclick: async () => {
      const selectedId = Number(memberSel.value);
      if (selectedId === doc.member_id) return;
      const res = await api(`/documents/${doc.id}/reassign`, { method: "POST", body: { member_id: selectedId } });
      const to = state.members.find(m => m.id === selectedId);
      toast(`Moved ${res.moved} result${res.moved !== 1 ? "s" : ""} to ${to ? to.name : "member"}`);
      await loadCore();
      doc.member_id = selectedId;
      doc.member_name = to ? to.name : "";
    }
  }, "Reassign");
  
  const openFileBtn = el("a", { 
    class: "btn btn-sm", 
    href: `/api/documents/${doc.id}/file`, 
    target: "_blank",
    style: "display: inline-flex; align-items: center; gap: 4px;"
  }, [el("span", {}, "📄"), "Open Original File"]);
  
  const deleteBtn = el("button", { 
    class: "btn btn-sm btn-danger", 
    style: "display: inline-flex; align-items: center; gap: 4px; margin-left: auto;",
    onclick: async () => {
      const n = doc.result_count;
      const msg = n
        ? `Delete "${doc.filename}" and the ${n} result${n !== 1 ? "s" : ""} saved from it? This can't be undone.`
        : `Delete "${doc.filename}"? This can't be undone.`;
      if (!confirm(msg)) return;
      const res = await api(`/documents/${doc.id}`, { method: "DELETE" });
      toast(`Import deleted · ${res.deleted_results} result${res.deleted_results !== 1 ? "s" : ""} removed`);
      await loadCore();
      navigateTo("documents");
    }
  }, [el("span", {}, "🗑"), "Delete"]);
  
  const actionsPanel = el("div", { class: "document-actions-card" }, [
    el("div", { style: "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;" }, [
      el("span", { style: "font-weight: 600; font-size: 13.5px; color: var(--text-secondary);" }, "Family member:"),
      memberSel,
      reassignBtn
    ]),
    openFileBtn,
    deleteBtn
  ]);
  main.append(actionsPanel);

  const mount = el("div");
  const status = el("div", { style: "margin-bottom:14px" }, [el("span", { class: "spinner" }), " Loading extracted results…"]);
  main.append(status, mount);

  const showExtractButton = (msg, isErr = false) => {
    status.innerHTML = "";
    status.append(
      el("div", { class: isErr ? "warn" : "page-sub", style: "margin-bottom:12px;max-width:600px" }, msg),
      el("button", { class: "btn btn-primary", onclick: async () => {
        status.innerHTML = ""; status.append(el("span", {}, [el("span", { class: "spinner" }), " Extracting with AI… this can take ~20s"]));
        try {
          const result = await api(`/documents/${doc.id}/extract`, { method: "POST", body: {} });
          status.innerHTML = "";
          renderReview(mount, doc, () => Number(memberSel.value), result, main);
        } catch (e) {
          showExtractButton("Error: " + e.message, true);
        }
      } }, isErr ? "🔄 Retry extraction" : "Extract with AI"),
    );
  };

  try {
    const result = await api(`/documents/${doc.id}/extraction`);
    status.innerHTML = "";
    if (result && result.error) {
      showExtractButton("Extraction failed: " + result.error, true);
    } else {
      renderReview(mount, doc, () => Number(memberSel.value), result, main);
    }
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
    el("div", { class: "report-brand" }, "🩸 Rakta Charitra · Health summary"),
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

// ---------------- privacy: PIN + which profiles are private ----------------
async function renderPrivacyCard() {
  const card = el("div", { class: "card", style: "max-width:560px; margin-top:20px" });
  card.append(
    el("h3", { style: "margin-top:0" }, "Privacy"),
    el("p", { class: "modal-lead" },
      "Profiles are visible to everyone using this app by default — no PIN, no sign-in. " +
      "Mark a profile Private below to hide it until the PIN is entered on a device."),
  );

  const pinFields = (labelText, showConfirm) => {
    const pin = el("input", { type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "8", placeholder: "New PIN (4–8 digits)" });
    const confirm = showConfirm ? el("input", { type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "8", placeholder: "Confirm PIN" }) : null;
    const wrap = el("div", { class: "field" }, [el("label", {}, labelText), pin, confirm].filter(Boolean));
    return { wrap, pin, confirm };
  };

  if (!state.access.has_pin) {
    const { wrap, pin, confirm } = pinFields("Set a PIN to enable private profiles", true);
    card.append(wrap, el("button", { class: "btn btn-primary", onclick: async () => {
      if (pin.value !== confirm.value) return toast("PINs don't match");
      try {
        await api("/access/pin", { method: "PUT", body: { new_pin: pin.value } });
        // Set it, then unlock immediately with the same PIN so the person who
        // just created it isn't asked to retype it a second later.
        const res = await api("/unlock", { method: "POST", body: { pin: pin.value } });
        setUnlockToken(res.token);
        await loadCore(); render();
        toast("PIN set — you're unlocked on this device");
      } catch (e) { toast(e.message); }
    } }, "Set PIN"));
    return card;
  }

  if (!state.access.unlocked) {
    card.append(
      el("p", { class: "modal-lead" }, "Enter the PIN to change privacy settings on this device."),
      el("button", { class: "btn btn-primary", onclick: openUnlockModal }, "Enter PIN"),
    );
    return card;
  }

  // Unlocked: manage who's private, and change or remove the PIN.
  const list = el("div", { style: "display:flex; flex-direction:column; gap:2px; margin:14px 0 20px" });
  for (const m of state.members) {
    const cb = el("input", { type: "checkbox", ...(m.private ? { checked: "" } : {}) });
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        await api(`/members/${m.id}`, { method: "PUT", body: {
          name: m.name, dob: m.dob, sex: m.sex, color: m.color, private: cb.checked,
        } });
        await loadCore();
        toast(cb.checked ? `${m.name} is now private` : `${m.name} is now visible to everyone`);
      } catch (e) { cb.checked = !cb.checked; toast(e.message); }
      cb.disabled = false;
    });
    list.append(el("label", { class: "check-row", style: "padding:6px 2px" }, [cb, m.name]));
  }
  card.append(el("div", { class: "category-label", style: "margin-top:20px" }, "Private profiles"), list);

  const { wrap, pin, confirm } = pinFields("Change PIN", true);
  card.append(wrap, el("div", { class: "row", style: "gap:10px" }, [
    el("button", { class: "btn btn-primary", onclick: async () => {
      if (pin.value !== confirm.value) return toast("PINs don't match");
      try {
        await api("/access/pin", { method: "PUT", body: { new_pin: pin.value } });
        const res = await api("/unlock", { method: "POST", body: { pin: pin.value } });
        setUnlockToken(res.token);
        await loadCore(); render();
        toast("PIN changed");
      } catch (e) { toast(e.message); }
    } }, "Change PIN"),
    el("button", { class: "btn btn-quiet", onclick: async () => {
      // window.confirm, not the local `confirm` PIN-confirmation input above.
      if (!window.confirm("Remove the PIN? Every profile becomes visible to everyone, on every device.")) return;
      await api("/access/pin", { method: "PUT", body: { new_pin: "" } });
      setUnlockToken(null);
      await loadCore(); render();
      toast("PIN removed — everyone is public again");
    } }, "Remove PIN"),
  ]));
  return card;
}

// ---------------- settings ----------------
// Persistent categorization work queue: every test still sitting in "Other",
// each assignable by hand from a dropdown or via an AI suggestion the user
// accepts. Unlike the old modal, this stays on the page and shrinks as you
// resolve rows, so there's an obvious place to "review these".
function buildCategorizationQueue(categories, onChange) {
  const wrap = el("div");
  const pending = state.testTypes
    .filter((t) => !t.category || t.category === "Other")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!pending.length) {
    wrap.append(el("p", { class: "page-sub" }, "✓ Every test is assigned to a panel — nothing to review."));
    return wrap;
  }

  wrap.append(el("p", { class: "page-sub", style: "margin-bottom:14px" },
    `${pending.length} test${pending.length !== 1 ? "s" : ""} still in “Other”. Assign each to a panel, or let AI suggest — then accept.`));

  const rows = [];
  const tbody = el("tbody");

  const removeRow = (r) => {
    r.tr.remove();
    rows.splice(rows.indexOf(r), 1);
    if (!rows.length) wrap.querySelector(".cq-table")?.replaceWith(
      el("p", { class: "page-sub" }, "✓ All done — every test is now assigned."));
    onChange && onChange();
  };

  for (const t of pending) {
    const sel = el("select", { style: "min-width:150px" });
    for (const c of categories) sel.append(el("option", { value: c, ...(c === "Other" ? { selected: "" } : {}) }, c));

    const saveBtn = el("button", { class: "btn btn-sm btn-primary", onclick: async () => {
      if (sel.value === "Other") return toast("Pick a panel other than Other");
      saveBtn.disabled = true;
      try {
        await api("/test-types/override-category", { method: "POST", body: { test_type_id: t.id, category: sel.value } });
        const local = state.testTypes.find((x) => x.id === t.id); if (local) local.category = sel.value;
        toast(`${t.name} → ${sel.value}`);
        removeRow(r);
      } catch (e) { toast("Failed: " + e.message); saveBtn.disabled = false; }
    } }, "Save");

    const suggestedTag = el("span", { class: "pill pill-muted", style: "display:none" });
    const tr = el("tr", {}, [
      el("td", {}, [el("div", { style: "font-weight:600" }, t.name), suggestedTag]),
      el("td", {}, sel),
      el("td", { style: "text-align:right" }, saveBtn),
    ]);
    tbody.append(tr);
    const r = { t, sel, tr, suggestedTag };
    rows.push(r);
  }

  const table = el("table", { class: "diff-table cq-table" }, [
    el("thead", {}, el("tr", {}, [el("th", {}, "Test"), el("th", {}, "Panel"), el("th", {}, "")])),
    tbody,
  ]);

  // AI suggest-all: fills each dropdown with a suggestion and flags it, so the
  // human still confirms every row (per the "no silent reclassify" rule).
  const suggestBtn = el("button", { class: "btn", style: "margin-bottom:14px", onclick: async () => {
    suggestBtn.disabled = true; suggestBtn.textContent = "Asking AI…";
    try {
      const res = await api("/test-types/batch-categorize", { method: "POST", body: { test_names: rows.map((r) => r.t.name) } });
      let n = 0;
      for (const s of (res.suggestions || [])) {
        const r = rows.find((x) => x.t.name === s.test_name);
        if (r && categories.includes(s.category) && s.category !== "Other") {
          r.sel.value = s.category;
          r.suggestedTag.textContent = "AI suggests " + s.category;
          r.suggestedTag.style.display = "";
          r.tr.style.background = "var(--accent-soft)";
          n++;
        }
      }
      toast(n ? `AI suggested ${n} — review and Save each, or Accept all` : "AI had no suggestions");
      if (n) acceptAllBtn.style.display = "";
    } catch (e) { toast("AI categorization failed: " + e.message); }
    suggestBtn.disabled = false; suggestBtn.textContent = "🤖 Suggest all with AI";
  } }, "🤖 Suggest all with AI");

  const acceptAllBtn = el("button", { class: "btn btn-primary", style: "margin:14px 0 0; display:none", onclick: async () => {
    acceptAllBtn.disabled = true;
    const toApply = rows.filter((r) => r.sel.value !== "Other");
    for (const r of [...toApply]) {
      try {
        await api("/test-types/override-category", { method: "POST", body: { test_type_id: r.t.id, category: r.sel.value } });
        const local = state.testTypes.find((x) => x.id === r.t.id); if (local) local.category = r.sel.value;
        removeRow(r);
      } catch (e) { toast("Failed on " + r.t.name + ": " + e.message); }
    }
    toast(`Categorized ${toApply.length} test${toApply.length !== 1 ? "s" : ""}`);
    acceptAllBtn.disabled = false;
  } }, "Accept all suggestions");

  wrap.append(suggestBtn, table, acceptAllBtn);
  return wrap;
}

async function renderSettings(main) {
  main.innerHTML = "";
  document.querySelectorAll('[data-view="settings"]').forEach((b) => b.classList.add("active"));
  const s = await api("/settings");
  const categories = (await api("/categories").catch(() => ({ categories: [] }))).categories || [];
  main.append(el("div", { class: "page-head" }, el("div", {}, [
    el("h1", { class: "page-title" }, "Settings"),
    el("p", { class: "page-sub" }, "Configure AI providers, system prompts, and privacy settings."),
  ])));

  // 1. AI Configuration Collapsible
  const aiConfigContent = el("div");
  
  const providerSel = el("select");
  const activeProvider = s.ai_provider || (s.has_key_gemini ? "gemini" : (s.has_key_openai ? "openai" : "anthropic"));
  for (const p of ["anthropic", "openai", "gemini"]) {
    providerSel.append(el("option", { value: p, ...(activeProvider === p ? { selected: "" } : {}) }, p[0].toUpperCase() + p.slice(1)));
  }

  const fields = {};
  const mk = (label, key, ph, isSet) => {
    const inp = el("input", { type: "text", placeholder: ph });
    fields[key] = inp;
    
    const statusText = isSet ? "Set" : "Not Set";
    const statusClass = isSet ? "pill-ok" : "pill-L";
    
    return el("div", { class: "field" }, [
      el("div", { style: "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;" }, [
        el("label", { style: "margin: 0;" }, label),
        el("span", { class: "pill " + statusClass, style: "font-size: 11px; padding: 2px 6px;" }, statusText)
      ]),
      inp
    ]);
  };

  aiConfigContent.append(
    el("div", { class: "field" }, [el("label", {}, "Active provider"), providerSel]),
    el("div", { class: "category-label", style: "margin-top:20px" }, "API Keys"),
    mk("Anthropic key", "ai_key_anthropic", s.has_key_anthropic ? "•••••• (leave blank to keep)" : "sk-ant-...", s.has_key_anthropic),
    mk("OpenAI key", "ai_key_openai", s.has_key_openai ? "•••••• (leave blank to keep)" : "sk-...", s.has_key_openai),
    mk("Gemini key", "ai_key_gemini", s.has_key_gemini ? "•••••• (leave blank to keep)" : "AIza...", s.has_key_gemini),
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
    } }, "Save settings")
  );

  if (s.commit_sha) {
    aiConfigContent.append(
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

  // 2. AI System Prompts Collapsible
  const promptsContent = el("div");
  const promptsFields = {};
  const mkPrompt = (label, key, value) => {
    const ta = el("textarea", { 
      style: "width: 100%; height: 160px; font-family: monospace; font-size: 13px; line-height: 1.5; background: var(--panel-2); margin-top: 4px;", 
      placeholder: "System prompt..." 
    });
    ta.value = value || "";
    promptsFields[key] = ta;
    return el("div", { class: "field", style: "margin-bottom:16px;" }, [
      el("label", { style: "font-weight:700;" }, label), 
      ta
    ]);
  };

  const savePromptsBtn = el("button", { class: "btn btn-primary", onclick: async () => {
    savePromptsBtn.disabled = true;
    try {
      const body = {};
      for (const [k, ta] of Object.entries(promptsFields)) {
        body[k] = ta.value;
      }
      await api("/settings", { method: "PUT", body });
      toast("AI Prompts saved");
      render();
    } catch (e) {
      toast(e.message);
    } finally {
      savePromptsBtn.disabled = false;
    }
  } }, "Save prompts");

  const resetPromptsBtn = el("button", { class: "btn btn-quiet", style: "margin-left: 8px;", onclick: async () => {
    if (!window.confirm("Reset all prompts to system defaults? Any custom modifications will be lost.")) return;
    resetPromptsBtn.disabled = true;
    try {
      const defaults = await api("/settings/defaults");
      for (const [k, value] of Object.entries(defaults)) {
        if (promptsFields[k]) {
          promptsFields[k].value = value;
        }
      }
      toast("Prompts reset to defaults (click Save prompts to write to database)");
    } catch (e) {
      toast("Failed to reset prompts: " + e.message);
    } finally {
      resetPromptsBtn.disabled = false;
    }
  } }, "Reset to Defaults");

  promptsContent.append(
    mkPrompt("Document Extraction Prompt", "prompt_extraction_system", s.prompt_extraction_system),
    mkPrompt("AI Q&A Assistant Prompt", "prompt_qa_system", s.prompt_qa_system),
    mkPrompt("Biomarker Explanation (Personalized)", "prompt_biomarker_personalized", s.prompt_biomarker_personalized),
    mkPrompt("Biomarker Explanation (Standard)", "prompt_biomarker_standard", s.prompt_biomarker_standard),
    mkPrompt("Full Health Analysis", "prompt_health_analysis", s.prompt_health_analysis),
    el("div", { style: "display: flex;" }, [savePromptsBtn, resetPromptsBtn])
  );

  // 3. Privacy & Security Collapsible
  const privacyContent = el("div");
  // We can just construct it, but to keep existing renderPrivacyCard intact, we append the generated card's children directly to privacyContent!
  const privacyCard = await renderPrivacyCard();
  while (privacyCard.firstChild) {
    privacyContent.appendChild(privacyCard.firstChild);
  }

  // 4. Categorization Queue — the admin work queue for tests still in "Other".
  const pendingCount = state.testTypes.filter((t) => !t.category || t.category === "Other").length;
  const queueContent = buildCategorizationQueue(categories);

  // Wrap all sections in collapsible panels. The queue opens automatically and
  // shows its backlog count in the header, so there's an obvious place to work.
  const aiSection = createCollapsible("AI Provider & Key Configuration", 1, aiConfigContent, true);
  const promptsSection = createCollapsible("AI System Prompts", 4, promptsContent, false);
  const privacySection = createCollapsible("Privacy & Security", state.access.has_pin ? "Protected" : "Public", privacyContent, false);
  const queueSection = createCollapsible("Categorization Queue", pendingCount === 0 ? "Clear" : pendingCount, queueContent, pendingCount > 0);

  main.append(aiSection, promptsSection, privacySection, queueSection);

  // PWA Add to Home Screen card
  if (window.deferredPrompt) {
    const installCard = el("div", { class: "card", style: "max-width:560px; margin-top:20px; border-left:5px solid var(--accent); background:var(--accent-soft)" }, [
      el("div", { class: "hh-name" }, "✨ Install Rakta Charitra"),
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
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => { if (b.dataset.view) navigateTo(b.dataset.view); }));
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
  toast("Rakta Charitra added to Home Screen successfully!");
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

loadCore().then(() => {
  handleInitialHash();
  render();
}).catch((e) => {
  $("#main").append(el("div", { class: "empty" }, "Failed to load: " + e.message));
});
