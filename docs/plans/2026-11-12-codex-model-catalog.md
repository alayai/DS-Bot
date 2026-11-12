# Codex 模型目录与 CLI 版本一致性

用户报告：DS Bot 的 Codex 模型菜单只有旧模型，而 Codex 桌面端已有 6.1 Sol 等。

## 已核实根因

Windows PATH 的 npm Codex 是 0.118.0，其公开 model/list 恰好返回截图的六个旧模型。
已安装的 Codex Desktop 附带 CLI 是 0.167.0-alpha.3.2；当前新版 CLI 的公开目录
包含 gpt-6.1-sol、gpt-6-astra、gpt-6-sol、gpt-6-luna、gpt-5.6-sol 等。
不是 UI 写死模型名，也不是这台机器上的分页造成的六模型截断。

## 实施

- 在 Windows 的后台 CLI 发现中，通过系统 Get-AppxPackage 获取官方 Codex Desktop
  的可执行文件候选；比较它与 PATH Codex 的实际 --version，采用较新且可执行的一份。
  路径不可读、未安装、版本探测失败时保留 PATH；其他 CLI 与非 Windows 发现不变。
  不安装或升级全局 CLI，不改变用户 Codex 配置，不从缓存拼造模型名。
- 发现结果的设置页路径、版本、登录探测、model/list 和 thread/start 都使用同一选择。
- Codex model/list 读完 nextCursor 分页，保留服务端名称、顺序、推理档位及模型路由 ID；
  不添加隐藏的内部模型。防止重复 cursor 无限循环；失败不缓存不完整目录。
- 保留按需启动、CLI default、刷新重新探测及权限/会话隔离语义。

## 验证

先补旧 PATH / 新 Desktop、缺失和失败回退、分页、后页模型选中与实际 thread 参数回归。
运行完整单测、生成一致性检查及 lint；Host 变化运行真实 DSH + 仓库 mock 的隔离 smoke。
实机只查询版本和模型目录，不调用真实模型，不读取凭证、不碰用户 DSH 数据。

## 结果

- Windows Node 实测：发现并选择官方 Desktop CLI 0.167.0-alpha.3.2，
  通过 DS Bot 的 Codex 驱动获得 9 个可见模型，包括 6.1 Sol、6 Astra、6 Sol、
  6 Luna、5.6 Sol；未把内部隐藏模型加入列表。检测路径和目录证据在
  `.playwright-mcp/codex-models/verification.json`。
- Codex/本地代理回归 61 通过、1 项 Windows 专用测试跳过；相关目录、模型菜单、
  会话与路由测试另有 59 项通过。Windows 上单跑 CLI 选择回归 4/4。
- DSH 0.2.2-rc.1 + 仓库 mock 的隔离 smoke 52/52。首次从 Windows 挂载盘启动超时；
  Linux 临时目录用相同修复源码重跑通过。测试服务已停止，四个端口已释放。
- 生成一致性与 lint 通过。工作树完整测试 2422 通过、3 跳过、13 失败：
  其中 10 项 Computer / 旧活动测试在恢复修复前源码后复现，另外 3 项群协作 /
  模式切换测试隔离复跑通过。临时副本不满足部分全量测试的仓库布局要求，
  因此未用该副本的全量结果替代工作树结果。
- 未安装或发布。Windows 验证涵盖实际 CLI 发现与目录读取；选中模型发给线程的
  参数由 mock 验证，未在用户正在使用的 DS Bot/Electron 中操作或运行真实模型。
