# BotHub：迁入 DSH 右侧面板

- 日期：2026-11-09。
- 来源：用户明确要求可视化进入 DSH 右侧面板，避免覆盖 Bot 对话、输入和信息流。
- 本文更新 MVP 曾采用的中央 `main` 面板决定；按本次用户指示实施。

## 已定行为与公开契约

- 删除 BotHub 的 `main` 和 `sidebar.panellist` 注册，不再替换中间内容。
- 通过 DSH 0.2.1-rc.4 随包公开的 `sidebarRightTabs.register` 注册 page type，
  在 `sidebar.right.pane.tab` 注册 body；使用 `sidebarRight.openTab` 打开。
  不修改 DSH，不读取安装内部文件作为运行依赖，不另造右栏。
- DS Bot 侧栏与 DSH footer 的立方体入口打开当前会话的 BotHub 标签；
  DSH 右栏 guide 提供同一入口。无当前会话时禁用快捷入口，不创建会话或 Bot。
- 由宿主管理关闭、缩放、分栏、全屏及逐会话布局；窄屏沿用 DSH 的全屏规则。
  正常桌面宽度中，对话、输入和信息流留在中间。
- 按 BotHub 容器宽度重排工具栏、场景和详情，不按整个窗口宽度推断右栏宽度。
- 通过公开 `useTabInfo` 读取可见性和绑定刷新操作；隐藏/关闭的 body 不采集或渲染。
  多个可见标签共用监控 store，每个挂载持有独立租约，最后一个离开才停流。
- 原生会话导航、监控授权、发送回执及私有桌面语义沿用现有实现。

## 实施与验证计划

1. 修改客户端注册、入口和标签生命周期，增加注册/入口/共享监控回归。
2. 改为容器响应布局，同步两份 README 和 MVP 当前指引；重新生成 client.js。
3. 运行 BotHub 全部测试、构建一致性、lint；运行 DS Bot 必需检查。
4. 在全新隔离 `.dsh-test-bothub-right-panel`、仓库 mock 与独立浏览器中验证：
   右栏挂载、中央对话/输入保留、2D/3D、详情、尺寸变化、关闭停流与重开。
   本次无 Host 改动；不触及用户真实 DSH 数据，不安装到用户 Desktop。

## 工作树与边界

当前分支为 `feat/bothub-mvp`，本地没有 `dev`；大量文件已有改动（包括行尾差异）。
延续现有 MVP 工作树，保留所有既有修改；不重置、不提交、不推送或发布。
真实 Windows/Electron 人工体验与 mock 浏览器验收分别记录。

## 验证记录

已完成本地实现与验证：

- `index.js` 注册原生右侧 page type、guide 入口和 body；两处立方体入口使用
  `sidebarRight.openTab('bothub')`，无当前会话时禁用；没有 `main` 注册。
- 宽度不超过 900px 时场景/列表与详情上下排列，未选成员时不占详情空间。
  容器宽度决定布局；移除中央面板专用的窗口标题栏留白。
- `HubTab` 使用公开 `useTabInfo`、绑定刷新，隐藏时不渲染 Hub；
  monitor store 按挂载租约共享采集，重复释放和旧租约不会关闭新连接。
- 最终 BotHub **104/104** 测试、生成一致性与 lint 通过；DS Bot
  **1609 通过、2 跳过、0 失败**，生成一致性与 lint 通过（保留既有警告）。
  没有修改 DS Bot 源码或 Host，没有要求重跑 Host smoke。
- 隔离 DSH 0.2.1-rc.4 + 仓库 mock + 全新无头 Chromium context，
  **10 项浏览器检查通过、页面异常 0**：原生右栏挂载；1600px 窗口中
  中央对话宽 600px、右栏 720px；中央输入和本次新 mock 回复正常；2D 详情、
  3D canvas；收起卸载并停流；重开单连接；643px 面板容器重排；
  390px 窗口使用 DSH 自带全屏右栏，均无横向溢出。
- 宿主在挂载盘冷启动超过台架的 240 秒就绪窗口，台架报超时后原进程继续
  启动并正常监听。浏览器随后连接同一隔离实例完成检查，没有新起第二个 Host。
  第一次 UI 自动化选中了被 DS Bot 侧栏覆盖的宿主 footer 按钮，点击超时；
  改用真实可点击的 `.bt-leftcol-foot` 入口后通过，没有 force click。
- 首次完整 BotHub 运行返回 102/103，未单独保留该次完整测试输出，不能判断
  失败项原因；随后完整复跑 103/103、最终可见工作树 104/104 通过。
  没有将最初失败归因于某个已修复 bug。

## 本地证据与交付

- 忽略目录 `.playwright-mcp/bothub-right-panel/` 中，`verify.mjs` / `verify.json`
  为最终浏览器检查；`01-right-panel.png`、`02-chat-reply.png`、`02-detail.png`、
  `03-narrow-panel.png`、`04-mobile.png` 来自最终检查，已人工查看代表截图。
  `probe` / `failure` 文件只作诊断，不是最终通过证据。
- 测试使用仓库规定的 mock；没有读取真实 API key，没有真实模型、私有桌面容器
  或用户 Windows/Electron 人工验收。本次仅保存浏览器截图，没有录制或发布 GIF。
- 当前未提交工作树基点 `5df2c006a67e3f026ffc06b3b77622da47123876`。
  生成客户端 SHA-256：
  `950fcf8e8e34417472c959518d0b5a8ea0b46689ec00c1317201cbe4ac6b11b3`。
- 本地包：`artifacts/bothub-right-panel-2026-11-09/dsh-bothub-0.1.0-rc.4.tgz`，
  194381 字节；版本仍为 rc.4，必须用目录与校验和区分之前的包。
  SHA-256：`1af14446a85335b6fa93ebf9f4990fb2317e33e8b795756e086894958a8b18ca`。
  包含 15 个发布文件，包内 client.js 与本次构建逐字节相同，没有 test/dev/数据目录。
  同目录提供 `.sha256`、`manifest.json`、`INSTALL.zh.md`；兼容 DS Bot 已装时只需更新 BotHub。
- 仅生成本地预览，未安装到用户配置、提交、推送或发布。台架与 mock 已停止，
  3210 / 8910 端口已释放；测试数据保留在隔离目录便于复核。
