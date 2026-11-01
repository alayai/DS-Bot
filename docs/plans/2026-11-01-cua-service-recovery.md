# CUA 桌面服务恢复

优先级 1：在插件面板恢复原生 Broker 连接，不要求日常故障都重启 DSH。
沿用原有 Host/Broker 边界，不修改 DSH。

## 用户流程

桌面面板新增“恢复桌面服务”。确认说明：同一个 Host 的所有受管桌面都会停止，
持久 home、checkpoint 和历史操作记录保留；恢复完成后手动启动需要的桌面。
恢复不重放输入、文件操作或聊天 continuation，也不自动继续 Bot。

恢复作为 Host 后台任务运行，状态接口报告阶段和已检查桌面数。
关闭或重新打开面板不重复任务。确认绑定服务实例的恢复版本；
重复请求、旧窗口确认、正在进行的管理操作和只读 Host 都不能再次启动恢复。

## 恢复顺序

1. 同步关闭新操作入口，撤销内存中的 frame、lease、human token 和 viewer。
2. 取消并等待正在进行的普通操作落定；等待有界，未落定则失败，不能启动新 Broker。
   先持久化 humanPaused，以便恢复途中 Host 崩溃后仍保持暂停。
3. 等待旧 Broker 确认退出，才允许重开原来固定的入口和引擎配置。
   不因普通状态轮询而自动重连；不强杀仍未退出的进程后宣称交接完成。
   Broker 回执包含连接与引擎身份摘要，恢复握手必须与 Host 之前收到的一致；
   默认 Docker context 被切换时，在派发任何桌面操作前拒绝，不把另一套环境当成恢复成功。
4. 使用原有归属、镜像和 volume 校验逐一 revoke、stop、reconcile lifecycle journal，
   再确认停止。失败不跳过目标后宣布成功，不删除持久 home 或 checkpoint。
5. 保留已完成/unknown 回执，pending 转 unknown。成功后推进 generation，
   取消旧待恢复 handoff，清掉 humanPaused；桌面保持 stopped，等待显式 Start。

运行或失败阶段禁止普通 CUA 操作，状态读取和恢复重试保持可用。
退出 Host 时取消恢复，等待后台任务落定，再走原有 shutdown。

## 支持边界

首批支持原生 Node/Electron 启动的 Broker（包括 Windows 原生 Docker）。
旧 WSL stdio 桥接只能证明宿主 wsl.exe 退出，不能据此证明 Linux Broker 已退出；
该路径继续提示重启 DSH，不提供虚假的原生进程交接保证。
不提供系统引擎重启、虚机重建、重新安装或镜像下载。
若 Broker 在启动/停止/备份/还原等生命周期操作回执返回前异常退出，可能留下
宿主侧引擎 helper，不能把普通断线恢复当作这些操作已落定。该情况拒绝原位重连，
要求重启 DSH 并检查原有生命周期恢复；只有旧 Broker 正常 drain 并退出时才解除
这项限制。普通输入回执仍按 unknown 保留，恢复不得重放。

## 验证

- Host：跨 Bot 撤销、全局互斥、取消/unknown、不重放、失败保持阻断、旧确认拒绝。
- Provider：普通轮询不重连；旧进程退出前不启动第二个；旧事件不污染新连接。
- UI：确认、取消、后台进度、跨窗口旧确认、成功后显式启动。
- 真实 Broker/guest：两个专用桌面写入不同 marker，终止测试 Broker 后从真实面板
  恢复，确认旧流关闭、桌面停止，再启动读取原文件；不操作用户容器。
- 全量单测、lint、生成文件校验和隔离 mock smoke；Windows GUI 由用户验收。
