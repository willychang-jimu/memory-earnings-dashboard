# CLAUDE.md — 記憶體三雄供貨追蹤 技術備忘錄

> 這是獨立專案，跟 `台股雷達` 無關（不同資料夾、不共用邏輯）。

## 這個專案的真正目的（2026-09-15 使用者澄清過，很重要）

**核心問題是「這三家供應商的供貨狀況」**，不是選股、不是股價。使用者要知道的是：
三星、美光、SK 海力士在每一季法說會上，對**自己的供給能力**講了什麼——
擴產、位元出貨成長、供需鬆緊、報價方向、是否售罄、長約綁了多少。

因此：

1. **股價分析已經整個移除**，不要再加回來（使用者明確說「先放棄股價之類的分析」）。
   曾經做過的股價反應圖表與 `stock_reaction` 相關 UI 已刪除；資料檔裡殘留的
   `stock_reaction` 欄位保留不刪（有出處、無害），但**前端不呈現**。
2. **財務數字降為輔助**，放在「財務數字（輔助）」分頁。使用者說「財報可以知道」，
   意思是財務數字他自己看得到，不需要 dashboard 幫他重講一次——
   財務數字的價值在於**佐證供給面的說法**（例如 capex 增加佐證擴產），
   不是自成一個分析主題。
3. **主視圖是供給面對照**：供需狀態時間軸、供給面對照矩陣、報價方向是否一致、
   擴產與產能動作、售罄狀態與長約。

加新功能前先問：這能幫使用者判斷「未來供貨會不會鬆」嗎？不能的話大概不該做。

## 部署

- Repo：`willychang-jimu/memory-earnings-dashboard`（**public**）
- 線上版：<https://willychang-jimu.github.io/memory-earnings-dashboard/>
  （GitHub Pages，來源為 `main` 分支根目錄，push 後約一分鐘自動重建）
- 根目錄的 `index.html` 只是導向 `dashboard/index.html` 的跳轉頁。
  Pages 指向根目錄，沒有這頁會 404，**不要刪**。
- 前端用相對路徑 `../data/...` 讀 JSON，在 Pages 的專案站台路徑
  （`/memory-earnings-dashboard/`）底下可正常解析，不要改成絕對路徑 `/data/...`，
  那樣在 Pages 上會指到網域根目錄而失效。

## PowerPoint 匯出（`dashboard/app.js` 的 `generatePptx`）

用 **PptxGenJS 3.12.0**，檔案直接放在 `dashboard/vendor/pptxgen.bundle.js`（466KB）——
**刻意不用 CDN**：cdnjs 沒有這個套件，而放進 repo 就不必依賴外部服務、離線也能用。

勾選機制：任何帶 `data-export-title` 屬性的元素都會自動長出勾選框
（`attachExportCheckboxes()`），以那個標題字串當 key 記在 `state.exportSelection`，
所以重繪後勾選狀態不會掉。**要讓新區塊可被匯出，只要加上 `data-export-title` 就好**，
不用改匯出程式。

### 這段踩過四個坑，改之前務必先讀

1. **`requestAnimationFrame` 在分頁隱藏時永遠不會觸發** —— 直接 `await` 它會讓匯出
   無限卡在「產生中…」。一定要用 `nextPaint()`（內建逾時保護），不要退回裸的 rAF。

2. **不能直接抓畫面上的 canvas 匯出圖表** —— 圖表在未顯示的分頁裡寬高是 0，
   `toDataURL()` 只會回傳空的 `"data:,"`。所以 `chartToPngData()` 是**用固定
   1400×700 的離屏畫布重新繪製**，順便讓簡報裡的圖解析度固定又銳利。

3. **重建圖表時不能用 `chart.options`** —— 那是 Chart.js 解析過的 proxy，
   拿去當新圖表的 options 會噴 `Recursion detected: _scriptable->_scriptable`。
   所以 `mountChart()` 會把原始 config 存成 `chart.$sourceConfig` 供匯出使用。

4. **PptxGenJS 的 `addImage` 要的是 `"image/png;base64,..."`**，
   但 `toDataURL()` 會多一個 `data:` 前綴，不拿掉會丟
   「lacks a base64 header」而且整個產生流程會卡死。

### 尚未驗證的部分（誠實記錄）

最後的 `pptx.writeFile()`（zip 壓縮＋觸發下載）**沒有在開發環境實測成功過**——
內嵌瀏覽器窗格的 `visibilityState` 永遠是 hidden，計時器被完全暫停，
JSZip 的分塊壓縮跑不完（連只有一張純文字投影片的最小測試放 95 秒也沒結束）。
**已驗證**的是：勾選、內容擷取、圖表轉圖（實際檢查過像素、確認不是空白圖）、
以及 47 張投影片的組裝。真實瀏覽器的前景分頁應該正常，但如果使用者回報卡住，
第一個要懷疑的是分頁在背景被節流（程式裡已有 20 秒後的提示文字）。

## 供給資料的幾個坑（做過了，別重踩）

1. **九個季度的 `supply_demand_balance.status` 目前全部都是「供不應求」**，
   所以那個有序色階完全沒有鑑別度。這不是 bug，是 2026 記憶體超級循環的現實。
   **真正的資訊在細節的不一致裡**，所以主視圖第一張卡片是「值得注意的分歧」
   （`data/analysis/divergences.json`），而不是狀態表。
   哪天狀態欄出現「偏緊」以外的值，那才是轉折訊號。

2. **「位元成長」欄位的口徑不統一**：有些季度公司給的是自家位元出貨成長（供給側），
   有些給的是產業需求成長（需求側）。**不要為了讓表格好看而統一改寫**——
   括號內逐格標明口徑就好，改寫等於竄改公司原本的說法。同樣的原則也適用於
   幣別（韓元 vs 美元）與口徑（三星 DS 部門 vs 另兩家公司整體）。

3. **`divergences.json` 是「整理者觀察」，不是公司說法**，前端有明確標示。
   每則都要列出 `supporting` 指向依據的季度檔案，讓讀者能回去對照原文。
   新增一季資料後要回頭檢查這個檔案是否需要更新（`last_reviewed` 欄位）。

4. **瀏覽器快取**：`index.html` 引用 `app.js`/`style.css` 時帶了 `?v=YYYYMMDD`
   版本參數。**改動 JS/CSS 後要同步更新這個日期**，否則使用者（特別是把頁面
   加到手機主畫面的情況）會載到舊版，出現「明明改了卻沒效果」的假象。
   這個坑在開發過程中已經踩過一次。

## 資料來源與可靠性（重要，先讀這段）

1. **法說會財務數字**：來自三家公司官方 IR 網站的財報新聞稿/簡報/逐字稿摘要，
   或路透、CNBC、Investing.com 等財經媒體對法說會的報導。每筆資料都會在
   `sources` 欄位附上出處連結，**不是自己去抓官方 API**（這三家都沒有台股那種
   公開資料 API，是人工/搜尋整理）。

2. **投行報告（大摩/小摩/高盛等）**：這些機構的完整研究報告是付費/內部流通，
   **沒有管道取得全文**。Dashboard 上呈現的是「公開財經媒體轉述的投行觀點」
   ——例如「Morgan Stanley 上調目標價至 $X、維持 Overweight」這類已被新聞
   引用的片段，**不是報告全文**，資料完整度依公開報導多寡而定，可能有缺口。

3. **三家公司財報週期不同，比較時要注意**：
   - **Micron**：美國財年制，財年結算在 8月底/9月初。FY2026 Q1~Q4 對應的
     日曆時間跟 Samsung/SK Hynix 的「2026 Q1~Q4」（日曆季）**不是同一個區間**，
     dashboard 上會同時標示「財年季度」跟「約略對應的日曆季度」，交叉比較時
     用日曆季對齊，不要直接拿 FY 季度號碼對號。
   - **Samsung**：Memory 業務只是 DS(Device Solutions) 部門的一部分，公司
     財報主要揭露到 DS 部門層級，Memory 細項（DRAM/NAND 各自營收）不一定
     每季都有揭露，缺值時標記 `null`，不要用部門數字冒充 Memory 數字。
   - **SK Hynix**：以 Memory 為主業，財報數字最直接對應，但仍要留意 HBM
     單獨揭露的程度依季度而異。

4. **資料缺漏是常態，不要為了填滿表格而編造數字**——查不到的欄位一律留
   `null`，並在 `sources` 或 `notes` 欄位註記「查無公開資料」，讓 dashboard
   前端明確顯示「無資料」而非顯示 0 或猜測值。

## 資料結構

```
data/
  samsung/2026Q1.json, 2026Q2.json, ...
  micron/FY2026Q2.json, FY2026Q3.json, ...   ← 用財年季度命名，內含 calendar_quarter_equivalent 欄位
  sk_hynix/2026Q1.json, 2026Q2.json, ...
  broker_reports/YYYY-MM-DD_<bank>_<company>.json  ← 每則投行觀點一個檔案
```

單季 JSON 欄位規格見 `data/SCHEMA.md`。

## 待辦 / 設計原則

- **不要做沒有出處的數字**：每個 JSON 都必須有 `sources` 陣列，dashboard 前端
  設計成可以點開看出處，這是這個專案存在的核心價值（避免變成沒人查證的內容農場）。
- **Dashboard 先做成單一 HTML（inline JS+CSS+chart library），資料用 JSON 檔案
  單獨存放**，方便之後要不要上 GitHub Pages 都可以直接動。
- 之後如果要放上 GitHub：這個資料夾本身還沒 git init，動手前跟使用者確認要
  public 還是 private（投行觀點彙整轉述內容, 公開發布前最好再過一次法律/合理使用
  的常識判斷——只放「事實摘要+出處連結」，不要整段抄研究報告內文）。
