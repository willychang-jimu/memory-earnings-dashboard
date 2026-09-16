# 單季法說會資料 JSON 欄位規格

> 實務上各家揭露結構不同，研究來源寫入的原始結構會先保留，
> 再由 `scripts/normalize.py` 產生下面這組扁平欄位供前端使用。
> 新增資料時照著原始揭露寫即可，跑一次 normalize 就好。
>
> normalize 會補上的欄位：
> - `reporting_scope`：這筆數字的口徑（三星＝DS 部門、另兩家＝公司整體）
> - 三星專屬：原始的 `consolidated` / `ds_division` / `memory_business` / `capex`
>   分層區塊會搬到 `divisions`，並把 DS 部門數字提升到 `financials` 供圖表使用
>
> 韓元計價的公司（三星、SK 海力士）請用 `revenue_krw_trillion`、
> `capex_krw_trillion`、`operating_profit_krw_trillion`（單位：兆韓元）——
> 前端會優先採用官方原幣別，美元欄位多半是第三方換算值。
>
> `stock_reaction` 另有 `event_type` / `event_date`：記錄這個漲跌幅對應的是
> 哪一個事件（初估財報公布日 vs 法說會後交易日），不同事件不可直接比較。

檔名：`data/<company>/<period>.json`
`company`: `samsung` | `micron` | `sk_hynix`
`period`: Samsung/SK Hynix 用 `2026Q1` 這種日曆季格式；Micron 用 `FY2026Q2` 這種財年格式。

```json
{
  "company": "micron",
  "period_label": "FY2026 Q3",
  "calendar_quarter_equivalent": "2026 Q2（約，實際涵蓋 2026-03 ~ 2026-05）",
  "period_start": "2026-03-01",
  "period_end": "2026-05-28",
  "report_date": "2026-06-25",

  "financials": {
    "revenue_usd_m": null,
    "revenue_yoy_pct": null,
    "revenue_qoq_pct": null,
    "gross_margin_pct": null,
    "operating_margin_pct": null,
    "net_income_usd_m": null,
    "eps_usd": null,
    "capex_usd_m": null,
    "dram_revenue_share_pct": null,
    "nand_revenue_share_pct": null,
    "hbm_revenue_usd_m": null,
    "notes": ""
  },

  "guidance": {
    "next_period_revenue_range_usd_m": [null, null],
    "next_period_gross_margin_range_pct": [null, null],
    "capex_plan_usd_m": null,
    "commentary_summary": "",
    "bit_shipment_growth_outlook": ""
  },

  "management_commentary": [
    {
      "speaker": "",
      "topic": "",
      "summary": "",
      "source_index": 0
    }
  ],

  "stock_reaction": {
    "price_prior_close_usd": null,
    "price_1d_after_usd": null,
    "pct_change_1d": null,
    "pct_change_1w": null,
    "notes": ""
  },

  "sources": [
    {
      "title": "",
      "publisher": "",
      "url": "",
      "accessed_date": ""
    }
  ]
}
```

# 投行觀點彙整 JSON（`data/broker_reports/`）

檔名：`YYYY-MM-DD_<bank>_<company>.json`

```json
{
  "date": "2026-07-XX",
  "bank": "Morgan Stanley",
  "company": "sk_hynix",
  "related_period": "2026Q2",
  "rating": "Overweight",
  "rating_change": "maintained",
  "price_target": "",
  "price_target_currency": "",
  "prior_price_target": "",
  "thesis_summary": "",
  "key_points": [""],
  "source": {
    "title": "",
    "publisher": "",
    "url": "",
    "accessed_date": ""
  }
}
```

**重要**：`thesis_summary`/`key_points` 只寫「公開新聞轉述的事實摘要」（例如
目標價變動、評等、一兩句核心論點），不要整段複製/改寫付費報告全文。
