/**
 * warroom.js — Tab 2「營運戰情室」即時模擬引擎
 *
 * 每 2 秒 tick 一次：機台狀態、KPI、趨勢圖、事件流全部即時演進；
 * 講師可注入異常情境，AI Copilot 會主動回報分析。
 */
(function () {
  const $ = id => document.getElementById(id);
  const T = () => window.ChartTheme;
  const AXIS_COLOR = "rgba(125, 140, 166, 0.9)";

  /* ------------------------------------------------------------ state --- */
  const S = {
    started: false,
    tick: 0,
    machines: [],
    uph: 142,            // 全線每分鐘產出
    uphBase: 142,
    yieldRate: 97.2,
    yieldTarget: 97.2,   // 受情境影響的目標值
    outputToday: 0,      // init() 時依當下時段回填
    targetToday: 130000,
    energy: 412,
    oee: 87.4,
    prodHistory: [],     // [time, uph]
    yieldHistory: [],
    prevKpi: {},
    scenario: null,      // 進行中的情境
    scenarioTimer: null,
    lastAutoBrief: 0
  };

  const MACHINE_NAMES = Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);
  const STATUS_LABEL = { run: "運轉中", idle: "待機", warn: "警報", down: "停機" };

  let chartProd, chartYield, chartGauge;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const walk = (v, step, lo, hi) => Math.min(hi, Math.max(lo, v + rnd(-step, step)));
  const fmtInt = n => Math.round(n).toLocaleString("en-US");
  const nowLabel = () => new Date().toLocaleTimeString("zh-TW", { hour12: false });

  /* --------------------------------------------------------- machines --- */
  function initMachines() {
    S.machines = MACHINE_NAMES.map((name, i) => ({
      name,
      status: i === 7 ? "idle" : "run", // M08 預設待機，畫面有層次
      temp: rnd(54, 64),
      baseTemp: rnd(56, 62)
    }));
  }

  function renderMachines() {
    const grid = $("machine-grid");
    grid.innerHTML = "";
    for (const m of S.machines) {
      const div = document.createElement("div");
      div.className = `machine ${m.status}`;
      div.innerHTML = `
        <div class="mid">${m.name}</div>
        <div class="mstat">${STATUS_LABEL[m.status]}</div>
        <div class="mtemp">模溫 ${m.temp.toFixed(1)}°C</div>`;
      grid.appendChild(div);
    }
  }

  /* ------------------------------------------------------------ events -- */
  function pushEvent(level, tag, text) {
    const feed = $("event-feed");
    const div = document.createElement("div");
    div.className = `event ${level}`;
    div.innerHTML = `<span class="etime">${nowLabel()}</span><span class="etag">${tag}</span>${text}`;
    feed.prepend(div);
    while (feed.children.length > 30) feed.removeChild(feed.lastChild);
  }

  const MINOR_EVENTS = [
    ["info", "生產", () => `批次 #A${Math.floor(rnd(3100, 3900))} 完工入庫，數量 ${fmtInt(rnd(380, 520))} 件`],
    ["info", "物流", () => `AGV-${Math.floor(rnd(1, 6))} 完成原料補給（線邊倉 ${Math.floor(rnd(70, 95))}%）`],
    ["info", "品保", () => `SPC 抽檢通過：CPK ${rnd(1.42, 1.71).toFixed(2)}`],
    ["info", "能源", () => `空壓機組負載最佳化，預估節電 ${rnd(2, 5).toFixed(1)}%`],
    ["warn", "品保", () => `${MACHINE_NAMES[Math.floor(rnd(0, 12))]} 外觀不良連續 ${Math.floor(rnd(2, 4))} 件，已通知巡檢`]
  ];

  /* ---------------------------------------------------------- snapshot -- */
  // 兩班制 08:00–24:00 的時間進度（讓達成率有比較基準）
  function planProgress() {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    return Math.min(0.98, Math.max(0.05, (h - 8) / 16));
  }

  function snapshot() {
    const counts = { run: 0, idle: 0, warn: 0, down: 0 };
    S.machines.forEach(m => counts[m.status]++);
    const abnormal = S.machines
      .filter(m => m.status === "warn" || m.status === "down")
      .map(m => `${m.name}:${STATUS_LABEL[m.status]}(${m.temp.toFixed(0)}°C)`);
    const recent = Array.from($("event-feed").children)
      .slice(0, 5)
      .map(e => e.textContent.trim().replace(/\s+/g, " "));
    return {
      time: nowLabel(),
      kpi: {
        oee: +S.oee.toFixed(1),
        yield: +S.yieldRate.toFixed(2),
        uphPerMin: Math.round(S.uph),
        outputToday: Math.round(S.outputToday),
        targetToday: S.targetToday,
        achieveRate: +((S.outputToday / S.targetToday) * 100).toFixed(1),
        planProgressPct: +(planProgress() * 100).toFixed(1),
        energyKw: Math.round(S.energy),
        activeAlarms: counts.warn + counts.down
      },
      machines: { ...counts, abnormal },
      activeScenario: S.scenario ? S.scenario.title : "無",
      recentEvents: recent
    };
  }

  /* -------------------------------------------------------------- tick -- */
  function tickOnce() {
    S.tick++;

    // 機台溫度與隨機狀態微調
    for (const m of S.machines) {
      if (m.status === "warn") m.temp = walk(m.temp, 0.8, 70, 82);
      else if (m.status === "down") m.temp = Math.max(35, m.temp - 0.6);
      else if (m.status === "idle") m.temp = walk(m.temp, 0.3, 40, 55);
      else m.temp = walk(m.temp, 0.5, m.baseTemp - 4, m.baseTemp + 5);
    }
    // 偶爾待機↔運轉切換（非情境機台）
    if (S.tick % 23 === 0 && !S.scenario) {
      const idleM = S.machines.find(m => m.status === "idle");
      const runMs = S.machines.filter(m => m.status === "run");
      if (idleM && Math.random() < 0.5) {
        idleM.status = "run";
        pushEvent("info", "設備", `${idleM.name} 換線完成，恢復運轉`);
      } else if (runMs.length > 9) {
        const m = runMs[Math.floor(Math.random() * runMs.length)];
        m.status = "idle";
        pushEvent("info", "設備", `${m.name} 進入換線待機`);
      }
    }

    // 產出與良率
    const counts = { run: 0, idle: 0, warn: 0, down: 0 };
    S.machines.forEach(m => counts[m.status]++);
    const capacity = (counts.run + counts.warn * 0.55) / 11; // 以 11 台滿線為基準
    S.uph = walk(S.uph, 2.2, S.uphBase * capacity * 0.92, S.uphBase * capacity * 1.06);
    S.outputToday += (S.uph * 2) / 60; // 每 tick = 2 秒

    S.yieldRate += (S.yieldTarget - S.yieldRate) * 0.12 + rnd(-0.08, 0.08);
    S.yieldRate = Math.min(99.5, Math.max(88, S.yieldRate));

    // OEE = 稼動 × 效率 × 品質（簡化教學版）
    const availability = (counts.run + counts.warn * 0.7) / 12;
    const performance = S.uph / (S.uphBase * Math.max(0.3, availability));
    S.oee = Math.min(99, Math.max(40, availability * Math.min(1.05, performance) * (S.yieldRate / 100) * 100));

    S.energy = walk(S.energy, 4, 330 + counts.run * 6, 360 + counts.run * 9);

    // 歷史序列
    const t = nowLabel();
    S.prodHistory.push([t, Math.round(S.uph)]);
    S.yieldHistory.push([t, +S.yieldRate.toFixed(2)]);
    if (S.prodHistory.length > 40) S.prodHistory.shift();
    if (S.yieldHistory.length > 40) S.yieldHistory.shift();

    // 隨機小事件
    if (S.tick % 9 === 0 && Math.random() < 0.75) {
      const [lvl, tag, gen] = MINOR_EVENTS[Math.floor(Math.random() * MINOR_EVENTS.length)];
      pushEvent(lvl, tag, gen());
    }

    render(counts);

    // 自動巡檢回報（只在戰情室分頁顯示中才呼叫，避免在 Tab1 授課時持續燒 token）
    const auto = $("auto-toggle").checked && document.getElementById("page-war").classList.contains("active");
    const sinceLast = Date.now() - S.lastAutoBrief;
    if (auto && !window.Copilot.busy && (S.lastAutoBrief === 0 ? S.tick >= 5 : sinceLast > 75_000)) {
      S.lastAutoBrief = Date.now();
      window.Copilot.request({ mode: "routine", snapshot: snapshot(), title: "自動巡檢" });
    }
  }

  /* ------------------------------------------------------------ render -- */
  function setKpi(id, value, fmtFn, deltaFmt) {
    const el = $(id);
    el.textContent = fmtFn(value);
    const dEl = $(id + "-delta");
    if (dEl && S.prevKpi[id] != null) {
      const d = value - S.prevKpi[id];
      if (Math.abs(d) > 0.001) {
        dEl.textContent = (d > 0 ? "▲ " : "▼ ") + deltaFmt(Math.abs(d));
        dEl.className = "kpi-delta mono " + (d > 0 ? "up" : "down");
      }
    }
    S.prevKpi[id] = value;
  }

  function render(counts) {
    setKpi("kpi-oee", S.oee, v => v.toFixed(1), d => d.toFixed(1) + "pp");
    setKpi("kpi-output", S.outputToday, fmtInt, d => fmtInt(d) + " 件");
    $("kpi-output-delta").textContent = `目標 ${fmtInt(S.targetToday)} ‧ 達成 ${((S.outputToday / S.targetToday) * 100).toFixed(1)}%`;
    $("kpi-output-delta").className = "kpi-delta mono";
    setKpi("kpi-yield", S.yieldRate, v => v.toFixed(2), d => d.toFixed(2) + "pp");
    setKpi("kpi-machines", counts.run + counts.warn, v => String(v), d => String(Math.round(d)));
    setKpi("kpi-alarms", counts.warn + counts.down, v => String(v), d => String(Math.round(d)));
    setKpi("kpi-energy", S.energy, v => String(Math.round(v)), d => Math.round(d) + " kW");

    $("kpi-card-alarms").classList.toggle("alert", counts.warn + counts.down > 0);
    $("kpi-card-oee").classList.toggle("good", S.oee >= 85);
    document.querySelector("#kpi-yield").parentElement.parentElement
      .classList.toggle("alert", S.yieldRate < 95);

    renderMachines();
    renderCharts();
  }

  /* ------------------------------------------------------------ charts -- */
  function initCharts() {
    const t = T();
    chartProd = echarts.init($("chart-production"));
    chartYield = echarts.init($("chart-yield"));
    chartGauge = echarts.init($("chart-gauge"));
    window.addEventListener("resize", () => {
      [chartProd, chartYield, chartGauge].forEach(c => {
        if (c && c.getDom() && c.getDom().offsetWidth > 0) c.resize();
      });
    });

    chartProd.setOption({
      textStyle: t.textStyle,
      animation: true, animationDurationUpdate: 600, animationEasingUpdate: "linear",
      grid: { left: 44, right: 16, top: 18, bottom: 26 },
      tooltip: { ...t.tooltip, trigger: "axis" },
      xAxis: { type: "category", boundaryGap: false, axisLine: t.axisLine, axisLabel: { color: AXIS_COLOR, fontSize: 9.5 }, data: [] },
      yAxis: {
        type: "value", min: v => Math.floor(v.min - 15), max: v => Math.ceil(v.max + 10),
        axisLine: t.axisLine, splitLine: t.splitLine, axisLabel: { color: AXIS_COLOR, fontSize: 10 }
      },
      series: [{
        name: "件/分", type: "line", smooth: true, showSymbol: false,
        lineStyle: { width: 2.5, color: "#29e6ff", shadowBlur: 12, shadowColor: "rgba(41,230,255,.5)" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(41,230,255,.30)" },
            { offset: 1, color: "rgba(41,230,255,.01)" }
          ])
        },
        data: []
      }]
    });

    chartYield.setOption({
      textStyle: t.textStyle,
      animation: true, animationDurationUpdate: 600, animationEasingUpdate: "linear",
      grid: { left: 44, right: 16, top: 18, bottom: 26 },
      tooltip: { ...t.tooltip, trigger: "axis", valueFormatter: v => v + "%" },
      xAxis: { type: "category", boundaryGap: false, axisLine: t.axisLine, axisLabel: { color: AXIS_COLOR, fontSize: 9.5 }, data: [] },
      yAxis: {
        type: "value", min: 90, max: 100,
        axisLine: t.axisLine, splitLine: t.splitLine,
        axisLabel: { color: AXIS_COLOR, fontSize: 10, formatter: "{value}%" }
      },
      series: [{
        name: "良率", type: "line", smooth: true, showSymbol: false,
        lineStyle: { width: 2.5, color: "#38e8a0", shadowBlur: 12, shadowColor: "rgba(56,232,160,.5)" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(56,232,160,.22)" },
            { offset: 1, color: "rgba(56,232,160,.01)" }
          ])
        },
        markLine: {
          silent: true, symbol: "none",
          lineStyle: { color: "rgba(255,92,110,.6)", type: "dashed" },
          label: { color: "#ff5c6e", fontSize: 10, formatter: "管制下限 95%" },
          data: [{ yAxis: 95 }]
        },
        data: []
      }]
    });

    chartGauge.setOption({
      series: [{
        type: "gauge",
        startAngle: 210, endAngle: -30, min: 0, max: 100,
        radius: "95%", center: ["50%", "60%"],
        progress: {
          show: true, width: 12, roundCap: true,
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: "#409cff" }, { offset: 1, color: "#29e6ff" }
            ]),
            shadowBlur: 14, shadowColor: "rgba(41,230,255,.5)"
          }
        },
        axisLine: { lineStyle: { width: 12, color: [[1, "rgba(64,156,255,.12)"]] } },
        axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { show: false }, pointer: { show: false }, anchor: { show: false },
        title: { show: true, offsetCenter: [0, "32%"], color: AXIS_COLOR, fontSize: 11 },
        detail: {
          valueAnimation: true, offsetCenter: [0, "-5%"],
          color: "#29e6ff", fontSize: 30, fontFamily: "Orbitron",
          formatter: v => v.toFixed(1) + "%"
        },
        data: [{ value: S.oee, name: "Overall Equipment Effectiveness" }]
      }]
    });
  }

  function renderCharts() {
    chartProd.setOption({
      xAxis: { data: S.prodHistory.map(p => p[0]) },
      series: [{ data: S.prodHistory.map(p => p[1]) }]
    });
    chartYield.setOption({
      xAxis: { data: S.yieldHistory.map(p => p[0]) },
      series: [{ data: S.yieldHistory.map(p => p[1]) }]
    });
    chartGauge.setOption({ series: [{ data: [{ value: +S.oee.toFixed(1), name: "Overall Equipment Effectiveness" }] }] });
  }

  /* --------------------------------------------------------- scenarios -- */
  const SCENARIOS = {
    overheat: () => {
      const m = S.machines.find(x => x.status === "run") || S.machines[0];
      m.status = "warn";
      m.temp = 74;
      const ev = {
        title: `${m.name} 模溫異常飆升`,
        severity: "高",
        detail: `${m.name} 模具溫度於 90 秒內由 60°C 升至 ${(74 + rnd(2, 6)).toFixed(0)}°C，溫控器回授異常，恐影響成品尺寸安定性`
      };
      pushEvent("crit", "設備", `🔥 ${ev.detail}`);
      after(50_000, () => {
        if (m.status === "warn") {
          m.status = "run";
          m.temp = m.baseTemp;
          pushEvent("info", "設備", `${m.name} 溫控恢復正常，警報解除`);
        }
      });
      return ev;
    },
    "yield-drop": () => {
      S.yieldTarget = 93.2;
      const ev = {
        title: "整線良率異常下滑",
        severity: "高",
        detail: `滾動良率於 5 分鐘內由 97.2% 下探 93.5%，主要不良模式為表面縮水與毛邊，疑似與原料批次切換相關`
      };
      pushEvent("crit", "品保", `📉 ${ev.detail}`);
      after(45_000, () => {
        S.yieldTarget = 97.2;
        pushEvent("info", "品保", "不良原因鎖定原料含水率，已換批 + 加嚴抽檢，良率回升中");
      });
      return ev;
    },
    "rush-order": () => {
      S.targetToday += 12000;
      S.uphBase = 156;
      const ev = {
        title: "業務急單插入",
        severity: "中",
        detail: `業務部插入急單 12,000 件（交期 48 小時），今日目標上修至 ${fmtInt(S.targetToday)} 件，需評估加班與換線排程`
      };
      pushEvent("warn", "生管", `📦 ${ev.detail}`);
      return ev;
    },
    breakdown: () => {
      const m = [...S.machines].reverse().find(x => x.status === "run") || S.machines[5];
      m.status = "down";
      const ev = {
        title: `${m.name} 非計畫停機`,
        severity: "高",
        detail: `${m.name} 液壓系統壓力異常觸發安全停機，初判油封洩漏，預估修復 40~60 分鐘，該機台今日剩餘工單 ${fmtInt(rnd(1800, 2600))} 件`
      };
      pushEvent("crit", "設備", `🛑 ${ev.detail}`);
      after(60_000, () => {
        if (m.status === "down") {
          m.status = "idle";
          pushEvent("info", "設備", `${m.name} 維修完成，待機驗證中`);
          after(12_000, () => { if (m.status === "idle") { m.status = "run"; pushEvent("info", "設備", `${m.name} 恢復生產`); } });
        }
      });
      return ev;
    }
  };

  const timers = [];
  function after(ms, fn) { timers.push(setTimeout(fn, ms)); }

  function triggerScenario(key) {
    const gen = SCENARIOS[key];
    if (!gen) return;
    const ev = gen();
    S.scenario = ev;
    after(55_000, () => { if (S.scenario === ev) S.scenario = null; });
    // Copilot 主動回報（帶觸發當下的快照）
    window.Copilot.request({ mode: "event", event: ev, snapshot: snapshot(), title: ev.title });
  }

  /* ------------------------------------------------------------- init --- */
  function bindControls() {
    document.querySelectorAll(".btn.scenario").forEach(btn => {
      btn.addEventListener("click", () => {
        btn.disabled = true;
        setTimeout(() => (btn.disabled = false), 8000); // 防連點洗版
        triggerScenario(btn.dataset.scenario);
      });
    });
    $("btn-brief").addEventListener("click", () => {
      window.Copilot.request({ mode: "routine", snapshot: snapshot(), title: "指揮官請求" });
    });
    const ask = () => {
      const q = $("ask-input").value.trim();
      if (!q) return;
      $("ask-input").value = "";
      window.Copilot.request({ mode: "ask", question: q, snapshot: snapshot(), title: q });
    };
    $("btn-ask").addEventListener("click", ask);
    // isComposing / keyCode 229：避免中文輸入法選字的 Enter 提早送出
    $("ask-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) ask();
    });
  }

  function init() {
    if (S.started) {
      [chartProd, chartYield, chartGauge].forEach(c => c && c.resize());
      return;
    }
    S.started = true;
    initMachines();
    bindControls();
    initCharts();

    // 今日累計產量依時段回填（達成率 ≈ 排程進度 × 95~100%，敘事才合理）
    S.outputToday = Math.round(S.targetToday * planProgress() * rnd(0.955, 1.0));

    // 預填 20 點歷史，圖表一進來就是活的
    for (let i = 20; i > 0; i--) {
      S.uph = walk(S.uph, 2.5, 132, 150);
      S.yieldRate = walk(S.yieldRate, 0.12, 96.6, 97.8);
      const d = new Date(Date.now() - i * 2000);
      const lbl = d.toLocaleTimeString("zh-TW", { hour12: false });
      S.prodHistory.push([lbl, Math.round(S.uph)]);
      S.yieldHistory.push([lbl, +S.yieldRate.toFixed(2)]);
    }
    pushEvent("info", "系統", "WinHub.AI 戰情室已連線，開始接收產線即時數據");
    tickOnce();
    setInterval(tickOnce, 2000);
  }

  window.WarRoom = { init, snapshot };
})();
