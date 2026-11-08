# BotHub

[English](README.md) | 中文

独立的 DSH 插件，通过 2D 列表和原创 3D 工作区展示 DS Bot 团队。
选择成员，查看各会话的运行状态，再打开原会话发送消息、停止工作或处理审批。

## MVP 范围

- 搜索团队、按群聊和状态筛选、统计运行数与待处理成员数。
- 同一 Bot 的私聊和群执行分别展示，身份不重复。
- 支持 3D 选中、旋转与缩放，也提供等价的 2D 导航。
- 监控只读；打开 BotHub 不创建 Bot，也不启动模型。
- 尚未收到实时回合的会话显示“尚未观测”，不会假定为空闲。
- 断线保留最后快照并禁用会话跳转；认证失效清空数据。
- 监控只传标识、名称、角色、工具名和状态分类，不传聊天正文、指令、
  文件路径、工具参数或密钥。

已登记的普通 DSH Agent 和本地子 Agent 显示驻留 Agent 的真实运行/空闲状态，
未驻留会话保持“尚未观测”。父子关系来自 DSH 的明确目录，可在详情中选择父成员
或子 Agent，并打开原生子会话。外部子 Agent 无法在本地打开。
每次快照最多读取 64 个目录、发现 64 个子节点、深入 4 层、用时 2 秒，覆盖不完整
时显示提示。监控不会加载或唤醒 Agent。

现已通过公开 DSH 事件和投影观测工具活动、回合起点、等待审批及待回答问题，
并行工具分别结算。timed 问题超时后仍可回答，Agent 也可以继续工作；此时成员
保持待处理提示，但不会把执行误报为暂停。问题和审批正文仍只在原生会话展示。

投影不可用时明确提示细节缺失。插件加载前已经阻塞的旧版提问无法补获实时等待
事件，只能看到仍在执行的提问工具。未驻留会话、历史结果、SSE 补发、场景编辑
和直接执行控制继续后置。

## 要求与安装

本预览版以仓库的 DSH `0.2.1-rc.4` 为基线，需要安装**包含
`src/host/monitor.js` 的 DS Bot 工作区版本**。旧的已发布 DS Bot 会显示
桥接不可用提示。插件不修改 DSH。

1. 使用 Node.js 22.19+，在本目录构建：

   ```sh
   npm ci
   npm run build
   npm test
   npm run lint
   npm run check
   ```

2. 在 DSH 插件管理中安装本地包目录，与兼容的 DS Bot bundle 一同启用。
3. 从 DS Bot 侧栏底部、账户按钮旁的立方体按钮打开 **BotHub**。
   普通 DSH 侧栏也提供 BotHub 面板入口。
   设备无法建立 WebGL 渲染器时，使用 **2D**。
4. 点击成员，再点“打开会话”。群内工作打开群聊，由 DS Bot 原生处理审批
   和成员控制。

这是当前主机中已登录用户的 DS Bot 团队视图，不是多租户监控 API、
模型可调用工具或外部 CLI 收集器。它复用 DSH 认证连接服务和同源请求，
无需新增服务器或端口。

禁用 BotHub 会移除通道、界面与渲染器，不会停止团队。面板可见时每 1.5 秒
获取快照；页面隐藏时不绘图，也不发起新的轮询。3D 最多显示筛选后的 50 位
成员，2D 可查看全部。不使用外部素材或 CDN。

## 隔离开发测试台

使用当前操作系统原生的 Node 和 pnpm，不要让 Linux DSH 进程使用 Windows
创建的包链接。辅助脚本通过公开的已安装 `dsh` CLI 和仓库模拟模型启动：

```sh
# 在仓库根目录执行，选择未占用的端口。
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 \
  sh dsh-bothub/dev/bench.sh bothub-smoke 3196 8896 start

# 现有 host 回归冒烟：
node ds-bot/dev/smoke.mjs bothub-smoke 3196

# 结束时停止测试台进程。
sh dsh-bothub/dev/bench.sh bothub-smoke 3196 8896 stop
```

测试台仅写入 `.dsh-test-bothub-smoke/`。可用 `DSH_CLI` 指定其他已安装的
公开 CLI，不使用用户真实 DSH profile。

在 WSL 中，测试数据目录必须支持仅所有者可读的文件权限。若 Windows 挂载盘
将所有文件报告为 `777`，请在 Linux 文件系统建立新的测试目录，并在**首次
启动前**将 `.dsh-test-bothub-smoke` 符号链接到该目录。不要放宽 DSH 的凭证
权限检查。

在该 mock 测试台中，从团队菜单新增 **DSH Agent**，在其原生会话发送
`BotHub work 10`，再打开 BotHub 观察“执行中 → 空闲”。随后发送
`BotHub delegate 20`，DSH 会真实启动名为 **BotHub review task** 的本地子 Agent。
可在 BotHub 中选择它、查看父成员并打开原生子会话。这些固定命令仅供 mock
测试使用，没有为正式模型增加专用命令。

alpha.3 可发送 `BotHub tool 10` 观察真实的无害 shell 工具；发送 `阻塞提问`，
在 BotHub 确认等待提示后回原生会话回答；再发送 `BotHub approve`，确认等待审批
提示后回原生会话拒绝请求，检查待处理状态清除。

## 开发约定

- `client.js` 从 `src/client/` 生成，不手工修改。
- host 消费由 DS Bot 提供的 version-2 `botMonitor` 服务。
- DS Bot 在自有侧栏底部声明可叠加的 `bot.sidebar.action` 列表槽位，
  配套插件可通过 `slots.inject` 注册入口。
- GET `api/bothub` 返回最小快照。POST 仅接受
  `{ action: "resolve", entityId, sessionId? }`，重新确认导航目标。
- 导航返回 `{ target }`：根会话 ID 或经后端确认的原生地址
  `{ parentSessionId, childSessionId, mode }`。
- 群成员会话映射回群聊。Bot 默认会话在点击时解析到当前段。
- 只有状态、尺寸或镜头变化才绘图；卸载释放几何体、材质、监听器和
  WebGL context。

参见 [MVP 设计](../docs/plans/2026-11-07-dsh-bothub-mvp.md) 和
[完整开发计划](../docs/plans/2026-11-07-dsh-bothub-development-plan.md)。

alpha.2 见 [Agent 切片设计](../docs/plans/2026-11-07-dsh-bothub-agents.md)。

alpha.3 见 [活动状态设计与验收](../docs/plans/2026-11-07-dsh-bothub-activity.md)。
