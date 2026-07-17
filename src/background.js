"use strict";

/*
 * 二维码解码 · QR Decode —— 纯本地版
 * ------------------------------------------------------------
 * 完全在浏览器内用 ZXing 解码，图片不上传到任何服务器。
 *
 * 取像素分两级（大多数情况零网络请求）：
 *   ① 页面侧（grab.js）：直接复用浏览器已渲染的 <img> 像素；
 *      跨域被 canvas 污染挡住时，由内容脚本以页面身份 fetch（请求特征与页面一致）。
 *   ② 兜底：background 特权 fetch 原图字节（可拿 data: URI、无法注入脚本的页面），
 *      createImageBitmap → canvas → getImageData。
 * 拿到 RGBA 后交给 ZXing 的 QRCodeReader 本地解码。
 *
 * ZXing 以 UMD 形式在 background 页里注册为全局 `ZXing`（见 manifest 的 background.scripts）。
 */

const MENU_ID = "qr-decode";
const MSG_TYPE = "CLIIM_QR_RESULT"; // 与 overlay.js 约定的消息类型（保持不变）
const MSG_GRAB = "QR_GRAB_PIXELS"; // 与 grab.js 约定的消息类型

/* ---------- 右键菜单 ---------- */

function setupMenu() {
  browser.menus.removeAll().then(() => {
    browser.menus.create({
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

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const srcUrl = info.srcUrl;
  const tabId = tab && tab.id != null ? tab.id : null;
  const overlay = await ensureOverlay(tabId);

  if (overlay) sendToOverlay(tabId, { state: "busy" });

  const problems = [];

  // ① 页面侧：复用浏览器已渲染的图像像素（零网络；跨域时 grab.js 内部退到页面身份 fetch）
  try {
    const grabbed = await grabFromPage(tabId, info);
    if (grabbed && grabbed.ok) {
      const text = decodeQR(new Uint8ClampedArray(grabbed.buf), grabbed.width, grabbed.height);
      if (text != null) {
        finish(tabId, overlay, { ok: true, text: text, srcUrl: srcUrl });
        return;
      }
      problems.push("页面图像未识别出二维码");
    } else {
      problems.push((grabbed && grabbed.error) || "页面侧取图失败");
    }
  } catch (err) {
    problems.push("页面侧取图失败：" + normalizeError(err));
  }

  // ② 兜底：background 特权 fetch 原图（受限页面、data: URI、srcset 缩略图等场景）
  if (srcUrl) {
    try {
      const blob = await fetchImage(srcUrl);
      const { data, width, height } = await getPixels(blob);
      const text = decodeQR(data, width, height);
      if (text != null) {
        finish(tabId, overlay, { ok: true, text: text, srcUrl: srcUrl });
        return;
      }
      problems.push("原图未识别出二维码");
    } catch (err) {
      problems.push(normalizeError(err));
    }
  } else {
    problems.push("未获取到图片地址");
  }

  finish(tabId, overlay, { ok: false, error: composeError(problems) });
});

/* ---------- 解码流水线（全本地） ---------- */

// ①. 页面侧取像素：注入 grab.js，让它从被右键的 <img> 直读 canvas（跨域时以页面身份 fetch）。
// 受限页面（about:、AMO 等）executeScript 会抛错，由调用方捕获后走 ② 兜底。
async function grabFromPage(tabId, info) {
  if (tabId == null) return { ok: false, error: "无标签页上下文" };
  const opts = typeof info.frameId === "number" ? { frameId: info.frameId } : {};
  await browser.tabs.executeScript(tabId, Object.assign({ file: "grab.js" }, opts));
  return browser.tabs.sendMessage(
    tabId,
    { type: MSG_GRAB, targetElementId: info.targetElementId, srcUrl: info.srcUrl || "" },
    opts
  );
}

// ②. 抓取图片（background 特权 fetch，可拿跨域图片与 data: URI）
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

// 把多级尝试的失败原因合成一条可读消息（去重、去尾部标点后用「；」连接）。
function composeError(problems) {
  const uniq = [];
  for (const p of problems) {
    const s = String(p || "").replace(/[。；;\s]+$/, "");
    if (s && uniq.indexOf(s) === -1) uniq.push(s);
  }
  if (uniq.length === 0) return "未知错误";
  if (uniq.every((s) => s.indexOf("未识别出二维码") !== -1)) return "未能识别出二维码。";
  return uniq.join("；") + "。";
}
