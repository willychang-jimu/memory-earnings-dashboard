/* 記憶體三雄法說會 Dashboard — 前端邏輯
   資料從 ../data/manifest.json 出發，manifest 由 scripts/build_manifest.py 產生。
   注意：用 fetch 讀 JSON，直接用 file:// 開會被瀏覽器 CORS 擋，
   本機預覽請用 `python3 -m http.server` 之類的靜態伺服器。 */

const COMPANIES = {
  samsung: { name: "三星", fullName: "Samsung Electronics", varName: "--series-samsung" },
  micron: { name: "美光", fullName: "Micron Technology", varName: "--series-micron" },
  sk_hynix: { name: "SK 海力士", fullName: "SK Hynix", varName: "--series-hynix" },
};

const state = {
  quarters: [],        // 正規化後的季度資料
  brokers: [],         // 投行觀點
  selected: new Set(Object.keys(COMPANIES)),
  range: "all",
  charts: {},
};

/* ── 工具 ───────────────────────────────── */

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const companyColor = (company) => cssVar(COMPANIES[company].varName);

function pickNumber(obj, candidates) {
  if (!obj) return null;
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** 在 financials 裡找營收，容許美元／韓元不同欄位命名，回傳含幣別的物件。
    三星與海力士的官方揭露是韓元，美元值多半是第三方換算，因此韓元欄位優先。 */
function resolveAmount(fin, kind, company) {
  if (!fin) return null;
  const patterns = {
    revenue: /^revenue.*(usd|krw)/i,
    capex: /^capex.*(usd|krw)/i,
  }[kind];
  const krwFirst = company === "samsung" || company === "sk_hynix";
  const direct = {
    revenue: krwFirst
      ? ["revenue_krw_trillion", "revenue_krw_b", "revenue_usd_m"]
      : ["revenue_usd_m", "revenue_krw_trillion", "revenue_krw_b"],
    capex: krwFirst
      ? ["capex_krw_trillion", "capex_krw_b", "capex_usd_m"]
      : ["capex_usd_m", "capex_krw_trillion", "capex_krw_b"],
  }[kind];

  const keys = [
    ...direct.filter((k) => typeof fin[k] === "number"),
    ...Object.keys(fin).filter(
      (k) => patterns.test(k) && typeof fin[k] === "number" && !direct.includes(k)
    ),
  ];
  if (!keys.length) return null;

  const key = keys[0];
  const value = fin[key];
  if (!Number.isFinite(value)) return null;

  if (/krw_t(rillion)?/i.test(key)) return { value, unit: "兆韓元", currency: "KRW", scale: "t" };
  if (/krw_b/i.test(key)) return { value, unit: "十億韓元", currency: "KRW", scale: "b" };
  if (/krw/i.test(key)) return { value, unit: "韓元", currency: "KRW", scale: "raw" };
  return { value, unit: "百萬美元", currency: "USD", scale: "m" };
}

function fmtNumber(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

/** 從資料推出可排序的日曆季，跨公司對齊用 */
function calendarQuarter(rec) {
  const iso = rec.period_end || rec.report_date || rec.period_start;
  if (iso && /^\d{4}-\d{2}/.test(iso)) {
    const year = Number(iso.slice(0, 4));
    const month = Number(iso.slice(5, 7));
    const q = Math.floor((month - 1) / 3) + 1;
    return { year, q, label: `${year} Q${q}` };
  }
  const src = `${rec.calendar_quarter_equivalent || ""} ${rec.period_label || ""}`;
  const m = src.match(/(\d{4})\s*Q(\d)/);
  if (m) return { year: Number(m[1]), q: Number(m[2]), label: `${m[1]} Q${m[2]}` };
  return { year: 0, q: 0, label: rec.period_label || "未知期間" };
}

const sortKey = (rec) => rec._cal.year * 10 + rec._cal.q;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 長文字欄位：預設收合三行，點擊展開。手機沒有 hover，所以不用 tooltip。 */
function longTextCell(text) {
  const td = el("td", "wide");
  if (!text) {
    td.appendChild(el("span", "na", "—"));
    return td;
  }
  const body = el("div", "clamp", text);
  const toggle = el("div", "clamp-more", "展開 ▾");
  const flip = () => {
    const open = body.classList.toggle("open");
    toggle.textContent = open ? "收合 ▴" : "展開 ▾";
  };
  body.addEventListener("click", flip);
  toggle.addEventListener("click", flip);
  td.append(body, toggle);
  return td;
}

/** 公司色塊 + 名稱，不換行 */
function companyTagCell(company) {
  const td = el("td", "tight");
  const tag = el("span", "company-tag");
  const key = el("span", "key");
  key.style.background = companyColor(company);
  tag.append(key, document.createTextNode(COMPANIES[company]?.name || company));
  td.appendChild(tag);
  return td;
}

/* ── 載入資料 ───────────────────────────── */

async function loadJson(path) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("讀取失敗:", path, err);
    return null;
  }
}

async function loadAll() {
  const manifest = await loadJson("../data/manifest.json");
  if (!manifest) {
    document.getElementById("meta-line").textContent =
      "無法讀取 data/manifest.json — 請用靜態伺服器開啟（python3 -m http.server），不要直接雙擊 file://";
    return;
  }

  const quarterJobs = [];
  for (const [company, files] of Object.entries(manifest.quarters || {})) {
    for (const file of files) {
      quarterJobs.push(
        loadJson(`../data/${company}/${file}`).then((rec) => {
          if (!rec) return null;
          rec.company = rec.company || company;
          rec._cal = calendarQuarter(rec);
          rec._file = `${company}/${file}`;
          return rec;
        })
      );
    }
  }
  const brokerJobs = (manifest.broker_reports || []).map((file) =>
    loadJson(`../data/broker_reports/${file}`).then((rec) => {
      if (rec) rec._file = file;
      return rec;
    })
  );

  const [quarters, brokers, divergences, upcoming] = await Promise.all([
    Promise.all(quarterJobs),
    Promise.all(brokerJobs),
    loadJson("../data/analysis/divergences.json"),
    loadJson("../data/analysis/upcoming.json"),
  ]);

  state.divergences = divergences?.items || [];
  state.upcoming = upcoming?.events || [];

  state.quarters = quarters.filter(Boolean).sort((a, b) => sortKey(a) - sortKey(b));
  state.brokers = brokers
    .filter(Boolean)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  const latest = state.quarters[state.quarters.length - 1];
  document.getElementById("meta-line").textContent =
    `已收錄 ${state.quarters.length} 季法說會資料、${state.brokers.length} 則投行觀點` +
    (latest ? `　|　最新季度：${latest._cal.label}` : "");

  renderAll();
}

/* ── 篩選 ───────────────────────────────── */

function visibleQuarters() {
  let rows = state.quarters.filter((r) => state.selected.has(r.company));
  if (state.range !== "all") {
    const n = Number(state.range);
    const labels = [...new Set(rows.map((r) => r._cal.label))].sort();
    const keep = new Set(labels.slice(-n));
    rows = rows.filter((r) => keep.has(r._cal.label));
  }
  return rows;
}

function quarterLabels(rows) {
  return [...new Set(rows.map((r) => r._cal.label))].sort((a, b) => {
    const pa = a.match(/(\d{4}) Q(\d)/);
    const pb = b.match(/(\d{4}) Q(\d)/);
    if (!pa || !pb) return a.localeCompare(b);
    return Number(pa[1]) * 10 + Number(pa[2]) - (Number(pb[1]) * 10 + Number(pb[2]));
  });
}

/* ── Chart.js 共用設定 ──────────────────── */

const tooltipEl = () => document.getElementById("viz-tooltip");

function externalTooltip(ctx) {
  const box = tooltipEl();
  const tt = ctx.tooltip;
  if (!tt.opacity) {
    box.style.opacity = 0;
    box.setAttribute("aria-hidden", "true");
    return;
  }
  box.textContent = "";
  const title = el("div", "tt-title", tt.title?.[0] || "");
  box.appendChild(title);

  tt.dataPoints.forEach((dp) => {
    const row = el("div", "tt-row");
    const key = el("span", "tt-key");
    key.style.background = dp.dataset.borderColor || dp.dataset.backgroundColor;
    const val = el("span", "tt-val", dp.dataset._fmt ? dp.dataset._fmt(dp.raw) : fmtNumber(dp.raw, 1));
    const name = el("span", "tt-name", dp.dataset.label || "");
    row.append(key, val, name);
    box.appendChild(row);
  });

  const rect = ctx.chart.canvas.getBoundingClientRect();
  box.style.opacity = 1;
  box.setAttribute("aria-hidden", "false");
  const bw = box.offsetWidth;
  let left = rect.left + tt.caretX + 14;
  if (left + bw > window.innerWidth - 8) left = rect.left + tt.caretX - bw - 14;
  box.style.left = `${Math.max(8, left)}px`;
  box.style.top = `${rect.top + tt.caretY - 10}px`;
}

/** 折線圖的十字線：讀者瞄準的是季度，不是 2px 的線 */
const crosshairPlugin = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const c = chart.ctx;
    c.save();
    c.beginPath();
    c.moveTo(x, top);
    c.lineTo(x, bottom);
    c.lineWidth = 1;
    c.strokeStyle = cssVar("--baseline");
    c.stroke();
    c.restore();
  },
};

function baseOptions({ yFmt, yTitle } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: true,
        position: "top",
        align: "start",
        labels: {
          color: cssVar("--text-secondary"),
          boxWidth: 12,
          boxHeight: 12,
          padding: 14,
          font: { size: 12.5 },
        },
      },
      tooltip: { enabled: false, external: externalTooltip },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: cssVar("--baseline") },
        ticks: { color: cssVar("--text-muted"), font: { size: 12 } },
      },
      y: {
        grid: { color: cssVar("--gridline"), drawTicks: false },
        border: { display: false },
        title: yTitle
          ? { display: true, text: yTitle, color: cssVar("--text-muted"), font: { size: 11.5 } }
          : { display: false },
        ticks: {
          color: cssVar("--text-muted"),
          font: { size: 12 },
          padding: 8,
          callback: (v) => (yFmt ? yFmt(v) : fmtNumber(v)),
        },
      },
    },
  };
}

function lineDataset(company, data, fmt) {
  const color = companyColor(company);
  return {
    label: COMPANIES[company].name,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    tension: 0,
    spanGaps: true,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointBorderWidth: 2,
    pointBorderColor: cssVar("--surface-1"),
    pointBackgroundColor: color,
    _fmt: fmt,
  };
}

function barDataset(company, data, fmt, colorOverride) {
  const color = colorOverride || companyColor(company);
  return {
    label: COMPANIES[company]?.name || company,
    data,
    backgroundColor: color,
    borderColor: color,
    borderRadius: 4,
    borderSkipped: "bottom",
    maxBarThickness: 24,
    categoryPercentage: 0.7,
    barPercentage: 0.8,
    _fmt: fmt,
  };
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

function mountChart(key, canvas, config) {
  destroyChart(key);
  state.charts[key] = new Chart(canvas, config);
}

function showEmpty(container, msg) {
  container.textContent = "";
  container.appendChild(el("div", "empty", msg));
}

/* ── 財務分頁 ───────────────────────────── */

function renderKpis() {
  const box = document.getElementById("kpi-row");
  box.textContent = "";
  const rows = visibleQuarters();
  if (!rows.length) {
    showEmpty(box, "尚無資料 — 請先執行 scripts/build_manifest.py，並確認 data/ 底下有季度 JSON。");
    return;
  }

  for (const company of Object.keys(COMPANIES)) {
    if (!state.selected.has(company)) continue;
    const recs = rows.filter((r) => r.company === company);
    if (!recs.length) continue;
    const latest = recs[recs.length - 1];
    const amount = resolveAmount(latest.financials, "revenue", company);
    const yoy = pickNumber(latest.financials, ["revenue_yoy_pct"]);

    const tile = el("div", "stat-tile");
    const label = el("div", "stat-label");
    const key = el("span", "key");
    key.style.background = companyColor(company);
    label.append(key, document.createTextNode(`${COMPANIES[company].name} 營收`));

    const value = el("div", "stat-value");
    if (amount) {
      value.textContent = fmtNumber(amount.value, amount.scale === "t" ? 2 : 0);
      value.appendChild(el("span", "stat-unit", amount.unit));
    } else {
      value.textContent = "—";
      value.appendChild(el("span", "stat-unit", "查無公開數字"));
    }

    const delta = el("div", "stat-delta");
    if (Number.isFinite(yoy)) {
      delta.appendChild(el("span", yoy >= 0 ? "up" : "down", fmtPct(yoy)));
      delta.appendChild(document.createTextNode(" 年增"));
    } else {
      delta.appendChild(el("span", "na", "年增率 —"));
    }

    tile.append(label, value, delta,
      el("div", "stat-period", `${latest.period_label || latest._cal.label}　公布日 ${latest.report_date || "—"}`));
    if (latest.reporting_scope) {
      tile.appendChild(el("div", "stat-period", `口徑：${latest.reporting_scope}`));
    }
    box.appendChild(tile);
  }
}

function renderRevenueIndex() {
  const canvas = document.getElementById("chart-revenue-index");
  const rows = visibleQuarters();
  const labels = quarterLabels(rows);
  const datasets = [];

  for (const company of Object.keys(COMPANIES)) {
    if (!state.selected.has(company)) continue;
    const recs = rows.filter((r) => r.company === company);
    const series = recs.map((r) => resolveAmount(r.financials, "revenue", company)?.value ?? null);
    const base = series.find((v) => Number.isFinite(v) && v !== 0);
    if (!base) continue;
    const byLabel = new Map();
    recs.forEach((r, i) => {
      const v = series[i];
      byLabel.set(r._cal.label, Number.isFinite(v) ? (v / base) * 100 : null);
    });
    datasets.push(
      lineDataset(company, labels.map((l) => byLabel.get(l) ?? null), (v) => v.toFixed(1))
    );
  }

  destroyChart("revenueIndex");
  if (!datasets.length) return;
  mountChart("revenueIndex", canvas, {
    type: "line",
    data: { labels, datasets },
    options: baseOptions({ yFmt: (v) => fmtNumber(v), yTitle: "指數（首季 = 100）" }),
    plugins: [crosshairPlugin],
  });
}

function renderSmallMultiples(containerId, chartPrefix, valueFn, unitFn) {
  const container = document.getElementById(containerId);
  container.textContent = "";
  const rows = visibleQuarters();
  let drew = 0;

  for (const company of Object.keys(COMPANIES)) {
    if (!state.selected.has(company)) continue;
    const recs = rows.filter((r) => r.company === company);
    const values = recs.map(valueFn);

    const card = el("div");
    const head = el("div", "stat-label");
    const key = el("span", "key");
    key.style.background = companyColor(company);
    head.append(key, document.createTextNode(`${COMPANIES[company].name}　${unitFn(recs) || ""}`));

    // 沒有資料時明確畫出「未揭露」，不要讓該公司從畫面上悄悄消失
    if (!values.some((v) => Number.isFinite(v))) {
      card.appendChild(head);
      card.appendChild(el("div", "empty", "該公司未揭露此項目"));
      container.appendChild(card);
      drew += 1;
      continue;
    }

    const box = el("div", "chart-box short");
    const canvas = document.createElement("canvas");
    box.appendChild(canvas);
    card.append(head, box);
    container.appendChild(card);

    const opts = baseOptions({ yFmt: (v) => fmtNumber(v) });
    opts.plugins.legend.display = false;
    mountChart(`${chartPrefix}-${company}`, canvas, {
      type: "bar",
      data: {
        labels: recs.map((r) => r.period_label || r._cal.label),
        datasets: [barDataset(company, values, (v) => fmtNumber(v, 1))],
      },
      options: opts,
    });
    drew += 1;
  }

  if (!drew) showEmpty(container, "此項目目前查無公開數字。");
}

function renderMargin() {
  const canvas = document.getElementById("chart-margin");
  const rows = visibleQuarters();
  const labels = quarterLabels(rows);
  const datasets = [];

  for (const company of Object.keys(COMPANIES)) {
    if (!state.selected.has(company)) continue;
    const recs = rows.filter((r) => r.company === company);
    const byLabel = new Map(
      recs.map((r) => [
        r._cal.label,
        pickNumber(r.financials, ["operating_margin_pct", "gross_margin_pct"]),
      ])
    );
    if (![...byLabel.values()].some((v) => Number.isFinite(v))) continue;
    datasets.push(
      lineDataset(company, labels.map((l) => byLabel.get(l) ?? null), (v) => `${v.toFixed(1)}%`)
    );
  }

  destroyChart("margin");
  const box = document.getElementById("margin-box");
  if (!datasets.length) {
    showEmpty(box, "目前查無可比較的獲利率數字。");
    return;
  }
  if (!box.querySelector("canvas")) {
    box.textContent = "";
    box.appendChild(canvas);
  }
  mountChart("margin", canvas, {
    type: "line",
    data: { labels, datasets },
    options: baseOptions({ yFmt: (v) => `${v}%`, yTitle: "營業利益率／毛利率 (%)" }),
    plugins: [crosshairPlugin],
  });
}

function renderMix() {
  const container = document.getElementById("mix-small-multiples");
  container.textContent = "";
  const rows = visibleQuarters();
  let drew = 0;

  for (const company of Object.keys(COMPANIES)) {
    if (!state.selected.has(company)) continue;
    const recs = rows.filter((r) => r.company === company);
    const dram = recs.map((r) => pickNumber(r.financials, ["dram_revenue_share_pct"]));
    const nand = recs.map((r) => pickNumber(r.financials, ["nand_revenue_share_pct"]));

    const card = el("div");
    const head = el("div", "stat-label");
    const key = el("span", "key");
    key.style.background = companyColor(company);
    head.append(key, document.createTextNode(`${COMPANIES[company].name}　營收占比 (%)`));

    if (![...dram, ...nand].some((v) => Number.isFinite(v))) {
      card.appendChild(head);
      card.appendChild(el("div", "empty", "該公司未揭露 DRAM/NAND 營收占比"));
      container.appendChild(card);
      drew += 1;
      continue;
    }

    const box = el("div", "chart-box short");
    const canvas = document.createElement("canvas");
    box.appendChild(canvas);
    card.append(head, box);
    container.appendChild(card);

    const color = companyColor(company);
    const opts = baseOptions({ yFmt: (v) => `${v}%` });
    opts.scales.y.stacked = true;
    opts.scales.x.stacked = true;
    opts.scales.y.max = 100;

    mountChart(`mix-${company}`, canvas, {
      type: "bar",
      data: {
        labels: recs.map((r) => r.period_label || r._cal.label),
        datasets: [
          {
            ...barDataset(company, dram, (v) => `${v}%`, color),
            label: "DRAM",
            borderRadius: 0,
            borderWidth: 1,
            borderColor: cssVar("--surface-1"),
          },
          {
            ...barDataset(company, nand, (v) => `${v}%`, cssVar("--diverge-mid")),
            label: "NAND",
            borderRadius: 4,
            borderWidth: 1,
            borderColor: cssVar("--surface-1"),
          },
        ],
      },
      options: opts,
    });
    drew += 1;
  }

  if (!drew) showEmpty(container, "各家尚未揭露可比較的 DRAM/NAND 營收占比。");
}

/* ── Guidance 分頁 ──────────────────────── */

function renderGuidance() {
  const table = document.getElementById("guidance-table");
  table.textContent = "";
  const rows = visibleQuarters();
  if (!rows.length) {
    table.appendChild(el("caption", "empty", "尚無資料。"));
    return;
  }

  const thead = el("thead");
  const hr = el("tr");
  ["公司", "期間", "次季營收財測", "次季毛利率財測", "Capex 計畫", "展望摘要"].forEach((h) =>
    hr.appendChild(el("th", null, h))
  );
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((r) => {
    const g = r.guidance || {};
    const tr = el("tr");

    const range = (arr, suffix) =>
      Array.isArray(arr) && arr.some((v) => Number.isFinite(v))
        ? `${fmtNumber(arr[0], 0)} – ${fmtNumber(arr[1], 0)}${suffix}`
        : "—";

    tr.append(
      companyTagCell(r.company),
      el("td", "tight", r.period_label || r._cal.label),
      el("td", "num", range(g.next_period_revenue_range_usd_m, " 百萬美元")),
      el("td", "num", range(g.next_period_gross_margin_range_pct, "%")),
      el("td", "num", Number.isFinite(g.capex_plan_usd_m) ? fmtNumber(g.capex_plan_usd_m) : "—"),
      longTextCell(g.commentary_summary)
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

/** 把各家用字不同的 topic 收斂成幾個主題，才能跨公司比對同一件事。
    順序＝判斷優先序，必須「具體主題在前」：像「需求」「supply」這種字幾乎每句都有，
    放前面會把所有發言都吸進同一桶，主題分組就失去意義。 */
const TOPIC_GROUPS = [
  { name: "HBM", match: /HBM/i },
  { name: "報價與 ASP", match: /報價|價格|售價|漲價|跌價|ASP|pricing|\bprice/i },
  { name: "擴產與 Capex", match: /capex|資本支出|擴產|新廠|產線|設備|fab|EUV|wafer|投片/i },
  { name: "位元出貨與庫存", match: /位元|出貨|bit growth|bit shipment|庫存|inventory/i },
  { name: "售罄與長約", match: /售罄|賣光|sold out|長約|LTA|long-term agreement|鎖定|包量/i },
  { name: "供需與需求展望", match: /供需|供給|供應|需求|短缺|吃緊|demand|supply|shortage|tight/i },
];

function topicGroupOf(text) {
  const hit = TOPIC_GROUPS.find((g) => g.match.test(text || ""));
  return hit ? hit.name : "其他";
}

function renderCommentary() {
  const container = document.getElementById("commentary-list");
  container.textContent = "";
  const rows = visibleQuarters().filter(
    (r) => Array.isArray(r.management_commentary) && r.management_commentary.length
  );
  if (!rows.length) {
    showEmpty(container, "尚無管理層說法資料。");
    return;
  }

  // 攤平成單筆發言，依主題分組；同主題內依時間新到舊，看得出說法怎麼演變
  const items = [];
  rows.forEach((r) => {
    r.management_commentary.forEach((c) => {
      items.push({
        company: r.company,
        quarter: r._cal.label,
        period: r.period_label,
        sortKey: sortKey(r),
        speaker: c.speaker,
        topic: c.topic,
        summary: c.summary,
        group: topicGroupOf(`${c.topic || ""} ${c.summary || ""}`),
      });
    });
  });

  const order = [...TOPIC_GROUPS.map((g) => g.name), "其他"];
  order.forEach((groupName) => {
    const group = items
      .filter((i) => i.group === groupName)
      .sort((a, b) => b.sortKey - a.sortKey);
    if (!group.length) return;

    const card = el("div", "card");
    const head = el("div", "card-head");
    head.appendChild(el("h2", null, groupName));
    head.appendChild(el("span", "note", `${group.length} 則`));
    card.appendChild(head);

    group.forEach((i) => {
      const block = el("div", "quote-block");
      const meta = el("div", "quote-speaker");
      const key = el("span", "key");
      key.style.background = companyColor(i.company);
      key.style.display = "inline-block";
      key.style.width = "9px";
      key.style.height = "9px";
      key.style.borderRadius = "3px";
      key.style.marginRight = "6px";
      meta.append(
        key,
        document.createTextNode(
          [COMPANIES[i.company].name, i.period || i.quarter, i.speaker, i.topic]
            .filter(Boolean)
            .join("　·　")
        )
      );
      block.appendChild(meta);
      block.appendChild(el("div", null, i.summary || ""));
      card.appendChild(block);
    });
    container.appendChild(card);
  });
}

/* ── 投行分頁 ───────────────────────────── */

function renderBrokers() {
  const table = document.getElementById("broker-table");
  table.textContent = "";
  const rows = state.brokers.filter((b) => state.selected.has(b.company));
  if (!rows.length) {
    table.appendChild(el("caption", "empty", "尚無投行觀點資料（公開新聞覆蓋度有限）。"));
    return;
  }

  const thead = el("thead");
  const hr = el("tr");
  ["日期", "機構", "標的", "評等", "目標價", "前次目標價", "論點摘要", "出處"].forEach((h) =>
    hr.appendChild(el("th", null, h))
  );
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((b) => {
    const tr = el("tr", "broker-row");
    const tdRating = el("td", "tight");
    if (b.rating) {
      const pill = el("span", "rating-pill", b.rating + (b.rating_change && b.rating_change !== "maintained" ? `（${b.rating_change}）` : ""));
      tdRating.appendChild(pill);
    } else {
      tdRating.appendChild(el("span", "na", "—"));
    }

    const tdSrc = el("td", "tight");
    if (b.source?.url) {
      const a = el("a", "src-link", b.source.publisher || "連結");
      a.href = b.source.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      tdSrc.appendChild(a);
    } else {
      tdSrc.appendChild(el("span", "na", "—"));
    }

    tr.append(
      el("td", "tight", b.date || "—"),
      el("td", "bank tight", b.bank || "—"),
      companyTagCell(b.company),
      tdRating,
      el("td", "num", b.price_target || "—"),
      el("td", "num", b.prior_price_target || "—"),
      longTextCell(b.thesis_summary),
      tdSrc
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

/* ── 供給與供需分頁（主視圖） ───────────── */

function renderUpcoming() {
  const table = document.getElementById("upcoming-table");
  table.textContent = "";
  const events = (state.upcoming || [])
    .filter((e) => state.selected.has(e.company))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!events.length) {
    table.appendChild(el("caption", "empty", "尚無排程資料。"));
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const thead = el("thead");
  const hr = el("tr");
  ["日期", "倒數", "公司", "場次", "涵蓋期間", "備註"].forEach((h) =>
    hr.appendChild(el("th", "tight", h))
  );
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  events.forEach((e) => {
    const tr = el("tr");
    const days = Math.round(
      (new Date(e.date) - new Date(today)) / 86400000
    );

    const tdDate = el("td", "tight");
    tdDate.appendChild(el("div", null, e.date));
    if (!e.confirmed) tdDate.appendChild(el("div", "quote-speaker", "日期推估"));

    const tdCount = el("td", "tight");
    tdCount.textContent = days > 0 ? `還有 ${days} 天` : days === 0 ? "就是今天" : "已公布";

    const tdLabel = el("td", "tight");
    tdLabel.appendChild(el("div", null, e.label || "—"));
    if (e.source_url) {
      const a = el("a", "src-link", "出處");
      a.href = e.source_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      tdLabel.appendChild(a);
    }

    tr.append(tdDate, tdCount, companyTagCell(e.company), tdLabel,
      el("td", null, e.covers || "—"), longTextCell(e.note));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderDivergences() {
  const container = document.getElementById("divergence-list");
  container.textContent = "";
  const items = (state.divergences || []).filter((i) =>
    (i.companies || []).some((c) => state.selected.has(c))
  );
  if (!items.length) {
    showEmpty(container, "尚無分歧觀察資料。");
    return;
  }

  items.forEach((i) => {
    const block = el("div", "quote-block");
    const meta = el("div", "quote-speaker");
    (i.companies || []).forEach((c) => {
      const key = el("span", "key");
      key.style.background = companyColor(c);
      key.style.display = "inline-block";
      key.style.width = "9px";
      key.style.height = "9px";
      key.style.borderRadius = "3px";
      key.style.marginRight = "4px";
      meta.appendChild(key);
    });
    meta.appendChild(document.createTextNode(` ${i.quarter}　·　${i.topic}`));
    block.appendChild(meta);

    const headline = el("div", null, i.headline);
    headline.style.fontWeight = "620";
    headline.style.margin = "2px 0 4px";
    block.appendChild(headline);
    block.appendChild(el("div", null, i.detail));

    if ((i.supporting || []).length) {
      block.appendChild(el("div", "quote-speaker", `依據：${i.supporting.join("、")}`));
    }
    container.appendChild(block);
  });
}

/* 供需鬆緊是有序刻度，越緊越深；顏色只輔助，狀態文字永遠在，不靠顏色單獨傳達 */
const TIGHTNESS = [
  { label: "供不應求", varName: "--tight-4" },
  { label: "偏緊", varName: "--tight-3" },
  { label: "供需平衡", varName: "--tight-2" },
  { label: "供給寬鬆", varName: "--tight-1" },
];

function tightnessColor(status) {
  const hit = TIGHTNESS.find((t) => status && status.includes(t.label));
  return hit ? cssVar(hit.varName) : cssVar("--text-muted");
}

function statusBadge(status) {
  const wrap = el("span", "company-tag");
  const key = el("span", "key");
  key.style.background = tightnessColor(status);
  wrap.append(key, document.createTextNode(status || "—"));
  return wrap;
}

/** 季度 × 公司的樞紐表：列是季度（新到舊），欄是公司 */
function quarterPivot(table, cellFn, emptyMsg) {
  table.textContent = "";
  const rows = visibleQuarters();
  const companies = Object.keys(COMPANIES).filter((c) => state.selected.has(c));
  if (!rows.length) {
    table.appendChild(el("caption", "empty", emptyMsg));
    return;
  }

  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", "tight", "日曆季"));
  companies.forEach((c) => {
    const th = el("th");
    const tag = el("span", "company-tag");
    const key = el("span", "key");
    key.style.background = companyColor(c);
    tag.append(key, document.createTextNode(COMPANIES[c].name));
    th.appendChild(tag);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  quarterLabels(rows)
    .reverse()
    .forEach((label) => {
      const tr = el("tr");
      const tdLabel = el("td", "tight");
      tdLabel.appendChild(el("div", null, label));
      tr.appendChild(tdLabel);
      companies.forEach((c) => {
        const rec = rows.find((r) => r.company === c && r._cal.label === label);
        if (!rec) {
          const td = el("td");
          td.appendChild(el("span", "na", "該季無資料"));
          tr.appendChild(td);
          return;
        }
        const td = cellFn(rec) || el("td");
        if (rec.period_label && rec.period_label !== label) {
          td.appendChild(el("div", "quote-speaker", rec.period_label));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
}

function clampedDiv(text) {
  const body = el("div", "clamp", text);
  const toggle = el("div", "clamp-more", "展開 ▾");
  const flip = () => {
    const open = body.classList.toggle("open");
    toggle.textContent = open ? "收合 ▴" : "展開 ▾";
  };
  body.addEventListener("click", flip);
  toggle.addEventListener("click", flip);
  const frag = document.createDocumentFragment();
  frag.append(body, toggle);
  return frag;
}

function renderSupplyBalance() {
  quarterPivot(
    document.getElementById("supply-balance-table"),
    (rec) => {
      const sd = rec.supply?.supply_demand_balance || {};
      const td = el("td", "wide");
      td.appendChild(statusBadge(sd.status));
      if (sd.statement) td.appendChild(clampedDiv(sd.statement));
      return td;
    },
    "尚無供需說法資料。"
  );
}

function renderPricing() {
  quarterPivot(
    document.getElementById("pricing-table"),
    (rec) => {
      const p = rec.supply?.pricing_direction || {};
      const td = el("td", "wide");
      if (p.dram) td.appendChild(el("div", null, `DRAM：${p.dram}`));
      if (p.nand) td.appendChild(el("div", null, `NAND：${p.nand}`));
      if (!p.dram && !p.nand) td.appendChild(el("span", "na", "未提及"));
      if (p.statement) td.appendChild(clampedDiv(p.statement));
      return td;
    },
    "尚無報價方向資料。"
  );
}

function renderSoldOut() {
  quarterPivot(
    document.getElementById("soldout-table"),
    (rec) => {
      const s = rec.supply || {};
      const td = el("td", "wide");
      if (s.sold_out_status) {
        td.appendChild(el("div", "quote-speaker", "售罄狀態"));
        td.appendChild(el("div", null, s.sold_out_status));
      }
      if (s.lta_status) {
        td.appendChild(el("div", "quote-speaker", "長約 LTA"));
        td.appendChild(el("div", null, s.lta_status));
      }
      if (!s.sold_out_status && !s.lta_status) td.appendChild(el("span", "na", "未提及"));
      return td;
    },
    "尚無售罄／長約資料。"
  );
}

function renderSupplyMatrix() {
  const table = document.getElementById("supply-matrix-table");
  table.textContent = "";
  const rows = visibleQuarters().slice().reverse();
  if (!rows.length) {
    table.appendChild(el("caption", "empty", "尚無資料。"));
    return;
  }

  const thead = el("thead");
  const hr = el("tr");
  ["日曆季", "公司", "期間", "供需狀態", "DRAM 位元成長", "NAND 位元成長", "Capex 方向", "Capex 計畫", "HBM 進度"].forEach(
    (h) => hr.appendChild(el("th", "tight", h))
  );
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((r) => {
    const s = r.supply || {};
    const bg = s.bit_growth_guidance || {};
    const tr = el("tr");

    const tdStatus = el("td", "tight");
    tdStatus.appendChild(statusBadge(s.supply_demand_balance?.status));

    const dram = [bg.dram_next_quarter, bg.dram_full_year].filter(Boolean).join("　/　");
    const nand = [bg.nand_next_quarter, bg.nand_full_year].filter(Boolean).join("　/　");

    tr.append(
      el("td", "tight", r._cal.label),
      companyTagCell(r.company),
      el("td", "tight", r.period_label || "—"),
      tdStatus,
      el("td", null, dram || "—"),
      el("td", null, nand || "—"),
      el("td", "tight", s.capex_direction || "—"),
      longTextCell(s.capex_plan_text),
      longTextCell(s.hbm_progress)
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderCapacityTimeline() {
  const container = document.getElementById("capacity-timeline");
  container.textContent = "";
  const rows = visibleQuarters().slice().reverse();
  const withActions = rows.filter((r) => (r.supply?.capacity_actions || []).length);
  if (!withActions.length) {
    showEmpty(container, "尚無擴產／產能動作資料。");
    return;
  }

  const byQuarter = new Map();
  withActions.forEach((r) => {
    if (!byQuarter.has(r._cal.label)) byQuarter.set(r._cal.label, []);
    byQuarter.get(r._cal.label).push(r);
  });

  byQuarter.forEach((recs, label) => {
    const section = el("div");
    const heading = el("h3", null, label);
    heading.style.fontSize = "14px";
    section.appendChild(heading);
    const grid = el("div", "grid-3");
    recs.forEach((r) => {
      const card = el("div", "stat-tile");
      const head = el("div", "stat-label");
      const key = el("span", "key");
      key.style.background = companyColor(r.company);
      head.append(key, document.createTextNode(`${COMPANIES[r.company].name}　${r.period_label || ""}`));
      card.appendChild(head);
      (r.supply.capacity_actions || []).forEach((a) => {
        const block = el("div", "quote-block");
        block.appendChild(
          el("div", "quote-speaker", [a.type, a.timing].filter(Boolean).join("　·　"))
        );
        block.appendChild(el("div", null, a.action || ""));
        if (a.detail) block.appendChild(el("div", "quote-speaker", a.detail));
        card.appendChild(block);
      });
      grid.appendChild(card);
    });
    section.appendChild(grid);
    container.appendChild(section);
  });
}

/* ── （已移除股價反應分頁：改以供給面為主軸） ── */

/* ── 原始資料分頁 ───────────────────────── */

function renderRaw() {
  const table = document.getElementById("raw-table");
  table.textContent = "";
  const rows = visibleQuarters();
  if (!rows.length) {
    table.appendChild(el("caption", "empty", "尚無資料。"));
    return;
  }

  const cols = [
    ["公司", (r) => COMPANIES[r.company].name],
    ["期間", (r) => r.period_label || r._cal.label],
    ["對應日曆季", (r) => r._cal.label],
    ["公布日", (r) => r.report_date || "—"],
    ["營收", (r) => {
      const a = resolveAmount(r.financials, "revenue", r.company);
      return a ? `${fmtNumber(a.value, a.scale === "t" ? 2 : 0)} ${a.unit}` : "—";
    }],
    ["年增", (r) => fmtPct(pickNumber(r.financials, ["revenue_yoy_pct"]))],
    ["季增", (r) => fmtPct(pickNumber(r.financials, ["revenue_qoq_pct"]))],
    ["毛利率", (r) => fmtPct(pickNumber(r.financials, ["gross_margin_pct"]))],
    ["營益率", (r) => fmtPct(pickNumber(r.financials, ["operating_margin_pct"]))],
    ["Capex", (r) => {
      const a = resolveAmount(r.financials, "capex", r.company);
      return a ? `${fmtNumber(a.value, 0)} ${a.unit}` : "—";
    }],
    ["DRAM 占比", (r) => fmtPct(pickNumber(r.financials, ["dram_revenue_share_pct"]))],
    ["NAND 占比", (r) => fmtPct(pickNumber(r.financials, ["nand_revenue_share_pct"]))],
  ];
  const NOTES_COL = "資料備註";

  const thead = el("thead");
  const hr = el("tr");
  cols.forEach(([h]) => hr.appendChild(el("th", "tight", h)));
  hr.appendChild(el("th", null, NOTES_COL));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((r) => {
    const tr = el("tr");
    cols.forEach(([, fn], i) => tr.appendChild(el("td", i >= 4 ? "num" : "tight", fn(r))));
    tr.appendChild(longTextCell(r.financials?.notes));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // 出處清單
  const list = document.getElementById("sources-list");
  list.textContent = "";
  const seen = new Set();
  rows.forEach((r) => {
    (r.sources || []).forEach((s) => {
      if (!s?.url || seen.has(s.url)) return;
      seen.add(s.url);
      const line = el("div", "quote-block");
      const a = el("a", "src-link", s.title || s.url);
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      line.appendChild(a);
      line.appendChild(el("div", "quote-speaker",
        [s.publisher, s.accessed_date ? `取用 ${s.accessed_date}` : null].filter(Boolean).join("　·　")));
      list.appendChild(line);
    });
  });
  if (!seen.size) showEmpty(list, "尚無出處資料。");
}

/* ── 總渲染 ─────────────────────────────── */

function renderAll() {
  renderKpis();
  renderRevenueIndex();
  renderSmallMultiples(
    "revenue-small-multiples",
    "revenue",
    (r) => resolveAmount(r.financials, "revenue", r.company)?.value ?? null,
    (recs) => resolveAmount(recs[0]?.financials, "revenue", recs[0]?.company)?.unit || ""
  );
  renderMargin();
  renderSmallMultiples(
    "capex-small-multiples",
    "capex",
    (r) => resolveAmount(r.financials, "capex", r.company)?.value ?? null,
    (recs) => resolveAmount(recs[0]?.financials, "capex", recs[0]?.company)?.unit || ""
  );
  renderMix();
  renderGuidance();
  renderCommentary();
  renderBrokers();
  renderUpcoming();
  renderDivergences();
  renderSupplyBalance();
  renderSupplyMatrix();
  renderPricing();
  renderCapacityTimeline();
  renderSoldOut();
  renderRaw();
}

/* ── 互動 ───────────────────────────────── */

document.getElementById("filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const company = chip.dataset.company;
  if (state.selected.has(company)) {
    if (state.selected.size === 1) return; // 至少留一家
    state.selected.delete(company);
    chip.setAttribute("aria-pressed", "false");
  } else {
    state.selected.add(company);
    chip.setAttribute("aria-pressed", "true");
  }
  renderAll();
});

document.getElementById("range-select").addEventListener("change", (e) => {
  state.range = e.target.value;
  renderAll();
});

document.getElementById("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", "false"));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  tab.setAttribute("aria-selected", "true");
  document.getElementById(tab.dataset.panel).hidden = false;
  Object.values(state.charts).forEach((c) => c.resize());
});

document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const isDark =
    root.dataset.theme === "dark" ||
    (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = isDark ? "light" : "dark";
  renderAll(); // 深淺色不是把顏色反轉，而是各自重新取色後重畫
});

loadAll();
