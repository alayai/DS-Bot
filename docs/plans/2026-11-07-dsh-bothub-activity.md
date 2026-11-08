# BotHub alpha.3：Agent 等待状态与工具活动

## 本轮范围

承接 alpha.2，补充普通 Agent / 本地子 Agent 的工具活动、回合起点与耗时、
等待审批和待回答问题。仍使用 1.5 秒快照轮询，所有执行和回答操作仍在原生会话。
不改 DSH，不读取安装内部文件作为运行时依赖，不为监控加载 Agent。

## 公开契约与状态语义

- 运行/空闲仍以 `agents.get(id).status` 为准；非驻留会话保持未知。
- 注册 host-only `dsBotMonitorActivity` Session projection，纯函数折叠公开的
  `turn/start`、`turn/end`、`tool/call`、`tool/result`、PTC 子调用和
  `approval/asked` / `approval/decided`。框架负责水位与缓存，不每次遍历日志。
  跳过 fork 继承前缀；新回合和回合结束清空未完成活动；未驻留或已空闲时不把
  历史 open turn / approval 当作当前运行。
- 每会话最多保留 128 个未完成工具和 128 个审批标识，溢出显示覆盖不完整；
  仅保留配对标识、受限工具名、turn 和时间，不保存参数、正文或审批理由。
- 阻塞提问通过公开 `user-questions/request` waterfall 透明观察：只记录实际 Agent
  实例和等待 token，原样调用 next、返回其答案或错误。取消、结束、插件卸载
  清理观察；不读取题目，不代答，不改变请求取消语义。
- 可继续执行的 timed questions 读取公开 `userQuestions` projection。
  `continued` 意味着仍可回答，不等于 Agent 阻塞；成员可同时“待回答”和执行工具。
  普通阻塞提问在插件热加载前已经开始时，无法补获 request 事件；此时只显示
  仍在执行的提问工具，不编造其等待状态。原生会话是完整状态来源。
- projection 不可用、读取异常或超限时只降级细节，保留 registry 的真实运行状态；
  给出明确的细节覆盖提示，不泄露异常内容。

## 接口与展示

保持 v2 兼容协议，新增 session 的 detailState（observed/partial/unavailable）
和 pendingInput（open/continued/null）；run 增加 tools（去重的受限工具名列表）。
旧的 tool 字段保留为首个工具，便于 alpha.2 客户端继续读取。

详情优先显示等待审批/等待回答，另列工具名；并行工具不会因一个结果返回就全部
消失。timed continued 问题显示“有待回答的问题”，不错误显示执行已暂停。
无开始时间时不显示时长，不把注册状态 running 自动称作“思考中”。
2D/3D 与筛选仍共享同一状态模型，不增加审批或发送控制。

## 验收与交付

- 纯折叠、继承隔离、并行工具配对、审批取消、边界上限、缺失能力与异常降级。
- live question 观察保持结果/错误/取消语义，多请求和 Agent 实例重建不串状态，
  卸载释放监听。timed continued + active 工具保持 attention，但 run 不伪装阻塞。
- DS Bot 和 BotHub 的完整测试、构建、生成一致性、lint；真实 DSH + mock smoke。
- 原生提问/审批实际 UI 往返和工具执行，记录轮询延迟，不改变既有超时掩盖问题。
- 本地 alpha.3 包、设计及验收记录、真实宿主演示；保留工作区原有修改，不发布。

## 实现与验收记录（2026-11-07）

本轮已完成上述切片，版本为 `0.1.0-alpha.3`。`monitor-activity.js` 提供活动
投影、透明提问观察及统一读取逻辑，普通 Agent 和本地子 Agent 共用适配器。
客户端保留 v2 协议，展示工具列表、真实回合起点、等待原因和覆盖提示。
DS Bot 与 BotHub 的生成客户端均已重新构建；中英文 README 同步更新。

### 自动验证

| 检查 | 结果 |
| --- | --- |
| DS Bot 完整单元测试 | 1588 通过，2 跳过，0 失败 |
| BotHub 单元测试 | 11 通过，0 失败 |
| 两个插件 build / 生成一致性检查 / lint | 全部通过；DS Bot 保留既有 lint warnings |
| 第一次 host smoke | 51/52；首次选择模型后的 state 请求 ECONNRESET，耗时 14618 ms |
| 清理测试数据并重启后的 host smoke | 52/52 |
| 浏览器活动往返 | 工具执行、阻塞提问及原生回答、审批及原生拒绝、清除等待状态均通过 |

新增单元测试覆盖并行 native/PTC 工具、审批配对、继承前缀、回合隔离、
投影上限和降级、问答结果/错误/取消语义、实例隔离及卸载清理。
timed `continued` 问题与工具同时执行的语义已单测；本轮浏览器使用宿主默认的
旧版阻塞提问，未声称验证 timed 问题的真实 UI。

浏览器无 page error。52 次直接快照探测中最长为 1081 ms，包含场景准备；
这只是本次本地样本，不代表延迟承诺。冷启动连接重置的根因仍未定位，
没有增加重试或放宽超时来隐藏失败。验收日志保存在
`/tmp/bothub-activity-checks/`，包括 `ds.log`、`hub.log`、`smoke.log`、
`smoke-rerun.log` 和 `browser-final.log`。未运行远端 CI。

### 演示证据

- 代码来源：当前 `feat/bothub-mvp` 工作树，基点 `ae0ee82`，含未提交修改；
  不将它表述为该提交的干净构建，也未混入其他工作树的产物。
- 使用隔离的真实 DSH `0.2.1-rc.4` 服务和仓库 scripted mock LLM；
  按仓库硬规则未使用真实模型凭证或用户 DSH 数据。录制前完成一次 Agent
  预热回合。工具、原生提问和审批链路实际执行，并未注入合成监控状态。
- 使用环境已有 Playwright 启动隔离 Chrome 录制，无新增仓库浏览器依赖。
  连续视频来自一次成功运行；失败诊断帧保存在单独目录，未拼接。
- 原始视频：`.playwright-mcp/bothub-activity/demo/demo.webm`，
  1440 × 960，25.08 秒，1,832,798 字节。
- GIF：`.playwright-mcp/bothub-activity/demo/demo.gif`，
  保留原视频 0–25.08 秒，1 倍速，追加 2 秒收尾定格；
  1200 × 800、12 fps、325 帧、27.08 秒、5,131,865 字节。
  已检查源视频接触表及从最终 GIF 解码出的代表帧，确认场景顺序、等待提示、
  原生往返和最终空闲状态。未发布到远端。
- 同目录 `result.json` 保存断言和探测结果；`01-tool.png`、
  `02-question-3d.png`、`03-approval.png`、`04-idle.png` 保存关键状态。

### 本地产物与清理

本地包：`artifacts/dsh-bothub-0.1.0-alpha.3.tgz`，153,128 字节；
SHA-256 为 `cc276b6717801400cfb230da3c802e93835bf759e9b02b8325328de8112aa061`，
同目录附 `.tgz.sha256`。已核对包内版本、生成客户端字节一致性和 13 个发布文件，
没有打入 node_modules、测试数据或演示媒体。此包仍需要本工作区包含监控桥接的
DS Bot，不能只搭配旧的已发布 DS Bot。

测试台使用 `.dsh-test-bothub-activity`（3196/8896）和
`.dsh-test-bothub-activity-ui`（3197/8897），均为独立 Linux 临时数据根的链接。
两个台架均已停止，四个端口已释放。包、录像和测试数据保留在 ignored 路径。
本轮未提交、推送、发布或修改用户真实 DSH 配置。

下一切片优先定位冷启动连接重置，并验证更多 Agent 生命周期边界；
SSE、历史回放和直接执行控制仍按 MVP 计划后置。
