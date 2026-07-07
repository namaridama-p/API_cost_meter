// =============================================================
// content.js — claude.ai / gemini.google.com 上で動くスクリプト
//
// Webアプリでの会話を「もしAPIで払っていたら」に換算します。
//  仕組み:
//   1) 送信(Enter / 送信ボタン)を検知して計測開始
//   2) 検知できなくても、会話テキストの増加を常時見張っていて
//      大きく増えたら自動で計測を開始(受け皿)
//   3) 増加が止まったら1往復として記録
//  DevToolsのConsoleに [AIコストメーター] のログを出します。
// =============================================================
(function () {
  "use strict";
  var TAG = "[AIコストメーター]";
  var SITE = location.hostname.indexOf("claude") >= 0 ? "claude" : "gemini";

  var settings = null;
  var pricing = null;
  var sessionUsd = 0;   // この会話での累計換算額
  var todayUsd = 0;
  var pending = null;   // 計測中の1往復
  var baseline = null;  // 会話テキスト長の基準値(受動検知用)
  var hud = null;
  var lastPath = location.pathname;
  var broken = false;   // 拡張機能が更新されて接続が切れた状態

  // ---------- 設定・集計 ----------
  function dateKey(ts) {
    var dt = new Date(ts);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
  }

  function loadSettings() {
    return chrome.storage.local.get(["settings", "days"]).then(function (d) {
      settings = Object.assign({}, CM_DEFAULTS.settings, d.settings || {});
      pricing = settings.pricing || CM_DEFAULTS.pricing;
      var today = (d.days || {})[dateKey(Date.now())];
      todayUsd = today ? today.usd : 0;
    });
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      try {
        if (changes.settings) {
          settings = Object.assign({}, CM_DEFAULTS.settings, changes.settings.newValue || {});
          pricing = settings.pricing || CM_DEFAULTS.pricing;
        }
        if (changes.days) {
          var today = (changes.days.newValue || {})[dateKey(Date.now())];
          todayUsd = today ? today.usd : 0;
        }
        updateHud();
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* noop */ }

  // ---------- テキスト計測 ----------
  function container() {
    return document.querySelector("main") ||
           document.querySelector('[role="main"]') ||
           document.body;
  }
  function convText() {
    var c = container();
    try {
      // textContentはレイアウト計算が不要で軽い(mainが見つからない時だけinnerText)
      return (c === document.body ? c.innerText : c.textContent) || "";
    } catch (e) { return ""; }
  }
  function editorText() {
    var sels = ['div[contenteditable="true"]', "textarea", '[role="textbox"]'];
    for (var i = 0; i < sels.length; i++) {
      var list = document.querySelectorAll(sels[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        var t = (el.value !== undefined && el.value !== null ? el.value : el.textContent) || "";
        if (t.trim()) return t;
      }
    }
    return "";
  }
  // 入力欄の文字数を除いた会話テキスト長(入力中のブレを消す)
  function effLen() {
    return Math.max(0, convText().length - editorText().length);
  }
  function densityOf(text) {
    if (!text || !text.length) return 0.3;
    var sample = text.length > 20000
      ? text.slice(0, 10000) + text.slice(-10000)
      : text;
    return cmEstimateTokens(sample) / sample.length;
  }

  // ---------- 使用中モデルの推定 ----------
  function detectEntry() {
    var hint = "";
    var els = document.querySelectorAll('button, [role="button"], [aria-haspopup]');
    var re = SITE === "claude" ? /(fable|opus|sonnet|haiku)/i : /(pro|flash|thinking|fast)/i;
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || "").trim();
      if (t && t.length <= 40 && re.test(t)) { hint = t.toLowerCase(); break; }
    }
    var id = SITE === "claude"
      ? (settings.claudeWebModel || "claude-sonnet-5")
      : (settings.geminiWebModel || "gemini-3-5-flash");
    if (SITE === "claude") {
      if (hint.indexOf("fable") >= 0) id = "claude-fable-5";
      else if (hint.indexOf("opus") >= 0) id = "claude-opus-4-8";
      else if (hint.indexOf("haiku") >= 0) id = "claude-haiku-4-5";
      else if (hint.indexOf("sonnet") >= 0) id = "claude-sonnet-5";
    } else {
      if (/pro/.test(hint)) id = /2\.5/.test(hint) ? "gemini-2-5-pro" : "gemini-3-1-pro";
      else if (/flash/.test(hint)) id = /2\.5/.test(hint) ? "gemini-2-5-flash" : "gemini-3-5-flash";
    }
    for (var k = 0; k < pricing.length; k++) if (pricing[k].id === id) return pricing[k];
    return pricing[0];
  }

  // ---------- 1往復の計測 ----------
  function startPending(opt) {
    if (pending) finalize(pending);
    pending = {
      entry: opt.entry,
      density: opt.density,
      passive: !!opt.passive,
      beforeLen: opt.beforeLen,
      promptTok: opt.promptTok || 0,
      inTok: opt.inTok,
      lastLen: opt.lastLen != null ? opt.lastLen : opt.beforeLen,
      stable: 0,
      started: Date.now(),
      timer: null
    };
    pending.timer = setInterval(function () { poll(pending); }, 2000);
    setStatus("measuring");
  }

  function onSend(promptText) {
    if (!promptText || !promptText.trim()) return;
    var conv = convText();
    var entry = detectEntry();
    var density = densityOf(conv + promptText) || 0.3;
    var histLen = Math.max(0, conv.length - editorText().length);
    var promptTok = cmEstimateTokens(promptText);
    startPending({
      entry: entry,
      density: density,
      beforeLen: histLen,
      promptTok: promptTok,
      // 実APIでは履歴+今回の発話をすべて入力として送る
      inTok: Math.max(1, Math.round(histLen * density) + promptTok)
    });
    console.info(TAG, "送信を検知:", entry.label, "入力 ≈", pending.inTok, "tok");
  }

  function poll(p) {
    if (p !== pending) { clearInterval(p.timer); return; }
    var len = effLen();
    if (len !== p.lastLen) { p.lastLen = len; p.stable = 0; }
    else { p.stable++; }
    var grown = p.lastLen > p.beforeLen;
    // 約6秒間テキストが増えなくなったら応答完了とみなす
    if ((grown && p.stable >= 3) || Date.now() - p.started > 240000) {
      finalize(p);
    }
  }

  function finalize(p) {
    clearInterval(p.timer);
    if (p === pending) pending = null;
    var growth = Math.max(0, p.lastLen - p.beforeLen);
    baseline = Math.max(p.lastLen, effLen());
    if (growth <= 0) {
      setStatus(null);
      console.info(TAG, "応答を検出できなかったため記録をスキップしました");
      return;
    }
    var outTok = Math.max(1, Math.round(growth * p.density) - p.promptTok);
    var usd = cmCost(p.entry, p.inTok, outTok);
    sessionUsd += usd;
    console.info(TAG, "記録:", p.entry.label, "入力", p.inTok, "tok / 出力 ≈", outTok, "tok →", money(usd));
    try {
      chrome.runtime.sendMessage({
        type: "cm-record",
        rec: {
          t: Date.now(),
          provider: p.entry.provider,
          model: p.entry.id,
          modelId: p.entry.id,
          label: p.entry.label,
          inTok: p.inTok,
          outTok: outTok,
          usd: usd,
          src: "web",
          from: location.hostname
        }
      });
    } catch (e) {
      markBroken();
      return;
    }
    setStatus("+" + money(usd));
    updateHud();
  }

  // ---------- 送信の検知 ----------
  document.addEventListener("keydown", function (e) {
    if (broken) return;
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    var t = e.target;
    if (!t) return;
    var editable = t.tagName === "TEXTAREA" || t.isContentEditable ||
      (t.getAttribute && t.getAttribute("role") === "textbox");
    if (!editable) return;
    var text = editorText();
    if (text.trim()) onSend(text);
  }, true);

  function clickHandler(e) {
    if (broken || pending) return;
    var n = e.target;
    var btn = null;
    while (n && n !== document) {
      if (n.tagName === "BUTTON" || (n.getAttribute && n.getAttribute("role") === "button")) { btn = n; break; }
      n = n.parentNode;
    }
    if (!btn) return;
    var label = ((btn.getAttribute("aria-label") || "") + " " + (btn.textContent || "")).toLowerCase();
    if (!/send|送信|submit|メッセージ/.test(label)) return;
    var text = editorText();
    if (text.trim()) onSend(text);
  }
  document.addEventListener("pointerdown", clickHandler, true);
  document.addEventListener("click", clickHandler, true);

  // ---------- 受動検知(送信検知が漏れたときの受け皿) ----------
  setInterval(function () {
    if (broken || !settings) return;
    var cur = effLen();
    if (baseline === null) { baseline = cur; return; }
    if (pending) return; // 計測中はpoll側に任せる
    if (cur < baseline - 50) { baseline = cur; return; } // 会話切替・削除など
    if (cur > baseline + 150) {
      var conv = convText();
      var entry = detectEntry();
      var density = densityOf(conv) || 0.3;
      console.info(TAG, "テキストの増加を検知(受動計測を開始)");
      startPending({
        entry: entry,
        density: density,
        passive: true,
        beforeLen: baseline,
        promptTok: 0,
        inTok: Math.max(1, Math.round(baseline * density)),
        lastLen: cur
      });
    }
  }, 3000);

  // 会話を切り替えたら「この会話」の額をリセット
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sessionUsd = 0;
      if (pending) finalize(pending);
      baseline = null;
      updateHud();
    }
  }, 1500);

  // ---------- HUD(右下の換算メーター) ----------
  function money(usd) {
    if (!settings) return "";
    if (settings.currency === "JPY") {
      var y = usd * (settings.jpyRate || 150);
      if (y >= 100) return "¥" + Math.round(y).toLocaleString("ja-JP");
      return "¥" + y.toFixed(y >= 10 ? 1 : 2);
    }
    return usd >= 1 ? "$" + usd.toFixed(2) : "$" + usd.toFixed(4);
  }

  var HUD_CSS = "" +
    ".hud{position:fixed;right:14px;bottom:14px;z-index:2147483647;" +
    "background:#17222f;color:#f4f8f5;border:1px solid #33475c;border-radius:999px;" +
    "padding:7px 12px 7px 14px;display:flex;align-items:center;gap:10px;" +
    "font:12px/1 ui-monospace,'SF Mono',Consolas,monospace;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.28);user-select:none;}" +
    ".hud b{font-weight:600;font-variant-numeric:tabular-nums;}" +
    ".lb{color:#93a3b4;font-size:10px;margin-right:3px;}" +
    ".sess b{color:#2fbf9a;}" +
    ".st{color:#93a3b4;font-size:10px;}" +
    ".st.on{color:#2fbf9a;animation:cmp 1.2s ease-in-out infinite;}" +
    "@keyframes cmp{0%,100%{opacity:.4}50%{opacity:1}}" +
    ".min{background:none;border:none;color:#93a3b4;font:12px ui-monospace,monospace;" +
    "cursor:pointer;padding:0 0 0 2px;}" +
    ".min:hover{color:#fff;}" +
    ".hud.small .full{display:none;}";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildHud() {
    if (hud || !settings || settings.webHud === false) return;
    try {
      var host = el("div");
      host.id = "cm-hud-host";
      var root = host.attachShadow({ mode: "open" });
      var style = el("style");
      style.textContent = HUD_CSS;

      var wrap = el("div", "hud");
      wrap.title = "APIで払っていた場合の概算(この拡張機能の推定値)";

      var sess = el("span", "full sess");
      sess.appendChild(el("span", "lb", "この会話"));
      var sVal = el("b", null, "¥0"); sVal.id = "s";
      sess.appendChild(sVal);

      var day = el("span", "full");
      day.appendChild(el("span", "lb", "今日"));
      var dVal = el("b", null, "¥0"); dVal.id = "d";
      day.appendChild(dVal);

      var mini = el("span", null); mini.hidden = true;
      var mVal = el("b", null, "¥0"); mVal.id = "m";
      mini.appendChild(mVal);

      var st = el("span", "st", ""); st.id = "st";

      var min = el("button", "min", "–");
      min.title = "折りたたみ/展開";
      min.addEventListener("click", function () {
        wrap.classList.toggle("small");
        mini.hidden = !wrap.classList.contains("small");
        min.textContent = wrap.classList.contains("small") ? "+" : "–";
      });

      wrap.appendChild(sess);
      wrap.appendChild(day);
      wrap.appendChild(mini);
      wrap.appendChild(st);
      wrap.appendChild(min);
      root.appendChild(style);
      root.appendChild(wrap);
      (document.body || document.documentElement).appendChild(host);
      hud = { host: host, root: root };
      updateHud();
      console.info(TAG, "メーターを表示しました(" + SITE + ")");
    } catch (e) {
      console.warn(TAG, "メーターを表示できませんでした:", e);
    }
  }

  var statusTimer = null;
  function setStatus(state) {
    if (!hud) return;
    var st = hud.root.getElementById("st");
    if (!st) return;
    clearTimeout(statusTimer);
    if (state === "measuring") {
      st.textContent = "計測中";
      st.className = "st on";
    } else if (state) {
      st.textContent = state; // 例: "+¥12"
      st.className = "st";
      statusTimer = setTimeout(function () { st.textContent = ""; }, 4000);
    } else {
      st.textContent = "";
      st.className = "st";
    }
  }

  function markBroken() {
    broken = true;
    if (!hud) return;
    var st = hud.root.getElementById("st");
    if (st) { st.textContent = "拡張が更新されました。ページを再読み込みしてください"; st.className = "st"; }
    console.warn(TAG, "拡張機能との接続が切れました。ページを再読み込みしてください。");
  }

  function updateHud() {
    if (settings && settings.webHud === false) {
      if (hud) { hud.host.remove(); hud = null; }
      return;
    }
    if (!hud) { buildHud(); return; }
    var r = hud.root;
    var s = r.getElementById("s");
    if (!s) return;
    s.textContent = money(sessionUsd);
    r.getElementById("d").textContent = money(todayUsd);
    r.getElementById("m").textContent = money(todayUsd);
  }

  // ---------- 起動 ----------
  function ensureHud() {
    if (hud && !document.documentElement.contains(hud.host)) {
      hud = null;
      buildHud();
    } else if (!hud) {
      buildHud();
    }
  }

  loadSettings().then(function () {
    console.info(TAG, "起動しました(" + location.hostname + ")");
    buildHud();
    baseline = effLen();
    // SPAがbodyを差し替えてもメーターを復活させる
    setInterval(ensureHud, 4000);
  }).catch(function (e) {
    console.warn(TAG, "設定の読み込みに失敗:", e);
  });
})();
