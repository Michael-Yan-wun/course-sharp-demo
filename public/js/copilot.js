/**
 * copilot.js — AI Copilot 串流客戶端
 *
 * 對 /api/copilot 發出請求並以 SSE 串流接收，文字逐塊打入訊息卡，
 * 營造「分析即時出現在儀表板上」的效果。伺服器端在 OpenAI 失敗時
 * 會自動切換為離線備援腳本，前端只負責顯示來源標記。
 */
(function () {
  const $ = id => document.getElementById(id);
  let busy = false;
  let pending = null; // 最多保留一筆排隊請求

  const MODE_LABEL = {
    routine: { text: "例行巡檢", cls: "routine" },
    event: { text: "異常回報", cls: "event" },
    ask: { text: "指揮官提問", cls: "ask" }
  };

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function decorate(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    html = html.replace(/【([^】]+)】/g, '<span class="sec">【$1】</span>');
    return html;
  }

  function newMessage(mode, title) {
    const feed = $("copilot-feed");
    const welcome = feed.querySelector(".copilot-welcome");
    if (welcome) welcome.remove();

    const m = MODE_LABEL[mode] || MODE_LABEL.routine;
    const div = document.createElement("div");
    div.className = "copilot-msg";
    const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
    div.innerHTML = `
      <div class="cm-head">
        <span class="cm-mode ${m.cls}">${m.text}</span>
        <span class="mono">${time}</span>
        ${title ? `<span>｜${escapeHtml(title)}</span>` : ""}
      </div>
      <div class="cm-body"><span class="cursor"></span></div>`;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
    while (feed.children.length > 12) feed.removeChild(feed.firstChild);
    return div.querySelector(".cm-body");
  }

  async function request({ mode = "routine", event = null, question = "", snapshot = {}, title = "" }) {
    if (busy) {
      // 異常回報優先權最高，覆蓋排隊中的例行請求
      if (mode === "event" || !pending) pending = { mode, event, question, snapshot, title };
      return;
    }
    busy = true;
    setThinking(true);

    const body = newMessage(mode, title);
    let acc = "";

    // watchdog：串流卡住 60 秒就放棄，避免 busy 鎖死整個 Copilot
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ mode, event, question, snapshot })
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let source = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const evt of events) {
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let parsed;
            try { parsed = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (parsed.delta) {
              acc += parsed.delta;
              body.innerHTML = decorate(acc) + '<span class="cursor"></span>';
              $("copilot-feed").scrollTop = $("copilot-feed").scrollHeight;
            }
            if (parsed.done) source = parsed;
          }
        }
      }
      body.innerHTML = decorate(acc || "（無回應）");
      if (source && source.interrupted) {
        body.innerHTML +=
          `<br/><span style="color:#ffb547">⚠ 串流中斷，以上為部分回應，可再請求一次簡報。</span>`;
      }
      updateSourceBadge(source);
    } catch (e) {
      const msg = e.name === "AbortError" ? "回應逾時" : e.message;
      body.innerHTML = decorate(acc) +
        `<br/><span style="color:#ff5c6e">⚠ 連線中斷（${escapeHtml(msg)}），請再試一次。</span>`;
    } finally {
      clearTimeout(watchdog);
      busy = false;
      setThinking(false);
      if (pending) {
        const next = pending;
        pending = null;
        setTimeout(() => request(next), 600);
      }
    }
  }

  function setThinking(on) {
    const orb = $("copilot-orb");
    if (orb) orb.classList.toggle("thinking", on);
  }

  function updateSourceBadge(info) {
    const el = $("copilot-source");
    if (!el || !info) return;
    if (info.source === "openai" && info.interrupted) {
      el.textContent = "串流中斷";
      el.style.color = "#ffb547";
      el.style.borderColor = "rgba(255,181,71,.4)";
    } else if (info.source === "openai") {
      el.textContent = `LIVE ‧ ${info.model || "GPT"}`;
      el.style.color = "#38e8a0";
      el.style.borderColor = "rgba(56,232,160,.4)";
    } else {
      el.textContent = "離線備援模式";
      el.style.color = "#ffb547";
      el.style.borderColor = "rgba(255,181,71,.4)";
    }
  }

  /* 開機時打 /api/health，先標示連線型態 */
  async function probe() {
    try {
      const res = await fetch("/api/health");
      const j = await res.json();
      const conn = $("conn-status");
      const src = $("copilot-source");
      if (j.copilot === "openai") {
        conn.className = "conn online";
        conn.querySelector("span").textContent = `AI 引擎連線 ‧ ${j.model}`;
        src.textContent = `READY ‧ ${j.model}`;
      } else {
        conn.className = "conn local";
        conn.querySelector("span").textContent = "離線備援模式";
        src.textContent = "離線備援模式";
      }
      $("footer-mode").textContent = `copilot: ${j.copilot}`;
    } catch {
      $("conn-status").querySelector("span").textContent = "伺服器離線";
    }
  }

  window.Copilot = {
    request,
    probe,
    get busy() { return busy; }
  };
})();
