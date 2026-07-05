"use strict";

/*
 * 二维码解码 · QR Decode —— 纯本地版
 * ------------------------------------------------------------
 * 完全在浏览器内用 ZXing 解码，图片不上传到任何服务器。
 * 唯一的网络行为是「抓取被右键的那张图片的字节」（等同于浏览器本来就要加载它）。
 *
 * 流程：
 *   1. 抓取图片字节（background 特权 fetch，可拿跨域图片与 data: URI，避免 canvas 跨域污染）
 *   2. createImageBitmap → canvas → getImageData 得到 RGBA 像素（webp/avif 等由浏览器原生解码）
 *   3. 交给 ZXing 的 QRCodeReader 本地解码
 *
 * ZXing 以 UMD 形式在 background 页里注册为全局 `ZXing`（见 manifest 的 background.scripts）。
 */

const MENU_ID = "qr-decode";
const MSG_TYPE = "CLIIM_QR_RESULT"; // 与 overlay.js 约定的消息类型（保持不变）

/* ---------- 右键菜单 ---------- */

function setupMenu() {
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
    const { data, width, height } = await getPixels(blob);
    const text = decodeQR(data, width, height);
    if (text == null) throw new Error("未能识别出二维码。");
    finish(tabId, overlay, { ok: true, text: text, srcUrl: srcUrl });
  } catch (err) {
    finish(tabId, overlay, { ok: false, error: normalizeError(err) });
  }
});

/* ---------- 解码流水线（全本地） ---------- */

// 1. 抓取图片（background 特权 fetch，可拿跨域图片与 data: URI）
async function fetchImage(srcUrl) {
  if (/^blob:/i.test(srcUrl)) {
    throw new Error("无法读取 blob: 图片（由页面动态生成）。可先在新标签页打开图片再解码。");
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

// 2. 解码图片为 RGBA 像素（浏览器原生解码 webp/avif/gif/…；从 Blob 绘制不会污染 canvas）
async function getPixels(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw new Error("无法解码该图片格式。");
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width: width, height: height };
}

// 3. ZXing 本地解码。按 打包 RGB→自适应二值化 / 反色 / 全局直方图 三种方式依次尝试，提高成功率。
function decodeQR(rgba, width, height) {
  const size = width * height;
  const argb = new Int32Array(size);
  for (let i = 0, j = 0; i < size; i++, j += 4) {
    argb[i] = (rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2];
  }

  const hints = new Map();
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

  const source = new ZXing.RGBLuminanceSource(argb, width, height);
  const makeBitmaps = [
    () => new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source)),
    () => new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source.invert())),
    () => new ZXing.BinaryBitmap(new ZXing.GlobalHistogramBinarizer(source))
  ];

  for (const make of makeBitmaps) {
    try {
      return new ZXing.QRCodeReader().decode(make(), hints).getText();
    } catch (e) {
      // NotFoundException 等 —— 换下一种二值化再试
    }
  }
  return null;
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

/* ---------- 工具 ---------- */

function normalizeError(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  return err.message || String(err);
}
