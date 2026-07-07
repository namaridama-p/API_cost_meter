// =============================================================
// popup.js — ダッシュボード・履歴・電卓・設定
// =============================================================
"use strict";

const $ = (sel) => document.querySelector(sel);
let D = null; // {settings, pricing, records, days, months, byModel}

const COLORS = { anthropic: "#4353a8", google: "#147d64", other: "#8d99ab" };

// ---------- データ ----------
async function load() {
  const d = await chrome.storage.local.get(["settings", "records", "days", "months", "byModel"]);
  const settings = Object.assign({}, CM_DEFAULTS.settings, d.settings || {});
  D = {
    settings,
    pricing: settings.pricing || CM_DEFAULTS.pricing,
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
const monthKey = (ts) => dateKey(ts).slice(0, 7);

function agg(map, key, usd, calls, inTok, outTok) {
  const cur = map[key] || { usd: 0, calls: 0, inTok: 0, outTok: 0 };
  cur.usd += usd; cur.calls += calls; cur.inTok += inTok; cur.outTok += outTok;
  if (cur.calls <= 0 && cur.usd <= 1e-12) { delete map[key]; return; }
  map[key] = cur;
}

// ---------- 表示ヘルパー ----------
function money(usd) {
  const s = D.settings;
  if (s.currency === "JPY") {
    const y = usd * (s.jpyRate || 150);
    if (y >= 100) return "¥" + Math.round(y).toLocaleString("ja-JP");
    return "¥" + y.toFixed(y >= 10 ? 1 : 2);
  }
  if (usd >= 100) return "$" + Math.round(usd).toLocaleString("en-US");
  return "$" + usd.toFixed(usd >= 1 ? 2 : 4);
}
function moneyBoth(usd) {
  const s = D.settings;
  const other = s.currency === "JPY"
    ? "$" + usd.toFixed(usd >= 1 ? 2 : 4)
    : "¥" + (usd * (s.jpyRate || 150)).toFixed(1);
  return `${money(usd)}(${other})`;
}
const num = (n) => Number(n || 0).toLocaleString("ja-JP");

function providerColor(p) { return COLORS[p] || COLORS.other; }

function findEntry(id) {
  return D.pricing.find((p) => p.id === id) ||
    Object.values(CM_DEFAULTS.fallback).find((f) => f.id === id) || null;
}

// ---------- ヘッダー ----------
function renderHeader() {
  const today = D.days[dateKey(Date.now())] || { usd: 0, calls: 0 };
  const month = D.months[monthKey(Date.now())] || { usd: 0 };
  const total = Object.values(D.months).reduce((a, m) => a + m.usd, 0);
  $("#todayVal").textContent = money(today.usd);
  $("#monthVal").textContent = money(month.usd);
  $("#totalVal").textContent = money(total);
  $("#todayCalls").textContent = today.calls ? `${num(today.calls)} 回` : "";
  $("#curToggle").textContent = D.settings.currency;
}

// ---------- 概要タブ ----------
function renderDash() {
  const bm = D.byModel[monthKey(Date.now())] || {};
  const items = Object.entries(bm)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.usd - a.usd);
  const sum = items.reduce((a, v) => a + v.usd, 0);

  const bar = $("#dashBar");
  const list = $("#dashList");
  $("#dashEmpty").hidden = items.length > 0;
  bar.hidden = items.length === 0;
  bar.innerHTML = "";
  list.innerHTML = "";

  for (const it of items) {
    if (sum > 0) {
      const seg = document.createElement("span");
      seg.style.width = Math.max(1.5, (it.usd / sum) * 100) + "%";
      seg.style.background = providerColor(it.provider);
      seg.title = `${it.label} ${money(it.usd)}`;
      bar.appendChild(seg);
    }
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="dot"></span>
      <div class="name"><div class="l1"></div><div class="l2"></div></div>
      <div class="amt"><div></div><div class="l2"></div></div>`;
    row.querySelector(".dot").style.background = providerColor(it.provider);
    row.querySelector(".l1").textContent = it.label || it.id;
    row.querySelector(".name .l2").textContent =
      `${num(it.calls)} 回 ・ 入 ${num(it.inTok)} / 出 ${num(it.outTok)} tok`;
    row.querySelector(".amt div").textContent = money(it.usd);
    list.appendChild(row);
  }

  // 最近7日
  const week = $("#weekChart");
  week.innerHTML = "";
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = Date.now() - i * 86400000;
    const k = dateKey(t);
    days.push({ k, lb: k.slice(8), usd: (D.days[k] || { usd: 0 }).usd });
  }
  const max = Math.max(...days.map((d) => d.usd), 1e-9);
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "col";
    const v = document.createElement("div");
    v.className = "v";
    v.textContent = d.usd > 0 ? money(d.usd).replace(/[¥$]/, "") : "";
    const bar2 = document.createElement("div");
    bar2.className = "bar";
    bar2.style.height = Math.max(2, (d.usd / max) * 46) + "px";
    if (d.usd === 0) bar2.style.background = "#d3dae2";
    const lb = document.createElement("div");
    lb.className = "lb";
    lb.textContent = d.lb;
    col.append(v, bar2, lb);
    week.appendChild(col);
  }
}

// ---------- 履歴タブ ----------
function renderHist() {
  const list = $("#histList");
  list.innerHTML = "";
  const recs = [...D.records].reverse().slice(0, 60);
  $("#histEmpty").hidden = recs.length > 0;

  for (const r of recs) {
    const row = document.createElement("div");
    row.className = "row";
    const dt = new Date(r.t);
    const p = (n) => String(n).padStart(2, "0");
    const when = `${p(dt.getMonth() + 1)}/${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
    row.innerHTML = `
      <span class="dot"></span>
      <div class="name"><div class="l1"></div><div class="l2"></div></div>
      <div class="amt"><div></div><div class="l2"></div></div>
      <button class="del" title="この記録を削除">×</button>`;
    row.querySelector(".dot").style.background = providerColor(r.provider);
    row.querySelector(".l1").textContent = r.label || r.model;
    row.querySelector(".name .l2").textContent =
      `${when} ・ ${r.src === "manual" ? "手入力" : r.from || "自動"} ・ 入 ${num(r.inTok)} / 出 ${num(r.outTok)}`;
    row.querySelector(".amt div").textContent = money(r.usd);
    row.querySelector(".del").addEventListener("click", () => deleteRecord(r.id));
    list.appendChild(row);
  }
}

async function deleteRecord(id) {
  const i = D.records.findIndex((r) => r.id === id);
  if (i < 0) return;
  const r = D.records[i];
  D.records.splice(i, 1);
  agg(D.days, dateKey(r.t), -r.usd, -1, -r.inTok, -r.outTok);
  agg(D.months, monthKey(r.t), -r.usd, -1, -r.inTok, -r.outTok);
  const bm = D.byModel[monthKey(r.t)];
  if (bm) {
    agg(bm, r.modelId, -r.usd, -1, -r.inTok, -r.outTok);
    if (Object.keys(bm).length === 0) delete D.byModel[monthKey(r.t)];
  }
  await chrome.storage.local.set({
    records: D.records, days: D.days, months: D.months, byModel: D.byModel
  });
  renderAll();
}

async function manualAdd() {
  const entry = findEntry($("#mModel").value);
  if (!entry) return;
  const inTok = Math.max(0, Number($("#mIn").value) || 0);
  const outTok = Math.max(0, Number($("#mOut").value) || 0);
  const t = Date.now();
  const rec = {
    id: t + "-" + Math.random().toString(36).slice(2, 7),
    t,
    provider: entry.provider,
    model: entry.id,
    modelId: entry.id,
    label: entry.label,
    inTok, outTok,
    usd: cmCost(entry, inTok, outTok),
    src: "manual",
    from: "手入力"
  };
  D.records.push(rec);
  agg(D.days, dateKey(t), rec.usd, 1, inTok, outTok);
  agg(D.months, monthKey(t), rec.usd, 1, inTok, outTok);
  if (!D.byModel[monthKey(t)]) D.byModel[monthKey(t)] = {};
  agg(D.byModel[monthKey(t)], rec.modelId, rec.usd, 1, inTok, outTok);
  D.byModel[monthKey(t)][rec.modelId].label = entry.label;
  D.byModel[monthKey(t)][rec.modelId].provider = entry.provider;
  await chrome.storage.local.set({
    records: D.records, days: D.days, months: D.months, byModel: D.byModel
  });
  renderAll();
}

// ---------- 電卓タブ ----------
function fillModelSelects() {
  for (const sel of [$("#mModel"), $("#cModel")]) {
    const cur = sel.value;
    sel.innerHTML = "";
    let lastProvider = null;
    let group = null;
    for (const p of D.pricing) {
      if (p.provider !== lastProvider) {
        group = document.createElement("optgroup");
        group.label = p.provider === "anthropic" ? "Claude (Anthropic)" : "Gemini (Google)";
        sel.appendChild(group);
        lastProvider = p.provider;
      }
      const op = document.createElement("option");
      op.value = p.id;
      op.textContent = `${p.label}  ($${p.in} / $${p.out})`;
      group.appendChild(op);
    }
    if (cur) sel.value = cur;
  }
}

function renderCalc() {
  const entry = findEntry($("#cModel").value) || D.pricing[0];
  const inTok = Math.max(0, Number($("#cIn").value) || 0);
  const outTok = Math.max(0, Number($("#cOut").value) || 0);
  const n = Math.max(1, Number($("#cN").value) || 1);
  const one = cmCost(entry, inTok, outTok);
  const total = one * n;
  $("#cResult").textContent = money(total);
  $("#cResultSub").textContent =
    `1回あたり ${moneyBoth(one)} ・ ${num(n)} 回分`;
}

// ---------- 設定タブ ----------
function fillWebModelSelect(sel, provider, current) {
  sel.innerHTML = "";
  for (const p of D.pricing.filter((x) => x.provider === provider)) {
    const op = document.createElement("option");
    op.value = p.id;
    op.textContent = `${p.label} ($${p.in} / $${p.out})`;
    sel.appendChild(op);
  }
  if (current) sel.value = current;
}

function renderConf() {
  $("#sCur").value = D.settings.currency;
  $("#sRate").value = D.settings.jpyRate;
  $("#sOutEst").value = D.settings.outputEstimate;
  $("#sHud").checked = D.settings.webHud !== false;
  fillWebModelSelect($("#sClaudeWeb"), "anthropic", D.settings.claudeWebModel || "claude-sonnet-5");
  fillWebModelSelect($("#sGeminiWeb"), "google", D.settings.geminiWebModel || "gemini-3-5-flash");

  const tbl = $("#priceTable");
  tbl.innerHTML = `
    <div class="price-head"><span>モデル</span><span>入力 $/M</span><span>出力 $/M</span></div>`;
  D.pricing.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "price-row";
    row.innerHTML = `
      <div class="pl"><span class="dot"></span><span></span></div>
      <input type="number" min="0" step="0.01" data-i="${i}" data-k="in">
      <input type="number" min="0" step="0.01" data-i="${i}" data-k="out">`;
    row.querySelector(".dot").style.background = providerColor(p.provider);
    row.querySelector(".pl span:last-child").textContent = p.label;
    row.querySelector('[data-k="in"]').value = p.in;
    row.querySelector('[data-k="out"]').value = p.out;
    tbl.appendChild(row);
  });
}

async function saveConf() {
  const pricing = D.pricing.map((p) => ({ ...p }));
  document.querySelectorAll(".price-row input").forEach((inp) => {
    const i = Number(inp.dataset.i);
    const v = Number(inp.value);
    if (Number.isFinite(v) && v >= 0) pricing[i][inp.dataset.k] = v;
  });
  const settings = {
    currency: $("#sCur").value,
    jpyRate: Math.max(1, Number($("#sRate").value) || 150),
    outputEstimate: Math.max(1, Math.round(Number($("#sOutEst").value) || 500)),
    webHud: $("#sHud").checked,
    claudeWebModel: $("#sClaudeWeb").value,
    geminiWebModel: $("#sGeminiWeb").value,
    pricing
  };
  await chrome.storage.local.set({ settings });
  await load();
  renderAll();
  fillModelSelects();
  const btn = $("#sSave");
  btn.textContent = "保存しました ✓";
  setTimeout(() => (btn.textContent = "設定を保存"), 1200);
}

// ---------- 全体 ----------
function renderAll() {
  renderHeader();
  renderDash();
  renderHist();
  renderCalc();
  renderConf();
}

function bindEvents() {
  // タブ切り替え
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("on"));
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      $("#tab-" + b.dataset.tab).classList.add("on");
    });
  });

  // 通貨トグル
  $("#curToggle").addEventListener("click", async () => {
    D.settings.currency = D.settings.currency === "JPY" ? "USD" : "JPY";
    await chrome.storage.local.set({
      settings: { ...D.settings, pricing: D.pricing }
    });
    renderAll();
  });

  $("#mAdd").addEventListener("click", manualAdd);
  ["#cModel", "#cIn", "#cOut", "#cN"].forEach((s) =>
    $(s).addEventListener("input", renderCalc)
  );
  $("#sSave").addEventListener("click", saveConf);

  $("#sReset").addEventListener("click", async () => {
    D.pricing = CM_DEFAULTS.pricing.map((p) => ({ ...p }));
    await chrome.storage.local.set({
      settings: { ...D.settings, pricing: D.pricing }
    });
    await load();
    renderAll();
    fillModelSelects();
  });

  $("#sClear").addEventListener("click", async () => {
    if (!confirm("すべての記録(履歴・集計)を削除します。よろしいですか?")) return;
    await chrome.storage.local.remove(["records", "days", "months", "byModel"]);
    try { await chrome.action.setBadgeText({ text: "" }); } catch (e) { /* noop */ }
    await load();
    renderAll();
  });

  // バックグラウンドが新しい記録を書いたら即反映
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.records || changes.days || changes.months || changes.byModel) {
      await load();
      renderHeader();
      renderDash();
      renderHist();
    }
  });
}

(async function init() {
  await load();
  bindEvents();
  fillModelSelects();
  renderAll();
})();
