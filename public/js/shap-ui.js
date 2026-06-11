/**
 * shap-ui.js — Tab 1「SHAP 預警解析」的介面與動畫
 */
(function () {
  const D = window.ShapData;
  const $ = id => document.getElementById(id);

  /* ---------------------------------------------- shared chart theme ---- */
  const AXIS_COLOR = "rgba(125, 140, 166, 0.9)";
  const SPLIT_COLOR = "rgba(64, 156, 255, 0.10)";
  window.ChartTheme = {
    textStyle: { fontFamily: "Noto Sans TC, sans-serif", color: AXIS_COLOR },
    axisLine: { lineStyle: { color: "rgba(64,156,255,0.25)" } },
    splitLine: { lineStyle: { color: SPLIT_COLOR } },
    tooltip: {
      backgroundColor: "rgba(10, 18, 36, 0.95)",
      borderColor: "rgba(41, 230, 255, 0.35)",
      textStyle: { color: "#d7e3f4", fontSize: 12 },
      axisPointer: { lineStyle: { color: "rgba(41,230,255,.4)" } }
    }
  };
  const T = window.ChartTheme;

  /* ------------------------------------------------------------ state --- */
  let selected = null;          // 目前選取的批次
  let estimator = null;         // ShapEstimator
  let runTimer = null;
  let runDone = false;
  let lastAdvice = [];
  const TOTAL_ITERS = 300;
  const convergeHistory = { iters: [], series: {} }; // key -> [φ...]
  D.FEATURE_KEYS.forEach(k => (convergeHistory.series[k] = []));

  let chartConverge, chartWaterfall, chartImportance, chartDependence;
  let globalComputed = false;
  let globalPhi = null; // 50 批次的 φ（依賴圖切換特徵時重繪用）

  const fmt = (v, d = 2) => Number(v).toFixed(d);
  const sign = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);

  /* --------------------------------------------------------- the table -- */
  function isBadValue(key, x) {
    switch (key) {
      case "moldTemp": return Math.abs(x.moldTemp - 60) > 2;
      case "injPressure": return x.injPressure > 115;
      case "holdTime": return x.holdTime < 2.9;
      case "coolantTemp": return x.coolantTemp > 24;
      case "moisture": return x.moisture > 0.12;
      case "runHours": return x.runHours > 72;
      case "humidity": return x.humidity > 65;
      case "operatorExp": return x.operatorExp < 2;
      default: return false;
    }
  }

  function renderTable() {
    const tbody = $("shap-table-body");
    tbody.innerHTML = "";
    for (const row of D.DATASET) {
      const risk = D.riskLevel(row.pred);
      const tr = document.createElement("tr");
      tr.dataset.id = row.id;
      tr.innerHTML = `
        <td>${row.id}</td>
        <td>${row.machine}</td>
        <td class="${isBadValue("moldTemp", row) ? "hot" : ""}">${fmt(row.moldTemp, 1)}</td>
        <td class="${isBadValue("injPressure", row) ? "hot" : ""}">${fmt(row.injPressure, 0)}</td>
        <td class="${isBadValue("holdTime", row) ? "hot" : ""}">${fmt(row.holdTime, 1)}</td>
        <td class="${isBadValue("moisture", row) ? "hot" : ""}">${fmt(row.moisture, 2)}</td>
        <td class="${isBadValue("humidity", row) ? "hot" : ""}">${fmt(row.humidity, 0)}</td>
        <td><b>${fmt(row.pred, 2)}%</b></td>
        <td><span class="risk-badge ${risk.cls}">${risk.label}</span></td>`;
      tr.addEventListener("click", () => selectRow(row.id));
      tbody.appendChild(tr);
    }
  }

  /* ------------------------------------------------------ select a row -- */
  function selectRow(id) {
    selected = D.DATASET.find(r => r.id === id);
    document.querySelectorAll("#shap-table-body tr").forEach(tr => {
      tr.classList.toggle("selected", tr.dataset.id === id);
    });

    const risk = D.riskLevel(selected.pred);
    $("sel-id").textContent = selected.id;
    $("sel-machine").textContent = `機台 ${selected.machine}`;
    $("sel-pred").textContent = `${fmt(selected.pred)}%`;
    const badge = $("sel-risk");
    badge.textContent = risk.label;
    badge.className = `risk-badge ${risk.cls}`;

    const box = $("sel-features");
    box.innerHTML = "";
    for (const f of D.FEATURES) {
      const bad = isBadValue(f.key, selected);
      const div = document.createElement("div");
      div.className = `feat-chip${bad ? " bad" : ""}`;
      div.innerHTML = `<label>${f.name}（規範 ${f.ideal}）</label>
        <b>${fmt(selected[f.key], f.digits)}</b><small>${f.unit}</small>`;
      box.appendChild(div);
    }
    resetRun();
  }

  /* --------------------------------------------------------- run reset -- */
  function resetRun() {
    if (runTimer) clearTimeout(runTimer);
    runTimer = null;
    runDone = false;
    lastAdvice = [];
    D.resetShapRng();
    estimator = new D.ShapEstimator(selected);
    convergeHistory.iters = [];
    D.FEATURE_KEYS.forEach(k => (convergeHistory.series[k] = []));

    $("shap-iter").textContent = "0";
    $("shap-progress").style.width = "0%";
    $("btn-shap-run").textContent = "▶ 開始計算";
    $("btn-shap-run").disabled = false;
    $("btn-whatif").disabled = true;
    $("whatif-result").innerHTML = "";
    $("advice-list").innerHTML =
      `<div class="advice-empty">完成 SHAP 計算後，系統會把主要風險因子轉換成可執行的改善建議。</div>`;
    $("shap-log").innerHTML =
      `<div class="log-line muted">目標批次 ${selected.id}｜f(x) = ${fmt(selected.pred)}%｜按「開始計算」播放抽樣過程</div>`;
    $("eq-baseline").textContent = `基準 ${fmt(D.BASELINE)}%`;
    $("eq-sum").textContent = "Σφ --";
    $("eq-pred").textContent = `預測 ${fmt(selected.pred)}%`;
    $("eq-check").textContent = "";

    renderConverge();
    renderWaterfall(true);
  }

  /* ----------------------------------------------------- the animation -- */
  const SPEEDS = {
    slow: { batch: 2, interval: 140 },
    normal: { batch: 6, interval: 70 },
    fast: { batch: 20, interval: 30 }
  };

  function startRun() {
    if (runTimer || !selected) return;
    if (runDone) resetRun();
    $("btn-shap-run").textContent = "‖ 計算中…";
    $("btn-shap-run").disabled = true;
    $("shap-log").innerHTML = "";

    // setTimeout 鏈：每輪重讀速度設定，講課中可即時切換快慢
    const tick = () => {
      const speed = SPEEDS[$("shap-speed").value] || SPEEDS.normal;
      let detail = null;
      const n = Math.min(speed.batch, TOTAL_ITERS - estimator.iter);
      for (let i = 0; i < n; i++) detail = estimator.step();

      // 進度與日誌
      $("shap-iter").textContent = String(estimator.iter);
      $("shap-progress").style.width = `${(estimator.iter / TOTAL_ITERS) * 100}%`;
      if (detail) appendLog(detail);

      // 收斂歷史（每批記一點）
      const phi = estimator.phi();
      convergeHistory.iters.push(estimator.iter);
      D.FEATURE_KEYS.forEach(k => convergeHistory.series[k].push(phi[k]));
      renderConverge();
      renderWaterfall();
      updateEquation();

      if (estimator.iter >= TOTAL_ITERS) {
        finishRun();
        return;
      }
      runTimer = setTimeout(tick, speed.interval);
    };
    runTimer = setTimeout(tick, 0);
  }

  function appendLog(detail) {
    const phiNow = {};
    D.FEATURE_KEYS.forEach(k => (phiNow[k] = detail.contribs[k]));
    const top = D.FEATURE_KEYS.slice()
      .sort((a, b) => Math.abs(phiNow[b]) - Math.abs(phiNow[a]))
      .slice(0, 2);
    const parts = top.map(k => {
      const f = D.FEATURES.find(o => o.key === k);
      const v = phiNow[k];
      return `<span class="lf">${f.name}</span> <span class="${v >= 0 ? "lv-pos" : "lv-neg"}">${sign(v)}</span>`;
    });
    const box = $("shap-log");
    const div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML =
      `#${String(estimator.iter).padStart(3, "0")} 背景 <span class="lz">${detail.z.id}</span>` +
      `｜f(z)=${fmt(detail.fz)}%｜主要邊際貢獻：${parts.join("、")}`;
    box.appendChild(div);
    while (box.children.length > 60) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function updateEquation() {
    const phi = estimator.phi();
    const sum = D.FEATURE_KEYS.reduce((s, k) => s + phi[k], 0);
    const base = estimator.dynamicBaseline();
    $("eq-baseline").textContent = `基準 ${fmt(base)}%`;
    $("eq-sum").textContent = `Σφ ${sign(sum)}`;
    $("eq-pred").textContent = `預測 ${fmt(estimator.fx)}%`;
    const ok = Math.abs(base + sum - estimator.fx) < 0.005;
    $("eq-check").textContent = ok ? "✓ 可加性成立" : "";
  }

  function finishRun() {
    clearTimeout(runTimer);
    runTimer = null;
    runDone = true;
    $("btn-shap-run").textContent = "⟲ 重新計算";
    $("btn-shap-run").disabled = false;

    const div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML = `<span class="lv-neg">■ 完成</span> ${TOTAL_ITERS} 次抽樣，φ 已收斂。`;
    $("shap-log").appendChild(div);
    $("shap-log").scrollTop = $("shap-log").scrollHeight;

    renderAdvice();
  }

  /* ------------------------------------------------- convergence chart -- */
  // 只 resize 可見的圖：對 display:none 容器 resize 會把 canvas 壓成最小尺寸
  function safeResize(...charts) {
    charts.forEach(c => {
      if (c && c.getDom() && c.getDom().offsetWidth > 0) c.resize();
    });
  }

  function initCharts() {
    chartConverge = echarts.init($("chart-converge"));
    chartWaterfall = echarts.init($("chart-waterfall"));
    window.addEventListener("resize", () => {
      safeResize(chartConverge, chartWaterfall, chartImportance, chartDependence);
    });
  }

  function renderConverge() {
    const series = D.FEATURES.map(f => ({
      name: f.name,
      type: "line",
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 1.6, color: f.color },
      itemStyle: { color: f.color },
      emphasis: { focus: "series" },
      data: convergeHistory.series[f.key].map((v, i) => [convergeHistory.iters[i], v])
    }));
    chartConverge.setOption({
      textStyle: T.textStyle,
      animation: false,
      grid: { left: 42, right: 12, top: 30, bottom: 24 },
      legend: {
        type: "scroll", top: 0, textStyle: { color: AXIS_COLOR, fontSize: 10 },
        itemWidth: 12, itemHeight: 7, pageIconColor: "#29e6ff"
      },
      tooltip: { ...T.tooltip, trigger: "axis", valueFormatter: v => (v == null ? "-" : Number(v).toFixed(3)) },
      xAxis: {
        type: "value", min: 0, max: TOTAL_ITERS, name: "迭代",
        nameTextStyle: { color: AXIS_COLOR, fontSize: 10 },
        axisLine: T.axisLine, splitLine: { show: false },
        axisLabel: { color: AXIS_COLOR, fontSize: 10 }
      },
      yAxis: {
        type: "value", name: "φ (pp)",
        nameTextStyle: { color: AXIS_COLOR, fontSize: 10 },
        axisLine: T.axisLine, splitLine: T.splitLine,
        axisLabel: { color: AXIS_COLOR, fontSize: 10, formatter: v => v.toFixed(1) }
      },
      series
    }, { replaceMerge: ["series"] });
  }

  /* --------------------------------------------------- waterfall chart -- */
  function renderWaterfall(empty = false) {
    const phi = estimator ? estimator.phi() : {};
    const base = estimator ? estimator.dynamicBaseline() : D.BASELINE;
    const fx = selected ? selected.pred : 0;

    const order = D.FEATURE_KEYS.slice().sort((a, b) => Math.abs(phi[b] || 0) - Math.abs(phi[a] || 0));
    const cats = ["基準值 E[f(z)]"];
    const placeholders = [0];
    const values = [{ value: base, itemStyle: { color: "rgba(64,156,255,.75)" }, label: { show: true, position: "right", color: "#7d8ca6", formatter: () => fmt(base) + "%" } }];

    let cum = base;
    for (const k of order) {
      const f = D.FEATURES.find(o => o.key === k);
      const v = empty ? 0 : phi[k] || 0;
      const start = cum;
      const end = cum + v;
      cats.push(f.name);
      placeholders.push(Math.min(start, end));
      values.push({
        value: Math.abs(v),
        itemStyle: {
          color: v >= 0 ? "rgba(255,92,110,.85)" : "rgba(56,232,160,.85)",
          borderRadius: 3,
          shadowBlur: 8,
          shadowColor: v >= 0 ? "rgba(255,92,110,.4)" : "rgba(56,232,160,.4)"
        },
        label: {
          show: Math.abs(v) > 0.01, position: "right",
          color: v >= 0 ? "#ff5c6e" : "#38e8a0",
          fontFamily: "Orbitron", fontSize: 10,
          formatter: () => sign(v)
        }
      });
      cum = end;
    }
    cats.push("模型預測 f(x)");
    placeholders.push(0);
    values.push({
      value: empty ? 0 : fx,
      itemStyle: { color: "rgba(41,230,255,.9)", shadowBlur: 12, shadowColor: "rgba(41,230,255,.5)", borderRadius: 3 },
      label: { show: !empty, position: "right", color: "#29e6ff", fontFamily: "Orbitron", formatter: () => fmt(fx) + "%" }
    });

    chartWaterfall.setOption({
      textStyle: T.textStyle,
      animationDuration: 300,
      animationDurationUpdate: 250,
      grid: { left: 110, right: 70, top: 10, bottom: 24 },
      tooltip: { ...T.tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: params => {
        const p = params.find(o => o.seriesName === "value");
        return p ? `${p.name}` : "";
      } },
      xAxis: {
        type: "value", axisLine: T.axisLine, splitLine: T.splitLine,
        axisLabel: { color: AXIS_COLOR, fontSize: 10, formatter: v => v + "%" }
      },
      yAxis: {
        type: "category", inverse: true, data: cats,
        axisLine: T.axisLine, axisTick: { show: false },
        axisLabel: { color: "#d7e3f4", fontSize: 11.5 }
      },
      series: [
        { name: "placeholder", type: "bar", stack: "wf", itemStyle: { color: "transparent" }, emphasis: { itemStyle: { color: "transparent" } }, data: placeholders, barWidth: 16, silent: true },
        { name: "value", type: "bar", stack: "wf", data: values, barWidth: 16 }
      ]
    });
  }

  /* --------------------------------------------------- advice rendering - */
  function renderAdvice() {
    const phi = estimator.phi();
    lastAdvice = D.adviceFromShap(selected, phi, 3);
    const box = $("advice-list");
    box.innerHTML = "";
    if (!lastAdvice.length) {
      box.innerHTML = `<div class="advice-empty">此批次無顯著風險因子（所有 φ 貢獻 < 0.15pp），維持標準作業即可。</div>`;
      return;
    }
    lastAdvice.forEach((a, i) => {
      const card = document.createElement("div");
      card.className = "advice-card";
      card.innerHTML = `
        <span class="rank mono">φ ${sign(a.phi)}pp</span>
        <h5>${i + 1}. ${a.title}</h5>
        <p>${a.detail}</p>
        <div class="meta"><span>負責：<b>${a.owner}</b></span><span>時限：<b>${a.due}</b></span></div>`;
      box.appendChild(card);
    });
    $("btn-whatif").disabled = false;
  }

  function runWhatIf() {
    if (!lastAdvice.length) return;
    const fixed = D.improvedSample(selected, lastAdvice.map(a => a.key));
    const newPred = D.predictDefectRate(fixed);
    const drop = selected.pred - newPred;
    $("whatif-result").innerHTML = `
      <div class="whatif-box">
        <span class="wf-num" style="color:#ff5c6e">${fmt(selected.pred)}%</span>
        <span class="arrow">➜</span>
        <span class="wf-num" style="color:#38e8a0">${fmt(newPred)}%</span>
        <p>套用 ${lastAdvice.length} 項建議後重新預測：不良率預估下降 <b>${fmt(drop)} 個百分點</b>（−${fmt((drop / selected.pred) * 100, 0)}%）。<br/>這就是「預警 → 解釋 → 建議 → 驗證」的完整閉環。</p>
      </div>`;
  }

  /* ----------------------------------------------------- global charts -- */
  function computeGlobal() {
    if (globalComputed) return;
    globalComputed = true;

    // 用獨立 RNG，避免干擾單批次動畫的共用隨機流（可重播性）
    const globalRng = D.makeRng(778);
    const allPhi = D.DATASET.map(row => D.computeShap(row, 150, globalRng).phi);

    // mean |SHAP|
    const imp = D.FEATURES.map(f => ({
      f,
      mean: allPhi.reduce((s, p) => s + Math.abs(p[f.key]), 0) / allPhi.length
    })).sort((a, b) => a.mean - b.mean);

    chartImportance = echarts.init($("chart-importance"));
    chartImportance.setOption({
      textStyle: T.textStyle,
      grid: { left: 100, right: 60, top: 10, bottom: 26 },
      tooltip: { ...T.tooltip, valueFormatter: v => Number(v).toFixed(3) + " pp" },
      xAxis: {
        type: "value", name: "mean |φ| (pp)",
        nameTextStyle: { color: AXIS_COLOR, fontSize: 10 },
        axisLine: T.axisLine, splitLine: T.splitLine,
        axisLabel: { color: AXIS_COLOR, fontSize: 10 }
      },
      yAxis: {
        type: "category", data: imp.map(o => o.f.name),
        axisLine: T.axisLine, axisTick: { show: false },
        axisLabel: { color: "#d7e3f4", fontSize: 12 }
      },
      series: [{
        type: "bar", barWidth: 14,
        data: imp.map(o => ({
          value: +o.mean.toFixed(3),
          itemStyle: {
            borderRadius: 3,
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: "rgba(64,156,255,.5)" },
              { offset: 1, color: "rgba(41,230,255,.95)" }
            ]),
            shadowBlur: 8, shadowColor: "rgba(41,230,255,.3)"
          },
          label: { show: true, position: "right", color: "#29e6ff", fontFamily: "Orbitron", fontSize: 10, formatter: "{c}" }
        })),
        animationDelay: idx => idx * 60
      }]
    });

    // 依賴圖：下拉選特徵（依重要性排序），x = 特徵實際值，y = 該特徵的 φ
    globalPhi = allPhi;
    const sel = $("dep-feature");
    sel.innerHTML = "";
    imp.slice().reverse().forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.f.key;
      opt.textContent = `${o.f.name}（${o.f.unit}）`;
      sel.appendChild(opt);
    });
    sel.value = "moisture"; // 預設講「含水率」— 故事最清楚
    sel.addEventListener("change", () => renderDependence(sel.value));
    chartDependence = echarts.init($("chart-dependence"));
    renderDependence(sel.value);
  }

  /* ----------------------------------------------- dependence plot ------ */
  // 各特徵的製程規範線（畫在依賴圖上，讓「超規 → 風險放大」一目了然）
  const SPEC_LINES = {
    moldTemp: [58, 62],
    injPressure: [115],
    holdTime: [2.9],
    coolantTemp: [24],
    moisture: [0.12],
    runHours: [72],
    humidity: [65],
    operatorExp: []
  };

  function renderDependence(key) {
    const f = D.FEATURES.find(o => o.key === key);
    const pts = D.DATASET.map((row, ri) => {
      const phi = globalPhi[ri][key];
      return {
        value: [row[key], phi],
        itemStyle: {
          color: phi >= 0 ? "rgba(255,92,110,.85)" : "rgba(56,232,160,.85)",
          shadowBlur: 6,
          shadowColor: phi >= 0 ? "rgba(255,92,110,.4)" : "rgba(56,232,160,.4)"
        },
        batch: row.id
      };
    });

    chartDependence.setOption({
      textStyle: T.textStyle,
      grid: { left: 56, right: 30, top: 26, bottom: 44 },
      tooltip: {
        ...T.tooltip,
        formatter: p =>
          `批次 <b>${p.data.batch}</b><br/>${f.name}：${p.value[0].toFixed(f.digits)} ${f.unit}` +
          `<br/>風險貢獻 φ = ${p.value[1] >= 0 ? "+" : ""}${p.value[1].toFixed(2)} pp`
      },
      xAxis: {
        type: "value", scale: true,
        name: `${f.name}（${f.unit}）`, nameLocation: "middle", nameGap: 30,
        nameTextStyle: { color: "#d7e3f4", fontSize: 12 },
        axisLine: T.axisLine, splitLine: T.splitLine,
        axisLabel: { color: AXIS_COLOR, fontSize: 10 }
      },
      yAxis: {
        type: "value", name: "對不良率的貢獻 φ (pp)",
        nameTextStyle: { color: AXIS_COLOR, fontSize: 10 },
        axisLine: T.axisLine, splitLine: T.splitLine,
        axisLabel: { color: AXIS_COLOR, fontSize: 10 }
      },
      series: [{
        type: "scatter", symbolSize: 10, data: pts,
        emphasis: { scale: 1.5 },
        markLine: {
          silent: true, symbol: "none",
          data: [
            {
              yAxis: 0,
              lineStyle: { color: "rgba(125,140,166,.5)", type: "dashed" },
              label: { show: false }
            },
            ...(SPEC_LINES[key] || []).map(v => ({
              xAxis: v,
              lineStyle: { color: "rgba(255,181,71,.8)", type: "dashed", width: 1.5 },
              label: { show: true, color: "#ffb547", fontSize: 10, formatter: `規範 ${v}` }
            }))
          ]
        },
        animationDelay: idx => idx * 8
      }]
    }, { replaceMerge: ["series"] });
  }

  /* -------------------------------------------------------- sub-tabs ---- */
  document.querySelectorAll(".subtab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".subtab-page").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $(`subtab-${btn.dataset.subtab}`).classList.add("active");
      if (btn.dataset.subtab === "global") {
        computeGlobal();
        setTimeout(() => safeResize(chartImportance, chartDependence), 30);
      }
    });
  });

  /* ------------------------------------------------------------- init --- */
  function init() {
    $("shap-baseline").textContent = `${D.BASELINE.toFixed(2)}%`;
    renderTable();
    initCharts();
    // 預設選一筆「有故事」的高風險批次（含水率 × 濕度交互作用）
    selectRow("B24");
    $("btn-shap-run").addEventListener("click", startRun);
    $("btn-whatif").addEventListener("click", runWhatIf);
  }

  window.ShapUI = { init, resize: () => safeResize(chartConverge, chartWaterfall, chartImportance, chartDependence) };
})();
