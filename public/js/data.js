/**
 * data.js — 模擬資料、預警模型與 SHAP 引擎
 *
 * Tab 1 的核心：50 筆射出成型生產批次資料、一個已「訓練完成」的
 * 不良率預警模型 f(x)，以及用排列抽樣 (permutation sampling)
 * 實作的 Monte Carlo Shapley 估計器 —— 真實計算、可動畫播放。
 */

/* ------------------------------------------------------ seeded random ---- */
// 固定種子 → 每次上課資料一致，方便對照講義。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260612);
const gauss = () => {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* ----------------------------------------------------------- features ---- */
const FEATURES = [
  { key: "moldTemp",    name: "模具溫度",   unit: "°C",  digits: 1, ideal: "60 ±2",     color: "#4fc3f7" },
  { key: "injPressure", name: "射出壓力",   unit: "bar", digits: 0, ideal: "≤ 115",     color: "#7e8ce0" },
  { key: "holdTime",    name: "保壓時間",   unit: "s",   digits: 1, ideal: "≥ 2.9",     color: "#26a69a" },
  { key: "coolantTemp", name: "冷卻水溫",   unit: "°C",  digits: 1, ideal: "≤ 24",      color: "#66bb6a" },
  { key: "moisture",    name: "原料含水率", unit: "%",   digits: 2, ideal: "≤ 0.12",    color: "#ff7043" },
  { key: "runHours",    name: "連續稼動",   unit: "hr",  digits: 0, ideal: "≤ 72",      color: "#ffa726" },
  { key: "humidity",    name: "環境濕度",   unit: "%",   digits: 0, ideal: "≤ 65",      color: "#ab47bc" },
  { key: "operatorExp", name: "操作員年資", unit: "年",  digits: 1, ideal: "越高越穩",  color: "#8d9bb3" }
];
const FEATURE_KEYS = FEATURES.map(f => f.key);

/* ------------------------------------------------------ 預警模型 f(x) ---- */
/**
 * 不良率預警模型（教學用，模擬一個已訓練完成的梯度提升模型）。
 * 含非線性與「含水率 × 環境濕度」交互作用 —— 讓 SHAP 有東西可解釋。
 * 回傳預測不良率 (%)。
 */
function predictDefectRate(x) {
  let y = 1.1;
  y += 0.018 * Math.pow(x.moldTemp - 60, 2);                 // 偏離最適模溫
  y += 0.045 * Math.max(0, x.injPressure - 115);             // 過壓
  y += 0.9 * Math.max(0, 2.9 - x.holdTime);                  // 保壓不足
  y += 0.1 * Math.max(0, x.coolantTemp - 24);                // 冷卻不良
  y += 28 * Math.max(0, x.moisture - 0.12);                  // 含水率超標（主因子）
  y += 0.02 * Math.max(0, x.runHours - 72);                  // 機台疲勞
  y += 0.05 * Math.max(0, x.humidity - 65);                  // 高濕環境
  y += 0.04 * (10 - Math.min(x.operatorExp, 10));            // 經驗不足
  // 交互作用：原料受潮 × 高濕環境 會放大彼此影響
  y += 12 * Math.max(0, x.moisture - 0.12) * Math.max(0, (x.humidity - 65) / 10);
  return Math.max(0.2, y);
}

/* ------------------------------------------------------------ dataset ---- */
function generateDataset() {
  const rows = [];
  // 先生成 50 筆「大致正常」的批次
  for (let i = 0; i < 50; i++) {
    rows.push({
      id: `B${String(i + 1).padStart(2, "0")}`,
      machine: `M${String(1 + Math.floor(rng() * 12)).padStart(2, "0")}`,
      moldTemp: clamp(60 + gauss() * 3.2, 52, 74),
      injPressure: clamp(100 + gauss() * 11, 80, 145),
      holdTime: clamp(3.4 + gauss() * 0.55, 1.8, 6),
      coolantTemp: clamp(22 + gauss() * 2.2, 16, 30),
      moisture: clamp(0.08 + Math.abs(gauss()) * 0.025, 0.04, 0.3),
      runHours: clamp(4 + rng() * 106, 4, 110),
      humidity: clamp(58 + gauss() * 7, 40, 80),
      operatorExp: clamp(0.5 + rng() * 14.5, 0.5, 15)
    });
  }
  // 注入 9 筆異常批次（每筆 1~2 個異常因子），讓風險分布有故事可講
  const anomalies = [
    { idx: 4,  set: { moisture: 0.21, humidity: 73 } },
    { idx: 11, set: { moldTemp: 69.5 } },
    { idx: 17, set: { injPressure: 138, holdTime: 2.3 } },
    { idx: 23, set: { moisture: 0.26, humidity: 76 } },
    { idx: 28, set: { holdTime: 2.0, operatorExp: 0.8 } },
    { idx: 33, set: { runHours: 108, coolantTemp: 28.5 } },
    { idx: 38, set: { moisture: 0.17 } },
    { idx: 42, set: { moldTemp: 53.5, injPressure: 132 } },
    { idx: 47, set: { moisture: 0.23, runHours: 96 } }
  ];
  for (const a of anomalies) Object.assign(rows[a.idx], a.set);

  for (const r of rows) {
    r.pred = predictDefectRate(r);
  }
  return rows;
}

const DATASET = generateDataset();
const BASELINE = DATASET.reduce((s, r) => s + r.pred, 0) / DATASET.length;

function riskLevel(pred) {
  if (pred >= 5) return { label: "高風險", cls: "risk-high" };
  if (pred >= 2.5) return { label: "注意", cls: "risk-mid" };
  return { label: "正常", cls: "risk-low" };
}

/* ------------------------------------------------------- SHAP engine ----- */
/**
 * 排列抽樣 Shapley 估計器（Štrumbelj & Kononenko 2014）。
 *
 * 每一次迭代：
 *   1. 從背景資料集輪流取一筆 z（背景樣本）
 *   2. 隨機抽一個特徵排列 π
 *   3. 從 z 出發，依 π 順序逐一把特徵換成目標樣本 x 的值，
 *      每換一個特徵 j，f 的變化量就是 j 在這個聯盟下的邊際貢獻
 *
 * 性質：單次迭代中所有特徵的邊際貢獻總和 = f(x) − f(z)，
 * 因此「動態基準值 = 已抽樣 z 的平均 f(z)」可保證瀑布圖在任何
 * 迭代數下都精確可加（baseline + Σφ ≡ f(x)）。
 */
class ShapEstimator {
  constructor(x, background = DATASET, rng = null) {
    this.x = x;
    this.background = background;
    this.rng = rng || (() => rngShap()); // 預設用共用 RNG（固定種子可重播）
    this.iter = 0;
    this.phiSum = Object.fromEntries(FEATURE_KEYS.map(k => [k, 0]));
    this.fzSum = 0;
    this.fx = predictDefectRate(x);
  }

  /** 跑一次迭代，回傳該次的明細（給動畫日誌用） */
  step() {
    const z = this.background[this.iter % this.background.length];
    // Fisher–Yates 抽排列
    const order = FEATURE_KEYS.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const cur = {};
    for (const k of FEATURE_KEYS) cur[k] = z[k];
    let prev = predictDefectRate(cur);
    const fz = prev;
    const contribs = {};
    for (const k of order) {
      cur[k] = this.x[k];
      const next = predictDefectRate(cur);
      contribs[k] = next - prev;
      prev = next;
    }
    for (const k of FEATURE_KEYS) this.phiSum[k] += contribs[k];
    this.fzSum += fz;
    this.iter += 1;
    return { z, order, contribs, fz };
  }

  /** 目前的 φ 估計值（平均邊際貢獻） */
  phi() {
    const n = Math.max(1, this.iter);
    return Object.fromEntries(FEATURE_KEYS.map(k => [k, this.phiSum[k] / n]));
  }

  /** 動態基準值：已抽樣背景樣本的平均預測 → 保證可加性 */
  dynamicBaseline() {
    return this.iter ? this.fzSum / this.iter : BASELINE;
  }
}

// SHAP 抽樣用獨立 RNG（不影響資料集種子），固定種子 → 收斂曲線可重播
let rngShap = mulberry32(777);
function resetShapRng() {
  rngShap = mulberry32(777);
}

/** 同步跑完 n 次迭代（給全局重要性預計算用），可注入獨立 RNG 避免干擾共用隨機流 */
function computeShap(x, iterations = 200, rng = null) {
  const est = new ShapEstimator(x, DATASET, rng);
  for (let i = 0; i < iterations; i++) est.step();
  return { phi: est.phi(), baseline: est.dynamicBaseline(), fx: est.fx };
}

/* ----------------------------------------------- 預警 → 建議行動規則 ----- */
const ADVICE_RULES = {
  moisture: x => ({
    title: "原料除濕再乾燥",
    detail: `含水率 ${x.moisture.toFixed(2)}% 超標（規範 ≤0.12%）。建議：本批原料回乾燥桶再乾燥 4 小時（80°C），並抽驗供應商批號。`,
    owner: "物料課", due: "立即"
  }),
  moldTemp: x => ({
    title: "校正模溫控制器",
    detail: `模具溫度 ${x.moldTemp.toFixed(1)}°C 偏離最適點 60°C。建議：調回 58–62°C，並檢查模溫機感溫線是否飄移。`,
    owner: "成型課", due: "30 分鐘內"
  }),
  injPressure: x => ({
    title: "降射出壓力並檢查噴嘴",
    detail: `射出壓力 ${x.injPressure.toFixed(0)} bar 過高（規範 ≤115）。建議：分段降至 110–115 bar，檢查噴嘴與螺桿磨耗。`,
    owner: "成型課", due: "1 小時內"
  }),
  holdTime: x => ({
    title: "延長保壓時間",
    detail: `保壓時間 ${x.holdTime.toFixed(1)}s 不足（規範 ≥2.9s）。建議：上調至 3.2–3.6s，觀察縮水與毛邊變化。`,
    owner: "成型課", due: "30 分鐘內"
  }),
  coolantTemp: x => ({
    title: "檢查冰水系統",
    detail: `冷卻水溫 ${x.coolantTemp.toFixed(1)}°C 偏高（規範 ≤24°C）。建議：檢查冰水機負載與管路結垢，必要時切換備援迴路。`,
    owner: "設備課", due: "2 小時內"
  }),
  runHours: x => ({
    title: "安排保養窗口",
    detail: `機台連續稼動 ${x.runHours.toFixed(0)} 小時（建議 ≤72）。建議：於下個換線點安排 2 小時一級保養。`,
    owner: "設備課", due: "今日內"
  }),
  humidity: x => ({
    title: "啟動廠區除濕",
    detail: `環境濕度 ${x.humidity.toFixed(0)}% 偏高（規範 ≤65%）。建議：開啟除濕機組並確認空調除濕模式，目標 60%。`,
    owner: "廠務課", due: "1 小時內"
  }),
  operatorExp: x => ({
    title: "資深人員帶線",
    detail: `操作員年資 ${x.operatorExp.toFixed(1)} 年偏低。建議：指派資深技術員督導本批次，並複核參數設定。`,
    owner: "製造部", due: "本班次"
  })
};

/** 把 SHAP 正貢獻轉成建議行動清單（預警 → 建議的核心） */
function adviceFromShap(x, phi, topN = 3) {
  return FEATURE_KEYS
    .map(k => ({ key: k, phi: phi[k] }))
    .filter(o => o.phi > 0.15)
    .sort((a, b) => b.phi - a.phi)
    .slice(0, topN)
    .map(o => ({ ...ADVICE_RULES[o.key](x), key: o.key, phi: o.phi }));
}

/** What-if：套用建議後的參數（把異常因子拉回規範值） */
function improvedSample(x, adviceKeys) {
  const fixed = { ...x };
  for (const k of adviceKeys) {
    if (k === "moisture") fixed.moisture = 0.09;
    if (k === "moldTemp") fixed.moldTemp = 60;
    if (k === "injPressure") fixed.injPressure = 110;
    if (k === "holdTime") fixed.holdTime = 3.4;
    if (k === "coolantTemp") fixed.coolantTemp = 22;
    if (k === "runHours") fixed.runHours = 24;
    if (k === "humidity") fixed.humidity = 60;
    if (k === "operatorExp") fixed.operatorExp = 8;
  }
  return fixed;
}

window.ShapData = {
  FEATURES,
  FEATURE_KEYS,
  DATASET,
  BASELINE,
  makeRng: mulberry32,
  predictDefectRate,
  riskLevel,
  ShapEstimator,
  resetShapRng,
  computeShap,
  adviceFromShap,
  improvedSample
};
