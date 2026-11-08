# BotHub alpha.2：Agent 与子 Agent 的只读监控

## 范围与数据来源

承接 MVP 下一步，保留 1.5 秒串行轮询和原生会话操作。本轮不增加直接发送、停止、审批或 SSE。

- 普通 Agent 和本地子 Agent 的运行状态仅读取公开 `agents.get(sessionId).status`。
  `running` 表示宿主正在驱动 Agent；不据此猜测工具、思考阶段、开始时间或审批。
  未驻留的 Agent 为 unknown，即使持久化日志曾有未结束回合，也不认为仍在执行。
- 发现范围限定为当前团队的 Bot 私聊、群成员会话和已登记普通 Agent 会话。
  使用公开 `subagents.listChildren` 的父会话目录，逐层查询，不扫描全部会话，
  不调用 create/resume，不从名称、fork 来源或目录中的 activity 猜测关系和状态。
- 每次发现最多查询 64 个父目录、纳入 64 个子节点、深度最多 4，整体限时 2 秒。
  截断、缺少服务或单个目录读取失败时显示覆盖不完整；已获得的节点仍可浏览。
  循环和重复节点去重，外部节点只展示关系，不尝试打开本地会话。
- 根成员在异步查询期间被移除时，丢弃它的发现结果。导航重新发现并验证当前目录，
  返回 DSH 公开的 SubagentAddress；不允许浏览器自行提交父子地址。
- 查询合并并发请求；卸载中止发现并移除服务。只输出名称、标识、关系和状态，
  不输出事件正文、工具参数、提示词、路径或诊断中的错误消息。

## 协议与界面

`botMonitor` 与快照升级至版本 2，前后端版本不匹配明确报错。
POST resolve 返回 `{ target }`；target 为根会话字符串或
`{ parentSessionId, childSessionId, mode }`，客户端交给 `uiWorkspace.openSession`。

子 Agent 使用独立实体，保留 rootEntityId / parentEntityId / parentSessionId；
群筛选沿根归属筛选。2D 与 3D 使用同一数据，详情支持选择父节点和子节点。
外部节点禁止打开会话；普通 Agent 的活动显示为执行中，不伪装成细粒度思考阶段。
本轮尚不覆盖普通 Agent 的审批、问题、历史成功/失败及用量；原生会话仍是完整操作入口。

## 验收

单元测试覆盖运行/空闲/未知、边界范围、循环、截断、超时、缺失能力、删除竞态、
协议与父子导航。执行 DS Bot 与 BotHub 的完整测试、构建校验、lint 和 mock smoke。
在隔离真实 DSH 宿主上用 mock 模型触发真实普通 Agent / 子 Agent，验证状态和导航。
演示只代表当前包含原有修改的工作区，不作为干净 HEAD 或远程 CI 的证据。

## 实现记录

- `ds-bot/src/host/monitor-agents.js`：驻留 Agent 状态、限额目录发现、父子实体转换。
- `ds-bot/src/host/monitor.js`：协议 v2、并发查询合并、重新校验根归属、卸载中止。
- `dsh-bothub/src/client/`：父子选择、子 Agent 群筛选、覆盖提示和原生地址导航。
- `ds-bot/dev/mock-llm.mjs`：增加 `BotHub work N` 和 `BotHub delegate N`；
  后者返回真实 `subagent` 工具调用，由 DSH 启动子 Agent。延迟上限 30 秒。
- `.gitignore`：测试根模式同时覆盖目录与符号链接，防止 Linux 测试根链接被误提交。
- 本地预览包版本提升为 `0.1.0-alpha.2`，监控协议 v2 必须成对升级。

### 本轮验证（本地 Node 22.23.2 / DSH 0.2.1-rc.4）

- DS Bot 完整单元测试：1,579 通过，2 跳过，0 失败。
- BotHub 单元测试：10 通过，0 失败。
- 两插件构建、生成文件校验与 lint 通过；DS Bot 保留既有 lint 警告。
- 源文件定向发布扫描包含 44 个文件：本轮新增代码与插件无阻断项；根 README
  已有的 `backup/history` 描述仍触发原有路径规则。该结果不代表全仓库发布扫描通过。
- 工作区保留用户原有修改；没有提交、推送或发布。远程 CI 未运行。
- 现有 host smoke 首轮 51/52 通过；模型首次初始化时出现一次 `ECONNRESET`；
  未增加请求重试。清空隔离测试数据并重启后，完整重跑 **52/52 通过**。
  两轮日志分别保留在 `/tmp/bothub-agents-checks/smoke.log` 和 `smoke-rerun.log`。

### 真实宿主浏览器验收与演示

隔离 Windows Chrome + 环境已有 Playwright（无头兜底），页面来自 Linux DSH
真实宿主，模型为仓库 scripted mock。没有注入生产事件或替换监控 API。

通过：普通 Agent 执行中→空闲、原生 subagent 工具启动、父子选择、子 Agent
运行状态、3D 选择、原生子会话地址和内容确认、结束后不误报运行。
成功验收运行没有浏览器 page error。另一个无录像 context 验证关闭 WebGL
自动退回 2D，以及 390px 下选择子节点没有横向溢出。

首次录制被宿主预览引导遮挡；第二次的精确文本断言未考虑 DSH 附加的父 Agent
说明。修正采集脚本后各自换用新测试根重录。失败录像独立保留，没有拼接。
成功源录像的普通 Agent 首轮期间曾短暂轮询超时；旧快照保留且跳转禁用，随后
自动恢复。宿主延迟的根因尚未定位，本次不宣称全程稳定低延迟。

- 演示代码树：`feat/bothub-mvp` 未提交工作区，HEAD 起点 `ae0ee82`，包含原有修改。
- 测试根：`.dsh-test-bothub-agents`（smoke）、`.dsh-test-bothub-agents-ui`（浏览器），
  都是本轮专用 Linux 临时目录的符号链接，不使用用户 DSH 数据。
- 测试端口 3196/8896、3197/8897；全部已停止，端口无监听。
- 媒体目录：`.playwright-mcp/bothub-agents/demo/`。
- 源视频 `demo.webm` 54.24 秒；GIF `demo.gif` 仅截取子 Agent 演示的
  28–54 秒连续区间，1.5 倍速、12 fps、1200×800、末帧停留 2 秒。
  成品 19.33 秒、3,010,874 字节；已从编码后的 GIF 解码检查顺序和终态。
- `result.json` 为自动断言摘要，`01-agent-running.png` / `02-agent-idle.png`
  留存普通 Agent 状态，`04-child-3d.png` / `05-native-child.png` 留存场景和原生跳转。
- 包：`artifacts/dsh-bothub-0.1.0-alpha.2.tgz`，152,238 字节；相邻 `.sha256`
  保存校验和。包清单已核对，包含许可证、host 与生成的 client，不包含测试数据。
- 媒体、包、所有测试根及失败测试根均被 Git 忽略。

### 后续范围

优先在实际使用中确认 Agent 状态和父子导航，并追踪首次宿主响应变慢的问题。
再按原计划补充公开事件支持的细粒度状态，随后评估 SSE。
直接发送、精确停止、审批快捷操作仍留在后续独立切片。

### alpha.3 后续

用户确认继续后，已开始接入工具活动、回合耗时、审批及问题等待状态，见
[活动状态设计与验收](2026-11-07-dsh-bothub-activity.md)。本文保留 alpha.2 的
范围与验证记录；当前工作区的新增字段仍兼容 v2 监控协议。
