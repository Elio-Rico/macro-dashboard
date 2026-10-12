import {
  lineChart, legend, seriesTable, sparkline, barList, stackedBars, rectLegend, stackedColumns, stackLegend,
  fmt, fmtSigned, fmtPeriod, htmlEl,
} from "./charts.js";

const MAX_SELECTED = 8;
const RANGES = { "1Y": 1, "3Y": 3, "5Y": 5, "10Y": 10, Max: Infinity };
const FX_BASES = ["CHF", "EUR", "USD", "GBP", "JPY"];
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "growth", label: "Growth & prices" },
  { id: "fiscal", label: "Public finances" },
  { id: "swissdebt", label: "Swiss debt" },
  { id: "debt", label: "Debt by sector" },
  { id: "housing", label: "Housing" },
  { id: "trade", label: "Foreign trade" },
  { id: "fx", label: "Exchange rates" },
  { id: "sources", label: "Sources & notes" },
];
const SOURCE_TEXT = {
  imf: "IMF World Economic Outlook",
  imf_fm: "IMF Fiscal Monitor",
  oecd_qna: "OECD Quarterly National Accounts (seasonally adjusted volumes)",
  bis_cpi: "BIS consumer prices",
  bis_cbpol: "BIS central bank policy rates",
  bis_eer: "BIS effective exchange rates",
  eurostat: "Eurostat quarterly government finance statistics",
  bis_credit: "BIS total credit statistics",
  eurostat_silc: "Eurostat, EU statistics on income and living conditions (EU-SILC)",
  comtrade: "UN Comtrade (reported by national customs), converted at ECB annual average rates",
  efv: "Federal Finance Administration (FFA), government finance statistics",
};

const state = {
  selected: [],
  slots: {},
  focus: "CHE",
  range: "10Y",
  tab: "overview",
  base: "CHF",
  gold: "excl",
  debtUnit: "gdp",
  reporter: null,
  sort: { key: null, dir: -1 },
  tableView: new Set(),
};

let META = null;
const DATA = {};
const IND = {};
const COUNTRY = {};
let observers = [];

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- theme

function themeMode() {
  try {
    const m = parseInt(localStorage.getItem("wcTheme") ?? "2", 10);
    return [0, 1, 2].includes(m) ? m : 2;
  } catch {
    return 2;
  }
}

function applyTheme() {
  const mode = themeMode();
  const root = document.documentElement;
  if (mode === 0) root.dataset.theme = "light";
  else if (mode === 1) root.dataset.theme = "dark";
  else delete root.dataset.theme;
  $("theme-btn").textContent = "Theme: " + ["Light", "Dark", "Auto"][mode];
}

// Shares the key with the main website's day/night switch (Wowchemy): 0 light, 1 dark, 2 auto.
function cycleTheme() {
  try {
    localStorage.setItem("wcTheme", String((themeMode() + 1) % 3));
  } catch {
    /* storage unavailable: theme still follows the OS */
  }
  applyTheme();
}

// ---------------------------------------------------------------- URL state

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const valid = (id) => COUNTRY[id] != null;
  const c = (p.get("c") || "").split(",").filter(valid).slice(0, MAX_SELECTED);
  const def = META.groups.find((g) => g.id === "default");
  state.selected = c.length ? c : (def ? def.members : META.countries.slice(0, 6).map((x) => x.id));
  if (valid(p.get("f"))) state.focus = p.get("f");
  if (RANGES[p.get("r")] != null) state.range = p.get("r");
  if (TABS.some((t) => t.id === p.get("tab"))) state.tab = p.get("tab");
  if (FX_BASES.includes(p.get("b"))) state.base = p.get("b");
  if (["excl", "incl"].includes(p.get("g"))) state.gold = p.get("g");
  if (["gdp", "chf"].includes(p.get("u"))) state.debtUnit = p.get("u");
  ensureSlots();
}

function writeHash() {
  const p = new URLSearchParams({
    tab: state.tab,
    // Slot order, so a shared or reloaded link reproduces the same colours.
    c: [...state.selected].sort((a, b) => state.slots[a] - state.slots[b]).join(","),
    f: state.focus,
    r: state.range,
    b: state.base,
    g: state.gold,
    u: state.debtUnit,
  });
  history.replaceState(null, "", "#" + p.toString().replace(/%2C/g, ","));
}

// Colour follows the country: a country keeps its slot while selected; new countries take
// the lowest free slot. Removing a country never repaints the others.
function ensureSlots() {
  for (const id of Object.keys(state.slots)) if (!state.selected.includes(id)) delete state.slots[id];
  const used = new Set(Object.values(state.slots));
  for (const id of state.selected) {
    if (state.slots[id] != null) continue;
    let k = 0;
    while (used.has(k)) k++;
    state.slots[id] = k;
    used.add(k);
  }
}

const colorOf = (cid) => `var(--s${(state.slots[cid] ?? 0) + 1})`;
const nameOf = (cid) => COUNTRY[cid]?.name ?? cid;
const shortOf = (cid) => (nameOf(cid).length <= 11 ? nameOf(cid) : cid);

// ---------------------------------------------------------------- data access

const fileOf = (indId) => IND[indId]?.file;
const ds = (indId) => DATA[fileOf(indId)] ?? null;
const vals = (indId, cid) => ds(indId)?.series?.[indId]?.[cid] ?? null;

function latestObs(indId, cid) {
  const d = ds(indId);
  const v = vals(indId, cid);
  if (!d || !v) return null;
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i] != null) return { i, period: d.periods[i], value: v[i], values: v, periods: d.periods, freq: d.freq };
  }
  return null;
}

function imfYear() {
  const d = DATA["imf.json"];
  return d ? Number(d.projection_start) : new Date().getFullYear();
}

function yearValue(indId, cid, year) {
  const d = ds(indId);
  const v = vals(indId, cid);
  if (!d || !v) return null;
  const i = d.periods.indexOf(String(year));
  return i < 0 ? null : v[i];
}

function sourceText(indId) {
  const ind = IND[indId];
  if (!ind) return "";
  if (ind.source === "imf") return /_G01_/.test(ind.code) ? SOURCE_TEXT.imf_fm : SOURCE_TEXT.imf;
  return SOURCE_TEXT[ind.source] ?? ind.source;
}

// Euro-area members have no policy rate of their own: use the ECB rate.
function policyCountry(cid) {
  if (vals("policy_rate", cid)) return cid;
  if (COUNTRY[cid]?.currency === "EUR" && vals("policy_rate", "EMU")) return "EMU";
  return null;
}

function policyLatest(cid) {
  const pc = policyCountry(cid);
  if (!pc) return null;
  const daily = DATA["bis_monthly.json"]?.policy_rate_latest?.[pc];
  const monthly = latestObs("policy_rate", pc);
  return { pc, daily, monthly, viaEcb: pc !== cid };
}

// ---------------------------------------------------------------- time windows

function windowStart(freq, periods) {
  let years = RANGES[state.range];
  if (freq === "A") {
    if (years === Infinity) return 0;
    const y0 = imfYear() - Math.max(years, 8);
    const i = periods.findIndex((p) => Number(p) >= y0);
    return i < 0 ? 0 : i;
  }
  if (years === Infinity) return 0;
  if (freq === "Q") years = Math.max(years, 3);
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const cut =
    freq === "Q" ? `${y}-Q${Math.ceil(m / 3)}` :
    freq === "M" ? `${y}-${String(m).padStart(2, "0")}` :
    d.toISOString().slice(0, 10);
  const i = periods.findIndex((p) => p >= cut);
  return i < 0 ? 0 : i;
}

// Cut to the window and drop leading/trailing periods where every series is empty.
function sliceSeries(periods, series, start) {
  let s = start;
  let e = periods.length - 1;
  while (s <= e && series.every((x) => x.values[s] == null)) s++;
  while (e >= s && series.every((x) => x.values[e] == null)) e--;
  return {
    periods: periods.slice(s, e + 1),
    series: series.map((x) => ({ ...x, values: x.values.slice(s, e + 1) })),
    offset: s,
  };
}

// ---------------------------------------------------------------- cards

function card(parent, { title, sub, source, wide = false, build, tableOnly = false }) {
  const c = htmlEl("section", "card", parent);
  if (wide) c.style.gridColumn = "1 / -1";
  const head = htmlEl("div", "card-head", c);
  const t = htmlEl("div", null, head);
  htmlEl("h3", null, t, title);
  if (sub) htmlEl("p", "sub", t, sub);
  const body = htmlEl("div", null, c);
  if (source) htmlEl("div", "src", c, "Source: " + source);

  let mode = tableOnly || state.tableView.has(title) ? "table" : "chart";
  let btn = null;
  if (!tableOnly) {
    btn = htmlEl("button", "icon-btn view-toggle", head);
    btn.type = "button";
    btn.addEventListener("click", () => {
      mode = mode === "chart" ? "table" : "chart";
      if (mode === "table") state.tableView.add(title);
      else state.tableView.delete(title);
      render();
    });
  }
  const render = () => {
    body.innerHTML = "";
    if (btn) {
      btn.textContent = mode === "table" ? "Show chart" : "Show table";
      btn.setAttribute("aria-label", `${btn.textContent}: ${title}`);
    }
    build(body, mode);
  };
  render();

  let lastW = body.clientWidth;
  const ro = new ResizeObserver(() => {
    const w = body.clientWidth;
    if (Math.abs(w - lastW) > 4 && mode === "chart") {
      lastW = w;
      render();
    }
  });
  ro.observe(body);
  observers.push(ro);
  return c;
}

function chartBody(body, mode, { title, data, freq, decimals, includeZero, projectionStart, missing }) {
  if (!data.series.length || !data.periods.length) {
    htmlEl("div", "empty", body, "No data for the selected countries.");
    return;
  }
  if (mode === "table") {
    seriesTable(body, { ...data, freq, decimals, projectionStart });
  } else {
    const box = htmlEl("div", null, body);
    lineChart(box, {
      title,
      periods: data.periods,
      freq,
      series: data.series,
      decimals,
      includeZero,
      projectionStart,
      projectionLabel: "IMF projections",
    });
    legend(body, data.series);
  }
  if (missing && missing.length) htmlEl("div", "src", body, "Not available: " + missing.join(", "));
}

function indicatorCard(parent, indId, opts = {}) {
  const ind = IND[indId];
  const d = ds(indId);
  const title = opts.title ?? ind?.label ?? indId;
  if (!ind || !d) {
    card(parent, { title, tableOnly: true, build: (b) => htmlEl("div", "empty", b, "Data currently unavailable.") });
    return;
  }
  const countries = opts.countries ?? state.selected;
  const all = countries
    .map((cid) => ({ id: cid, label: nameOf(cid), short: shortOf(cid), color: colorOf(cid), values: vals(indId, cid) }))
    .filter((s) => s.values);
  const missing = countries.filter((cid) => !vals(indId, cid)).map(nameOf);
  const data = sliceSeries(d.periods, all, windowStart(d.freq, d.periods));
  const pIdx = d.projection_start ? d.periods.indexOf(d.projection_start) : -1;
  const projectionStart = pIdx >= 0 ? pIdx - data.offset : null;

  card(parent, {
    title,
    sub: opts.sub ?? unitLabel(ind),
    source: opts.source ?? sourceText(indId),
    build: (body, mode) =>
      chartBody(body, mode, {
        title,
        data,
        freq: d.freq,
        decimals: ind.decimals,
        includeZero: opts.includeZero,
        projectionStart,
        missing: opts.hideMissing ? null : missing,
      }),
  });
}

function unitLabel(ind) {
  const freqText = { A: "annual", Q: "quarterly", M: "monthly", D: "daily" }[ind.freq];
  return `${ind.unit}, ${freqText}`;
}

// ---------------------------------------------------------------- filters

function renderFilters() {
  const root = $("filters");
  root.innerHTML = "";
  // The trade and Swiss debt tabs have their own entities and colours; showing the country
  // chips there would suggest a link (and colours) that does not exist.
  if (state.tab === "trade") {
    htmlEl("span", "filter-label", root, "Country selection and period do not apply to this tab");
    return;
  }
  if (state.tab === "swissdebt") {
    htmlEl("span", "filter-label", root, "Country selection does not apply to this tab");
    renderRangeFilter(root);
    return;
  }

  const countries = htmlEl("div", "chips", root);
  htmlEl("span", "filter-label", countries, "Countries");
  for (const cid of state.selected) {
    const chip = htmlEl("span", "chip", countries);
    const dot = htmlEl("span", "dot", chip);
    dot.style.background = colorOf(cid);
    chip.appendChild(document.createTextNode(nameOf(cid)));
    const x = htmlEl("button", null, chip, "×");
    x.type = "button";
    x.setAttribute("aria-label", "Remove " + nameOf(cid));
    x.disabled = state.selected.length <= 1;
    x.addEventListener("click", () => {
      state.selected = state.selected.filter((id) => id !== cid);
      update();
    });
  }

  const add = htmlEl("select", "select", countries);
  add.setAttribute("aria-label", "Add a country");
  const full = state.selected.length >= MAX_SELECTED;
  htmlEl("option", null, add, full ? `Max. ${MAX_SELECTED} countries` : "+ Add country").value = "";
  if (!full) {
    for (const c of META.countries) {
      if (state.selected.includes(c.id)) continue;
      htmlEl("option", null, add, c.name).value = c.id;
    }
  }
  add.disabled = full;
  add.addEventListener("change", () => {
    if (add.value) {
      state.selected = [...state.selected, add.value];
      update();
    }
  });

  const preset = htmlEl("select", "select", countries);
  preset.setAttribute("aria-label", "Choose a country preset");
  htmlEl("option", null, preset, "Presets").value = "";
  for (const g of META.groups) htmlEl("option", null, preset, g.label).value = g.id;
  preset.addEventListener("change", () => {
    const g = META.groups.find((x) => x.id === preset.value);
    if (g) {
      state.selected = [...g.members];
      update();
    }
  });

  renderRangeFilter(root);
}

function renderRangeFilter(root) {
  const range = htmlEl("div", "chips", root);
  htmlEl("span", "filter-label", range, "Period");
  const seg = htmlEl("div", "segmented", range);
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Time range");
  for (const r of Object.keys(RANGES)) {
    const b = htmlEl("button", null, seg, r);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.range === r));
    b.addEventListener("click", () => {
      state.range = r;
      update();
    });
  }
}

function renderTabs() {
  const nav = $("tabs");
  nav.innerHTML = "";
  for (const t of TABS) {
    const b = htmlEl("button", null, nav, t.label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(state.tab === t.id));
    b.addEventListener("click", () => {
      state.tab = t.id;
      update();
    });
  }
}

// ---------------------------------------------------------------- overview

function deltaText(obs, lag, unit, decimals = 1) {
  const j = obs.i - lag;
  if (j < 0 || obs.values[j] == null) return "";
  return `${fmtSigned(obs.value - obs.values[j], decimals)} ${unit} vs ${fmtPeriod(obs.periods[j], obs.freq)}`;
}

function fxPrice(ccy, base, i) {
  const r = DATA["ecb_fx.json"]?.rates;
  if (!r) return null;
  const rc = ccy === "EUR" ? 1 : r[ccy]?.[i];
  const rb = base === "EUR" ? 1 : r[base]?.[i];
  return rc == null || rb == null ? null : rb / rc;
}

function fxIndexAtOrBefore(date) {
  const p = DATA["ecb_fx.json"].periods;
  let lo = 0, hi = p.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function shiftDate(iso, { days = 0, months = 0, years = 0 }) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + years, d.getUTCMonth() + months, d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fxDecimals(v) {
  return v >= 100 ? 2 : v >= 10 ? 3 : 4;
}

function tilesFor(cid) {
  const tiles = [];
  const Y = imfYear();

  const g = latestObs("gdp_yoy", cid);
  if (g) {
    tiles.push({
      label: "Real GDP growth, y/y", value: fmt(g.value, 1), unit: "%",
      meta: fmtPeriod(g.period, "Q"), delta: deltaText(g, 1, "pp"),
      spark: g.values.slice(Math.max(0, g.i - 11), g.i + 1),
    });
  } else if (yearValue("gdp_growth_a", cid, Y) != null) {
    const v = vals("gdp_growth_a", cid);
    const i = ds("gdp_growth_a").periods.indexOf(String(Y));
    tiles.push({
      label: "Real GDP growth", value: fmt(v[i], 1), unit: "%",
      meta: `${Y}, IMF projection`, delta: "",
      spark: v.slice(Math.max(0, i - 11), i + 1),
    });
  }

  const p = latestObs("cpi_yoy", cid);
  if (p) {
    tiles.push({
      label: "Inflation, y/y", value: fmt(p.value, 1), unit: "%",
      meta: fmtPeriod(p.period, "M"), delta: deltaText(p, 1, "pp"),
      spark: p.values.slice(Math.max(0, p.i - 23), p.i + 1),
    });
  }

  const pol = policyLatest(cid);
  if (pol && pol.monthly) {
    const m = pol.monthly;
    const value = pol.daily ? pol.daily.value : m.value;
    const asOf = pol.daily ? fmtPeriod(pol.daily.date, "D") : fmtPeriod(m.period, "M");
    tiles.push({
      label: "Policy rate" + (pol.viaEcb ? " (ECB)" : ""), value: fmt(value, 2), unit: "%",
      meta: "as of " + asOf, delta: deltaText(m, 12, "pp", 2),
      spark: m.values.slice(Math.max(0, m.i - 35), m.i + 1),
    });
  }

  for (const [indId, label] of [["gov_debt", "Government gross debt"], ["gov_balance", "Government balance"]]) {
    const v = vals(indId, cid);
    if (!v) continue;
    const i = ds(indId).periods.indexOf(String(Y));
    if (i < 0 || v[i] == null) continue;
    tiles.push({
      label, value: fmt(v[i], 1), unit: "% of GDP",
      meta: `${Y}, IMF`,
      delta: v[i - 1] != null ? `${fmtSigned(v[i] - v[i - 1], 1)} pp vs ${Y - 1}` : "",
      spark: v.slice(Math.max(0, i - 11), i + 1),
    });
  }

  const fx = DATA["ecb_fx.json"];
  const ccy = COUNTRY[cid]?.currency;
  if (fx && ccy) {
    const [from, to] = ccy === "EUR" ? ["EUR", "USD"] : ["EUR", ccy];
    if (to === "EUR" || fx.rates[to]) {
      const last = fx.periods.length - 1;
      const now = fxPrice(from, to, last);
      const ago = fxIndexAtOrBefore(shiftDate(fx.periods[last], { years: -1 }));
      const prev = ago >= 0 ? fxPrice(from, to, ago) : null;
      const spark = [];
      for (let i = Math.max(0, ago); i <= last; i += 5) spark.push(fxPrice(from, to, i));
      tiles.push({
        label: `Exchange rate ${from}/${to}`, value: fmt(now, fxDecimals(now)), unit: "",
        meta: `${to} per ${from}, ${fmtPeriod(fx.periods[last], "D")}`,
        delta: prev ? `${fmtSigned(100 * (now / prev - 1), 1)}% vs 1 year ago` : "",
        spark,
      });
    }
  }
  return tiles;
}

function renderTiles(parent, tileData) {
  const tiles = htmlEl("div", "tiles", parent);
  const els = tileData.map((t) => {
    const el = htmlEl("div", "tile", tiles);
    htmlEl("div", "label", el, t.label);
    const v = htmlEl("div", "value", el, t.value);
    if (t.unit) htmlEl("span", "unit", v, t.unit);
    htmlEl("div", "meta", el, t.meta);
    if (t.delta) htmlEl("div", "delta", el, t.delta);
    return el;
  });
  // Sparklines need the laid-out tile width.
  tileData.forEach((t, k) => sparkline(els[k], t.spark));
}

const OVERVIEW_COLUMNS = (Y) => [
  { id: "gdp_yoy", label: "Real GDP", sub: "y/y, latest qtr", kind: "latest", dec: 1 },
  { id: "gdp_growth_a", label: "GDP growth", sub: `${Y}, IMF`, kind: "year", year: Y, dec: 1 },
  { id: "gdp_growth_a", key: "gdp_next", label: "GDP growth", sub: `${Y + 1}, IMF`, kind: "year", year: Y + 1, dec: 1 },
  { id: "cpi_yoy", label: "Inflation", sub: "y/y, latest", kind: "latest", dec: 1 },
  { id: "policy_rate", label: "Policy rate", sub: "latest", kind: "policy", dec: 2 },
  { id: "unemployment", label: "Unemploy&shy;ment", sub: `${Y}, IMF`, kind: "year", year: Y, dec: 1 },
  { id: "gov_debt", label: "Gov. debt", sub: `% GDP, ${Y}`, kind: "year", year: Y, dec: 1 },
  { id: "gov_balance", label: "Gov. balance", sub: `% GDP, ${Y}`, kind: "year", year: Y, dec: 1 },
  { id: "gov_primary_balance", label: "Primary bal.", sub: `% GDP, ${Y}`, kind: "year", year: Y, dec: 1 },
  { id: "current_account", label: "Current acc.", sub: `% GDP, ${Y}`, kind: "year", year: Y, dec: 1 },
  { id: "credit_pnfs", label: "Private debt", sub: "% GDP, latest", kind: "latest", dec: 0 },
];

function overviewCell(col, cid) {
  if (col.kind === "year") return { value: yearValue(col.id, cid, col.year), per: "" };
  if (col.kind === "policy") {
    const pol = policyLatest(cid);
    if (!pol || !pol.monthly) return { value: null, per: "" };
    return { value: pol.daily ? pol.daily.value : pol.monthly.value, per: pol.viaEcb ? "ECB" : "" };
  }
  const o = latestObs(col.id, cid);
  return o ? { value: o.value, per: fmtPeriod(o.period, o.freq, true) } : { value: null, per: "" };
}

function renderOverview(panel) {
  const head = htmlEl("div", "panel-head", panel);
  htmlEl("h2", null, head, "At a glance");
  const controls = htmlEl("div", "controls", head);
  htmlEl("label", "filter-label", controls, "Focus").htmlFor = "focus-select";
  const sel = htmlEl("select", "select", controls);
  sel.id = "focus-select";
  for (const c of META.countries) {
    const o = htmlEl("option", null, sel, c.name);
    o.value = c.id;
    o.selected = c.id === state.focus;
  }
  sel.addEventListener("change", () => {
    state.focus = sel.value;
    update();
  });

  renderTiles(panel, tilesFor(state.focus));

  const Y = imfYear();
  const cols = OVERVIEW_COLUMNS(Y);
  const grid = htmlEl("div", "grid", panel);
  card(grid, {
    title: "Country comparison",
    sub: `Latest observations and IMF figures for ${Y} (from ${Y} onwards IMF figures are projections). Click a column to sort.`,
    source: "OECD, BIS, IMF World Economic Outlook and Fiscal Monitor",
    wide: true,
    tableOnly: true,
    build: (body) => {
      const rows = state.selected.map((cid) => ({ cid, cells: cols.map((c) => overviewCell(c, cid)) }));
      const { key, dir } = state.sort;
      if (key != null) {
        const k = cols.findIndex((c) => (c.key ?? c.id) === key);
        rows.sort((a, b) => {
          if (k < 0) return dir * nameOf(a.cid).localeCompare(nameOf(b.cid));
          const va = a.cells[k].value, vb = b.cells[k].value;
          if (va == null) return 1;
          if (vb == null) return -1;
          return dir * (va - vb);
        });
      }
      const wrap = htmlEl("div", "table-wrap", body);
      const table = htmlEl("table", "data", wrap);
      const tr = htmlEl("tr", null, htmlEl("thead", null, table));
      const sortHeader = (th, k) => {
        th.className = "sortable";
        th.tabIndex = 0;
        const go = () => {
          state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 };
          update();
        };
        th.addEventListener("click", go);
        th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        if (state.sort.key === k) th.setAttribute("aria-sort", state.sort.dir < 0 ? "descending" : "ascending");
      };
      const th0 = htmlEl("th", null, tr, "Country");
      sortHeader(th0, "country");
      for (const c of cols) {
        const th = htmlEl("th", null, tr);
        th.innerHTML = c.label; // static labels defined above (may contain a soft hyphen)
        htmlEl("span", "th-sub", th, c.sub);
        sortHeader(th, c.key ?? c.id);
      }
      const tbody = htmlEl("tbody", null, table);
      for (const r of rows) {
        const row = htmlEl("tr", null, tbody);
        const td0 = htmlEl("td", null, row);
        const lab = htmlEl("span", "country", td0);
        htmlEl("span", "dot", lab).style.background = colorOf(r.cid);
        lab.appendChild(document.createTextNode(nameOf(r.cid)));
        r.cells.forEach((cell, k) => {
          const td = htmlEl("td", cell.value == null ? "na" : null, row, fmt(cell.value, cols[k].dec));
          if (cell.per) htmlEl("span", "per", td, cell.per);
        });
      }
    },
  });
}

// ---------------------------------------------------------------- growth & prices

function policyCard(parent) {
  const d = ds("policy_rate");
  const title = "Central bank policy rates";
  if (!d) return indicatorCard(parent, "policy_rate", { title });
  // Euro-area members share the ECB rate: show it once, coloured by the first euro country selected.
  const seen = new Set();
  const all = [];
  for (const cid of state.selected) {
    const pc = policyCountry(cid);
    if (!pc || seen.has(pc)) continue;
    seen.add(pc);
    const label = pc === cid ? nameOf(cid) : "Euro area (ECB)";
    all.push({ id: pc, label, short: pc === "EMU" ? "ECB" : shortOf(pc), color: colorOf(cid), values: vals("policy_rate", pc) });
  }
  const data = sliceSeries(d.periods, all, windowStart(d.freq, d.periods));
  card(parent, {
    title,
    sub: "%, end of month; euro-area members share the ECB rate (deposit facility rate since Sep 2024, MRO rate before)",
    source: SOURCE_TEXT.bis_cbpol,
    build: (body, mode) => chartBody(body, mode, { title, data, freq: d.freq, decimals: 2, includeZero: true }),
  });
}

function renderGrowth(panel) {
  htmlEl("p", "note", panel,
    `Quarterly GDP growth is computed from seasonally adjusted real GDP. Annual IMF figures from ${imfYear()} onwards are projections (shaded).`);
  const grid = htmlEl("div", "grid", panel);
  indicatorCard(grid, "gdp_yoy", { includeZero: true });
  indicatorCard(grid, "gdp_growth_a", { title: "Real GDP growth, annual", includeZero: true });
  indicatorCard(grid, "cpi_yoy", { includeZero: true });
  indicatorCard(grid, "inflation_a", { title: "Inflation, annual average", includeZero: true });
  policyCard(grid);
  indicatorCard(grid, "unemployment", { includeZero: true });
  indicatorCard(grid, "current_account", { includeZero: true });
  indicatorCard(grid, "gdp_qoq", { includeZero: true });
}

// ---------------------------------------------------------------- public finances

function renderFiscal(panel) {
  htmlEl("p", "note", panel,
    `Annual figures are IMF estimates and projections (from ${imfYear()} onwards, shaded), on a general government basis. ` +
    "Quarterly figures are Eurostat (Maastricht definitions) and cover EU and EEA countries only.");
  const grid = htmlEl("div", "grid", panel);
  indicatorCard(grid, "gov_debt", { includeZero: true });
  indicatorCard(grid, "gov_balance", { includeZero: true });
  indicatorCard(grid, "gov_primary_balance", { includeZero: true });
  indicatorCard(grid, "gov_ca_primary_balance", { includeZero: true });
  indicatorCard(grid, "gov_revenue", { includeZero: true });
  indicatorCard(grid, "gov_expenditure", { includeZero: true });
  indicatorCard(grid, "gov_net_debt", { includeZero: true });
  indicatorCard(grid, "gov_debt_q", { includeZero: true });
  indicatorCard(grid, "gov_balance_q", { includeZero: true });
}

// ---------------------------------------------------------------- debt by sector

function renderDebt(panel) {
  htmlEl("p", "note", panel,
    "Credit from all lenders to each borrowing sector, in % of GDP (BIS total credit statistics). " +
    "Private sectors at market value, government at nominal value.");
  const grid = htmlEl("div", "grid", panel);

  const sectors = [
    ["credit_hh", "Households"],
    ["credit_nfc", "Non-fin. corporations"],
    ["credit_gov", "Government"],
  ];
  card(grid, {
    title: "Debt by sector, latest quarter",
    sub: "% of GDP. Bars compare countries within each column.",
    source: SOURCE_TEXT.bis_credit,
    wide: true,
    tableOnly: true,
    build: (body) => {
      const rows = state.selected.map((cid) => {
        const cells = sectors.map(([id]) => latestObs(id, cid));
        const total = cells.every(Boolean) ? cells.reduce((s, o) => s + o.value, 0) : null;
        const per = cells.find(Boolean)?.period;
        return { cid, cells: cells.map((o) => o?.value ?? null), total, per };
      });
      const cols = [...sectors.map((s) => s[1]), "Total"];
      const colMax = cols.map((_, k) => Math.max(1, ...rows.map((r) => (k < 3 ? r.cells[k] : r.total) ?? 0)));
      const wrap = htmlEl("div", "table-wrap", body);
      const table = htmlEl("table", "data", wrap);
      const tr = htmlEl("tr", null, htmlEl("thead", null, table));
      htmlEl("th", null, tr, "Country");
      for (const c of cols) htmlEl("th", null, tr, c);
      const tbody = htmlEl("tbody", null, table);
      for (const r of rows) {
        const row = htmlEl("tr", null, tbody);
        const td0 = htmlEl("td", null, row);
        const lab = htmlEl("span", "country", td0);
        htmlEl("span", "dot", lab).style.background = colorOf(r.cid);
        lab.appendChild(document.createTextNode(nameOf(r.cid)));
        if (r.per) htmlEl("span", "per", td0, fmtPeriod(r.per, "Q"));
        [...r.cells, r.total].forEach((v, k) => {
          const td = htmlEl("td", v == null ? "na" : null, row);
          const cell = htmlEl("div", "bar-cell", td);
          const track = htmlEl("div", "bar-track", cell);
          if (v != null) htmlEl("div", "bar-fill", track).style.width = `${(100 * v) / colMax[k]}%`;
          htmlEl("span", "bar-val", cell, fmt(v, 0));
        });
      }
    },
  });

  indicatorCard(grid, "credit_hh", { includeZero: true });
  indicatorCard(grid, "credit_nfc", { includeZero: true });
  indicatorCard(grid, "credit_gov", { includeZero: true });
  indicatorCard(grid, "credit_pnfs", { includeZero: true });
}

// ---------------------------------------------------------------- Swiss debt (FFA)

// Each debt instrument keeps one colour in every chart; financial-asset positions (drawn
// below zero in the net debt charts) use a lighter tint of the same hue.
const INSTRUMENT_COLOR = {
  1: "var(--s7)", 2: "var(--s4)", 3: "var(--s1)", 4: "var(--s2)", 6: "var(--s5)", 8: "var(--s3)", other: "var(--bar)",
};
// Subsector lines (validated as a set, all pairs): general government in ink, social
// security (close to zero) in neutral grey.
const SECTOR_COLOR = { staat: "var(--ink)", bund: "var(--s7)", ktn: "var(--s6)", gdn: "var(--s5)", sv: "var(--muted)" };

function componentColor(c) {
  const base = INSTRUMENT_COLOR[c.instrument] ?? "var(--bar)";
  return c.side === "A" ? `color-mix(in srgb, ${base} 50%, var(--surface))` : base;
}

function renderSwissDebt(panel) {
  const D = DATA["swiss_debt.json"];
  const head = htmlEl("div", "panel-head", panel);
  htmlEl("h2", null, head, "Swiss public debt");
  if (!D) {
    htmlEl("div", "empty", panel, "Data currently unavailable.");
    return;
  }
  const controls = htmlEl("div", "controls", head);
  htmlEl("span", "filter-label", controls, "Unit");
  const seg = htmlEl("div", "segmented", controls);
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Unit");
  for (const [k, lab] of [["gdp", "% of GDP"], ["chf", "CHF bn"]]) {
    const b = htmlEl("button", null, seg, lab);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.debtUnit === k));
    b.addEventListener("click", () => { state.debtUnit = k; update(); });
  }

  const P = D.periods;
  const Y = Number(D.latest_period);
  const iY = P.indexOf(String(Y));
  const inGdp = state.debtUnit === "gdp";
  const unit = inGdp ? "% of GDP" : "CHF bn";
  const conv = (v, i) => (v == null ? null : inGdp ? (D.gdp[i] ? (100 * v) / D.gdp[i] : null) : v / 1000);
  const convAll = (arr) => arr.map((v, i) => conv(v, i));

  // Window: same period control as the other tabs, at least 8 years.
  const years = RANGES[state.range];
  const firstYear = years === Infinity ? Number(P[0]) : Y - Math.max(years, 8) + 1;
  const start = Math.max(0, P.indexOf(String(firstYear)));

  htmlEl("p", "note", panel,
    "Gross debt (IMF) = liabilities (GFS 630) excluding equity and investment fund shares (6305) and financial derivatives (6307). " +
    "Net debt (IMF) = gross debt minus financial assets (620) excluding equity (6205) and financial derivatives (6207). " +
    "Maastricht debt as published by the FFA, including its forecasts. General government is consolidated, so it is smaller than the sum of the subsectors. " +
    `Data from the FFA's GFS balance sheets up to ${Y}; GDP from the FFA.`);

  const staat = D.sectors.find((s) => s.id === "staat");
  const tiles = [];
  for (const [key, label] of [["gross", "Gross debt (IMF)"], ["net", "Net debt (IMF)"], ["maastricht", "Maastricht debt"]]) {
    const raw = key === "maastricht" ? staat.maastricht : staat[key].total;
    const v = convAll(raw);
    tiles.push({
      label: `${label}, general government`,
      value: fmt(v[iY], 1),
      unit: inGdp ? "% of GDP" : " CHF bn",
      meta: String(Y),
      delta: v[iY - 1] != null ? `${fmtSigned(v[iY] - v[iY - 1], 1)} ${inGdp ? "pp" : "CHF bn"} vs ${Y - 1}` : "",
      spark: v.slice(Math.max(0, iY - 11), iY + 1),
    });
  }
  renderTiles(panel, tiles);

  const grid = htmlEl("div", "grid", panel);

  // Summary table: the three measures for every subsector, latest year.
  card(grid, {
    title: `Debt by subsector, ${Y}`,
    sub: "CHF bn and % of GDP",
    source: SOURCE_TEXT.efv,
    wide: true,
    tableOnly: true,
    build: (body) => {
      const wrap = htmlEl("div", "table-wrap", body);
      const table = htmlEl("table", "data", wrap);
      const tr = htmlEl("tr", null, htmlEl("thead", null, table));
      htmlEl("th", null, tr, "Subsector");
      for (const h of ["Gross debt (IMF)", "Net debt (IMF)", "Maastricht debt"]) {
        for (const u of ["CHF bn", "% of GDP"]) {
          const th = htmlEl("th", null, tr, h);
          htmlEl("span", "th-sub", th, u);
        }
      }
      const tbody = htmlEl("tbody", null, table);
      for (const s of D.sectors) {
        const row = htmlEl("tr", null, tbody);
        const td0 = htmlEl("td", null, row);
        const lab = htmlEl("span", "country", td0);
        htmlEl("span", "dot", lab).style.background = SECTOR_COLOR[s.id];
        lab.appendChild(document.createTextNode(s.name));
        for (const raw of [s.gross.total[iY], s.net.total[iY], s.maastricht[iY]]) {
          htmlEl("td", raw == null ? "na" : null, row, fmt(raw == null ? null : raw / 1000, 1));
          htmlEl("td", raw == null ? "na" : null, row, fmt(raw == null || !D.gdp[iY] ? null : (100 * raw) / D.gdp[iY], 1));
        }
      }
    },
  });

  // Maastricht debt: one line per subsector, FFA forecasts shaded.
  const mSeries = D.sectors.map((s) => ({
    id: s.id, label: s.name, short: s.name, color: SECTOR_COLOR[s.id], values: convAll(s.maastricht),
  }));
  const mData = sliceSeries(P, mSeries, start);
  const pIdx = P.indexOf(D.projection_start);
  const mTitle = "Maastricht debt by subsector";
  card(grid, {
    title: mTitle,
    sub: `${unit}, annual; FFA forecasts from ${D.projection_start} (shaded)`,
    source: SOURCE_TEXT.efv,
    wide: true,
    build: (body, mode) => {
      if (mode === "table") {
        seriesTable(body, { ...mData, freq: "A", decimals: 1, projectionStart: pIdx - mData.offset });
        return;
      }
      lineChart(htmlEl("div", null, body), {
        title: mTitle, periods: mData.periods, freq: "A", series: mData.series, decimals: 1,
        includeZero: true, projectionStart: pIdx - mData.offset, projectionLabel: "FFA forecasts",
      });
      legend(body, mData.series);
    },
  });

  // Gross and net debt with their main components, one pair of charts per subsector.
  for (const s of D.sectors) {
    for (const [key, label] of [["gross", "Gross debt (IMF)"], ["net", "Net debt (IMF)"]]) {
      const m = s[key];
      const title = `${label}: ${s.name}`;
      const segments = m.components.map((c) => ({
        id: c.code,
        label: c.code === "other" ? c.label : `${c.label} (${c.code})`,
        color: componentColor(c),
        values: convAll(c.values),
      }));
      const total = { label: label.replace(" (IMF)", ""), values: convAll(m.total) };
      // Balance sheets end at the latest actual year.
      const cut = (arr) => arr.slice(start, iY + 1);
      const data = {
        periods: cut(P),
        segments: segments.map((g) => ({ ...g, values: cut(g.values) })),
        total: { ...total, values: cut(total.values) },
      };
      card(grid, {
        title,
        sub: `${unit}; the four largest positions in ${Y}, the rest aggregated` + (key === "net" ? "; financial assets below zero" : ""),
        source: SOURCE_TEXT.efv,
        build: (body, mode) => {
          if (mode === "table") {
            seriesTable(body, { periods: data.periods, freq: "A", decimals: 1, series: [data.total, ...data.segments] });
            return;
          }
          stackedColumns(htmlEl("div", null, body), { title, periods: data.periods, freq: "A", segments: data.segments, total: data.total, decimals: 1 });
          stackLegend(body, data.segments, data.total);
        },
      });
    }
  }
}

// ---------------------------------------------------------------- housing

const TENURE_SEGMENTS = [
  { key: "own_outright", label: "Owners without mortgage", color: "var(--own-outright)" },
  { key: "own_mortgage", label: "Owners with mortgage", color: "var(--own-mortgage)" },
  { key: "rent", label: "Tenants", color: "var(--bar)" },
];

function renderHousing(panel) {
  htmlEl("p", "note", panel,
    "Share of the population by tenure status of the dwelling they live in (EU statistics on income and living conditions). " +
    "Covers EU and EFTA countries, including Switzerland, and some candidate countries; the US, Japan and other economies are not included. " +
    "National statistics can define homeownership differently (e.g. the Swiss FSO counts households, not persons).");
  const grid = htmlEl("div", "grid", panel);
  const H = DATA["eurostat_housing.json"];

  card(grid, {
    title: "Homeownership in Europe",
    sub: "% of population, latest year available. Bars split the population by tenure; the number is the homeownership rate. " +
      `${nameOf(state.focus)} is highlighted (change it with Focus on the Overview tab).`,
    source: SOURCE_TEXT.eurostat_silc,
    wide: true,
    build: (body, mode) => {
      if (!H || !H.latest) {
        htmlEl("div", "empty", body, "Data currently unavailable.");
        return;
      }
      const maxYear = Math.max(...H.latest.map((r) => Number(r.year)));
      const label = (r) => r.name + (Number(r.year) < maxYear ? ` (${r.year})` : "");
      if (mode === "table") {
        const wrap = htmlEl("div", "table-wrap scroll", body);
        const table = htmlEl("table", "data", wrap);
        const tr = htmlEl("tr", null, htmlEl("thead", null, table));
        for (const h of ["Country", "Year", "Owners", "with mortgage", "without mortgage", "Tenants"]) htmlEl("th", null, tr, h);
        const tbody = htmlEl("tbody", null, table);
        for (const r of H.latest) {
          const row = htmlEl("tr", null, tbody);
          htmlEl("td", null, row, r.name);
          htmlEl("td", null, row, r.year);
          for (const v of [r.own, r.own_mortgage, r.own_outright, r.rent]) htmlEl("td", null, row, fmt(v, 1));
        }
        return;
      }
      rectLegend(body, TENURE_SEGMENTS);
      stackedBars(htmlEl("div", null, body), {
        segments: TENURE_SEGMENTS,
        totalText: (r) => fmt(r.total, 0) + "%",
        rows: H.latest.map((r) => ({
          label: label(r),
          values: r,
          total: r.own,
          emph: r.id != null && r.id === state.focus,
          ref: r.geo === "EU27_2020",
          tip: () => [
            `${r.name}, ${r.year}`,
            [fmt(r.own, 1) + "%", "Owners, total"],
            [fmt(r.own_outright, 1) + "%", "without mortgage", "var(--own-outright)"],
            [fmt(r.own_mortgage, 1) + "%", "with mortgage", "var(--own-mortgage)"],
            [fmt(r.rent, 1) + "%", "Tenants", "var(--bar)"],
          ],
        })),
      });
    },
  });

  indicatorCard(grid, "home_own", { title: "Homeownership rate over time", includeZero: true, sub: "% of population, annual" });
  indicatorCard(grid, "home_own_mortgage", { title: "Owners with a mortgage or housing loan", includeZero: true, sub: "% of population, annual" });
  indicatorCard(grid, "home_own_outright", { title: "Owners without a mortgage", includeZero: true, sub: "% of population, annual" });
  indicatorCard(grid, "credit_hh", { title: "Household debt", sub: "% of GDP, quarterly", includeZero: true });
}

// ---------------------------------------------------------------- foreign trade

const goldOut = () => state.gold === "excl";

// Values are USD million; gold (HS 7108) is stored separately so it can be taken out.
function tradeVal(entry, i, mode = state.gold) {
  const v = entry?.incl?.[i];
  if (v == null) return null;
  return mode === "excl" ? v - (entry.gold?.[i] ?? 0) : v;
}

function tradeTotal(flow, i, mode = state.gold) {
  const t = flow.total[i];
  if (t == null) return null;
  return mode === "excl" ? t - (flow.gold[i] ?? 0) : t;
}

function tradeRank(dict, i, n, mode, exclude = []) {
  return Object.entries(dict)
    .filter(([k]) => !exclude.includes(k))
    .map(([k, e]) => ({ key: k, e, v: tradeVal(e, i, mode) }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, n);
}

// Annual average price of one USD in the reporter's currency (ECB rates); falls back to USD.
function usdConverter(ccy, years) {
  const fx = DATA["ecb_fx.json"];
  if (!fx || !fx.rates.USD || (ccy !== "EUR" && !fx.rates[ccy])) return { ccy: "USD", rate: years.map(() => 1) };
  const rate = years.map((y) => {
    let sum = 0, n = 0;
    fx.periods.forEach((p, i) => {
      if (!p.startsWith(String(y))) return;
      const v = fxPrice("USD", ccy, i);
      if (v != null) { sum += v; n++; }
    });
    return n ? sum / n : null;
  });
  return { ccy, rate };
}

function tradeBarsCard(grid, { title, sub, dict, flow, i, conv, exclude = [], what }) {
  const total = tradeTotal(flow, i);
  const bn = (v) => (v == null || conv.rate[i] == null ? null : (v * conv.rate[i]) / 1000);
  const list = tradeRank(dict, i, 25, state.gold, exclude);
  card(grid, {
    title,
    sub,
    source: SOURCE_TEXT.comtrade,
    build: (body, mode) => {
      if (!list.length || !total) {
        htmlEl("div", "empty", body, "No data.");
        return;
      }
      if (mode === "table") {
        const wrap = htmlEl("div", "table-wrap scroll", body);
        const table = htmlEl("table", "data", wrap);
        const tr = htmlEl("tr", null, htmlEl("thead", null, table));
        for (const h of ["#", what, `${conv.ccy} bn`, "Share, %"]) htmlEl("th", null, tr, h);
        const tbody = htmlEl("tbody", null, table);
        list.forEach((x, k) => {
          const row = htmlEl("tr", null, tbody);
          htmlEl("td", null, row, String(k + 1));
          htmlEl("td", null, row, x.e.name);
          htmlEl("td", null, row, fmt(bn(x.v), 1));
          htmlEl("td", null, row, fmt((100 * x.v) / total, 1));
        });
        return;
      }
      const top = list.slice(0, 12);
      barList(htmlEl("div", null, body), {
        rows: top.map((x) => ({
          label: x.e.name,
          value: (100 * x.v) / total,
          text: fmt((100 * x.v) / total, 1) + "%",
          tip: () => [x.e.name, [fmt((100 * x.v) / total, 1) + "%", "of total"], [`${conv.ccy} ${fmt(bn(x.v), 1)} bn`, "value"]],
        })),
      });
      const covered = top.reduce((s, x) => s + x.v, 0);
      htmlEl("div", "bars-foot", body, `Top ${top.length} together: ${fmt((100 * covered) / total, 0)}% of the total (${conv.ccy} ${fmt(bn(total), 1)} bn).`);
    },
  });
}

function tradeShareHistoryCard(grid, { title, sub, dict, flow, years, exclude = [], withEU = false }) {
  const li = years.length - 1;
  // Stable colours: union of the top 6 with and without gold, ordered by the ranking
  // without gold, so switching the gold view never repaints a line.
  const order = [...new Set([
    ...tradeRank(dict, li, 6, "excl", exclude).map((x) => x.key),
    ...tradeRank(dict, li, 6, "incl", exclude).map((x) => x.key),
  ])].slice(0, 7);
  const shown = tradeRank(dict, li, 6, state.gold, exclude).map((x) => x.key).filter((k) => order.includes(k));
  const share = (e, i) => {
    const v = tradeVal(e, i), t = tradeTotal(flow, i);
    return v == null || !t ? null : (100 * v) / t;
  };
  const series = shown.map((k) => ({
    id: k, label: dict[k].name, color: `var(--s${order.indexOf(k) + 1})`, values: years.map((_, i) => share(dict[k], i)),
  }));
  if (withEU && dict.EU27) {
    series.push({ id: "EU27", label: "EU-27", color: "var(--s8)", values: years.map((_, i) => share(dict.EU27, i)) });
  }
  const data = { periods: years.map(String), series };
  card(grid, {
    title,
    sub,
    source: SOURCE_TEXT.comtrade,
    build: (body, mode) => chartBody(body, mode, { title, data, freq: "A", decimals: 1, includeZero: true }),
  });
}

function renderTrade(panel) {
  const T = DATA["trade.json"];
  const head = htmlEl("div", "panel-head", panel);
  if (!T || !Object.keys(T.reporters || {}).length) {
    htmlEl("h2", null, head, "Foreign trade in goods");
    htmlEl("div", "empty", panel, "Trade data currently unavailable.");
    return;
  }
  const ids = Object.keys(T.reporters);
  if (!ids.includes(state.reporter)) state.reporter = ids.includes("CHE") ? "CHE" : ids[0];
  const rid = state.reporter;
  const R = T.reporters[rid];
  const years = R.years;
  const li = years.length - 1;
  const Y = years[li];
  const X = R.flows.X, M = R.flows.M;
  const conv = usdConverter(COUNTRY[rid]?.currency ?? "USD", years);

  htmlEl("h2", null, head, `Foreign trade in goods: ${nameOf(rid)}, ${Y}`);
  const controls = htmlEl("div", "controls", head);
  if (ids.length > 1) {
    const sel = htmlEl("select", "select", controls);
    sel.setAttribute("aria-label", "Reporting country");
    for (const id of ids) {
      const o = htmlEl("option", null, sel, nameOf(id));
      o.value = id;
      o.selected = id === rid;
    }
    sel.addEventListener("change", () => { state.reporter = sel.value; update(); });
  }
  htmlEl("span", "filter-label", controls, "Gold");
  const seg = htmlEl("div", "segmented", controls);
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Include non-monetary gold");
  for (const [k, lab] of [["excl", "Excluded"], ["incl", "Included"]]) {
    const b = htmlEl("button", null, seg, lab);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.gold === k));
    b.addEventListener("click", () => { state.gold = k; update(); });
  }

  htmlEl("p", "note", panel,
    `Annual merchandise trade as reported to UN Comtrade, in ${conv.ccy} at annual average exchange rates. ` +
    (goldOut()
      ? "Non-monetary gold (HS 7108) is excluded: gold refining and transit dominate Swiss trade flows and swing with the gold market. "
      : "Non-monetary gold (HS 7108) is included. ") +
    "Swiss customs' “Total 1” additionally excludes other precious metals, gems, art and antiques, so figures differ slightly.");

  const bn = (usdMn, i) => (usdMn == null || conv.rate[i] == null ? null : (usdMn * conv.rate[i]) / 1000);
  const series = (fn) => years.map((_, i) => fn(i));
  const pct = (a, b) => (a == null || !b ? null : (100 * a) / b);
  const tiles = [];
  for (const [flow, label] of [[X, "Exports"], [M, "Imports"]]) {
    const v = series((i) => bn(tradeTotal(flow, i), i));
    tiles.push({
      label: `${label}${goldOut() ? ", excl. gold" : ""}`, value: fmt(v[li], 1), unit: ` ${conv.ccy} bn`, meta: String(Y),
      delta: v[li - 1] ? `${fmtSigned(100 * (v[li] / v[li - 1] - 1), 1)}% vs ${Y - 1}` : "", spark: v,
    });
  }
  const bal = series((i) => {
    const x = bn(tradeTotal(X, i), i), m = bn(tradeTotal(M, i), i);
    return x == null || m == null ? null : x - m;
  });
  const gdp = yearValue("gdp_usd", rid, Y);
  const balUsd = tradeTotal(X, li) - tradeTotal(M, li);
  tiles.push({
    label: "Trade balance", value: fmt(bal[li], 1), unit: ` ${conv.ccy} bn`, meta: String(Y),
    delta: gdp ? `${fmtSigned(balUsd / 10 / gdp, 1)}% of GDP` : "", spark: bal,
  });
  for (const [key, label] of [["EU27", "EU-27"], ["USA", "United States"]]) {
    const e = X.partners[key];
    if (!e) continue;
    const s = series((i) => pct(tradeVal(e, i), tradeTotal(X, i)));
    tiles.push({
      label: `Exports to ${label}`, value: fmt(s[li], 1), unit: "% of total", meta: String(Y),
      delta: s[li - 1] != null ? `${fmtSigned(s[li] - s[li - 1], 1)} pp vs ${Y - 1}` : "", spark: s,
    });
  }
  const goldShare = series((i) => pct(X.gold[i], X.total[i]));
  tiles.push({
    label: "Gold in total exports", value: fmt(goldShare[li], 1), unit: "%", meta: `${Y}, share of exports incl. gold`,
    delta: goldShare[li - 1] != null ? `${fmtSigned(goldShare[li] - goldShare[li - 1], 1)} pp vs ${Y - 1}` : "", spark: goldShare,
  });
  renderTiles(panel, tiles);

  const grid = htmlEl("div", "grid", panel);
  const gl = goldOut() ? ", excl. gold" : "";
  tradeBarsCard(grid, { title: `Main export destinations, ${Y}`, sub: `% of total exports${gl}`, dict: X.partners, flow: X, i: li, conv, exclude: ["EU27"], what: "Destination" });
  tradeBarsCard(grid, { title: `Main import origins, ${Y}`, sub: `% of total imports${gl}`, dict: M.partners, flow: M, i: li, conv, exclude: ["EU27"], what: "Origin" });
  tradeBarsCard(grid, { title: `Main exported goods, ${Y}`, sub: `HS chapters, % of total exports${gl}`, dict: X.products, flow: X, i: li, conv, what: "Product (HS chapter)" });
  tradeBarsCard(grid, { title: `Main imported goods, ${Y}`, sub: `HS chapters, % of total imports${gl}`, dict: M.products, flow: M, i: li, conv, what: "Product (HS chapter)" });
  tradeShareHistoryCard(grid, { title: "Export destinations over time", sub: `% of total exports${gl}, top 6 in ${Y} and the EU-27`, dict: X.partners, flow: X, years, exclude: ["EU27"], withEU: true });
  tradeShareHistoryCard(grid, { title: "Import origins over time", sub: `% of total imports${gl}, top 6 in ${Y} and the EU-27`, dict: M.partners, flow: M, years, exclude: ["EU27"], withEU: true });
  tradeShareHistoryCard(grid, { title: "Exported goods over time", sub: `% of total exports${gl}, top 6 HS chapters in ${Y}`, dict: X.products, flow: X, years });
  tradeShareHistoryCard(grid, { title: "Imported goods over time", sub: `% of total imports${gl}, top 6 HS chapters in ${Y}`, dict: M.products, flow: M, years });

  const totals = {
    periods: years.map(String),
    series: [
      { id: "X", label: "Exports", color: "var(--s1)", values: series((i) => bn(tradeTotal(X, i), i)) },
      { id: "M", label: "Imports", color: "var(--s2)", values: series((i) => bn(tradeTotal(M, i), i)) },
    ],
  };
  card(grid, {
    title: "Exports and imports",
    sub: `${conv.ccy} bn, annual${gl}`,
    source: SOURCE_TEXT.comtrade,
    build: (body, mode) => chartBody(body, mode, { title: "Exports and imports", data: totals, freq: "A", decimals: 1, includeZero: true }),
  });
}

// ---------------------------------------------------------------- exchange rates

function fxCurrencies() {
  const seen = new Map();
  for (const cid of state.selected) {
    const c = COUNTRY[cid].currency;
    if (c === state.base || seen.has(c)) continue;
    if (c !== "EUR" && !DATA["ecb_fx.json"]?.rates?.[c]) continue;
    seen.set(c, cid);
  }
  return [...seen].map(([ccy, cid]) => ({ ccy, cid }));
}

function pairLabel(ccy, base, v) {
  return v != null && v < 0.05 ? `100 ${ccy}/${base}` : `${ccy}/${base}`;
}

function renderFx(panel) {
  const fx = DATA["ecb_fx.json"];
  const head = htmlEl("div", "panel-head", panel);
  htmlEl("h2", null, head, "Exchange rates");
  const controls = htmlEl("div", "controls", head);
  htmlEl("span", "filter-label", controls, "Against");
  const seg = htmlEl("div", "segmented", controls);
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Base currency");
  for (const b of FX_BASES) {
    const btn = htmlEl("button", null, seg, b);
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(state.base === b));
    btn.addEventListener("click", () => {
      state.base = b;
      update();
    });
  }
  if (!fx) {
    htmlEl("div", "empty", panel, "Exchange rate data currently unavailable.");
    return;
  }
  const base = state.base;
  htmlEl("p", "note", panel,
    `Value of the selected countries' currencies in ${base}. A rising line means the currency gains against the ${base}. ` +
    "Cross rates derived from ECB euro reference rates.");

  const grid = htmlEl("div", "grid", panel);
  const ccys = fxCurrencies();
  const last = fx.periods.length - 1;
  const start = windowStart("D", fx.periods);

  const series = ccys.map(({ ccy, cid }) => {
    const raw = fx.periods.map((_, i) => (i >= start ? fxPrice(ccy, base, i) : null));
    const first = raw.find((v) => v != null);
    const label = ccy === "EUR" ? "EUR (euro)" : `${ccy} (${nameOf(cid)})`;
    return { id: ccy, label, short: ccy, color: colorOf(cid), values: raw.map((v) => (v == null ? null : (100 * v) / first)) };
  });
  const data = sliceSeries(fx.periods, series, start);
  const title = `Currencies against the ${base}`;
  card(grid, {
    title,
    sub: `Index, start of period = 100, daily`,
    source: "ECB euro foreign exchange reference rates",
    build: (body, mode) => {
      if (!ccys.length) {
        htmlEl("div", "empty", body, `All selected countries use the ${base}. Pick another base currency.`);
        return;
      }
      chartBody(body, mode, { title, data, freq: "D", decimals: 1 });
    },
  });

  card(grid, {
    title: `Changes against the ${base}`,
    sub: `Latest rate (${fmtPeriod(fx.periods[last], "D")}) and % change; positive = currency stronger`,
    source: "ECB euro foreign exchange reference rates",
    tableOnly: true,
    build: (body) => {
      if (!ccys.length) {
        htmlEl("div", "empty", body, `All selected countries use the ${base}.`);
        return;
      }
      const ref = fx.periods[last];
      const horizons = [
        ["1W", shiftDate(ref, { days: -7 })],
        ["1M", shiftDate(ref, { months: -1 })],
        ["YTD", `${Number(ref.slice(0, 4)) - 1}-12-31`],
        ["1Y", shiftDate(ref, { years: -1 })],
        ["5Y", shiftDate(ref, { years: -5 })],
      ];
      const wrap = htmlEl("div", "table-wrap", body);
      const table = htmlEl("table", "data", wrap);
      const tr = htmlEl("tr", null, htmlEl("thead", null, table));
      for (const h of ["Currency", "Rate", ...horizons.map((h) => h[0])]) htmlEl("th", null, tr, h);
      const tbody = htmlEl("tbody", null, table);
      for (const { ccy, cid } of ccys) {
        const now = fxPrice(ccy, base, last);
        const mult = now != null && now < 0.05 ? 100 : 1;
        const row = htmlEl("tr", null, tbody);
        const td0 = htmlEl("td", null, row);
        const lab = htmlEl("span", "country", td0);
        htmlEl("span", "dot", lab).style.background = colorOf(cid);
        lab.appendChild(document.createTextNode(pairLabel(ccy, base, now)));
        htmlEl("td", null, row, fmt(now * mult, fxDecimals(now * mult)));
        for (const [, date] of horizons) {
          const j = fxIndexAtOrBefore(date);
          const then = j >= 0 ? fxPrice(ccy, base, j) : null;
          const v = then ? 100 * (now / then - 1) : null;
          htmlEl("td", v == null ? "na" : null, row, fmtSigned(v, 1));
        }
      }
    },
  });

  indicatorCard(grid, "neer", { sub: "Index, 2020 = 100, monthly; rising = appreciation" });
  indicatorCard(grid, "reer", { sub: "Index, 2020 = 100, CPI-based, monthly; rising = appreciation" });
}

// ---------------------------------------------------------------- sources

function renderSources(panel) {
  const head = htmlEl("div", "panel-head", panel);
  htmlEl("h2", null, head, "Sources & notes");
  const list = htmlEl("ul", "sources-list", panel);
  for (const s of META.sources) {
    const li = htmlEl("li", null, list);
    const a = htmlEl("a", null, li, s.name);
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    const st = htmlEl("div", "src", li);
    const okSpan = htmlEl("span", s.ok ? "status-ok" : "status-err", st, s.ok ? "✓ Updated" : "⚠ Last update failed");
    okSpan.setAttribute("aria-label", s.ok ? "Updated" : "Last update failed");
    st.appendChild(document.createTextNode(
      ` · last successful refresh ${s.last_success ? s.last_success.slice(0, 10) : "never"}` +
      (s.latest_period ? ` · data up to ${s.latest_period}` : "") + " · "
    ));
    const dl = htmlEl("a", null, st, s.file);
    dl.href = "data/" + s.file;
  }

  const notes = [
    "IMF figures (World Economic Outlook and Fiscal Monitor) are annual and include projections five years ahead; they are revised in April and October. Fiscal figures are on a general government basis.",
    "Quarterly real GDP growth is computed from OECD seasonally and calendar adjusted chain-linked volumes. China and Singapore are not covered; the overview falls back to IMF annual figures there.",
    "Inflation is the year-on-year change in consumer prices as compiled by the BIS. Policy rates are end-of-month values; the overview shows the latest daily value. Euro-area members are shown with the ECB rate.",
    "Sectoral debt is BIS total credit to households, non-financial corporations and the general government, in % of GDP.",
    "Exchange rates are ECB euro reference rates; cross rates (e.g. against the CHF) are derived from them. Effective exchange rates are BIS broad indices.",
    "Swiss public debt is computed from the FFA's GFS balance sheets (data.finance.admin.ch) for general government and its subsectors: gross debt (IMF) = GFS 630 − 6305 − 6307, net debt (IMF) = gross debt − (620 − 6205 − 6207); the charts show the four largest positions in the latest year and aggregate the rest. Maastricht debt, its forecasts and nominal GDP are the FFA's published figures.",
    "Homeownership is the share of the population living in an owner-occupied dwelling (Eurostat, EU-SILC), split into owners with and without an outstanding mortgage or housing loan. Countries that stopped reporting are dropped from the cross-country comparison.",
    "Foreign trade is annual merchandise trade reported to UN Comtrade (Swiss data from the Federal Office for Customs and Border Security), by partner country and HS chapter, converted from USD at ECB annual average rates. Excluding gold removes non-monetary gold (HS 7108). Trade data are refreshed weekly.",
    "Data are refreshed automatically every day. If a source cannot be reached, the previous data are kept and flagged above.",
  ];
  const ul = htmlEl("ul", "note", panel);
  ul.style.marginTop = "18px";
  for (const n of notes) htmlEl("li", null, ul, n);
}

// ---------------------------------------------------------------- main

function renderUpdated() {
  const el = $("updated");
  el.innerHTML = "";
  const when = new Date(META.generated);
  el.appendChild(document.createTextNode(
    "Data refreshed " + when.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
  ));
  const failed = META.sources.filter((s) => !s.ok);
  if (failed.length) {
    el.appendChild(document.createTextNode(" · "));
    htmlEl("span", "stale", el, `⚠ ${failed.length} source${failed.length > 1 ? "s" : ""} could not be refreshed (see Sources & notes)`);
  }
}

function renderPanel() {
  for (const o of observers) o.disconnect();
  observers = [];
  const panel = $("panel");
  panel.innerHTML = "";
  ({
    overview: renderOverview,
    growth: renderGrowth,
    fiscal: renderFiscal,
    swissdebt: renderSwissDebt,
    debt: renderDebt,
    housing: renderHousing,
    trade: renderTrade,
    fx: renderFx,
    sources: renderSources,
  })[state.tab](panel);
}

function update() {
  ensureSlots();
  renderFilters();
  renderTabs();
  renderPanel();
  writeHash();
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function main() {
  $("theme-btn").addEventListener("click", cycleTheme);
  applyTheme();
  try {
    META = await fetchJSON("data/meta.json");
    for (const c of META.countries) COUNTRY[c.id] = c;
    for (const i of META.indicators) IND[i.id] = i;
    const files = [...new Set([...META.indicators.map((i) => i.file), ...META.sources.map((x) => x.file)])];
    await Promise.all(files.map(async (f) => {
      try {
        DATA[f] = await fetchJSON("data/" + f);
      } catch (e) {
        console.warn(e);
        DATA[f] = null;
      }
    }));
  } catch (e) {
    $("panel").textContent = "The data could not be loaded. Please try again later.";
    console.error(e);
    return;
  }
  readHash();
  renderUpdated();
  update();
  window.addEventListener("hashchange", () => {
    readHash();
    update();
  });
}

main();
