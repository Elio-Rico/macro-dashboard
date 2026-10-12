// Small dependency-free SVG chart helpers: multi-series line chart with crosshair tooltip,
// sparkline, number and period formatting.

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function htmlEl(tag, className, parent, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

// ---------- formatting ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmt(v, decimals = 1) {
  if (v == null || Number.isNaN(v)) return "–";
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  // Avoid "-0.0"
  return v < 0 && Number(s.replace(/,/g, "")) !== 0 ? "−" + s : s;
}

export function fmtSigned(v, decimals = 1) {
  if (v == null || Number.isNaN(v)) return "–";
  const s = fmt(v, decimals);
  return v > 0 && Number(Math.abs(v).toFixed(decimals)) !== 0 ? "+" + s : s;
}

export function fmtPeriod(p, freq, short = false) {
  if (p == null) return "";
  if (freq === "A") return p;
  if (freq === "Q") return short ? `Q${p.slice(6)} ${p.slice(2, 4)}` : `${p.slice(0, 4)} Q${p.slice(6)}`;
  if (freq === "M") {
    const m = MONTHS[Number(p.slice(5, 7)) - 1];
    return short ? `${m} ${p.slice(2, 4)}` : `${m} ${p.slice(0, 4)}`;
  }
  // daily
  const m = MONTHS[Number(p.slice(5, 7)) - 1];
  return short ? `${Number(p.slice(8, 10))} ${m}` : `${Number(p.slice(8, 10))} ${m} ${p.slice(0, 4)}`;
}

// ---------- scales ----------

export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], lo: 0, hi: 1, step: 1 };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const step = (r > 5 ? 10 : r > 2.5 ? 5 : r > 2 ? 2.5 : r > 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, lo, hi, step };
}

function tickDecimals(step) {
  if (step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
}

// Pick x tick positions at calendar boundaries (years, or months/quarters for short spans).
function xTicks(periods, freq, maxTicks) {
  const n = periods.length;
  if (n === 0) return [];
  const yearStarts = [];
  for (let i = 0; i < n; i++) {
    const y = periods[i].slice(0, 4);
    if (i === 0 ? freq === "A" || isYearStart(periods[i], freq) : y !== periods[i - 1].slice(0, 4)) {
      yearStarts.push(i);
    }
  }
  if (yearStarts.length >= 3 || freq === "A") {
    const step = Math.max(1, Math.ceil(yearStarts.length / maxTicks));
    const niceStep = [1, 2, 5, 10, 20].find((s) => s >= step) || step;
    return yearStarts
      .filter((i) => Number(periods[i].slice(0, 4)) % niceStep === 0)
      .map((i) => ({ i, label: periods[i].slice(0, 4) }));
  }
  // Short span: month (D, M) or quarter (Q) boundaries.
  const starts = [];
  for (let i = 1; i < n; i++) {
    const key = freq === "Q" ? periods[i] : periods[i].slice(0, 7);
    const prev = freq === "Q" ? periods[i - 1] : periods[i - 1].slice(0, 7);
    if (key !== prev) starts.push(i);
  }
  const step = Math.max(1, Math.ceil(starts.length / maxTicks));
  return starts
    .filter((_, k) => k % step === 0)
    .map((i) => ({
      i,
      label: freq === "Q" ? fmtPeriod(periods[i], "Q", true) : fmtPeriod(periods[i].slice(0, 7), "M", true),
    }));
}

function isYearStart(p, freq) {
  if (freq === "Q") return p.endsWith("Q1");
  if (freq === "M") return p.endsWith("-01");
  return false;
}

// ---------- line chart ----------

/**
 * opts: {
 *   periods: string[], freq: "A"|"Q"|"M"|"D",
 *   series: [{ id, label, color, values: (number|null)[] }],
 *   decimals, unit, includeZero, projectionStart (index or null), height
 * }
 * Returns { destroy() }.
 */
export function lineChart(container, opts) {
  container.innerHTML = "";
  container.classList.add("chart");
  const { periods, freq, series } = opts;
  const decimals = opts.decimals ?? 1;
  const height = opts.height ?? 240;
  const width = Math.max(260, container.clientWidth);
  const n = periods.length;

  let ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
  if (!Number.isFinite(ymin)) {
    htmlEl("div", "empty", container, "No data for the selected countries and period.");
    return { destroy() {} };
  }
  if (opts.includeZero) { ymin = Math.min(0, ymin); ymax = Math.max(0, ymax); }
  const yt = niceTicks(ymin, ymax, height < 200 ? 4 : 5);
  const yDec = tickDecimals(yt.step);
  const tickLabels = yt.ticks.map((t) => fmt(t, yDec));

  // End labels only when they will not collide (few series, separated at the right edge).
  const lastPoints = series.map((s) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return { s, i, v: s.values[i] };
    return null;
  }).filter(Boolean);

  const ml = 10 + Math.max(...tickLabels.map((t) => t.length)) * 6.5;
  const mt = 10, mb = 24;
  let mr = 10;
  const ph = height - mt - mb;
  const yScale = (v) => mt + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;

  let endLabels = [];
  if (series.length <= 4 && lastPoints.length === series.length) {
    const ys = lastPoints.map((p) => yScale(p.v)).sort((a, b) => a - b);
    const minGap = ys.slice(1).reduce((g, y, k) => Math.min(g, y - ys[k]), Infinity);
    const allAtEnd = lastPoints.every((p) => p.i >= n - 3);
    if (minGap >= 13 && allAtEnd) {
      endLabels = lastPoints;
      mr = 14 + Math.max(...lastPoints.map((p) => p.s.short || p.s.label).map((l) => l.length)) * 6.2;
    }
  }
  const pw = width - ml - mr;
  const xScale = (i) => ml + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: "img",
    tabindex: "0",
    "aria-label": `${opts.title || "Chart"}. Use left and right arrow keys to read values.`,
  }, container);

  // Projection band
  const ps = opts.projectionStart;
  if (ps != null && ps >= 0 && ps < n) {
    const x0 = n <= 1 ? ml : xScale(ps) - pw / (n - 1) / 2;
    svgEl("rect", { class: "band", x: x0, y: mt, width: ml + pw - x0, height: ph }, svg);
    const lbl = svgEl("text", { class: "band-label", x: x0 + 6, y: mt + 13 }, svg);
    lbl.textContent = opts.projectionLabel || "Projections";
  }

  // Grid + y labels
  const yAxis = svgEl("g", { class: "axis" }, svg);
  yt.ticks.forEach((t, k) => {
    const y = Math.round(yScale(t)) + 0.5;
    svgEl("line", { class: t === 0 ? "zeroline" : "gridline", x1: ml, x2: ml + pw, y1: y, y2: y }, svg);
    const txt = svgEl("text", { x: ml - 8, y: y + 4, "text-anchor": "end" }, yAxis);
    txt.textContent = tickLabels[k];
  });

  // X labels
  const xAxis = svgEl("g", { class: "axis" }, svg);
  const maxTicks = Math.max(2, Math.floor(pw / 64));
  for (const t of xTicks(periods, freq, maxTicks)) {
    const txt = svgEl("text", { x: xScale(t.i), y: height - 6, "text-anchor": "middle" }, xAxis);
    txt.textContent = t.label;
  }

  // Lines (split at gaps; projected part dashed)
  for (const s of series) {
    const segs = [];
    let cur = null;
    s.values.forEach((v, i) => {
      if (v == null) { cur = null; return; }
      if (!cur) { cur = []; segs.push(cur); }
      cur.push([xScale(i), yScale(v), i]);
    });
    for (const seg of segs) {
      const actual = ps != null ? seg.filter((p) => p[2] < ps) : seg;
      const proj = ps != null ? seg.filter((p) => p[2] >= ps - 1) : [];
      const draw = (pts, cls) => {
        if (pts.length === 0) return;
        if (pts.length === 1) {
          svgEl("circle", { cx: pts[0][0], cy: pts[0][1], r: 2.5, style: `fill:${s.color}` }, svg);
          return;
        }
        svgEl("path", {
          class: cls,
          d: "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L"),
          style: `stroke:${s.color}`,
        }, svg);
      };
      draw(actual, "series-line");
      if (proj.length > 1 && proj.some((p) => p[2] >= ps)) draw(proj, "series-line proj");
    }
  }

  for (const p of endLabels) {
    const t = svgEl("text", { class: "end-label", x: xScale(p.i) + 6, y: yScale(p.v) + 4 }, svg);
    t.textContent = p.s.short || p.s.label;
  }

  // Hover layer
  const hover = svgEl("g", { style: "display:none" }, svg);
  const cross = svgEl("line", { class: "crosshair", y1: mt, y2: mt + ph }, hover);
  const dots = series.map((s) => svgEl("circle", { class: "hover-dot", r: 4, style: `fill:${s.color}` }, hover));
  const tip = htmlEl("div", "tooltip", container);
  tip.style.display = "none";
  const hit = svgEl("rect", { x: ml, y: mt, width: pw, height: ph, fill: "transparent" }, svg);

  let active = null;
  function show(i) {
    i = Math.max(0, Math.min(n - 1, i));
    active = i;
    const x = xScale(i);
    hover.style.display = "";
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    series.forEach((s, k) => {
      const v = s.values[i];
      if (v == null) dots[k].style.display = "none";
      else {
        dots[k].style.display = "";
        dots[k].setAttribute("cx", x);
        dots[k].setAttribute("cy", yScale(v));
      }
    });
    tip.innerHTML = "";
    const isProj = ps != null && i >= ps;
    htmlEl("div", "t-head", tip, fmtPeriod(periods[i], freq) + (isProj ? " · projection" : ""));
    const rows = series
      .map((s) => ({ s, v: s.values[i] }))
      .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
    for (const { s, v } of rows) {
      const row = htmlEl("div", "t-row", tip);
      const key = htmlEl("span", "key", row);
      key.style.background = s.color;
      htmlEl("span", "v", row, v == null ? "–" : fmt(v, decimals));
      htmlEl("span", "n", row, s.label);
    }
    tip.style.display = "";
    const tw = tip.offsetWidth;
    const left = x + 14 + tw > width ? x - 14 - tw : x + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${mt}px`;
  }
  function hide() {
    active = null;
    hover.style.display = "none";
    tip.style.display = "none";
  }
  function indexAt(evt) {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * width;
    return n <= 1 ? 0 : Math.round(((px - ml) / pw) * (n - 1));
  }
  hit.addEventListener("pointermove", (e) => show(indexAt(e)));
  hit.addEventListener("pointerdown", (e) => show(indexAt(e)));
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(active ?? n - 1));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show((active ?? n - 1) - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { show((active ?? n - 1) + 1); e.preventDefault(); }
    else if (e.key === "Home") { show(0); e.preventDefault(); }
    else if (e.key === "End") { show(n - 1); e.preventDefault(); }
    else if (e.key === "Escape") hide();
  });

  return { destroy() { container.innerHTML = ""; } };
}

// ---------- legend ----------

export function legend(parent, series) {
  const box = htmlEl("div", "legend", parent);
  if (series.length < 2) return box;
  for (const s of series) {
    const item = htmlEl("span", null, box);
    const key = htmlEl("span", "key", item);
    key.style.background = s.color;
    item.appendChild(document.createTextNode(s.label));
  }
  return box;
}

// ---------- table view (the accessible twin of every chart) ----------

export function seriesTable(parent, { periods, freq, series, decimals = 1, projectionStart = null, maxRows = 400 }) {
  const wrap = htmlEl("div", "table-wrap scroll", parent);
  const table = htmlEl("table", "data", wrap);
  const head = htmlEl("tr", null, htmlEl("thead", null, table));
  htmlEl("th", null, head, "Period");
  for (const s of series) htmlEl("th", null, head, s.label);
  const body = htmlEl("tbody", null, table);
  let rows = 0;
  for (let i = periods.length - 1; i >= 0 && rows < maxRows; i--) {
    if (!series.some((s) => s.values[i] != null)) continue;
    const tr = htmlEl("tr", null, body);
    const proj = projectionStart != null && i >= projectionStart;
    htmlEl("td", null, tr, fmtPeriod(periods[i], freq) + (proj ? " (proj.)" : ""));
    for (const s of series) {
      const v = s.values[i];
      htmlEl("td", v == null ? "na" : null, tr, fmt(v, decimals));
    }
    rows++;
  }
  return wrap;
}

// ---------- stacked columns with a total line ----------

/**
 * segments: [{ id, label, color, values }]: positive values stack up from zero, negative ones
 * down. total: { label, values } drawn as a line. Same hover/keyboard behaviour as lineChart.
 */
export function stackedColumns(container, { title, periods, freq, segments, total, decimals = 1, height = 260 }) {
  container.innerHTML = "";
  container.classList.add("chart");
  const width = Math.max(260, container.clientWidth);
  const n = periods.length;

  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    let up = 0, down = 0;
    for (const s of segments) {
      const v = s.values[i];
      if (v == null) continue;
      if (v >= 0) up += v; else down += v;
    }
    const t = total.values[i] ?? 0;
    lo = Math.min(lo, down, t);
    hi = Math.max(hi, up, t);
  }
  if (lo === 0 && hi === 0) {
    htmlEl("div", "empty", container, "No data for this period.");
    return { destroy() {} };
  }
  const yt = niceTicks(lo, hi, 5);
  const yDec = tickDecimals(yt.step);
  const tickLabels = yt.ticks.map((t) => fmt(t, yDec));
  const ml = 10 + Math.max(...tickLabels.map((t) => t.length)) * 6.5;
  const mt = 10, mb = 24, mr = 10;
  const pw = width - ml - mr;
  const ph = height - mt - mb;
  const band = pw / n;
  const bw = Math.max(2, Math.min(24, band * 0.72));
  const xc = (i) => ml + band * (i + 0.5);
  const y = (v) => mt + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`, height, role: "img", tabindex: "0",
    "aria-label": `${title || "Chart"}. Use left and right arrow keys to read values.`,
  }, container);
  const hoverBand = svgEl("rect", { class: "band", y: mt, height: ph, width: band, style: "display:none" }, svg);

  const yAxis = svgEl("g", { class: "axis" }, svg);
  const zero = [];
  yt.ticks.forEach((t, k) => {
    const yy = Math.round(y(t)) + 0.5;
    const line = svgEl("line", { class: t === 0 ? "zeroline" : "gridline", x1: ml, x2: ml + pw, y1: yy, y2: yy }, svg);
    if (t === 0) zero.push(line);
    svgEl("text", { x: ml - 8, y: yy + 4, "text-anchor": "end" }, yAxis).textContent = tickLabels[k];
  });
  const xAxis = svgEl("g", { class: "axis" }, svg);
  for (const t of xTicks(periods, freq, Math.max(2, Math.floor(pw / 64)))) {
    svgEl("text", { x: xc(t.i), y: height - 6, "text-anchor": "middle" }, xAxis).textContent = t.label;
  }

  // Segments: a 2px surface gap separates touching segments.
  const bars = svgEl("g", {}, svg);
  for (let i = 0; i < n; i++) {
    let up = 0, down = 0;
    for (const s of segments) {
      const v = s.values[i];
      if (v == null || v === 0) continue;
      const a = v > 0 ? up : down;
      const b = a + v;
      if (v > 0) up = b; else down = b;
      const top = y(Math.max(a, b)), bottom = y(Math.min(a, b));
      const h = bottom - top - 2;
      if (h <= 0) continue;
      svgEl("rect", { x: xc(i) - bw / 2, y: top + 1, width: bw, height: h, style: `fill:${s.color}` }, bars);
    }
  }
  // Keep the zero line above the bars.
  for (const z of zero) svg.appendChild(z);

  // Total line
  const pts = [];
  total.values.forEach((v, i) => { if (v != null) pts.push(`${xc(i).toFixed(1)},${y(v).toFixed(1)}`); });
  if (pts.length > 1) svgEl("path", { class: "series-line", d: "M" + pts.join("L"), style: "stroke:var(--ink)" }, svg);
  const dot = svgEl("circle", { class: "hover-dot", r: 4, style: "fill:var(--ink);display:none" }, svg);

  const tip = htmlEl("div", "tooltip", container);
  tip.style.display = "none";
  const hit = svgEl("rect", { x: ml, y: mt, width: pw, height: ph, fill: "transparent" }, svg);

  let active = null;
  function show(i) {
    i = Math.max(0, Math.min(n - 1, i));
    active = i;
    hoverBand.style.display = "";
    hoverBand.setAttribute("x", ml + band * i);
    const t = total.values[i];
    if (t != null) {
      dot.style.display = "";
      dot.setAttribute("cx", xc(i));
      dot.setAttribute("cy", y(t));
    } else dot.style.display = "none";
    tip.innerHTML = "";
    htmlEl("div", "t-head", tip, fmtPeriod(periods[i], freq));
    const row = (v, label, color, rect) => {
      const r = htmlEl("div", "t-row", tip);
      const key = htmlEl("span", "key", r);
      key.style.background = color;
      if (rect) { key.style.height = "8px"; key.style.width = "8px"; key.style.borderRadius = "2px"; }
      htmlEl("span", "v", r, v == null ? "–" : fmt(v, decimals));
      htmlEl("span", "n", r, label);
    };
    row(t, total.label, "var(--ink)", false);
    for (const s of segments.slice().reverse()) if (s.values[i] != null && s.values[i] !== 0) row(s.values[i], s.label, s.color, true);
    tip.style.display = "";
    const x = xc(i);
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, x + 14 + tw > width ? x - 14 - tw : x + 14)}px`;
    tip.style.top = `${mt}px`;
  }
  function hide() {
    active = null;
    hoverBand.style.display = "none";
    dot.style.display = "none";
    tip.style.display = "none";
  }
  const indexAt = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * width;
    return Math.floor((px - ml) / band);
  };
  hit.addEventListener("pointermove", (e) => show(indexAt(e)));
  hit.addEventListener("pointerdown", (e) => show(indexAt(e)));
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(active ?? n - 1));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show((active ?? n - 1) - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { show((active ?? n - 1) + 1); e.preventDefault(); }
    else if (e.key === "Home") { show(0); e.preventDefault(); }
    else if (e.key === "End") { show(n - 1); e.preventDefault(); }
    else if (e.key === "Escape") hide();
  });
  return { destroy() { container.innerHTML = ""; } };
}

export function stackLegend(parent, segments, total) {
  const box = htmlEl("div", "legend", parent);
  const item = htmlEl("span", null, box);
  const key = htmlEl("span", "key", item);
  key.style.background = "var(--ink)";
  item.appendChild(document.createTextNode(total.label));
  for (const g of segments) {
    const it = htmlEl("span", null, box);
    htmlEl("span", "rect-key", it).style.background = g.color;
    it.appendChild(document.createTextNode(g.label));
  }
  return box;
}

// ---------- horizontal bars (HTML) ----------

// Shared hover/focus tooltip for HTML bar rows. `lines(row)` returns [head, ...rows] where
// each row is [value, label].
function attachRowTooltip(box, rowEl, lines) {
  let tip = box.querySelector(":scope > .tooltip");
  if (!tip) {
    tip = htmlEl("div", "tooltip", box);
    tip.style.display = "none";
  }
  const show = () => {
    const [head, ...rows] = lines();
    tip.innerHTML = "";
    htmlEl("div", "t-head", tip, head);
    for (const [v, n, color] of rows) {
      const r = htmlEl("div", "t-row", tip);
      if (color) {
        const key = htmlEl("span", "key", r);
        key.style.background = color;
        key.style.height = "8px";
        key.style.width = "8px";
        key.style.borderRadius = "2px";
      }
      htmlEl("span", "v", r, v);
      htmlEl("span", "n", r, n);
    }
    tip.style.display = "";
    const top = rowEl.offsetTop + rowEl.offsetHeight + 4;
    const maxTop = box.offsetHeight - tip.offsetHeight;
    tip.style.top = `${top > maxTop ? Math.max(0, rowEl.offsetTop - tip.offsetHeight - 4) : top}px`;
    tip.style.left = `${Math.min(box.clientWidth - tip.offsetWidth, rowEl.offsetLeft + rowEl.offsetWidth * 0.35)}px`;
  };
  const hide = () => (tip.style.display = "none");
  rowEl.tabIndex = 0;
  rowEl.addEventListener("pointerenter", show);
  rowEl.addEventListener("pointerleave", hide);
  rowEl.addEventListener("focus", show);
  rowEl.addEventListener("blur", hide);
}

/**
 * Ranked horizontal bars, one colour. rows: [{ label, value, text, tip: () => [head, [v, n], ...] }]
 */
export function barList(container, { rows, max }) {
  container.innerHTML = "";
  const box = htmlEl("div", "bars", container);
  const top = max ?? Math.max(...rows.map((r) => r.value ?? 0), 1e-9);
  for (const r of rows) {
    const row = htmlEl("div", "bar-row", box);
    const lab = htmlEl("div", "bar-label", row, r.label);
    lab.title = r.label;
    const inner = htmlEl("div", "bar-inner", htmlEl("div", "bar-area", row));
    const w = Math.max(0, (100 * (r.value ?? 0)) / top);
    htmlEl("div", "bar-fill", inner).style.width = `${w}%`;
    const val = htmlEl("span", "bar-value", inner, r.text);
    val.style.left = `calc(${w}% + 6px)`;
    if (r.tip) attachRowTooltip(box, row, r.tip);
  }
  return box;
}

/**
 * 100% stacked horizontal bars. segments: [{ key, label, color }];
 * rows: [{ label, values: {key: number}, total, emph, ref, tip }]
 */
export function stackedBars(container, { rows, segments, totalText }) {
  container.innerHTML = "";
  const box = htmlEl("div", "bars", container);
  for (const r of rows) {
    const row = htmlEl("div", "bar-row stack-row" + (r.emph ? " emph" : "") + (r.ref ? " ref" : ""), box);
    const lab = htmlEl("div", "bar-label", row, r.label);
    lab.title = r.label;
    const stack = htmlEl("div", "stack", row);
    const sum = segments.reduce((s, g) => s + (r.values[g.key] ?? 0), 0) || 1;
    for (const g of segments) {
      const v = r.values[g.key] ?? 0;
      if (v <= 0) continue;
      const seg = htmlEl("div", "seg", stack);
      seg.style.flex = `${v / sum} 1 0`;
      seg.style.background = g.color;
    }
    htmlEl("div", "stack-total", row, totalText(r));
    if (r.tip) attachRowTooltip(box, row, r.tip);
  }
  return box;
}

export function rectLegend(parent, segments) {
  const box = htmlEl("div", "legend", parent);
  for (const g of segments) {
    const item = htmlEl("span", null, box);
    htmlEl("span", "rect-key", item).style.background = g.color;
    item.appendChild(document.createTextNode(g.label));
  }
  return box;
}

// ---------- sparkline ----------

export function sparkline(parent, values) {
  const w = Math.max(80, parent.clientWidth || 160);
  const h = 34;
  const pts = values.map((v, i) => [i, v]).filter((p) => p[1] != null);
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, height: h, "aria-hidden": "true" }, parent);
  if (pts.length < 2) return svg;
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = 5;
  const x = (i) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v) => (hi === lo ? h / 2 : pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad));
  svgEl("path", {
    class: "spark-line",
    d: "M" + pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("L"),
  }, svg);
  const last = pts[pts.length - 1];
  svgEl("circle", { class: "spark-dot", cx: x(last[0]), cy: y(last[1]), r: 4 }, svg);
  return svg;
}

export { htmlEl };
