"use strict";

/*
 * 页面浮层：显示解码进度与结果。
 * 由 background.js 通过 tabs.executeScript 按需注入，再用 sendMessage 推送数据。
 * 采用 Shadow DOM 隔离页面样式；关键定位样式用 CSSOM (.style) 设置，
 * 即使在严格 CSP 页面下浮层依然可用。
 */

(() => {
  // 防止重复注入时重复绑定监听器（executeScript 每次点击都会再跑一遍本文件）。
  if (window.__cliimQrOverlayInjected) return;
  window.__cliimQrOverlayInjected = true;

  const STATE = { host: null, card: null };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "CLIIM_QR_RESULT") return;
    try {
      if (msg.state === "busy") renderBusy();
      else renderDone(msg);
    } catch (e) {
      console.error("[QR Decode overlay]", e);
    }
  });

  /* ---------- DOM 构建 ---------- */

  function ensureDom() {
    if (STATE.host && document.documentElement.contains(STATE.host)) return;

    const host = document.createElement("div");
    // CSSOM 设置定位（不受页面 CSP 影响），保证浮层始终可见。
    setStyles(host, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      width: "320px",
      maxWidth: "calc(100vw - 32px)"
    });

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);

    const card = document.createElement("div");
    card.className = "card";
    // 关键外观兜底（若 <style> 被 CSP 拦截，仍是一张可读白卡片）。
    setStyles(card, {
      background: "#ffffff",
      color: "#111827",
      border: "1px solid #e5e7eb",
      borderRadius: "12px",
      boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      overflow: "hidden",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    });
    shadow.appendChild(card);

    (document.body || document.documentElement).appendChild(host);
    STATE.host = host;
    STATE.card = card;
  }

  function renderBusy() {
    ensureDom();
    const card = STATE.card;
    card.textContent = "";
    card.appendChild(makeHeader("二维码解码"));
    const body = el("div", "body");
    const spinner = el("span", "spinner");
    const label = el("span", null, "解码中…");
    body.appendChild(spinner);
    body.appendChild(label);
    card.appendChild(body);
  }

  function renderDone(msg) {
    ensureDom();
    const card = STATE.card;
    card.textContent = "";
    card.appendChild(makeHeader(msg.ok ? "二维码解码结果" : "解码失败"));

    const body = el("div", "body");
    body.style.display = "block";

    if (msg.ok) {
      const text = msg.text == null ? "" : String(msg.text);
      const box = el("div", "result", text.length ? text : "(空内容)");
      body.appendChild(box);

      const actions = el("div", "actions");
      const copyBtn = makeButton("复制", () => copyText(text, copyBtn));
      actions.appendChild(copyBtn);

      const trimmed = text.trim();
      if (/^(https?|ftp):\/\//i.test(trimmed)) {
        actions.appendChild(
          makeButton("打开链接", () => window.open(trimmed, "_blank", "noopener"))
        );
      }
      body.appendChild(actions);
    } else {
      body.appendChild(el("div", "error", msg.error || "未知错误"));
    }
    card.appendChild(body);
  }

  /* ---------- 小组件 ---------- */

  function makeHeader(title) {
    const header = el("div", "header");
    header.appendChild(el("span", "title", title));
    const close = el("button", "close", "×");
    close.title = "关闭";
    close.addEventListener("click", dismiss);
    header.appendChild(close);
    return header;
  }

  function makeButton(label, onClick) {
    const b = el("button", "btn", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function dismiss() {
    if (STATE.host && STATE.host.parentNode) STATE.host.parentNode.removeChild(STATE.host);
    STATE.host = null;
    STATE.card = null;
  }

  async function copyText(text, btn) {
    const flash = (t) => {
      const orig = "复制";
      btn.textContent = t;
      setTimeout(() => (btn.textContent = orig), 1200);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        flash("已复制 ✓");
        return;
      }
    } catch (e) {
      /* 退回 execCommand */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      setStyles(ta, { position: "fixed", top: "-1000px", opacity: "0" });
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      flash("已复制 ✓");
    } catch (e) {
      flash("复制失败");
    }
  }

  /* ---------- 辅助 ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setStyles(node, styles) {
    for (const k in styles) node.style.setProperty(camelToKebab(k), styles[k]);
  }

  function camelToKebab(s) {
    return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .card { font-size: 14px; line-height: 1.5; }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #111827; color: #fff;
    }
    .title { font-weight: 600; font-size: 14px; }
    .close {
      all: unset; cursor: pointer; font-size: 20px; line-height: 1;
      color: #cbd5e1; padding: 0 4px;
    }
    .close:hover { color: #fff; }
    .body { padding: 14px; display: flex; align-items: center; gap: 10px; }
    .result {
      word-break: break-all; white-space: pre-wrap; user-select: text;
      background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
      padding: 10px 12px; max-height: 220px; overflow: auto;
      font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace; font-size: 13px;
    }
    .error { color: #b91c1c; word-break: break-word; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .btn {
      all: unset; cursor: pointer; user-select: none;
      background: #2563eb; color: #fff; border-radius: 8px;
      padding: 7px 14px; font-size: 13px; font-weight: 500;
    }
    .btn:hover { background: #1d4ed8; }
    .spinner {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid #e5e7eb; border-top-color: #2563eb;
      display: inline-block; animation: cliim-spin 0.7s linear infinite;
    }
    @keyframes cliim-spin { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f2937; color: #f3f4f6; border-color: #374151; }
      .result { background: #111827; border-color: #374151; color: #e5e7eb; }
    }
  `;
})();
