# 二维码解码 · QR Decode (cli.im)

[![build](https://github.com/3b391433/qr-decode-firefox/actions/workflows/build.yml/badge.svg)](https://github.com/3b391433/qr-decode-firefox/actions/workflows/build.yml)

一个 Firefox 扩展：**右键任意图片 → 「解码二维码 (QR Decode)」**，即可识别图片里的二维码内容。结果以页面浮层展示，可一键复制、若是网址可直接打开。

解码能力来自草料二维码 (cli.im) 的公开解码接口。

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

解码接口只接受托管在 cli.im 自家 CDN 上的图片，因此扩展分三步（全部在后台脚本完成，绕过 CORS，也顺带支持 `data:` 图片与跨域/防盗链图片）：

1. **抓取**图片字节
2. **归一化格式**：cli.im 解码器只认 PNG/JPEG，WebP / AVIF / GIF / BMP 等用 canvas 转成 PNG
3. **上传**到 cli.im 图床，拿到其 CDN 图片 URL
4. 用该 URL 调用**解码**接口，取回内容

接口契约（逆向自 `https://cli.im/deqr`，已实测）：

```
上传  POST https://upload-api.cli.im/upload?kid=cliim
      Content-Type: multipart/form-data   字段名: Filedata
      → { "code":200, "data":{ "url":"https://ncstatic.clewm.net/....png", ... } }

解码  POST https://cli.im/Api/Browser/deqr
      Content-Type: application/x-www-form-urlencoded
      body: data=<上一步返回的 url>
      成功 → { "status":1, "data":{ "RawData":"<二维码内容>" } }
      失败 → { "status":0, "data":{ "info":"<错误信息>" } }
```

## 开发

依赖 [`web-ext`](https://github.com/mozilla/web-ext)（Mozilla 官方工具）。

```bash
npm install
npm run start   # 启动一个临时 Firefox 并自动加载/热重载扩展
npm run lint    # 校验扩展
npm run build   # 打包到 web-ext-artifacts/*.zip
```

## 打包与发布 (CI)

GitHub Actions（`.github/workflows/build.yml`）：

- **每次 push / PR**：`web-ext lint` + `web-ext build`，未签名包作为 workflow artifact 上传。
- **打 tag（`v*`）**：调用 `web-ext sign` 向 AMO 申请**签名**，把签名后的 `.xpi` 附加到自动创建的 GitHub Release。签名凭据已配在仓库 Secrets：`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`。

发布一个新版本（⚠️ 同一版本号在 AMO **只能签一次**，务必先升版本号）：

```bash
# 1) 把 src/manifest.json 和 package.json 的 version 一起改成新号，如 1.0.1
# 2) 提交后打 tag 推送
git commit -am "release v1.0.1"
git tag v1.0.1
git push && git push origin v1.0.1
```

## 本地签名

CI 已能在打 tag 时自动签名（见上）。若想在本地手动签一个：

```bash
export WEB_EXT_API_KEY=user:xxxx:xxx      # AMO JWT issuer
export WEB_EXT_API_SECRET=xxxxxxxx        # AMO JWT secret
npm run sign                              # channel=unlisted，自行分发；产物在 web-ext-artifacts/*.xpi
```

[AMO API 凭据在此申请](https://addons.mozilla.org/developers/addon/api/key/)。

## 隐私说明

解码时，被右键的图片会**上传到第三方服务 cli.im**。请勿对包含敏感信息的图片使用本扩展。这是「使用 cli.im 解码接口」这一需求的固有代价。

## 已知限制

- **`blob:` 图片**（页面 JS 动态生成）后台脚本无法读取；可先在新标签页打开图片再解码。
- 需要登录态 / 有防盗链的图片可能抓取失败。
- 极大的图片可能被图床拒绝。
- 接口为 cli.im 私有、非官方开放 API，未来可能变动。若失效，用开发者工具重新查看 `cli.im/deqr` 的网络请求并更新 `src/background.js` 里的常量即可。

## 文件结构

```
qr-decode-firefox/
├── src/
│   ├── manifest.json      扩展清单 (Manifest V2)
│   ├── background.js      右键菜单 + 抓取/上传/解码流水线
│   ├── overlay.js         按需注入的页面浮层 (Shadow DOM)
│   └── icons/icon.svg     图标
├── .github/workflows/build.yml   CI：lint + 打包 + 签名发布
├── package.json           web-ext 脚本
├── LICENSE                MIT
└── README.md
```

## License

[MIT](LICENSE)
