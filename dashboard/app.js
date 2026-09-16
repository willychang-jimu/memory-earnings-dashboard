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
  divergences: [],
  upcoming: [],
  selected: new Set(Object.keys(COMPANIES)),
  range: "all",
  charts: {},
  exportSelection: new Set(), // 要匯出成簡報的區塊（以 data-export-title 為 key）
  collapsedQuarters: new Set(), // 收折起來的季度；預設只展開最新一季
  collapsedInit: false,
  search: "",      // 搜尋關鍵字
  hits: [],        // 目前標黃的節點
  hitIndex: -1,    // 「下一筆」跳到第幾個
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
  const chart = new Chart(canvas, config);
  // 保留建立時的原始 config：匯出簡報時要用它重建圖表。
  // 不能用 chart.options，那是 Chart.js 解析過的 proxy，重用會觸發
  // "Recursion detected: _scriptable->_scriptable"。
  chart.$sourceConfig = config;
  state.charts[key] = chart;
}

function showEmpty(container, msg) {
  container.textContent = "";
  container.appendChild(el("div", "empty", msg));
}

/* ── 財務分頁 ───────────────────────────── */

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
    card.dataset.exportTitle = `管理層說法 · ${groupName}`;
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

/* ── 各季度分頁（主視圖） ───────────────── */

function fieldRow(label, value) {
  if (value === null || value === undefined || value === "") return null;
  const row = el("div", "field-row");
  row.appendChild(el("div", "field-label", label));
  const box = el("div", "field-value");
  if (typeof value === "string") box.textContent = value;
  else box.appendChild(value);
  row.appendChild(box);
  return row;
}

function listNode(items, renderItem) {
  const frag = document.createDocumentFragment();
  items.forEach((it) => frag.appendChild(renderItem(it)));
  return frag;
}

function renderQuarters() {
  const container = document.getElementById("quarters-list");
  container.textContent = "";
  const rows = visibleQuarters();
  if (!rows.length) {
    showEmpty(container, "尚無資料。");
    return;
  }

  const labels = quarterLabels(rows).reverse(); // 新到舊
  const latest = labels[0];

  // 第一次渲染時，除了最新一季以外預設收折
  if (!state.collapsedInit) {
    labels.slice(1).forEach((l) => state.collapsedQuarters.add(l));
    state.collapsedInit = true;
  }

  labels.forEach((label) => {
    const recs = rows.filter((r) => r._cal.label === label);
    const section = el("div", "quarter-section");
    const heading = el("div", "quarter-heading");

    const collapsed = state.collapsedQuarters.has(label);
    const toggle = el("button", "quarter-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "▸" : "▾";

    const h = el("h2", null, label);
    if (label === latest) heading.appendChild(el("span", "latest-badge", "最新"));

    const sub = el("span", "sub",
      `${recs.length} 家　·　${recs.map((r) => COMPANIES[r.company].name).join("、")}`);

    // 整季一次勾選：季度層級的勾選框會連動這一季底下所有公司卡片
    const titlesOfQuarter = recs.map((r) => `${label}　${COMPANIES[r.company].name}`);
    const selectAll = el("label", "export-check quarter-select");
    const cbAll = document.createElement("input");
    cbAll.type = "checkbox";
    cbAll.checked = titlesOfQuarter.every((t) => state.exportSelection.has(t));
    cbAll.addEventListener("change", () => {
      titlesOfQuarter.forEach((t) => {
        if (cbAll.checked) state.exportSelection.add(t);
        else state.exportSelection.delete(t);
      });
      attachExportCheckboxes();
    });
    selectAll.append(cbAll, document.createTextNode("整季選入簡報"));

    heading.append(toggle, h, sub, selectAll);
    section.appendChild(heading);

    const body = el("div", "quarter-body");
    body.hidden = collapsed;
    toggle.addEventListener("click", () => {
      const nowCollapsed = !body.hidden;
      body.hidden = nowCollapsed;
      toggle.textContent = nowCollapsed ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!nowCollapsed));
      if (nowCollapsed) state.collapsedQuarters.add(label);
      else state.collapsedQuarters.delete(label);
    });

    recs.forEach((r) => {
      const s = r.supply || {};
      const g = r.guidance || {};
      const fin = r.financials || {};
      const card = el("div", "quarter-card");
      card.dataset.exportTitle = `${label}　${COMPANIES[r.company].name}`;

      const head = el("div", "card-head");
      const title = el("h2");
      const key = el("span", "key");
      key.style.background = companyColor(r.company);
      key.style.display = "inline-block";
      key.style.width = "11px";
      key.style.height = "11px";
      key.style.borderRadius = "3px";
      key.style.marginRight = "8px";
      title.append(key, document.createTextNode(COMPANIES[r.company].name));
      head.appendChild(title);
      head.appendChild(
        el("span", "note", `${r.period_label || label}　·　公布日 ${r.report_date || "—"}`)
      );
      card.appendChild(head);
      if (r.reporting_scope) card.appendChild(el("p", "note", `口徑：${r.reporting_scope}`));

      const balance = s.supply_demand_balance || {};
      const bg = s.bit_growth_guidance || {};
      const pricing = s.pricing_direction || {};

      const add = (node) => { if (node) card.appendChild(node); };

      if (balance.status) {
        const box = el("div");
        box.appendChild(statusBadge(balance.status));
        if (balance.statement) box.appendChild(el("div", null, balance.statement));
        add(fieldRow("供需狀態", box));
      }

      if (pricing.dram || pricing.nand || pricing.statement) {
        const box = el("div");
        const dirs = [pricing.dram ? `DRAM：${pricing.dram}` : null, pricing.nand ? `NAND：${pricing.nand}` : null]
          .filter(Boolean).join("　·　");
        if (dirs) box.appendChild(el("div", null, dirs));
        if (pricing.statement) box.appendChild(el("div", "note", pricing.statement));
        add(fieldRow("報價方向", box));
      }

      const bits = [
        bg.dram_next_quarter ? `DRAM 次季：${bg.dram_next_quarter}` : null,
        bg.nand_next_quarter ? `NAND 次季：${bg.nand_next_quarter}` : null,
        bg.dram_full_year ? `DRAM 全年：${bg.dram_full_year}` : null,
        bg.nand_full_year ? `NAND 全年：${bg.nand_full_year}` : null,
      ].filter(Boolean);
      if (bits.length || bg.note) {
        const box = el("div");
        bits.forEach((b) => box.appendChild(el("div", null, b)));
        if (bg.note) box.appendChild(el("div", "note", bg.note));
        add(fieldRow("位元出貨成長", box));
      }

      if (s.capex_direction || s.capex_plan_text) {
        const box = el("div");
        if (s.capex_direction) box.appendChild(el("div", null, s.capex_direction));
        if (s.capex_plan_text) box.appendChild(el("div", "note", s.capex_plan_text));
        add(fieldRow("Capex", box));
      }

      if ((s.capacity_actions || []).length) {
        add(fieldRow("擴產動作", listNode(s.capacity_actions, (a) => {
          const d = el("div");
          d.appendChild(el("span", null, a.action || ""));
          const meta = [a.type, a.timing].filter(Boolean).join("　·　");
          if (meta) d.appendChild(el("span", "note", `　（${meta}）`));
          if (a.detail) d.appendChild(el("div", "note", a.detail));
          return d;
        })));
      }

      if (s.sold_out_status) add(fieldRow("售罄狀態", s.sold_out_status));
      if (s.lta_status) add(fieldRow("長約 LTA", s.lta_status));
      if (s.hbm_progress) add(fieldRow("HBM 進度", s.hbm_progress));
      if (s.customer_allocation) add(fieldRow("客戶配置", s.customer_allocation));
      if (s.inventory_comment) add(fieldRow("庫存", s.inventory_comment));

      if ((r.management_commentary || []).length) {
        add(fieldRow("管理層發言", listNode(r.management_commentary, (c) => {
          const block = el("div", "quote-block");
          block.appendChild(el("div", "quote-speaker", [c.speaker, c.topic].filter(Boolean).join("　·　")));
          block.appendChild(el("div", null, c.summary || ""));
          return block;
        })));
      }

      if (g.commentary_summary) add(fieldRow("次季展望", g.commentary_summary));

      const amount = resolveAmount(fin, "revenue", r.company);
      const finBits = [
        amount ? `營收 ${fmtNumber(amount.value, amount.scale === "t" ? 2 : 0)} ${amount.unit}` : null,
        Number.isFinite(fin.revenue_yoy_pct) ? `年增 ${fmtPct(fin.revenue_yoy_pct)}` : null,
        Number.isFinite(fin.revenue_qoq_pct) ? `季增 ${fmtPct(fin.revenue_qoq_pct)}` : null,
        // 比率本身不是變化量，不該帶 +/- 號
        Number.isFinite(fin.operating_margin_pct) ? `營益率 ${fin.operating_margin_pct.toFixed(1)}%` : null,
        Number.isFinite(fin.gross_margin_pct) ? `毛利率 ${fin.gross_margin_pct.toFixed(1)}%` : null,
      ].filter(Boolean);
      if (finBits.length) add(fieldRow("關鍵財務", finBits.join("　·　")));

      if ((r.sources || []).length) {
        add(fieldRow("出處", listNode(r.sources.filter((x) => x?.url), (src) => {
          const d = el("div");
          const a = el("a", "src-link", src.title || src.url);
          a.href = src.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          d.appendChild(a);
          if (src.publisher) d.appendChild(el("span", "note", `　${src.publisher}`));
          return d;
        })));
      }

      body.appendChild(card);
    });

    section.appendChild(body);
    container.appendChild(section);
  });
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

/* ── 搜尋與螢光標記 ─────────────────────── */

/** 在已渲染的內容裡逐個文字節點找出關鍵字，包成 <mark> 標黃。
    直接改 DOM 而不是重組字串——用 innerHTML 拼接會破壞既有的事件處理，
    而且內容含使用者資料，拼 HTML 等於開一個注入破口。 */
function highlightMatches(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  const hits = [];
  document.querySelectorAll(".panel").forEach((panel) => {
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        // 勾選框的說明文字、已經標過的部分都不再處理
        if (parent.closest(".export-check") || parent.tagName === "MARK") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    targets.forEach((node) => {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      if (!lower.includes(q)) return;

      const frag = document.createDocumentFragment();
      let pos = 0;
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
        const mark = document.createElement("mark");
        mark.className = "hit";
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        hits.push(mark);
        pos = idx + q.length;
        idx = lower.indexOf(q, pos);
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    });
  });

  return hits;
}

/** 命中如果藏在收折的季度或收合的長文字裡就看不到，要自動打開 */
function revealHits(hits) {
  hits.forEach((mark) => {
    const clamp = mark.closest(".clamp");
    if (clamp && !clamp.classList.contains("open")) {
      clamp.classList.add("open");
      const toggle = clamp.parentElement?.querySelector(".clamp-more");
      if (toggle) toggle.textContent = "收合 ▴";
    }
    const body = mark.closest(".quarter-body");
    if (body?.hidden) {
      body.hidden = false;
      const section = body.closest(".quarter-section");
      const toggle = section?.querySelector(".quarter-toggle");
      const label = section?.querySelector("h2")?.textContent;
      if (toggle) {
        toggle.textContent = "▾";
        toggle.setAttribute("aria-expanded", "true");
      }
      if (label) state.collapsedQuarters.delete(label);
    }
  });
}

/** 分頁上顯示各自的命中數，否則使用者不會知道別的分頁也有結果 */
function updateTabBadges() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.querySelector(".tab-badge")?.remove();
    const panel = document.getElementById(tab.dataset.panel);
    const n = panel ? panel.querySelectorAll("mark.hit").length : 0;
    if (n) {
      const badge = el("span", "tab-badge", String(n));
      tab.appendChild(badge);
    }
  });
}

/** 把舊的標記還原成純文字。
    不能只靠 renderAll —— 卡片說明那類寫死在 index.html 的內容不會被重畫，
    舊標記會一直殘留，造成計數對不上、畫面上留著上一次搜尋的黃色。 */
function clearHighlights() {
  document.querySelectorAll("mark.hit").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
}

function applySearch() {
  const status = document.getElementById("search-status");
  const next = document.getElementById("search-next");
  const clear = document.getElementById("search-clear");
  const q = state.search;

  clearHighlights();
  state.hits = [];
  state.hitIndex = -1;
  clear.hidden = !q;

  if (!q) {
    status.textContent = "";
    next.hidden = true;
    updateTabBadges();
    return;
  }

  const hits = highlightMatches(q);
  revealHits(hits);
  updateTabBadges();

  state.hits = hits;

  if (!hits.length) {
    status.textContent = "找不到符合的內容";
    next.hidden = true;
    return;
  }

  const activePanel = document.querySelector(".panel:not([hidden])");
  const inThisTab = activePanel ? activePanel.querySelectorAll("mark.hit").length : 0;
  status.textContent = `找到 ${hits.length} 筆${
    inThisTab === hits.length ? "" : `（本分頁 ${inThisTab} 筆，其餘在其他分頁）`
  }`;
  next.hidden = false;
}

/** 跳到下一筆命中；跨分頁時自動切換分頁 */
function gotoNextHit() {
  const hits = state.hits || [];
  if (!hits.length) return;
  state.hitIndex = (state.hitIndex + 1) % hits.length;
  const mark = hits[state.hitIndex];
  if (!mark.isConnected) return;

  hits.forEach((m) => m.classList.remove("current"));
  mark.classList.add("current");

  const panel = mark.closest(".panel");
  if (panel?.hidden) {
    const tab = document.querySelector(`.tab[data-panel="${panel.id}"]`);
    tab?.click();
  }
  mark.scrollIntoView({ block: "center", behavior: "smooth" });

  const status = document.getElementById("search-status");
  status.textContent = `第 ${state.hitIndex + 1} / ${hits.length} 筆`;
}

/* ── 匯出勾選 ───────────────────────────── */

/* 以 data-export-title 當 key，重繪後勾選狀態才不會掉 */
function attachExportCheckboxes() {
  document.querySelectorAll("[data-export-title]").forEach((block) => {
    const title = block.dataset.exportTitle;
    let head = block.querySelector(".card-head");
    if (!head) {
      head = el("div", "card-head");
      block.insertBefore(head, block.firstChild);
    }
    let label = head.querySelector(".export-check");
    if (!label) {
      label = el("label", "export-check");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", () => {
        if (cb.checked) state.exportSelection.add(title);
        else state.exportSelection.delete(title);
        block.classList.toggle("is-selected", cb.checked);
        syncQuarterCheckboxes(); // 單張卡片的變動要反映到季度層級的勾選框
        updateExportBar();
      });
      label.append(cb, document.createTextNode("選入簡報"));
      head.appendChild(label);
    }
    const checked = state.exportSelection.has(title);
    label.querySelector("input").checked = checked;
    block.classList.toggle("is-selected", checked);
  });

  syncQuarterCheckboxes();
  updateExportBar();
}

/** 季度層級的勾選框要反映底下卡片的實際狀態（全選才勾起，部分選取顯示為 indeterminate） */
function syncQuarterCheckboxes() {
  document.querySelectorAll(".quarter-section").forEach((section) => {
    const cb = section.querySelector(".quarter-select input");
    if (!cb) return;
    const titles = [...section.querySelectorAll("[data-export-title]")]
      .map((b) => b.dataset.exportTitle);
    cb.checked = titles.length > 0 && titles.every((t) => state.exportSelection.has(t));
    cb.indeterminate = !cb.checked && titles.some((t) => state.exportSelection.has(t));
  });
}

function updateExportBar() {
  const n = state.exportSelection.size;
  const bar = document.getElementById("export-bar");
  if (!bar) return;
  document.getElementById("export-count").textContent = `已選 ${n} 項`;
  bar.hidden = n === 0;
}

/* ── PowerPoint 產生 ────────────────────── */

const CLEAN_RE = /\s*(展開 ▾|收合 ▴|選入簡報)\s*/g;
const cleanText = (s) => (s || "").replace(CLEAN_RE, " ").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();

function tableToRows(table) {
  const head = [...table.querySelectorAll("thead th")].map((th) => cleanText(th.innerText));
  // 投影片上的表格字一多就沒人讀得下去，超長內容截斷；
  // 欄位愈多、每欄愈窄，能塞的字愈少。完整文字仍留在 dashboard 上可展開。
  const cap = head.length >= 7 ? 90 : head.length >= 5 ? 130 : 180;
  const body = [...table.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.children].map((td) => {
      const t = cleanText(td.innerText);
      return t.length > cap ? `${t.slice(0, cap)}…` : t;
    })
  );
  return { head, body };
}

function collectSelectedBlocks() {
  return [...document.querySelectorAll("[data-export-title]")].filter((b) =>
    state.exportSelection.has(b.dataset.exportTitle)
  );
}

function addTitleBar(slide, text) {
  slide.addText(text, {
    x: 0.45, y: 0.28, w: 9.1, h: 0.55,
    fontSize: 20, bold: true, color: "0B0B0B", valign: "middle",
  });
}

/** 把 Chart.js 圖表轉成 PptxGenJS 的原生圖表資料。
    用原生圖表而不是貼圖：在 PowerPoint 裡是向量、可以縮放不失真、
    也能直接改顏色改標題，而且不會因為圖片比例算錯被截掉。 */
function chartToPptxSeries(chart) {
  const src = chart.$sourceConfig || chart.config;
  const labels = (src.data.labels || []).map(String);

  const series = (src.data.datasets || []).map((ds) => ({
    name: ds.label || "",
    labels,
    values: (ds.data || []).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
  }));

  const colors = (src.data.datasets || []).map((ds) => {
    const raw = Array.isArray(ds.borderColor) ? ds.borderColor[0] : ds.borderColor || ds.backgroundColor;
    const hex = String(raw || "#888888").trim();
    // PptxGenJS 要不含 # 的六碼 hex
    return /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace("#", "").toUpperCase() : "888888";
  });

  return {
    isLine: (src.type || "bar") === "line",
    stacked: Boolean(src.options?.scales?.y?.stacked),
    series,
    colors,
  };
}

/** 小倍數圖的標題在 canvas 前面的 .stat-label 裡，用來當該張投影片的副標 */
function chartCaption(canvas) {
  const label = canvas.closest(".chart-box")?.previousElementSibling;
  return label?.classList?.contains("stat-label") ? cleanText(label.innerText) : "";
}

function addSlideFor(pptx, block) {
  const title = block.dataset.exportTitle;
  const charts = [...block.querySelectorAll("canvas")];
  const tables = [...block.querySelectorAll("table.data")];
  const notes = [...block.querySelectorAll(":scope > p.note")]
    .map((p) => cleanText(p.innerText)).filter(Boolean);

  // 1) 圖表：一張圖一頁，用 PowerPoint 原生圖表（向量、可編輯）
  if (charts.length) {
    charts.forEach((canvas, idx) => {
      const slide = pptx.addSlide();
      const caption = chartCaption(canvas);
      const slideTitle = caption ? `${title}　—　${caption}` : title;
      addTitleBar(slide, charts.length > 1 ? `${slideTitle}（${idx + 1}/${charts.length}）` : slideTitle);

      const live = Chart.getChart(canvas);
      let spec = null;
      try {
        if (live) spec = chartToPptxSeries(live);
      } catch (err) {
        console.warn("圖表轉換失敗:", err);
      }
      if (!spec || !spec.series.length) {
        slide.addText("（此圖表無資料可匯出）", {
          x: 0.45, y: 2.4, w: 9.1, h: 0.4, fontSize: 12, color: "898781", align: "center",
        });
        return;
      }

      let top = 0.95;
      if (notes.length && idx === 0) {
        const note = notes.join("　");
        slide.addText(note.length > 180 ? `${note.slice(0, 180)}…` : note, {
          x: 0.45, y: 0.9, w: 9.1, h: 0.45, fontSize: 9, color: "52514E", valign: "top",
        });
        top = 1.45;
      }

      slide.addChart(spec.isLine ? pptx.ChartType.line : pptx.ChartType.bar, spec.series, {
        x: 0.5, y: top, w: 9.0, h: 5.4 - top,
        chartColors: spec.colors,
        showLegend: spec.series.length > 1,
        legendPos: "b",
        legendFontSize: 10,
        barGrouping: spec.stacked ? "stacked" : "clustered",
        catAxisLabelFontSize: 10,
        valAxisLabelFontSize: 10,
        displayBlanksAs: "gap",
        lineSize: 2,
        lineDataSymbolSize: 6,
        showValue: false,
      });
    });
    return;
  }

  // 2) 表格：用原生 PowerPoint 表格，之後可以直接在簡報裡編輯。
  //    自己分頁而不用 autoPage —— autoPage 產生的續頁不會帶標題，翻到後面會不知道在看什麼。
  if (tables.length) {
    tables.forEach((table) => {
      const { head, body } = tableToRows(table);
      if (!body.length) return;

      const ROWS_BUDGET = 900; // 一頁塞得下的字元量（含所有欄位）
      const pages = [[]];
      let used = 0;
      body.forEach((row) => {
        const len = row.reduce((a, c) => a + c.length, 0);
        if (used + len > ROWS_BUDGET && pages[pages.length - 1].length) {
          pages.push([]);
          used = 0;
        }
        pages[pages.length - 1].push(row);
        used += len;
      });

      pages.forEach((page, i) => {
        const slide = pptx.addSlide();
        addTitleBar(slide, pages.length > 1 ? `${title}（${i + 1}/${pages.length}）` : title);
        const rows = [
          head.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: "2A78D6" } })),
          ...page.map((r) => r.map((c) => ({ text: c }))),
        ];
        slide.addTable(rows, {
          x: 0.45, y: 1.0, w: 9.1,
          fontSize: 9, border: { type: "solid", pt: 0.5, color: "E1E0D9" },
          valign: "top",
        });
      });
    });
    return;
  }

  // 3) 其他一律轉成文字（各季度卡片、分歧觀察…）
  // 簡報是拿來講的，不是拿來讀整段的：每則重點裁到可掃視的長度，
  // 完整內容留在 dashboard（投影片頁尾會註明）。
  const BULLET_MAX = 150;
  const trim = (s) => (s.length > BULLET_MAX ? `${s.slice(0, BULLET_MAX)}…` : s);

  const rawLines = [];
  const fields = [...block.querySelectorAll(".field-row")];
  if (fields.length) {
    fields.forEach((row) => {
      const label = cleanText(row.querySelector(".field-label")?.innerText);
      const value = cleanText(row.querySelector(".field-value")?.innerText);
      if (value) rawLines.push(`${label}：${trim(value)}`);
    });
  } else {
    [...block.querySelectorAll(".quote-block")].forEach((q) => {
      const t = cleanText(q.innerText);
      if (t) rawLines.push(trim(t));
    });
  }
  if (!rawLines.length) {
    const t = cleanText(block.innerText);
    if (t) rawLines.push(t);
  }

  // 一張投影片塞得下的字數是有限的，超過就換頁——不能只靠 autoPage，
  // 單一超長段落它不會切，會直接溢出版面外看不到。
  const PER_SLIDE = 560;   // 中文字寬，實測這個量在 11pt 下不會超出版面
  const MAX_LINE = 480;    // 單一段落太長時自己先切開
  const chunks = [];
  rawLines.forEach((line) => {
    for (let i = 0; i < line.length; i += MAX_LINE) {
      chunks.push(line.slice(i, i + MAX_LINE) + (line.length > i + MAX_LINE ? "…" : ""));
    }
  });

  const pages = [[]];
  let used = 0;
  chunks.forEach((c) => {
    if (used + c.length > PER_SLIDE && pages[pages.length - 1].length) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(c);
    used += c.length;
  });

  const scope = cleanText(block.querySelector(":scope > p.note")?.innerText);
  pages.forEach((page, i) => {
    const slide = pptx.addSlide();
    addTitleBar(slide, pages.length > 1 ? `${title}（${i + 1}/${pages.length}）` : title);
    slide.addText(
      page.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
      {
        x: 0.45, y: 0.95, w: 9.1, h: 4.3,
        fontSize: 11, color: "0B0B0B", valign: "top", lineSpacingMultiple: 1.2,
      }
    );
    const footer = [
      scope && i === 0 ? (scope.length > 120 ? `${scope.slice(0, 120)}…` : scope) : "",
      "完整內容見 dashboard",
    ].filter(Boolean).join("　|　");
    slide.addText(footer, { x: 0.45, y: 5.3, w: 9.1, h: 0.3, fontSize: 8, color: "898781" });
  });
}

/** 等下一次繪製。requestAnimationFrame 在分頁被隱藏時「永遠不會觸發」，
    直接 await 它會讓匯出無限卡住，所以一定要搭配逾時保護。 */
function nextPaint(timeoutMs = 300) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, timeoutMs);
  });
}

async function generatePptx() {
  const btn = document.getElementById("export-pptx");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "產生中…";

  const root = document.documentElement;
  const hadThemeAttr = root.hasAttribute("data-theme");
  const prevTheme = root.dataset.theme;
  const isDark =
    prevTheme === "dark" ||
    (!hadThemeAttr && window.matchMedia("(prefers-color-scheme: dark)").matches);

  try {
    // 深色模式的圖表用的是淺色系文字，貼到白底投影片會看不清楚，
    // 所以匯出前先切成淺色重畫，匯出完再切回來。
    if (isDark) {
      root.dataset.theme = "light";
      renderAll();
      await nextPaint();
    }

    const blocks = collectSelectedBlocks();
    if (!blocks.length) return;

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    pptx.title = "記憶體三雄供貨追蹤";

    // 壓縮 pptx 的過程在「分頁切到背景」時會被瀏覽器暫停，看起來像卡住。
    // 超過 20 秒還沒好就提示使用者把分頁留在前景。
    const watchdog = setTimeout(() => {
      const count = document.getElementById("export-count");
      if (count) count.textContent = "產生中，請讓此分頁保持在前景";
    }, 20000);

    const today = new Date().toISOString().slice(0, 10);
    const cover = pptx.addSlide();
    cover.addText("記憶體三雄供貨追蹤", {
      x: 0.6, y: 1.9, w: 8.8, h: 0.8, fontSize: 32, bold: true, color: "0B0B0B",
    });
    cover.addText("三星 Samsung ・ 美光 Micron ・ SK 海力士 SK Hynix", {
      x: 0.6, y: 2.7, w: 8.8, h: 0.4, fontSize: 14, color: "52514E",
    });
    cover.addText(
      `產生日期 ${today}　·　收錄 ${state.quarters.length} 季法說會資料、${state.brokers.length} 則投行觀點\n` +
      "資料取自各公司官方 IR 揭露與公開財經媒體報導，投行觀點僅為公開新聞轉述之摘要，非研究報告全文。",
      { x: 0.6, y: 3.25, w: 8.8, h: 0.8, fontSize: 10, color: "898781" }
    );

    blocks.forEach((block) => addSlideFor(pptx, block));

    await pptx.writeFile({ fileName: `記憶體三雄供貨追蹤_${today}.pptx` });
    clearTimeout(watchdog);
  } catch (err) {
    console.error("PowerPoint 產生失敗:", err);
    const count = document.getElementById("export-count");
    count.textContent = "產生失敗，詳見主控台";
    setTimeout(updateExportBar, 4000);
  } finally {
    if (isDark) {
      if (hadThemeAttr) root.dataset.theme = prevTheme;
      else root.removeAttribute("data-theme");
      renderAll();
    }
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ── 總渲染 ─────────────────────────────── */

function renderAll() {
  renderQuarters();
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
  attachExportCheckboxes(); // 一定要在最後：重繪後要把勾選狀態接回新的 DOM
  applySearch();            // 重繪會洗掉舊的標記，要重新標一次
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

let searchTimer = null;
document.getElementById("search-input").addEventListener("input", (e) => {
  const value = e.target.value;
  clearTimeout(searchTimer);
  // 稍微延遲再搜，邊打字邊整頁重繪會很頓
  searchTimer = setTimeout(() => {
    state.search = value;
    applySearch(); // 只重標記，不整份重畫：比較快，也不會讓收折狀態跳掉
  }, 180);
});

document.getElementById("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    gotoNextHit();
  }
});

document.getElementById("search-next").addEventListener("click", gotoNextHit);

document.getElementById("search-clear").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  state.search = "";
  applySearch();
});

document.getElementById("export-pptx").addEventListener("click", generatePptx);

document.getElementById("export-clear").addEventListener("click", () => {
  state.exportSelection.clear();
  document.querySelectorAll(".export-check input").forEach((cb) => (cb.checked = false));
  document.querySelectorAll(".is-selected").forEach((b) => b.classList.remove("is-selected"));
  updateExportBar();
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
