# WinHub.AI 戰情室 — 課程示範系統

給「預警轉建議模組與 SHAP 分析實作」與「虛擬營運戰情室模擬」兩堂課使用的互動教學 demo。

## 兩個分頁

### 01 ‧ SHAP 預警解析（上午課程 10:40–12:00）

- 50 筆模擬射出成型生產批次（固定種子，每次上課資料一致）
- 內建不良率預警模型（含非線性與「含水率 × 環境濕度」交互作用）
- **真實的 SHAP 計算**：排列抽樣 Monte Carlo Shapley（Štrumbelj & Kononenko），
  可動畫播放 300 次抽樣的全過程 —— 收斂曲線、即時抽樣日誌、瀑布圖
- 可加性檢查：基準值 + Σφ ≡ 模型預測（現場驗證給學員看）
- **預警 → 建議**：SHAP 正貢獻自動轉成改善行動卡（負責單位＋時限）
- **What-if**：套用建議後重新預測，展示「預警 → 解釋 → 建議 → 驗證」閉環
- 全局視角：mean |SHAP| 特徵重要性 + 蜂群圖

建議授課動線：點高風險批次（預設 B24）→ 讓學員先猜原因 → 慢速播放抽樣
→ 瀑布圖講可加性 → 看建議行動卡 → What-if 收尾 → 切到全局重要性。

### 02 ‧ 營運戰情室（下午課程 13:00–14:50）

- 每 2 秒更新的即時模擬：OEE、產量、良率、12 台機台狀態、事件流、能耗
- **AI Copilot 主動回報**：GPT 串流生成繁中簡報（事件觸發 + 自動巡檢），
  打字機效果直接出現在儀表板上
- 講師控制台可注入 4 種情境：模溫飆高 / 良率劣化 / 急單插入 / 設備停機
- 可直接向 Copilot 提問（例：「現在最大的風險是什麼？」）
- 無 API key 或斷網時自動切換**離線備援模式**，課堂演示不會開天窗

## 本機啟動

```bash
cp .env.example .env   # 填入 OPENAI_API_KEY（不填也能跑，會用離線備援）
npm start              # http://localhost:3000
```

無任何 npm 相依套件，Node 18+ 直接執行。
前端圖表使用 [Apache ECharts](https://echarts.apache.org/)（Apache-2.0 授權），vendored 於 `public/vendor/`。

## Zeabur 部署

1. Zeabur 連結此 GitHub repo，選 Node.js 服務（不需 build command，start = `npm start`）
2. 在服務的 **Environment Variables** 加入：
   - `OPENAI_API_KEY` = 你的 OpenAI 金鑰
   - （可選）`OPENAI_MODEL`，預設 `gpt-4o-mini`
3. Port 由 Zeabur 自動注入 `PORT`，程式會自動讀取

> ⚠️ 金鑰只放環境變數，不要 commit 進 repo。

## API

- `GET /api/health` — 服務狀態與 copilot 模式
- `POST /api/copilot` — SSE 串流分析（body: `{mode, event, question, snapshot}`）
