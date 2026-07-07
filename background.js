// =============================================================
// background.js — API呼び出しの監視と記録
//
// chrome.webRequest で次のエンドポイントへのPOSTを観測します:
//   - https://api.anthropic.com/v1/messages          (Claude)
//   - https://generativelanguage.googleapis.com/...  (Gemini)
//
// リクエスト本文からモデル名とプロンプトの文字数を取り出し、
// 入力トークンを概算します。応答本文はwebRequestでは読めないため、
// 出力トークンは設定値(既定500)と max_tokens の小さい方で見積もります。
// =============================================================
importScripts("pricing.js");

const MAX_RECORDS = 600; // 明細の保持件数(超えた分は集計に畳み込む)

// ---------- ストレージ(直列化して読み書き) ----------
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error("[cost-meter]", e));
  return queue;
}

async function loadData() {
  const d = await chrome.storage.local.get(["settings", "records", "days", "months", "byModel"]);
  return {
    settings: Object.assign({}, CM_DEFAULTS.settings, d.settings || {}),
    pricing: (d.settings && d.settings.pricing) || CM_DEFAULTS.pricing,
    records: d.records || [],
    days: d.days || {},
    months: d.months || {},
    byModel: d.byModel || {}
  };
}

function dateKey(ts) {
  const dt = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function monthKey(ts) {
  return dateKey(ts).slice(0, 7);
}

function addToAgg(map, key, usd, calls, inTok, outTok) {
  const cur = map[key] || { usd: 0, calls: 0, inTok: 0, outTok: 0 };
  cur.usd += usd;
  cur.calls += calls;
  cur.inTok += inTok;
  cur.outTok += outTok;
  map[key] = cur;
}

async function saveRecord(rec) {
  return enqueue(async () => {
    const d = await loadData();
    rec.id = rec.id || rec.t + "-" + Math.random().toString(36).slice(2, 7);
    d.records.push(rec);

    addToAgg(d.days, dateKey(rec.t), rec.usd, 1, rec.inTok, rec.outTok);
    addToAgg(d.months, monthKey(rec.t), rec.usd, 1, rec.inTok, rec.outTok);

    // モデル別集計は月ごとに持つ: byModel["2026-07"]["claude-sonnet-4-6"]
    const mk = monthKey(rec.t);
    if (!d.byModel[mk]) d.byModel[mk] = {};
    addToAgg(d.byModel[mk], rec.modelId, rec.usd, 1, rec.inTok, rec.outTok);
    d.byModel[mk][rec.modelId].label = rec.label;
    d.byModel[mk][rec.modelId].provider = rec.provider;

    // 明細が増えすぎたら古いものから捨てる(集計には残る)
    if (d.records.length > MAX_RECORDS) {
      d.records = d.records.slice(d.records.length - MAX_RECORDS);
    }
    // 日別集計は120日分、モデル別集計は24か月分だけ保持
    const dayKeys = Object.keys(d.days).sort();
    while (dayKeys.length > 120) delete d.days[dayKeys.shift()];
    const bmKeys = Object.keys(d.byModel).sort();
    while (bmKeys.length > 24) delete d.byModel[bmKeys.shift()];

    await chrome.storage.local.set({
      records: d.records,
      days: d.days,
      months: d.months,
      byModel: d.byModel
    });
    await updateBadge(d);
  });
}

// ---------- バッジ(今日の合計を表示) ----------
async function updateBadge(dataMaybe) {
  const d = dataMaybe || (await loadData());
  const today = d.days[dateKey(Date.now())];
  const usd = today ? today.usd : 0;
  let text = "";
  if (usd > 0) {
    if (d.settings.currency === "JPY") {
      const yen = usd * (d.settings.jpyRate || 150);
      text = yen >= 1000 ? `¥${(yen / 1000).toFixed(1)}k` : `¥${Math.round(yen)}`;
    } else {
      text = usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(usd < 10 ? 1 : 0)}`;
    }
  }
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#147D64" });
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    /* noop */
  }
}

chrome.runtime.onStartup.addListener(() => updateBadge());
chrome.runtime.onInstalled.addListener(() => updateBadge());

// content script(Webアプリ換算)からの記録を受け取る
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "cm-record" && msg.rec) {
    saveRecord(msg.rec).then(() => sendResponse({ ok: true }));
    return true; // 非同期応答
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  // ポップアップからの手入力・削除・設定変更でもバッジを更新
  if (area === "local" && (changes.days || changes.settings)) updateBadge();
});

// ---------- リクエスト本文の解析 ----------
function decodeBody(details) {
  const rb = details.requestBody;
  if (!rb || !rb.raw || !rb.raw.length) return null;
  try {
    const dec = new TextDecoder("utf-8");
    return rb.raw.map((r) => (r.bytes ? dec.decode(r.bytes) : "")).join("");
  } catch (e) {
    return null;
  }
}

function textFromAnthropic(body) {
  const parts = [];
  const push = (c) => {
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) if (b && typeof b.text === "string") parts.push(b.text);
    }
  };
  if (body.system) push(body.system);
  for (const m of body.messages || []) push(m.content);
  return parts.join("\n");
}

function textFromGemini(body) {
  const parts = [];
  const grab = (c) => {
    for (const p of (c && c.parts) || []) if (typeof p.text === "string") parts.push(p.text);
  };
  if (body.systemInstruction) grab(body.systemInstruction);
  if (body.system_instruction) grab(body.system_instruction);
  for (const c of body.contents || []) grab(c);
  return parts.join("\n");
}

function textFromOpenAICompat(body) {
  const parts = [];
  for (const m of body.messages || []) {
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function callerOf(details) {
  const init = details.initiator || details.documentUrl || "";
  try {
    const u = new URL(init);
    if (u.protocol === "chrome-extension:") return `拡張機能 (${u.hostname.slice(0, 8)}…)`;
    return u.hostname;
  } catch (e) {
    return "不明";
  }
}

// ---------- メインの監視ハンドラ ----------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;

    // 非同期で処理(観測のみ、ブロックしない)
    handleRequest(details).catch((e) => console.error("[cost-meter]", e));
  },
  {
    urls: [
      "https://api.anthropic.com/v1/messages*",
      "https://generativelanguage.googleapis.com/*"
    ]
  },
  ["requestBody"]
);

async function handleRequest(details) {
  const url = new URL(details.url);
  const raw = decodeBody(details);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    body = {};
  }

  let provider = null;
  let modelStr = "";
  let promptText = "";
  let maxOut = null;

  if (url.hostname === "api.anthropic.com") {
    // 課金対象の生成リクエストのみ(トークン数カウントやバッチ管理は除外)
    if (url.pathname !== "/v1/messages") return;
    provider = "anthropic";
    modelStr = body.model || "";
    promptText = textFromAnthropic(body);
    if (typeof body.max_tokens === "number") maxOut = body.max_tokens;
  } else if (url.hostname === "generativelanguage.googleapis.com") {
    if (url.pathname.includes("/openai/")) {
      // OpenAI互換エンドポイント
      if (!url.pathname.endsWith("/chat/completions")) return;
      provider = "google";
      modelStr = body.model || "";
      promptText = textFromOpenAICompat(body);
      if (typeof body.max_tokens === "number") maxOut = body.max_tokens;
    } else {
      // ネイティブ: /v1beta/models/{model}:generateContent など
      const m = url.pathname.match(/\/models\/([^:]+):(streamG|g)enerateContent/i);
      if (!m) return;
      provider = "google";
      modelStr = decodeURIComponent(m[1]);
      promptText = textFromGemini(body);
      const gc = body.generationConfig || {};
      if (typeof gc.maxOutputTokens === "number") maxOut = gc.maxOutputTokens;
    }
  }
  if (!provider) return;

  const d = await loadData();
  const entry =
    cmMatchModel(d.pricing, provider, modelStr) || CM_DEFAULTS.fallback[provider];

  // 入力トークン: プロンプト文字列から概算(取れなければ本文全体から)
  const inTok = cmEstimateTokens(promptText || raw || "");
  // 出力トークン: 応答は読めないので設定値とmax_tokensの小さい方
  let outTok = d.settings.outputEstimate || 500;
  if (maxOut && maxOut < outTok) outTok = maxOut;

  const rec = {
    t: Date.now(),
    provider,
    model: modelStr || "(不明)",
    modelId: entry.id,
    label: entry.label,
    inTok,
    outTok,
    usd: cmCost(entry, inTok, outTok),
    src: "auto",
    from: callerOf(details)
  };
  await saveRecord(rec);
}
