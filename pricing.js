// =============================================================
// 既定の料金表(USD / 100万トークン)
// 2026年7月時点の各社公表値をもとにした初期値です。
// 料金は変わることがあるので、ポップアップの「設定」タブから
// いつでも編集できます(編集値が優先されます)。
// =============================================================
globalThis.CM_DEFAULTS = {
  pricing: [
    // ---- Anthropic (Claude) ----
    { id: "claude-fable-5",      provider: "anthropic", label: "Claude Fable 5",      in: 10,   out: 50,  match: ["fable-5", "fable5"] },
    { id: "claude-opus-4-8",     provider: "anthropic", label: "Claude Opus 4.8",     in: 5,    out: 25,  match: ["opus-4-8", "opus-4.8"] },
    { id: "claude-opus-4-7",     provider: "anthropic", label: "Claude Opus 4.7",     in: 5,    out: 25,  match: ["opus-4-7", "opus-4.7"] },
    { id: "claude-opus-4-6",     provider: "anthropic", label: "Claude Opus 4.6",     in: 5,    out: 25,  match: ["opus-4-6", "opus-4.6"] },
    { id: "claude-opus-4-5",     provider: "anthropic", label: "Claude Opus 4.5",     in: 5,    out: 25,  match: ["opus-4-5", "opus-4.5"] },
    { id: "claude-opus-4-1",     provider: "anthropic", label: "Claude Opus 4.1",     in: 15,   out: 75,  match: ["opus-4-1", "opus-4.1"] },
    { id: "claude-sonnet-5",     provider: "anthropic", label: "Claude Sonnet 5",     in: 2,    out: 10,  match: ["sonnet-5", "sonnet5"] },
    { id: "claude-sonnet-4-6",   provider: "anthropic", label: "Claude Sonnet 4.6",   in: 3,    out: 15,  match: ["sonnet-4-6", "sonnet-4.6"] },
    { id: "claude-sonnet-4-5",   provider: "anthropic", label: "Claude Sonnet 4.5",   in: 3,    out: 15,  match: ["sonnet-4-5", "sonnet-4.5"] },
    { id: "claude-haiku-4-5",    provider: "anthropic", label: "Claude Haiku 4.5",    in: 1,    out: 5,   match: ["haiku-4-5", "haiku-4.5"] },
    { id: "claude-haiku-3-5",    provider: "anthropic", label: "Claude Haiku 3.5",    in: 0.8,  out: 4,   match: ["haiku-3-5", "haiku-3.5"] },

    // ---- Google (Gemini) ----  ※「-lite」を含むIDは必ずliteでない同名モデルより上に置く
    { id: "gemini-3-1-pro",        provider: "google", label: "Gemini 3.1 Pro",        in: 2,    out: 12,  match: ["gemini-3.1-pro"] },
    { id: "gemini-3-5-flash",      provider: "google", label: "Gemini 3.5 Flash",      in: 1.5,  out: 9,   match: ["gemini-3.5-flash"] },
    { id: "gemini-3-1-flash-lite", provider: "google", label: "Gemini 3.1 Flash-Lite", in: 0.25, out: 1.5, match: ["gemini-3.1-flash-lite"] },
    { id: "gemini-2-5-pro",        provider: "google", label: "Gemini 2.5 Pro",        in: 1.25, out: 10,  match: ["gemini-2.5-pro"] },
    { id: "gemini-2-5-flash-lite", provider: "google", label: "Gemini 2.5 Flash-Lite", in: 0.1,  out: 0.4, match: ["gemini-2.5-flash-lite"] },
    { id: "gemini-2-5-flash",      provider: "google", label: "Gemini 2.5 Flash",      in: 0.3,  out: 2.5, match: ["gemini-2.5-flash"] }
  ],

  // 料金表にないモデル名だったときの受け皿
  fallback: {
    anthropic: { id: "anthropic-other", provider: "anthropic", label: "Claude(その他)", in: 5, out: 25 },
    google:    { id: "google-other",    provider: "google",    label: "Gemini(その他)", in: 2, out: 12 }
  },

  settings: {
    currency: "JPY",      // 表示通貨: "JPY" or "USD"
    jpyRate: 150,         // 1USDあたりの円レート(設定で変更可)
    outputEstimate: 500,  // API直呼びの自動記録時の出力トークン推定値
    webHud: true,                        // claude.ai / Gemini のページ右下にメーターを表示
    claudeWebModel: "claude-sonnet-5",   // claude.aiでモデルを検出できなかったときの既定
    geminiWebModel: "gemini-3-5-flash"   // gemini.google.comでの既定
  }
};

// テキストからトークン数をざっくり見積もる。
// 日本語・中国語・韓国語などの文字はおよそ1文字≒1トークン、
// 英数字などはおよそ4文字≒1トークンとして計算する簡易ヒューリスティック。
globalThis.cmEstimateTokens = function (text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x3000 && c <= 0x30ff) || // 記号・ひらがな・カタカナ
      (c >= 0x3400 && c <= 0x9fff) || // CJK漢字
      (c >= 0xf900 && c <= 0xfaff) || // CJK互換漢字
      (c >= 0xff00 && c <= 0xffef) || // 全角英数・半角カナ
      (c >= 0xac00 && c <= 0xd7af) || // ハングル
      (c >= 0x20000 && c <= 0x2fa1f)  // CJK拡張
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.max(1, Math.round(cjk + other / 4));
};

// モデル名文字列から料金表エントリを探す
globalThis.cmMatchModel = function (pricing, provider, modelStr) {
  const s = String(modelStr || "").toLowerCase();
  for (const p of pricing) {
    if (p.provider !== provider) continue;
    if ((p.match || []).some((m) => s.includes(m))) return p;
  }
  return null;
};

// コスト計算(USD)
globalThis.cmCost = function (entry, inTok, outTok) {
  return (inTok / 1e6) * entry.in + (outTok / 1e6) * entry.out;
};
