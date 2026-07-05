"use strict";

/*
 * 二维码解码 · QR Decode (via cli.im)
 * ------------------------------------------------------------
 * 流程 (reverse-engineered from https://cli.im/deqr):
 *   1. 抓取图片字节 (background 特权 fetch，绕过 CORS)
 *   2. 上传到 cli.im 图床  ->  拿到 ncstatic.clewm.net 上的图片 URL
 *   3. 用该 URL 调用解码接口  ->  拿到 RawData
 *
 * 接口契约:
 *   上传:  POST https://upload-api.cli.im/upload?kid=cliim
 *          multipart/form-data，字段名 "Filedata"
 *          -> { "code":200, "data": { "url": "https://ncstatic.clewm.net/....png", ... } }
 *   解码:  POST https://cli.im/Api/Browser/deqr
 *          application/x-www-form-urlencoded，body: data=<上传返回的 url>
 *          成功 -> { "status":1, "data": { "RawData": "<内容>" } }
 *          失败 -> { "status":0, "data": { "info": "<错误信息>" } }
 *   解码接口只接受托管在 cli.im 自家 CDN 上的图片，所以上传这一步是必需的。
 */

const UPLOAD_URL = "https://upload-api.cli.im/upload?kid=cliim";
const DECODE_URL = "https://cli.im/Api/Browser/deqr";
const MENU_ID = "cliim-decode-qr";
const MSG_TYPE = "CLIIM_QR_RESULT";

/* ---------- 右键菜单 ---------- */

function setupMenu() {
  // removeAll 再 create，保证 background 重新加载时不会因重复 id 报错。
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_ID,
      title: "解码二维码 (QR Decode)",
      contexts: ["image"]
    });
  });
}

setupMenu();
browser.runtime.onInstalled.addListener(setupMenu);
browser.runtime.onStartup.addListener(setupMenu);

/* ---------- 点击处理 ---------- */

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const srcUrl = info.srcUrl;
  const tabId = tab && tab.id != null ? tab.id : null;
  const overlay = await ensureOverlay(tabId);

  if (!srcUrl) {
    finish(tabId, overlay, { ok: false, error: "未获取到图片地址。" });
    return;
  }

  if (overlay) sendToOverlay(tabId, { state: "busy" });

  try {
    const blob = await fetchImage(srcUrl);
    const uploadedUrl = await uploadImage(blob, srcUrl);
    const text = await decode(uploadedUrl);
    finish(tabId, overlay, { ok: true, text: text, srcUrl: srcUrl });
  } catch (err) {
    finish(tabId, overlay, { ok: false, error: normalizeError(err) });
  }
});

/* ---------- 三步流水线 ---------- */

// 1. 抓取图片（background 特权 fetch，可拿跨域图片与 data: URI）
async function fetchImage(srcUrl) {
  if (/^blob:/i.test(srcUrl)) {
    // blob: URL 属于页面上下文，background 无法读取。
    throw new Error("无法读取 blob: 图片（该图片由页面动态生成）。请尝试先在新标签页打开图片再解码。");
  }
  let resp;
  try {
    resp = await fetch(srcUrl, { credentials: "omit", cache: "force-cache" });
  } catch (e) {
    throw new Error("抓取图片失败：" + (e && e.message ? e.message : "网络错误"));
  }
  if (!resp.ok) throw new Error("抓取图片失败 (HTTP " + resp.status + ")。");
  const blob = await resp.blob();
  if (!blob || blob.size === 0) throw new Error("图片内容为空。");
  return blob;
}

// 2. 上传到 cli.im 图床，返回其 CDN 上的 URL
async function uploadImage(blob, srcUrl) {
  const ext = pickExtension(blob.type, srcUrl);
  const fd = new FormData();
  fd.append("Filedata", blob, "qr." + ext);

  const resp = await fetch(UPLOAD_URL, {
    method: "POST",
    body: fd,
    credentials: "omit"
  });
  const json = await readJson(resp, "上传");
  const url = json && json.data && (json.data.url || json.data.path);
  if (Number(json && json.code) !== 200 || !url) {
    throw new Error("上传失败：" + (json && json.msg ? json.msg : "code " + (json && json.code)));
  }
  return url;
}

// 3. 调用解码接口
async function decode(imageUrl) {
  const body = new URLSearchParams();
  body.set("data", imageUrl);

  const resp = await fetch(DECODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    credentials: "omit"
  });
  const json = await readJson(resp, "解码");
  const data = json && json.data;
  if (Number(json && json.status) === 1 && data && typeof data.RawData !== "undefined") {
    return String(data.RawData);
  }
  const info = data && data.info ? data.info : "未能识别出二维码。";
  throw new Error(info);
}

/* ---------- 结果呈现：优先页面浮层，失败退回系统通知 ---------- */

// 尝试注入浮层脚本；成功返回 true。受限页面 (about:, addons.mozilla.org 等) 会失败。
async function ensureOverlay(tabId) {
  if (tabId == null) return false;
  try {
    await browser.tabs.executeScript(tabId, { file: "overlay.js" });
    return true;
  } catch (e) {
    return false;
  }
}

function sendToOverlay(tabId, payload) {
  if (tabId == null) return Promise.resolve();
  return browser.tabs
    .sendMessage(tabId, Object.assign({ type: MSG_TYPE }, payload))
    .catch(() => {});
}

function finish(tabId, hasOverlay, payload) {
  if (hasOverlay) {
    sendToOverlay(tabId, Object.assign({ state: "done" }, payload));
  } else {
    notify(payload);
  }
}

function notify(payload) {
  const title = payload.ok ? "二维码解码结果" : "解码失败";
  const message = payload.ok
    ? (payload.text && payload.text.length ? payload.text : "(空内容)")
    : (payload.error || "未知错误");
  try {
    browser.notifications.create({ type: "basic", title: title, message: message });
  } catch (e) {
    console.error("[QR Decode]", title, message, e);
  }
}

/* ---------- 工具函数 ---------- */

async function readJson(resp, label) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(label + "接口返回异常 (HTTP " + resp.status + ")。");
  }
}

function pickExtension(mime, srcUrl) {
  const byMime = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "image/avif": "avif",
    "image/tiff": "tiff"
  };
  if (mime && byMime[mime.toLowerCase()]) return byMime[mime.toLowerCase()];
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(srcUrl || "");
  if (m && m[1].length <= 5) return m[1].toLowerCase();
  return "png";
}

function normalizeError(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  return err.message || String(err);
}
