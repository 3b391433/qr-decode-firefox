# 二维码解码 · QR Decode

[![build](https://github.com/3b391433/qr-decode-firefox/actions/workflows/build.yml/badge.svg)](https://github.com/3b391433/qr-decode-firefox/actions/workflows/build.yml)

一个 Firefox 扩展：**右键任意图片 → 「解码二维码 (QR Decode)」**，即可识别图片里的二维码内容。结果以页面浮层展示，可一键复制、若是网址可直接打开。

**完全在本地解码**（基于 [ZXing](https://github.com/zxing-js/library)）——图片不上传到任何服务器，可离线使用。

## 安装

### 方式一：安装已签名的 `.xpi`（推荐，可永久安装）

Release 里的 `.xpi` 已由 Mozilla (AMO) 签名，可在**普通版 Firefox** 永久安装：

1. 到 [Releases](https://github.com/3b391433/qr-decode-firefox/releases) 下载最新的 `.xpi`
2. Firefox 打开 `about:addons` → 右上角齿轮 ⚙ → **「从文件安装附加组件…」(Install Add-on From File…)** → 选中该 `.xpi`
   （或直接把 `.xpi` 文件拖进 Firefox 窗口）

### 方式二：临时加载（自用 / 调试，无需签名）

1. 地址栏打开 `about:debugging#/runtime/this-firefox`
2. 点 **「临时载入附加组件…」(Load Temporary Add-on…)**
3. 选择本仓库 `src/manifest.json`

> 临时加载在浏览器重启后失效。

## 使用

在网页上任意图片 **右键** → **「解码二维码 (QR Decode)」**：

- 成功：右上角浮层显示内容；点 **复制** 复制文本；若内容是网址，点 **打开链接**。
- 失败：浮层显示错误原因（如「未能识别出二维码」）。
- 在无法注入脚本的受限页面（`about:`、附加组件商店等），结果会以**系统通知**弹出。

## 工作原理

全程在浏览器内完成，除了抓取那张图片本身，不产生任何网络请求：

1. **抓取**图片字节（background 特权 `fetch`，可拿跨域图片与 `data:` URI，避免 canvas 跨域污染）
2. **取像素**：`createImageBitmap` → `canvas` → `getImageData` 得到 RGBA（WebP / AVIF / GIF 等由浏览器原生解码，无需额外处理）
3. **本地解码**：把像素喂给 [ZXing](https://github.com/zxing-js/library) 的 `QRCodeReader`；依次尝试「自适应二值化 / 反色 / 全局直方图」三种方式以提高成功率

## 开发

依赖 [`web-ext`](https://github.com/mozilla/web-ext)（Mozilla 官方工具）。

```bash
npm install
npm run start   # 启动一个临时 Firefox 并自动加载/热重载扩展
npm run lint    # 校验扩展
npm run build   # 打包到 web-ext-artifacts/*.zip
```

ZXing 以 UMD 形式随扩展一起分发（`src/vendor/zxing.min.js`），在 background 页注册为全局 `ZXing`，无需构建步骤。

## 打包与发布 (CI)

GitHub Actions（`.github/workflows/build.yml`）：

- **每次 push / PR**：`web-ext lint` + `web-ext build`，未签名包作为 workflow artifact 上传。
- **打 tag（`v*`）**：调用 `web-ext sign` 向 AMO 申请**签名**，把签名后的 `.xpi` 附加到自动创建的 GitHub Release。签名凭据已配在仓库 Secrets：`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`。

发布一个新版本（⚠️ 同一版本号在 AMO **只能签一次**，务必先升版本号）：

```bash
# 1) 把 src/manifest.json 和 package.json 的 version 一起改成新号
# 2) 提交后打 tag 推送
git commit -am "release v1.1.1"
git tag v1.1.1
git push && git push origin v1.1.1
```

## 本地签名

```bash
export WEB_EXT_API_KEY=user:xxxx:xxx      # AMO JWT issuer
export WEB_EXT_API_SECRET=xxxxxxxx        # AMO JWT secret
npm run sign                              # channel=unlisted，自行分发；产物在 web-ext-artifacts/*.xpi
```

[AMO API 凭据在此申请](https://addons.mozilla.org/developers/addon/api/key/)。

## 隐私说明

✅ **图片不会离开你的浏览器**——解码完全在本地进行，不上传、不联网（抓取图片除外，那只是浏览器本来就要做的加载）。

## 已知限制

- **`blob:` 图片**（页面 JS 动态生成）background 无法读取；可先在新标签页打开图片再解码。
- 需要登录态 / 有防盗链的图片可能抓取失败。
- 极端**美化 / 残损**的二维码可能识别失败（受本地解码库能力所限）。

## 第三方

- [ZXing (zxing-js/library)](https://github.com/zxing-js/library) —— 二维码解码，Apache-2.0，见 `src/vendor/zxing-LICENSE.txt`。

## 文件结构

```
qr-decode-firefox/
├── src/
│   ├── manifest.json          扩展清单 (Manifest V2)
│   ├── background.js          右键菜单 + 抓取/取像素/ZXing 本地解码
│   ├── overlay.js             按需注入的页面浮层 (Shadow DOM)
│   ├── icons/icon.svg         图标
│   └── vendor/
│       ├── zxing.min.js       ZXing UMD 库
│       └── zxing-LICENSE.txt  ZXing 许可证 (Apache-2.0)
├── .github/workflows/build.yml   CI：lint + 打包 + 签名发布
├── package.json               web-ext 脚本
├── LICENSE                    MIT
└── README.md
```

## License

本项目 [MIT](LICENSE)；内置的 ZXing 为 Apache-2.0。
