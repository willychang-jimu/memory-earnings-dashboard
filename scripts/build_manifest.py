#!/usr/bin/env python3
"""掃描 data/ 底下實際存在的 JSON 檔案，重建 data/manifest.json。
之後每季新增資料，只要把新的 JSON 檔案丟進對應資料夾，重跑這支腳本即可。
用法: python3 scripts/build_manifest.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
COMPANIES = ["samsung", "micron", "sk_hynix"]


def period_sort_key(filename: str):
    # 支援 "2026Q1.json" 跟 "FY2026Q1.json" 兩種命名
    m = re.match(r"(?:FY)?(\d{4})Q(\d)\.json", filename)
    if not m:
        return (9999, 9)
    return (int(m.group(1)), int(m.group(2)))


def main():
    manifest = {
        "generated_note": "此檔案由 scripts/build_manifest.py 自動產生，不要手動編輯。",
        "companies": COMPANIES,
        "quarters": {},
        "broker_reports": [],
    }

    for company in COMPANIES:
        company_dir = DATA / company
        files = sorted(
            (f.name for f in company_dir.glob("*.json")) if company_dir.exists() else [],
            key=period_sort_key,
        )
        manifest["quarters"][company] = files

    broker_dir = DATA / "broker_reports"
    if broker_dir.exists():
        broker_files = sorted(f.name for f in broker_dir.glob("*.json"))
        manifest["broker_reports"] = broker_files

    out_path = DATA / "manifest.json"
    out_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total_quarters = sum(len(v) for v in manifest["quarters"].values())
    print(f"寫入 {out_path}")
    print(f"  季度資料: {total_quarters} 筆 ({ {k: len(v) for k, v in manifest['quarters'].items()} })")
    print(f"  投行觀點: {len(manifest['broker_reports'])} 筆")


if __name__ == "__main__":
    main()
