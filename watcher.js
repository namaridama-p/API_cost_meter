// =============================================================
// watcher.js — Webアプリ(claude.ai / gemini.google.com)の会話監視
//
// 会話画面のDOMを観測し、ユーザーの質問とAIの回答の文章量から
// トークンを推定 →「APIで同じことをしたらいくらか」を換算して記録します。
// ページ右下に現在の会話・今日の合計を表示するミニメーターも出します。
//
// ※ サイトのUI変更でセレクタが効かなくなったら、下のCONFIGの
//    user / asst のセレクタ配列に新しいものを足してください。
// =============================================================
"use strict";

(function () {
  const HOST = location.hostname;

  const CONFIG = {
    "claude.ai": {
      provider: "anthropic",
      user: ['[data-testid="user-message"]'],
      asst: [
        '[data-testid="assistant-message"]',
        ".font-claude-message",
        ".font-claude-response",
        "div[data-is-streaming]"
      ],
      modelRegex: /(Fable|Opus|Sonnet|Haiku)\s*([0-9][0-9.]*)/i,
      buildModel: (m) => (m[1] + "-" + m[2]).toLowerCase()
    },
    "gemini.google.com": {
      provider: "google",
      user: ["user-query"],
      asst: ["model-response"],
      modelRegex: /\b(\d\.\d)\s?(Pro|Flash(?:[ -]?Lite)?)\b/i,
      buildModel: (m) =>
        ("gemini-" + m[1] + "-" + m[2]).toLowerCase().replace(/[\s]+/g, "-")
    }
  };

  const cfg = CONFIG[HOST];
  if (!cfg) return;

  // ---------- ヘルパー ----------
  function textFor(selectors) {
    for (const sel of selectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      if (els.length) {
        return Array.from(els)
          .map((e) => e.innerText || e.textContent || "")
          .join("\n");
      }
    }
    return "";
  }

  let cachedModel = null;
  let cachedAt = 0;
  function detectModelStr() {
    if (cachedModel && Date.now() - cachedAt < 30000) return cachedModel;
    const nodes = document.querySelectorAll(
      'button, [role="button"], [class*="model"], [data-testid*="model"]'
    );
    for (const n of nodes) {
      const t = (n.textContent || "").trim();
      if (!t || t.length > 60) continue;
      const m = t.match(cfg.modelRegex);
      if (m) {
        cachedModel = cfg.buildModel(m);
        cachedAt = Date.now();
        return cachedModel;
      }
    }
    return null;
  }

  function fmtMoney(usd, settings) {
    if ((settings.currency || "JPY") === "JPY") {
      const y = usd * (settings.jpyRate || 150);
      if (y >= 100) return "¥" + Math.round(y).toLocaleString("ja-JP");
      return "¥" + y.toFixed(y >= 10 ? 1 : 2);
    }
    if (usd >= 100) return "$" + Math.round(usd).toLocaleString("en-US");
    return "$" + usd.toFixed(usd >= 1 ? 2 : 4);
  }

  function dateKey(ts) {
    const dt = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }

  // ---------- ミニメーター(右下のピル) ----------
  let pill = null;
  function ensurePill(show) {
    if (!show) {
      if (pill) pill.remove(), (pill = null);
      return;
    }
    if (pill && document.body.contains(pill)) return;
    pill = document.createElement("div");
    pill.id = "cm-cost-pill";
    pill.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483646",
      "background:#17222f", "color:#f4f8f5",
      "font:11px/1.4 ui-monospace,SF Mono,Consolas,monospace",
      "font-variant-numeric:tabular-nums",
      "padding:7px 12px", "border-radius:999px",
      "border:1px solid #33475c",
      "box-shadow:0 2px 10px rgba(10,20,30,.35)",
      "pointer-events:auto", "cursor:pointer", "user-select:none",
      "display:flex", "gap:10px", "align-items:center"
    ].join(";");
    pill.title = "AI API コストメーター(API料金換算・概算)/ クリックで最小化";
    pill.innerHTML =
      '<span style="width:7px;height:7px;border-radius:50%;background:#2fbf9a;flex:none"></span>' +
      '<span id="cm-pill-text">計測中…</span>';
    pill.addEventListener("click", () => {
      const t = pill.querySelector("#cm-pill-text");
      t.style.display = t.style.display === "none" ? "" : "none";
    });
    document.body.appendChild(pill);
  }

  async function updatePill(convUsd) {
    if (!pill) return;
    const d = await chrome.storage.local.get(["settings", "days"]);
    const settings = Object.assign({}, CM_DEFAULTS.settings, d.settings || {});
    const today = (d.days || {})[dateKey(Date.now())] || { usd: 0 };
    const t = pill.querySelector("#cm-pill-text");
    if (t) {
      t.textContent =
        `この会話 ${fmtMoney(convUsd || 0, settings)} ・ 今日 ${fmtMoney(today.usd, settings)}`;
    }
  }

  // ---------- 本体: 差分計上 ----------
  let scanning = false;

  async function doScan() {
    if (scanning || document.hidden) return;
    scanning = true;
    try {
      const userText = textFor(cfg.user);
      const asstText = textFor(cfg.asst);
      if (!userText && !asstText) {
        // 会話がまだ無い(トップページ等)
        const conv0 = await currentConvState();
        await updatePill(conv0 ? conv0.usd : 0);
        return;
      }

      const uTok = cmEstimateTokens(userText);
      const aTok = cmEstimateTokens(asstText);

      const store = await chrome.storage.local.get(["settings", "convs"]);
      const settings = Object.assign({}, CM_DEFAULTS.settings, store.settings || {});
      const pricing = settings.pricing || CM_DEFAULTS.pricing;
      const convs = store.convs || {};
      const key = HOST + location.pathname;
      const st = convs[key] || { u: 0, a: 0, usd: 0, t: Date.now() };

      const uDelta = uTok - st.u;
      const aDelta = aTok - st.a;

      if (uDelta <= 0 && aDelta <= 0) {
        // 過去の会話を開き直しただけ / 編集で減った → 基準値だけ合わせる
        if (uTok < st.u || aTok < st.a) {
          st.u = Math.min(st.u, uTok);
          st.a = Math.min(st.a, aTok);
          st.t = Date.now();
          convs[key] = st;
          await chrome.storage.local.set({ convs: pruneConvs(convs) });
        }
        await updatePill(st.usd);
        return;
      }

      // モデル判定(UIから読めなければ既定値)
      const detected = detectModelStr();
      const defaults = settings.webDefaults || CM_DEFAULTS.settings.webDefaults;
      let entry = detected ? cmMatchModel(pricing, cfg.provider, detected) : null;
      if (!entry) {
        entry =
          pricing.find((p) => p.id === defaults[cfg.provider]) ||
          CM_DEFAULTS.fallback[cfg.provider];
      }

      // 入力: 新しい質問。API課金と同じく「会話全体を毎回送る」前提で
      // 履歴込みにするかは設定で切り替え(既定: 込み)
      let inTok = 0;
      if (uDelta > 0) {
        inTok = settings.includeHistory !== false ? st.u + st.a + uDelta : uDelta;
      }
      const outTok = Math.max(0, aDelta);

      const usd = cmCost(entry, inTok, outTok);
      const t = Date.now();
      const rec = {
        id: t + "-" + Math.random().toString(36).slice(2, 7),
        t,
        provider: cfg.provider,
        model: detected || entry.id,
        modelId: entry.id,
        label: entry.label,
        inTok,
        outTok,
        usd,
        src: "web",
        from: HOST
      };

      st.u = uTok;
      st.a = aTok;
      st.usd = (st.usd || 0) + usd;
      st.t = t;
      convs[key] = st;
      await chrome.storage.local.set({ convs: pruneConvs(convs) });

      chrome.runtime.sendMessage({ type: "cm-record", rec }, () => {
        void chrome.runtime.lastError; // ワーカー起動直後などのエラーは無視
      });
      await updatePill(st.usd);
    } catch (e) {
      // 拡張機能が更新された直後などはコンテキストが無効になることがある
    } finally {
      scanning = false;
    }
  }

  async function currentConvState() {
    const d = await chrome.storage.local.get(["convs"]);
    return (d.convs || {})[HOST + location.pathname] || null;
  }

  function pruneConvs(convs) {
    const keys = Object.keys(convs);
    if (keys.length <= 60) return convs;
    keys
      .sort((a, b) => (convs[a].t || 0) - (convs[b].t || 0))
      .slice(0, keys.length - 60)
      .forEach((k) => delete convs[k]);
    return convs;
  }

  // ---------- 起動 ----------
  let timer = null;
  const observer = new MutationObserver(() => {
    // ストリーミング中は変異が続く → 1.8秒静かになったら計上
    clearTimeout(timer);
    timer = setTimeout(doScan, 1800);
  });

  async function boot() {
    const d = await chrome.storage.local.get(["settings"]);
    const settings = Object.assign({}, CM_DEFAULTS.settings, d.settings || {});
    ensurePill(settings.showOverlay !== false);
    const conv = await currentConvState();
    await updatePill(conv ? conv.usd : 0);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // SPAのページ遷移(会話切り替え)を検知
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        cachedModel = null;
        clearTimeout(timer);
        timer = setTimeout(doScan, 1200);
      }
    }, 800);

    // 設定変更(オーバーレイ表示など)に追従
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.settings) {
        const s = Object.assign({}, CM_DEFAULTS.settings, changes.settings.newValue || {});
        ensurePill(s.showOverlay !== false);
      }
      if (changes.days || changes.convs) {
        currentConvState().then((c) => updatePill(c ? c.usd : 0));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
