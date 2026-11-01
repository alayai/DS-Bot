# CUA Podman adapter 与固定镜像交付

日期：2026-11-01。续接 2026-10-31 一键准备计划 D/E。

## 本轮实现

- 首次准备可显式选择 Docker 或实验性 Podman。检查状态不保存选择、不创建虚机；
  开始准备后持久记录选择，已有选择不可通过 UI 或 API 静默切换。
- Windows Podman 从 `machine list/inspect` 获取本地 machine；仅接受 rootful、
  Linux x64、cgroup v2。SSH 连接固定到 inspect 对应的 `root@127.0.0.1:port`、
  `/run/podman/podman.sock` 和 identity 路径，不读取或输出 SSH 私钥。
- 保存 machine 名称、创建时间、连接参数和由 hostname/store 元数据形成的身份。
  metadata 或存储位置不符时拒绝使用。此身份不能证明人为重置后的数据库内容相同；
  原有 Computer/volume/image 归属校验继续执行。
- Linux Podman 仅接受 rootful 本地 Unix socket，要求先启动 service。
- CLI、MCP、文件、checkpoint/helper 都使用同一固定连接参数和最小环境变量集。
  不继承 `CONTAINER_HOST` / `CONTAINER_SSHKEY` 等可覆盖连接的运行环境。
- Podman inspect 仅规范化 image ID、CPU quota/period、capability 大小写、
  no-new-privileges 的 true 表达形式以及空的 restart policy；不填补缺失安全属性。
  create 使用受限大小的 k8s-file 日志，不传不兼容的 Docker max-file 参数。
- Windows 用户可显式点击准备 Podman machine：创建或启动固定名称 `ds-bot` 的
  rootful machine。不会删除/重建已保存 machine，不修改默认 connection，不安装
  系统组件，不强制重启，也不在取消时停止其他用户可能使用的 machine。
- machine 准备纳入持久任务与取消流程；Host 重启后标为 interrupted，用户重试时
  重新检查实际环境。系统要求重启时仍由用户完成，然后重新打开 DSH 重试。

## 预构建镜像交付

新增手动 workflow `Computer image candidate`：

1. 校验固定 recipe，构建 Linux amd64 镜像，核对实际 image ID。
2. 用真实桌面 smoke 检查截图、文件、checkpoint 和停止/再启动。
3. 生成 guest package inventory。
4. 只有 dispatch 明确选择 publish 才登录 GHCR 并推送候选镜像。
5. 输出 digest 与 commit 的候选记录，不自动编辑插件 lock 或宣称正式发行。

`runtime.lock.json` 支持可选 `publishedImage`，只接受 GHCR 上固定 SHA-256 digest。
可信发行包填写通过验收的 digest 后，setup 使用持久任务拉取该镜像，随后执行原有
image ID、driver、protocol、platform 和 user 校验。当前 lock 不含虚构发行地址；
没有发布任何镜像，用户路径仍构建固定 recipe。

## 验证边界

新增测试覆盖远程端点拒绝、machine 身份变化、存储变更、rootless/cgroup 不兼容、
固定 argv、原环境变量隔离、边界归一化、专用 machine 生命周期及引擎选择持久化。
保留原生 Windows Docker 和 DSH→Broker→实际 guest 的回归，防止新 adapter 破坏旧路径。

本机没有 Podman，因此 adapter/machine 功能仍标为实验性。不能以 fixture 通过代替
Windows Podman 的实际创建、输入、备份/恢复和重启验收。测试脚本已支持
`--engine=podman`；`--prepare-runtime` 仅在操作者明确要准备专用 machine 时传入。
首次无缓存准备、Windows GUI、签名安装器、自动系统组件安装以及实际 OCI 发布
仍是未完成项。最终测试计数和例外写入 `computer-runtime/VALIDATION.md`。

## 核对依据

- Podman 官方安装文档：https://podman.io/docs/installation
- machine inspect：https://docs.podman.io/en/stable/markdown/podman-machine-inspect.1.html
- machine start：https://docs.podman.io/en/stable/markdown/podman-machine-start.1.html

按官方 CLI 接口原创实现，没有复制 OpenMausBot 或 Podman 的业务代码。


补充：20 文件的受控 payload 在构建时统一为 LF，生成目录禁用 Git 自动换行转换；
manifest 仍校验真实发行字节，不能在运行时通过规范化来放过被修改文件。源码与生成
文件校验也使用同一规范化规则，避免 Windows checkout 导致假校验失败。
现有 pinned image 保留原 recipe 记录，不因插件升级被标成新 recipe 构建的镜像。

## 后续：候选验收与发行导入

预构建镜像交付继续补齐以下流程，不自动发布或修改用户已有桌面：

1. 构建 job 输出 image ID、真实桌面 smoke 的结构化结果和 CycloneDX 清单。
   smoke 覆盖截图、文件往返、checkpoint、停止与重新启动，清理成功后才写成功记录。
2. 显式 publish 之后，独立 runner 使用空 Docker 配置匿名拉取固定 digest。
   私有镜像、失效权限或错误 digest 不生成可导入候选；不自动修改 GHCR 包可见性。
3. 候选绑定仓库、完整 commit、recipe、image ID、registry digest 及四份证据的
   SHA-256。生成时要求构建/运行时源码已跟踪且干净，禁止用未提交源码冒充旧 commit。
4. `computer-image-release.mjs verify` 只读检查；`promote` 要求操作者明确提供
   预期仓库及 commit，再检查证据、当前配方、镜像 user/platform/protocol/driver。
   全部匹配后原子替换源码 lock；不提交、不推送，不触碰任何 DSH 数据或容器。
5. 发行 lock 增加 `publishedImageId` 与 `publishedImageRecipe`。首次准备除了 digest
   拉取与原有运行时检查，还核对本地 ID。旧安装继续使用原来的 pinned image。
   无 `publishedImage` 仍使用本地构建；拉取失败不会暗中改用另一配方构建。

recipe 对 LF/CRLF 归一化，包含除发行字段外的 lock 与 Dockerfile、requirements、
launch 的内容；不包含发行 digest 自身，避免循环。新发布元数据不改变已有 home。

候选 JSON 和 SHA-256 是一致性检查，不是独立签名或来源证明。只接受本仓库
可信 workflow run 的 artifact，并由操作者核对其 commit；未知来源的文件不能
因本地 verify 通过就视作可信。真实 OCI 发布、GHCR 公开可见性及首次无缓存下载
仍须实际执行验证，不能把本地 fixture 或缓存 smoke 当作完成。
