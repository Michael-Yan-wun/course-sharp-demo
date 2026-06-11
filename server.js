/**
 * WinHub.AI 戰情室 — teaching demo server
 *
 * Zero-dependency Node server:
 *   - serves the static SPA from /public
 *   - POST /api/copilot : streams a GPT analysis (SSE). Falls back to a local
 *     simulated narrator when no API key is configured or the upstream fails,
 *     so the classroom demo never dies.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

/* ---------------------------------------------------------------- env ---- */
// Tiny .env loader (kept dependency-free for one-click Zeabur deploys).
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env file — fine, rely on real env vars */
  }
})();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ------------------------------------------------------------- static ---- */
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fbErr, fallback) => {
        if (fbErr) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": contentTypes[".html"] });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath);
    // vendor 大檔（echarts ~1MB）允許快取一天，其餘維持 no-store 方便迭代
    const cacheable = safePath.replace(/\\/g, "/").includes("vendor/");
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": cacheable ? "public, max-age=86400" : "no-store"
    });
    res.end(content);
  });
}

/* -------------------------------------------------------------- utils ---- */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // 累積 Buffer 再一次解碼：避免多位元組中文字被 chunk 邊界切壞
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/* ------------------------------------------------------ copilot prompt --- */
function buildMessages(body) {
  const { mode = "routine", event = null, snapshot = {}, question = "" } = body;

  const system = [
    "你是「WinHub.AI 戰情室」的 AI 營運副駕駛（Copilot），即時向製造業高階主管簡報。",
    "語言：繁體中文。風格：冷靜、精準、量化、可執行，像戰情室值班官。",
    "嚴格遵守輸出格式：",
    "第一行：一句話總結當前態勢（必須引用快照中的關鍵數字）。",
    "接著一行【風險焦點】，列 1~2 點最值得注意的風險。",
    "接著一行【建議行動】，列 2~3 點，每點以「・」開頭，註明負責單位與時限（例：製造部，30 分鐘內）。",
    "全文不超過 180 字。不要任何開場白、客套話或結尾語。不要使用 # 標題。",
    "判讀產量達成率（achieveRate）時，必須與排程進度（planProgressPct，生產時段已過比例）比較：兩者接近代表正常，明顯落後才是風險。"
  ].join("\n");

  let task;
  if (mode === "event" && event) {
    task = `產線剛剛觸發事件：「${event.title}」（等級：${event.severity}，內容：${event.detail}）。請立即向指揮官回報分析與處置建議。`;
  } else if (mode === "ask" && question) {
    task = `指揮官提問：「${question}」。請依據快照數據回答並給出建議。`;
  } else {
    task = "請進行例行產線巡檢簡報，主動指出趨勢變化與潛在風險。";
  }

  const user = `${task}\n\n=== 戰情室即時快照 (JSON) ===\n${JSON.stringify(snapshot, null, 1)}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

/* ----------------------------------------------- local fallback narrator - */
// Generates a believable Mandarin briefing from the snapshot so the demo
// keeps streaming even with no network / quota issues.
function fallbackScript(body) {
  const s = body.snapshot || {};
  const k = s.kpi || {};
  // 截斷使用者可控的回打內容，避免惡意長 payload 拖住打字 timer
  const ev = body.event
    ? {
        title: String(body.event.title || "").slice(0, 80),
        detail: String(body.event.detail || "").slice(0, 200)
      }
    : null;
  const oee = k.oee != null ? `${k.oee}%` : "—";
  const yld = k.yield != null ? `${k.yield}%` : "—";
  const out = k.outputToday != null ? `${k.outputToday} 件` : "—";
  const alarms = k.activeAlarms != null ? k.activeAlarms : "—";

  if (body.mode === "event" && ev) {
    return [
      `偵測到「${ev.title}」，目前整線 OEE ${oee}、良率 ${yld}，警報數 ${alarms}。`,
      `【風險焦點】${ev.detail}；若 30 分鐘內未處置，預估影響今日達成率 2~4 個百分點。`,
      `【建議行動】`,
      `・製造部：15 分鐘內派員至現場確認設備狀態並回報（15 分鐘內）。`,
      `・品保部：對受影響批次啟動加嚴抽檢（30 分鐘內）。`,
      `・生管：評估是否將工單轉移至備援機台（1 小時內）。`
    ].join("\n");
  }
  return [
    `例行巡檢：整線 OEE ${oee}、良率 ${yld}、今日累計產量 ${out}，警報 ${alarms} 件，整體態勢受控。`,
    `【風險焦點】留意高稼動機台的溫度爬升趨勢；夜班人力配置略低於標準。`,
    `【建議行動】`,
    `・設備課：對連續稼動超過 72 小時之機台安排保養窗口（今日內）。`,
    `・生管：確認明日急單之原料到位狀況（下班前）。`
  ].join("\n");
}

function streamFallback(res, body) {
  if (res.destroyed) return; // client 在 OpenAI fetch 階段就斷線了
  sseHead(res);
  const text = fallbackScript(body);
  const chunks = Array.from(text);
  let i = 0;
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      clearInterval(timer);
      return;
    }
    if (i >= chunks.length) {
      clearInterval(timer);
      sseSend(res, { done: true, source: "local" });
      res.end();
      return;
    }
    // Emit a few characters per tick for a typing feel.
    const step = 2 + Math.floor(Math.random() * 3);
    sseSend(res, { delta: chunks.slice(i, i + step).join("") });
    i += step;
  }, 28);
  res.on("close", () => clearInterval(timer));
}

/* --------------------------------------------------- OpenAI streaming ---- */
async function streamOpenAI(res, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.6,
        max_tokens: 500,
        messages: buildMessages(body)
      })
    });
  } catch (e) {
    clearTimeout(timeout);
    console.error("[copilot] upstream fetch failed:", e.message);
    streamFallback(res, body);
    return;
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeout);
    const errText = await upstream.text().catch(() => "");
    console.error(`[copilot] OpenAI HTTP ${upstream.status}: ${errText.slice(0, 300)}`);
    streamFallback(res, body);
    return;
  }

  sseHead(res);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        for (const line of evt.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) sseSend(res, { delta });
          } catch {
            /* ignore malformed keep-alives */
          }
        }
      }
    }
    sseSend(res, { done: true, source: "openai", model: OPENAI_MODEL });
  } catch (e) {
    console.error("[copilot] stream interrupted:", e.message);
    sseSend(res, { done: true, source: "openai", interrupted: true });
  } finally {
    clearTimeout(timeout);
    res.end();
  }
}

/* -------------------------------------------------------------- server --- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "winhub-warroom-demo",
        copilot: OPENAI_KEY ? "openai" : "local-fallback",
        model: OPENAI_KEY ? OPENAI_MODEL : null
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/copilot") {
      const body = await readBody(req);
      if (OPENAI_KEY) {
        await streamOpenAI(res, body);
      } else {
        streamFallback(res, body);
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API route not found" });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || "Server error" });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`WinHub.AI 戰情室 demo → http://localhost:${PORT}`);
  console.log(`Copilot mode: ${OPENAI_KEY ? `OpenAI (${OPENAI_MODEL})` : "local fallback (no OPENAI_API_KEY)"}`);
});
