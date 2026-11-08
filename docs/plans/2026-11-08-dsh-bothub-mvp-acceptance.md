# BotHub MVP 收尾与候选包验收

## 首版边界

本轮按原计划 P0–P5 收尾。P6 历史分析、P7 空间编辑与外部来源不计入 MVP。
P3 原文允许“无法精确实现的入口交回原生”；首版据此采用逐会话导航，
在原生会话处理停止、审批、回答及普通 Agent 的输入。没有实现或声称原子精确停止。
追加的私有桌面显示包含被动 PNG、待机动画和放大查看；实时视频和远程输入不在
这一候选版承诺内。真实容器与 Electron 的验收单列，不用模拟 provider 代替。

## 短任务结束记录

新增独立的 host-only `dsBotMonitorRecent` Session projection，使用公开
`sessionProjections.register/stateOf`，不修改 DSH。

- 按 `event.seq` 水位拒绝重复和迟到事件；跳过 fork 继承前缀。
- 只配对本会话观察到的 `turn/start` 与相同 turn 的 `turn/end`。
- `reason.kind` 为 completed / aborted / error 时显示对应结果，其余为 unknown。
  idle、连接中断、Agent 卸载和会话换段不产生虚构终态。
- 每会话最多 16 条，只保存 turn、seq、起止时间和结果类别，超限标记 bounded。
  不保存正文、参数、错误详情、文件路径、审批内容。
- 只读取现有驻留 Agent，不为监控加载会话。非驻留或投影不可用时返回 unavailable。
- 记录附在当前授权快照的 session 上；删除 Bot、移除 group session、切换段后，
  不维护另一个可泄漏旧数据的客户端历史缓存。
- 详情在所选群/私聊范围内汇总最多 16 条；不计入当前活动数，不改变角色工作状态。
  点击只定位原会话，不承诺定位具体消息。v2 增量协议兼容旧桥接的缺失字段。

这是有界的最近结束记录，不是 P6 的完整历史。非驻留会话、被轮换的旧段、
超过容量的记录和没收到结束事件的回合仍需原生会话检查。

## 验收方法

1. 两插件完整测试、lint、生成文件一致性检查；host 变更运行 mock smoke。
2. 真正的 npm tarball 安装到新建 `.dsh-test-bothub-mvp-release`，
   通过公开 CLI 启动 DSH `0.2.1-rc.4`，不链接源目录。
3. 使用仓库 mock model 验证短回合结束记录、消息回执、群导航、2D/3D、
   禁用后 Bot 会话可用、旧包回滚再升级。测试不进入用户 profile。
4. 对最终固定包运行一小时三窗口持续检查，再做 50 次场景进出及资源释放断言。
   已有 20/50 席位基准和测试桌面预览证据作为补充，注明构建版本与范围，
   不将其说成新候选的全部平台验收。
5. 包含内容清单、SHA-256、依赖许可及可复制命令随候选交付；不上传或发布。

## 候选包与构建来源

最终交付目录为 `artifacts/bothub-0.1.0-rc.3/`，含两个 npm tarball、各自的
SHA-256 校验文件和逐文件内容清单 `manifest.json`。构建来自
`feat/bothub-mvp`，基线提交 `7c70f49a7efd1d32cf343ef7154760d4a7013f11` 加工作区修改；
不能把这个提交单独当作候选源码。验收以包的 SHA-256 和逐文件比对为准。
DSH 基线 `0.2.1-rc.4`，Cordis `4.0.5`，Three.js `0.182.0`。

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `ds-bot-0.2.16.tgz` | 1155362 | `1c8a0ba8fe070894609955d05eec5a90693fa1121e044945d6feec5b95039958` |
| `dsh-bothub-0.1.0-rc.3.tgz` | 192913 | `1b6c7f4a9ceccd07a9fbb7fb176e9c36e1062195fa9dc26c9d590006772332c6` |

DS Bot 版本仍为 `0.2.16`，仅看版本号不能区分旧发布版和配套桥接版本。
**必须安装本目录中的两份包**，先更新 DS Bot，再更新 BotHub，随后重启宿主。
不要同时启用重复的 DS Bot bundle，也不要删除原有团队、会话或消息回执账本。

最终 BotHub `client.js` SHA-256 为
`d64cfef52bd3dfcd5dc1030501fa3e3369c181aa943f086c0dc66751e88d8c8b`。
三个隔离环境安装后分别比对了 DS Bot 151 个文件、BotHub 15 个文件，全部与
最终 tarball 一致；这些安装目录不是指向源目录的链接。包清单检查排除了测试目录、
开发依赖、DSH 数据和环境文件；必需的入口、manifest、客户端、许可证与 NOTICE 齐全。
打包脚本拒绝覆盖已有候选目录。逐文件比对结果见 `install-verified.json`。

## 本轮新增与修复

- DS Bot 增加上述最近结束记录投影，补足两次监控采样之间已经结束的短回合。
  BotHub 按当前私聊或群房间展示完成、停止、失败及结果未知，保持与活动数分离。
- 最近记录默认折叠，避免挤走快捷输入。rc.2 的实际 Electron 验收发现活动列表
  变化会重新挂载并收起展开项；rc.3 给记录区固定 key，验证展开状态在真实回合
  开始和结束后均保留。
- 增加 100 Run、20 轮各 10000 次通知的合成协议压力验收，以及 10000 回合
  结束投影边界测试。验证合并、收敛、重复帧、删除、容量上限与定时器释放。
- 固定候选依赖范围，增加成对打包和校验清单、真实 tarball 测试台及专用
  BotHub smoke；补全中英文安装、升级、禁用、回滚和能力限制说明。

本轮候选的 DS Bot 还包含工作区已有的桌面错误诊断改动。rc.1 与 rc.2 的 DS Bot
包相同，rc.3 的 `client.js` 和 `src/host/computer/service.js` 已变化，因此最终包
另外执行完整检查，不将旧包的 smoke 结果直接归到新包。

## 自动化与真实宿主结果

- BotHub：**95/95 通过**，生成文件一致性和 lint 通过（0 警告、0 错误）。
- 最终配套 DS Bot：**1609 通过、2 跳过、0 失败**，生成文件一致性和 lint 通过。
  两项跳过是 Linux 上不适用的 Windows 文件占用测试；DS Bot lint 保留既有警告。
- 最终两个 rc.3 配套包在新建测试台完整 host smoke **52/52 通过**；
  随后的 BotHub full smoke **7 项通过**。日志为 `/tmp/bothub-mvp-final-smoke.log`
  和 `/tmp/bothub-mvp-final-hub-smoke.log`，副本保存为下述证据目录中的
  `final-host-smoke.log` 和 `final-hub-smoke.json`。最终测试台及 mock 已停止。

测试日志为 `/tmp/bothub-mvp-final-ds-tests.log`、`/tmp/bothub-mvp-rc3-tests.log`、
`/tmp/bothub-mvp-final-*-check.log`、`/tmp/bothub-mvp-final-*-lint.log`。
本报告下文所称 JSON/截图，除另注明外均位于
`.playwright-mcp/bothub-mvp-release/`；它们为本地忽略文件，没有公开发布。

真实 BotHub API 集成覆盖：未认证返回 401；单独读取快照不新增模型调用；相同
commandId 并发发送返回相同的 accepted 回执；原生会话中只有一条对应的用户消息；
当前回执对应会话的短回合获得真实 completed 结束记录；同一 ID 换正文返回 409。
受理回执不是任务完成结果。

真实原生控制验收：让同一 Chief 同时在群和私聊工作，从 BotHub 的群执行入口
进入原生群详情，停止该成员的群工作后，私聊仍保持运行；再从私聊执行入口进入
原生会话停止，投影收到 aborted。导航不自行取消任务，没有声称实现缺少上游
原子 expected-run 前置条件的精确停止 API。证据：`native-stop.json`。

浏览器交互还覆盖中文多行 Enter 不误发送、切换成员保留草稿、真实快捷发送与
会话导航、桌面待机/Escape 焦点恢复、实际 `WEBGL_lose_context` 后可用的 2D 降级、
恶意名称按文本显示和 390px 宽度无横向溢出。运行期间页面异常为 0。
相关证据为 `ui.json`、`rc2-ui/ui.json` 及对应截图；这是各候选的分项证据，
最终 rc.3 再通过 Electron、演示和持续运行检查。

## 安装生命周期与桌面端

隔离环境按以下顺序验证：首次安装 rc.1 两包 → 禁用 BotHub 并重启 → 升级 rc.2 →
回滚已有 alpha.6 → 再升级 rc.2 → 升级最终 rc.3。
禁用时 BotHub 路由为 404，DS Bot 原生频道仍可用；恢复时 accepted 消息回执仍可查询，
Bot ID、群 ID 和工作区 ID 保留。重启/回滚采用公开 profile 配置，不修改 DSH。
这项证据证明重启后的安装生命周期，不证明运行中热重载可以保留打开的面板。

最终 rc.3 在真实 Windows Electron **源码应用**中通过：独立 profile 启动真实
DSH、3D 展示、快捷消息受理、最近结束记录展开状态跨回合变化保留、桌面待机窗口
及 Escape、原生会话导航。页面异常为 0，证据为 `electron.json`。
测试复制本仓库 app 源码并使用现有 Electron 依赖，装入候选包文件；
`DS_BOT_HOME`、shell 数据与工作区均为一次性目录，没有导入或操作用户数据。
这不是已签名安装器、自动更新通道或 macOS/Linux Electron 的认证。

## 一小时三窗口持续运行

最终 rc.3 **通过**：60 次定期采样，测量期约 3656 秒；
包含收尾的 50 次 2D/3D 往返和资源检查，总时长 **3748.573 秒**。
Windows Chrome、真实 Linux/WSL DSH Web、3 个 Bot、2 个群房间、Lively 动效。
一个窗口从头到尾不重载；另外两个分别进行 3 次刷新和 3 次关闭后重建。
另有 3 轮全部窗口断网/恢复，均自动回到已连接。

每次采样主动 GC 后通过 CDP 读取 JS heap。字节数如下；峰值为一分钟采样峰值，
不是操作系统或 GPU 的内存峰值。

| 窗口 | 开始 heap | 持续采样结束 heap | 采样峰值 heap | 场景切换并退出 3D 后 heap |
|---|---:|---:|---:|---:|
| 1 | 33147136 | 34736504 | 34850300 | 36807536 |
| 2 | 33056076 | 34332692 | 34758532 | 32516172 |
| 3 | 32761372 | 33874348 | 34379648 | 31999640 |

未重载的第一窗口，持续采样结束较基线增长 **1.52 MiB**；
50 次场景往返并退出 3D 后较基线增长 **3.49 MiB**。
另外两个窗口经历文档重建，不能用其前后差值证明同一文档的持续泄漏情况。
三个窗口的结束及清理后 heap 均低于基线 +16 MiB 检查阈值。

全部采样中每个窗口保持 **1 个跟踪 context / 10 个跟踪纹理**；
50 次场景往返后，三个窗口退出 3D 的跟踪 context/纹理均为 **0 / 0**。
页面异常 **0**，最终 Hub tarball 校验和未变，运行前后 mock 记录均为 **3 条**，
均来自准备团队；持续被动监控没有新增模型调用。

证据：`soak-final.json`、`soak-final.mjs` 和 `/tmp/bothub-mvp-soak-final.log`。
这是小团队的一小时真实运行，不能替代 100 个真实模型并发、全平台、真实容器
或长期生产负载验收；100 Run 为独立的合成协议测试。
持续测试的浏览器和测试台已停止，3197 / 8897 已释放。

## 界面演示

最终候选的连续录制：
`.playwright-mcp/bothub-mvp-release/demo-final/demo.gif`。
1080 × 720、10 fps、220 帧、22 秒、3399504 字节。
内容为办公室 → 选择 Chief → 发送 `BotHub work 8` → 原生结果 → 最近结束记录 →
待机预览 → 办公室。真实已安装 rc.3、真实 DSH Web、仓库 scripted mock model；
没有拦截 transport 或注入合成监控状态，也不代表真实模型能力。

使用独立 Chrome context。遵循仓库 mock-only 要求，优先于录制 skill 的真实模型建议。
源 WebM 保留；取同一次录制中 11.2–31.2 秒连续区间，1× 速度，最后一帧停留 2 秒。
源视频和最终 GIF 的解码代表帧均已检查，没有拼接不同运行。
构建身份以本报告中最终 Hub 包及 client 校验和为准。

## 可重复命令

从仓库根目录执行，使用本机可用的 Node.js 和 pnpm。示例仅用于新建的隔离测试环境；
先确认端口未占用。WSL 下测试目录需要支持 owner-only 权限，必要时先将这个
全新的 `.dsh-test-bothub-candidate` 链接到 Linux 文件系统；不放宽凭证文件权限。

```sh
# 单元测试和生成文件/lint 检查。
(cd ds-bot && npm test && node scripts/build-client.mjs --check && npm run lint)
(cd dsh-bothub && npm test && npm run check && npm run lint)

# 生成一个新的候选目录；已存在时拒绝覆盖。
(cd dsh-bothub && npm run candidate -- ../artifacts/bothub-local-review)

# 安装已经验收的最终包到独立 profile。
export BENCH_BOT_PACKAGE="$PWD/artifacts/bothub-0.1.0-rc.3/ds-bot-0.2.16.tgz"
export BENCH_HUB_PACKAGE="$PWD/artifacts/bothub-0.1.0-rc.3/dsh-bothub-0.1.0-rc.3.tgz"
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 \
  sh dsh-bothub/dev/bench.sh bothub-candidate 3196 8896 reset
node ds-bot/dev/smoke.mjs bothub-candidate 3196
node dsh-bothub/dev/smoke-bothub.mjs bothub-candidate 3196 full
sh dsh-bothub/dev/bench.sh bothub-candidate 3196 8896 stop
```

`reset` 会重置示例测试台，不能用于用户的真实 DSH 数据目录。
升级或回滚时更换 `BENCH_HUB_PACKAGE` 后使用 `start`，不要用 reset；
`recover` 模式检查先前 full 模式写入的 accepted 回执。
禁用测试需要先停止测试台，在该测试 profile 的 bundles 列表移除 BotHub，
再以 `DSH_CLI="$PWD/ds-bot/dev/harness/node_modules/.bin/dsh"` 和已导出的
`BENCH_BOT_PACKAGE` 调用 `ds-bot/dev/bench.sh`，启动保留的 profile；
用 Hub bench 启动会重新启用它。
`disabled` 模式检查路由消失且 DS Bot 仍可访问。

## 已知限制与未通过的尝试

- Docker daemon 及 Windows Docker Desktop Linux Engine 命名管道不可连接；
  真实私有桌面容器画面仍未端到端验收。已有真实 Computer service + 测试 provider
  证据证明采集协调/清理，不能代替容器启动和实际截图链路。
- 先前 rc.1 持续运行在约第 9 分钟等待 BotHub 连接状态超时，当时另一个测试 DSH
  正在重启。此前资源计数稳定、没有页面异常，但根因尚未确定，不能宣称已修复。
  失败记录保留；最终复验只保留一个测试宿主并冻结构建。
- rc.2 集成脚本曾通过被截短的 mock 日志搜索 command 文本，误报模型请求计数为 0。
  原生会话中消息实际存在；脚本改为检查唯一持久用户消息及本次会话的真实结束事件，
  复跑通过。这是测试观测方法的修正，不是生产发送逻辑修复。
- 完整历史、非驻留会话推断、直接原子取消、嵌入式审批、视频流及远程输入不在本候选承诺内。
- 运行中插件热重载保留面板、其他宿主版本/浏览器/操作系统和真实用户小范围试用尚未完成。
  候选没有发布到 npm 或远端，也没有安装到用户真实 profile。

## 进度

固定阶段权重不变，本轮后 P0/P1/P2/P3/P4/P5 分别估计为
95% / 95% / 100% / 95% / 90% / 95%。MVP 加权 **95.5%（约 96%）**，
完整计划 **66.85%（约 67%）**；这是约 ±5 个百分点的工程估计，不是工时实测。

首版功能已形成候选，未验收项仍单列，不声称 100%。P3 按原计划的原生降级
控制验收；P6/P7 尚未启动。正式台账见
[开发进度](2026-11-08-dsh-bothub-progress.md)。
