"use strict";

/*
 * 页面侧取像素（按需注入的内容脚本）
 * ------------------------------------------------------------
 * 浏览器已经把图渲染出来了——优先直接复用它，而不是再发一次网络请求：
 *   ① menus.getTargetElement 拿到被右键的 <img>，画到 canvas 直读像素（零网络）。
 *      同源图（含直接打开的图片页、data: URI、页面自建的 blob:）都走这条路。
 *   ② 跨域 <img> 的像素受同源策略保护（canvas 被污染，getImageData 抛 SecurityError），
 *      退而以「页面身份」fetch——带主机权限的内容脚本可跨域读取，且请求特征与页面
 *      自身加载一致，防盗链 / WAF 风控通常不会拦。
 * 两条都失败时返回错误，由 background 用特权 fetch 做最后兜底。
 */

(() => {
  // 防止重复注入时重复绑定监听器（executeScript 每次点击都会再跑一遍本文件）。
  if (window.__qrGrabInjected) return;
  window.__qrGrabInjected = true;

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "QR_GRAB_PIXELS") return;
    return grabPixels(msg.targetElementId, msg.srcUrl).catch((e) => ({
      ok: false,
      error: e && e.message ? e.message : String(e)
    }));
  });

  async function grabPixels(targetElementId, srcUrl) {
    // ① 已渲染的 <img> → canvas 直读
    const img = findImage(targetElementId, srcUrl);
    if (img) {
      try {
        if (!img.complete && img.decode) await img.decode();
      } catch (e) {
        // 图片加载失败——落到 fetch 路径
      }
      try {
        return readPixels(img, img.naturalWidth, img.naturalHeight, "canvas");
      } catch (e) {
        // SecurityError（跨域污染）等——换页面身份 fetch
      }
    }

    // ② 页面身份 fetch
    if (!srcUrl) throw new Error("页面中未找到该图片。");
    const resp = await fetch(srcUrl, { credentials: "omit", cache: "force-cache" });
    if (!resp.ok) throw new Error("页面侧抓取失败 (HTTP " + resp.status + ")。");
    const bitmap = await createImageBitmap(await resp.blob());
    try {
      return readPixels(bitmap, bitmap.width, bitmap.height, "fetch");
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  // 定位被右键的图片元素：优先精确定位，退回按 src 匹配。
  function findImage(targetElementId, srcUrl) {
    let el = null;
    if (browser.menus && typeof browser.menus.getTargetElement === "function") {
      try {
        el = browser.menus.getTargetElement(targetElementId);
      } catch (e) {}
    }
    if (el instanceof HTMLImageElement) return el;
    for (const img of document.images) {
      if (img.currentSrc === srcUrl || img.src === srcUrl) return img;
    }
    return null;
  }

  function readPixels(source, width, height, via) {
    if (!width || !height) throw new Error("图片尺寸为空。");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data; // 跨域污染在这里抛 SecurityError
    return { ok: true, width: width, height: height, buf: data.buffer, via: via };
  }
})();
