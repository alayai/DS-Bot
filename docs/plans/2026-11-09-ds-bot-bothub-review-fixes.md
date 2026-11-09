# DS Bot / BotHub 审查问题修复

日期：2026-11-09。用户要求修复本轮审查发现的全部三项问题。
在现有 `feat/bothub-mvp` 开发分支继续，保留工作树已有改动。

## 范围与实现

1. DS Bot 按公开 `tool/result.data.message.toolCallId` 配对结束工具。
   回归工具结束后恢复 thinking、并行调用只移除已结束的一项、PTC 混合调用。
   监控快照和角色活动都不能继续显示已完成的工具。
2. BotHub 删除空闲且正文为空的草稿记录，使 64 个目标的容量可复用。
   不淘汰非空草稿，不解除 submitting / unknown 命令的锁定，不自动重发。
3. BotHub 会话和消息回执入口统一通过公开 `sessions.list` / `sessions.refresh`
   等待客户端认识 Host 已解析的字符串 Session ID，再调用 `uiWorkspace.openSession`。
   已知会话立即打开；原生子 Agent 地址直接保留，不能错误等待顶层列表。
   等待有界，后来的导航、外部会话切换和插件卸载清理旧等待，避免迟到跳转。
   同时覆盖 Host resolve 未返回时发生的新导航。

不改变已决定的消息去重、unknown 回执、群发送范围和监控权限；不修改 DSH，
不读取用户 DSH 数据，不安装、发布或提交其他工作树改动。

## 验证

- 先添加能暴露三项缺陷的回归，再运行针对性测试。
- 重新生成 BotHub `client.js`，执行两插件完整测试、生成一致性检查和 lint。
- Host 改动运行仓库 mock + 真实 DSH 的隔离 smoke；新建专用
  `.dsh-test-review-fixes`，使用空闲端口，最终停止本轮启动的进程。
- 记录实际结果和未验收边界；自动化 mock 验证不等于用户 Windows / Electron
  或真实模型服务验收。

## 验证记录

- 三项已实现；新增工具活动、草稿容量、导航等待及生成客户端入口回归。
  修复前工具活动三项失败，容量回归失败；未重建的原 BotHub 客户端在
  新入口回归中因打开未知 Session 失败。修复并重建后均通过。
- 既有 `group-status` / `group-work` 中 17 处模拟工具结果原先使用错误的
  顶层 callId，已统一为公开 message.toolCallId；针对性 62/62 通过。
- DS Bot 完整测试：1612 通过、2 跳过、0 失败；BotHub：119/119 通过。
  BotHub build / check / lint、DS Bot 生成一致性检查 / lint 均通过；
  DS Bot 原有 lint 警告保留。
- 隔离真实 DSH + 仓库 mock：`dev/smoke.mjs review-fixes 3218`
  全部 52 步通过，未使用真实模型凭证或用户数据。
  测试台 web / mock 已停止，3218 / 8918 端口已确认无监听。
- 本地诊断日志：`/tmp/dsbot-review-fixes-{tests,targeted,smoke,lint}.log`、
  `/tmp/bothub-review-fixes-{tests,lint}.log`；生成客户端包含本轮修复。
  容量与客户端列表延迟采用自动化 fixture / 打包客户端回归，未进行本轮
  Windows / Electron、真实模型或浏览器人工验收。
- 本轮仅交付源码、生成客户端与验证记录；未安装、发布或提交。
