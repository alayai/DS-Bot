# 新增代码审查与清理

审查基线：`f25bcc2`，重点为最近三次提交的浏览器、定时/周期任务、网络策略和外部备份，并检查相邻生命周期逻辑。

当前 fork 的远端没有 `dev` 分支（fetch 返回 `couldn't find remote ref dev`）；为保留这些尚未合入上游的功能，从当前提交建立 `chore/cua-code-review`。不回退工作区已有的版本和换行改动，不修改 DSH 或用户运行数据。

## 修复前的核验计划

1. 复现人工接管与任务暂停/取消/超时之间的竞争。任务管理不应清除已经授予用户的控制权；接管后旧任务不能继续运行。
2. 检查投递异常、代际切换、周期推进以及浏览器响应失败是否保留未知结果和旧请求隔离。
3. 仅移除确认无用的代码；保留为兼容、校验、隔离和生成产物交付所需的逻辑。
4. 为实际缺陷补充回归测试，运行插件全量测试、生成文件检查、lint、相关 Python/App 测试和隔离 mock Host smoke。真实 Windows GUI/Firefox/容器验收单独标明。

## 初始证据

- 任务和 Computer service 定向测试 110/110 通过。
- 工作区几乎所有文件具有 CRLF 差异；忽略行尾差异后，既有实质变更只有四个 package/package-lock 文件。
- Windows 安装的 esbuild/oxlint 不能直接用于 Linux；测试工具安装在临时目录，避免覆盖原依赖。邻近 DSH checkout 的版本和 peer 包不完整，不能将其产生的测试失败直接认定为项目缺陷。

## 最终结果

### 已复现并修复

| 优先级 | 问题与触发条件 | 修复 |
| --- | --- | --- |
| P1 | 外部备份用 `os.walk` 遍历 home 时，默认静默跳过无法扫描的目录，导致缺文件的备份仍被认定成功。 | 显式传播目录读取异常；在写入备份头前中止，避免生成声称完整的备份。 |
| P1 | 用户接管正在执行队列任务的桌面时，只撤销输入，任务仍为 running，交还控制后旧任务可继续执行。 | 接管前持久中断当前任务、撤销输入并取消匹配回合；恢复仍需核验。 |
| P2 | 人工接管期间暂停/取消任务，或任务 watchdog 超时、用户消息中断任务时，任务清理再次撤销桌面并将 control 设为 none，导致用户的 control token 失效。 | 统一任务尝试的清理；已有 human 控制时仅撤销匹配投递，不销毁人工控制票据。 |

上述问题先通过新增测试复现失败，再修复为通过。覆盖任务 pause/cancel/timeout/interrupt、实际 Computer service 接管与继续使用原 control token、用户消息中断与人工接管并发时迟到的清理，以及备份目录扫描失败。

另用 Linux 非特权 UID 65534 实测备份权限问题：读取 root 可遍历、子目录仅 root 可读的独立 fixture。原代码报告成功且产物缺少子目录内的 `important` 文件；修复后返回 PermissionError，备份输出为 0 字节。该测试不使用容器或用户文件。

### 清理范围

- 删除浏览器 Python 的未使用 `os` 导入、受限浏览器 bootstrap 的未使用 `stat` 导入。
- 移除 XLSX 解析中的 `value = value`，以显式排除错误单元格的条件保留原解析行为。
- 合并三处任务撤销/清理重复逻辑，纠正并不存在 tombstone 的注释。
- 重新生成 `office.js` 和插件内 runtime payload/manifest。`client.js` 校验一致，无需源码行为变更。
- 保留 runtime 的源码/交付副本、兼容分支、归属校验、未知结果隔离和原工作区变更。

### 验证记录

| 检查 | 结果 |
| --- | --- |
| 插件全量 `npm test` | 1561 通过，2 跳过，0 失败 |
| 任务与 Computer service 定向回归 | 新增 3 项 JS 回归测试，包含在全量测试中 |
| Python 全部 `*_test.py` | 26/26 通过 |
| App Computer runtime 打包测试 | 5/5 通过 |
| `npm run build` | 通过 |
| client/office 与 runtime `--check` | 通过 |
| `npm run lint` | 通过；45 条既有警告保留，自赋值警告已消除 |
| 修改文件 diff whitespace 检查 | 通过；按现有 CRLF 设置 `core.whitespace=cr-at-eol` |
| 隔离 mock DSH smoke | 52/52 通过；两个本轮 bench 均已停止，临时团队已删除，四个测试端口已关闭 |

验证使用项目锁定的 npm DSH `0.2.1-rc.4`、oxlint `1.76.0`、esbuild `0.28.2`；工具安装在临时目录。插件和 App 已有 Windows 依赖不被重装。App 测试通过临时 Node resolve hook 读取临时安装的 yaml，无产品代码适配。

最终 smoke 在 Linux 临时目录中的源码快照执行，459 个插件跟踪文件逐字节与最终工作区核对一致；使用 mock 模型，`CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 MOCK_DELAY_MS=20`。此前在 Windows 挂载目录的较慢 smoke 在切换至最终快照后停止，不将其中间结果计入最终通过数。完整最终日志：`/tmp/dsbot-review-smoke-final.log`；单测日志：`/tmp/dsbot-review-tests-final.log`。

审查覆盖本轮新增及相邻关键路径，不等于对整个仓库无缺陷的证明。本轮未重新执行真实 Firefox、Docker/Podman 或 Windows Electron GUI 验收，不发布、不安装插件。

## 分支归属

用户要求将本轮修复合入 `cua/2026-10-31`，后续继续在该分支开发。本轮修复单独提交，再快进合入原分支；工作区已有版本号及换行改动保留为未提交改动。
