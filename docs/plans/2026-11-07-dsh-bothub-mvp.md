# BotHub MVP：只读监控与原生会话交互

- 日期：2026-11-07。
- 来源：用户在开发计划后明确要求按 MVP 推进；本地实现，尚未发布。
- 相关：[完整开发计划](2026-11-07-dsh-bothub-development-plan.md)。

## 为什么

先验证“真实状态 → 2D/3D → 找到正确会话”的闭环。首个切片保留原生聊天、
停止与审批入口，缩小执行副作用与兼容性风险。

## 当前实现范围

- 独立 `dsh-bothub` 包，与 DS Bot 共享宿主。
- DS Bot 增加公开 Cordis 服务 `botMonitor`，version 1；它只读当前团队，
  不调用 bootstrap、不提供执行命令。
- BotHub 在宿主认证的 connection fetch 通道注册 `api/bothub`。
  GET 为快照，POST 只重新解析导航目标。
- 客户端使用公开 `main` keyed slot、`sidebar.panellist` 和
  `sidebar.footer.action`，通过 `uiWorkspace.openSession()` 打开会话。
- DS Bot 自有侧栏会覆盖宿主底部，因此增加 `bot.sidebar.action` 列表槽位，
  由标准 `slots.register` 的 children 声明并由 `renderSlot` 渲染。
  BotHub 在此注册立方体入口；没有 DOM 注入或宿主补丁。
- 私聊和群成员执行分别来自 DS Bot 已有的逐 Session `live` 数据。
  详情保留每个执行上下文，群成员跳转回群聊。
- 没观测过的会话显示 unknown。普通 DSH Agent 提供会话导航，本版不声称
  已监控其运行状态；没有子 Agent 全局扫描。
- 审批只显示类别；不复制审批原因、工具参数或聊天文本。
- 首版使用可见面板每 1.5 秒获取完整快照，单请求串行，10 秒超时。
  断线保留旧快照并关闭跳转，失权清空快照；重新打开后先重新获取。
- 原创程序化 3D 工位与角色，支持选择、旋转、缩放和重置。没有持续环境动画。
- 2D 提供相同的筛选、详情与导航能力；WebGL 失败退回 2D。
- 场景最多 50 个可见成员，其他成员仍可搜索并在 2D 中查看。

## 公开扩展点证据

对照 DSH `0.2.1-rc.4` 随包发布的插件开发文档与公开类型：

- Cordis `Context.provide/get/effect`：服务注册、读取与生命周期。
- DSH connection fetch：与 DS Bot 现有通道同一认证边界。
- `dsh-client-ui-layout` 公开 `main` slot。
- `dsh-client-ui-sidebar` 公开 panel list / footer action。
- `dsh-client-ui-workspace` 公开 `openSession`。
- locale `register` 和 slot `locale`。
- `slots.register` 的 children 声明和组件 `renderSlot`：DS Bot 侧栏扩展入口。

connection 会规范化交给 fetch route 的 Request URL，不能拿这个 URL 的
origin 与浏览器 Origin 头直接比较。监控通道复用宿主认证；额外拒绝明确标为
`Sec-Fetch-Site: cross-site` 的浏览器请求。POST 仍仅解析导航目标，不执行命令。

代码不导入 DSH 安装目录内部文件；这些类型只用于确认契约。运行通过公开
CLI、包导出与服务完成。

## 边界与后续

- 这是已登录用户的当前本机团队视图，不作为多租户 API 或模型工具发布。
- 没有持久监控历史，也不判断未观测执行的成功/失败。
- 尚未实施完整计划中的 SSE 水位、命令凭证、直接快捷发送、精确停止、
  子 Agent 投影和多来源接入。
- 3D 为单一工作区，通过群筛选查看成员；不提供物理房间编辑和三级镜头。
- 不保存布局、聊天或敏感摘要，不触及用户真实 DSH 数据。
- 可观测性不足时以 unknown 表示，不以动画补造运行事实。

## 本地开发基线

`origin` 没有 `dev`，对原文档上游的网络查询也未成功。因此保留用户的当前
工作区，在 `feat/bothub-mvp` 本地分支增量实现；不重置、清理或提交原有改动。
提交 PR 前需确认正确开发上游与目标分支。

## 验证要求

- 新增单元测试：最小快照、并发会话、敏感字段排除、空团队不初始化、
  换段解析、失效目标、路由与协议错误、客户端重连和卸载竞态。
- 运行现有 DS Bot 测试、生成文件检查、lint，以及 mock bench smoke。
- 浏览器实际加载插件，验证 2D/3D、筛选、详情、真实会话跳转。
- 演示来自独立测试台与仓库 mock model，明确标注为 mock；
  不使用真实凭证，遵循用户给出的仓库硬规则。
- 本地工作区含用户未提交改动，演示证明工作区构建，不冒充某个干净 PR SHA。

## 变更

- 2026-11-07：收缩首个 MVP 切片，开始实现与验证。
- 2026-11-07：完成本地 alpha 实现、实际宿主联调和下列验证；未发布。

## 实施状态与验收记录

### 已交付文件

- `dsh-bothub/`：独立插件、原创 3D 场景、2D 页面、双语文案、构建脚本、
  单元测试、安装说明及隔离测试台脚本，版本 `0.1.0-alpha.1`。
- `ds-bot/src/host/monitor.js`：最小只读服务，接入 `ds-bot/index.js`。
- `ds-bot/src/client/index.js`、`sidebar.js`：声明并渲染配套插件入口槽位；
  已重新生成 `ds-bot/client.js`。
- `ds-bot/test/monitor.test.js`：服务集成和数据边界测试；测试上下文支持
  独立的服务注册表，避免共用 fixture 被注册过程污染。
- `.github/workflows/test.yml`：新增 BotHub 的 Node 22/24 检查，并纳入最终
  Test result；本地只实际运行了 Node 22，远程 CI 尚未执行。
- 根目录 `NOTICE` 及 `dsh-bothub/licenses/three.txt`：Three.js MIT 声明。

### 验证结果

本机为 WSL / Linux Node 22.23.2，DSH `0.2.1-rc.4`。浏览器使用独立无头
Windows Chrome + 环境已有 Playwright，未使用用户浏览器 profile。

| 检查 | 结果 |
| --- | --- |
| DS Bot `npm run build` | 通过 |
| DS Bot `npm test` | 1,569 通过、2 跳过、0 失败 |
| DS Bot 生成文件 `--check` | 通过 |
| DS Bot `npm run lint` | 通过；保留已有警告 |
| BotHub `npm test` | 8 通过、0 失败 |
| BotHub 构建、`check`、lint | 全部通过 |
| 现有 DS Bot mock smoke | 干净重跑后 52/52 步骤通过 |
| 未认证读取监控 API | 宿主返回 401 |
| 真实宿主中的 3D | 选中成员、旋转、缩放、重置均通过 |
| 2D | 搜索、无结果提示、群筛选均通过 |
| 真实 mock 回合 | 从原生会话派活，BotHub 观测到 working，结束后回到 idle |
| 原生导航 | Bot 私聊与群成员上下文均打开正确会话 |
| 面板卸载 | 轮询停止，场景 canvas 移除 |
| 断网与重连 | 保留旧快照、禁用跳转；恢复后重新启用 |
| WebGL 不可用 | 自动退回 2D，3D 按钮不可用 |
| 390px 窄屏 | 成员可选、详情可见，没有横向溢出 |
| 浏览器 JavaScript 异常 | 最终验收运行 0 个 page error |
| npm 包 | 已检查打包清单，包含 host、client、manifest 和许可证 |
| CI YAML | 本地解析通过，最终检查依赖包含 BotHub |

早期 smoke 曾有一次连接重置；没有增加自动重试掩盖问题，重新清空隔离
测试台后完整执行 52 步通过。宿主联调修正了两个无法由纯单元测试发现的问题：
自有侧栏遮住宿主插件入口，以及规范化 Request URL 导致同源 POST 被误拒绝。

检查过的新增 BotHub 文件与两份计划没有扫描命中。覆盖相关源文件、生成文件及
必要仓库元数据的扫描仍有 10 条既有告警：根 README 的备份清理描述被当作
非公开路径，以及 CUA 固定工作目录文案被当作个人路径。这些位于本次没有编辑
的既有源文案或其生成产物，未为通过扫描而修改用户已有 CUA 工作。本记录不
宣称整个仓库发布扫描或远程 CI 已通过。

### 本地演示与复现

- 演示源树：`feat/bothub-mvp` 未提交工作区，起点 HEAD `ae0ee82`，包含原有修改。
  演示不能作为该 HEAD 的干净构建证据。
- 测试台：`.dsh-test-bothub-mvp`，只连接仓库 scripted mock LLM；
  WSL 文件权限原因将该目录符号链接到本次专用的 Linux 临时目录。
- 端口：Web 3196、mock 8896；验收后均已停止。
- 演示：`.playwright-mcp/bothub-mvp/demo/demo.gif`；
  原始视频为同目录 `demo.webm`，截图 `01-running.png`。
- GIF 截取源视频 7.0–26.4 秒，1.5 倍速，10 fps，1200×800，
  末帧停留 2 秒；仅裁剪和加速，没有拼接不同运行。已解码检查代表帧。
- 浏览器断言摘要：同目录 `result.json`。WebGL 关闭及窄屏检查为单独验收，
  不拼入该演示。
- 媒体和测试数据被 Git 忽略，不纳入包或提交；没有部署、提交、推送或发布。

### 下一轮的建议顺序

1. 先由用户实际体验当前 alpha，确认空间交互与会话导航是否有用。
2. 依据公开 DSH 能力补充普通 Agent / 子 Agent 的真实活动来源与权限边界。
3. 需求稳定后再实现 SSE 增量同步与可恢复事件水位，替换快照轮询。
4. 最后考虑场景内直接发送、精确停止和审批快捷操作；复用原执行通路，
   单独测试授权、重复点击和失效目标，不在首版悄悄放宽只读边界。

### 后续切片

用户确认继续后，alpha.2 开始补充普通 Agent / 子 Agent，详见
[Agent 设计与验收](2026-11-07-dsh-bothub-agents.md)。上文 alpha.1 的数字和演示
保留为首次交付记录；当前工作区协议已升级至 version 2，须同时更新两插件。
