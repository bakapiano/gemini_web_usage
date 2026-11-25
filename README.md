# Gemini 额度悬浮卡片

在 Gemini 聊天页显示官方的 **5 小时额度**、**每周额度**和重置时间。卡片默认在右下角，整个头部都可以拖动；位置保存在当前 Chrome 配置中。用键盘聚焦标题后，可以用方向键移动，用 Home 回到右下角。

重置时间使用浏览器本地时区。聊天页可见时每 30 秒刷新，隐藏时停止轮询，也可以手动点「刷新」。两项用量分别对比上次成功读取的值，有变化时会在对应数字上方显示短暂的差值动画（如 `+5%`）；首次读取和数值不变时不播放。

## 安装（二选一）

**油猴脚本**：先安装 Tampermonkey，再点 [安装 Gemini 额度脚本](https://raw.githubusercontent.com/bakapiano/gemini_web_usage/main/gemini-web-usage.user.js)，在油猴弹出的页面确认安装，最后刷新 Gemini 聊天页。也可以复制仓库里的 `gemini-web-usage.user.js`，手动新建脚本。油猴版与 Chrome 扩展版的功能一致，但卡片位置各自保存。

**Chrome 扩展**：

1. 打开 `chrome://extensions`。
2. 打开「开发者模式」，选择「加载已解压的扩展程序」。
3. 克隆本仓库或下载并解压 ZIP，选择包含 `manifest.json` 的 `gemini_web_usage` 文件夹。
4. 刷新已登录的 Gemini 聊天标签页（`/app`），右下角即会出现卡片。

如果已安装旧版，在 `chrome://extensions` 找到该扩展并点击「重新加载」，再刷新 Gemini 聊天页。

## 数据与权限

两个版本都只在 `gemini.google.com` 运行。它们用当前浏览器会话同源读取官方 `/usage` HTML 的 Relay 预载响应，解析 `viewer.rpcs.getUsageInfo.pools` 中的 `GXU_FIVE_HOURLY` 与 `GXU_WEEKLY`。不需要额外的 API key，不读取 Cookie 值或对话内容，也不向第三方发送额度数据。浏览器存储权限只用于记住卡片位置，不保存额度快照。

Google 未把这个 HTML 结构作为公开 API 提供。如果响应结构变化，可能读不到额度。读取失败时，卡片会标明旧数据的更新时间，并保留官方用量页入口；未成功读到数据时不会显示为 `0%`。

## 开发

两个版本共用 `usage.js` 和 `widget.js`。修改后运行 `node scripts/build-userscript.cjs`，重新生成可独立安装的 `gemini-web-usage.user.js`；用 `node scripts/build-userscript.cjs --check` 检查生成文件，用 `node --test` 跑测试。
