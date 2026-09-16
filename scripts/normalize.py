#!/usr/bin/env python3
"""把各家研究來源寫入的原始 JSON 正規化成 dashboard 可以直接吃的扁平欄位。

為什麼需要這支：三家公司的揭露結構天生不同，
- 三星只揭露到 DS 部門（記憶體＋System LSI＋晶圓代工），沒有純記憶體的財務數字
- SK 海力士是公司整體（以記憶體為主，含 Solidigm 的 NAND）
- 美光是公司整體
所以資料檔維持各自的原始結構（不破壞可查證性），由這支腳本產生
`financials` 扁平欄位供圖表使用，並在 `reporting_scope` 標明每家的口徑，
讓前端可以明白告訴讀者「這三個數字的基準不一樣」。

冪等：重複執行結果相同。用法: python3 scripts/normalize.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

REPORTING_SCOPE = {
    "samsung": "DS 部門（記憶體＋System LSI＋晶圓代工，非純記憶體）",
    "micron": "公司整體（以記憶體為主業）",
    "sk_hynix": "公司整體（以記憶體為主，含 Solidigm NAND）",
}


def flatten_samsung(rec: dict) -> dict:
    """三星：把 DS 部門數字提升為主要比較口徑，原始分層資料保留在 divisions。
    研究來源把 consolidated / ds_division / memory_business / capex 這些分層
    區塊放在 financials 底下（也可能放最上層），兩種位置都要處理。"""
    fin = rec.setdefault("financials", {})
    blocks = {}
    for key in ("consolidated", "ds_division", "memory_business", "capex"):
        for holder in (fin, rec):
            if isinstance(holder.get(key), dict):
                blocks[key] = holder.pop(key)
                break
    if not blocks:
        return rec  # 已經正規化過

    rec.setdefault("divisions", {}).update(blocks)
    ds = blocks.get("ds_division", {})
    capex = blocks.get("capex", {})
    memory = blocks.get("memory_business", {})
    mapping = {
        "revenue_krw_trillion": ds.get("revenue_krw_trillion"),
        "revenue_usd_m": ds.get("revenue_usd_m"),
        "revenue_yoy_pct": ds.get("revenue_yoy_pct"),
        "revenue_qoq_pct": ds.get("revenue_qoq_pct"),
        "operating_profit_krw_trillion": ds.get("operating_profit_krw_trillion"),
        "operating_margin_pct": ds.get("operating_margin_pct"),
        "gross_margin_pct": ds.get("gross_margin_pct"),
        "capex_krw_trillion": capex.get("capex_ds_krw_trillion"),
        "dram_revenue_share_pct": None,
        "nand_revenue_share_pct": None,
    }
    for key, value in mapping.items():
        fin.setdefault(key, value)

    note_parts = [
        "圖表採用 DS 部門數字（三星未單獨揭露記憶體事業的財務數字）。",
        ds.get("notes") or "",
        capex.get("notes") or "",
        ("記憶體事業：" + memory["notes"]) if memory.get("notes") else "",
        rec.get("notes") or "",
    ]
    fin["notes"] = " ".join(p.strip() for p in note_parts if p and p.strip())
    return rec


def normalize_file(path: Path, company: str) -> bool:
    rec = json.loads(path.read_text(encoding="utf-8"))
    before = json.dumps(rec, sort_keys=True, ensure_ascii=False)

    rec.setdefault("company", company)
    rec["reporting_scope"] = REPORTING_SCOPE.get(company, "")

    if company == "samsung":
        rec = flatten_samsung(rec)

    after = json.dumps(rec, sort_keys=True, ensure_ascii=False)
    if before != after:
        path.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return True
    return False


def main():
    changed = 0
    for company in REPORTING_SCOPE:
        folder = DATA / company
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.json")):
            if normalize_file(path, company):
                changed += 1
                print(f"  正規化 {company}/{path.name}")
    print(f"完成，異動 {changed} 個檔案。")


if __name__ == "__main__":
    main()
