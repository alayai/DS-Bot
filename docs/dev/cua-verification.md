# CUA 回归与流式桌面性能验证

本页只使用独立测试 home、mock 模型和自动清理的测试容器。Windows GUI、原生输入法、
真实视觉模型质量和签名安装器仍需分别验收。

## 通用 Bot 回归

在 WSL 中，把 DSH 测试依赖装在 Linux 文件系统上，再通过已有的
`DSH_HARNESS` 和 `DSH_CLI` 入口运行。源码可以留在 Windows 挂载目录。
不要替换 Windows 正在使用的 `node_modules`，也不要测试用户的 DSH profile。

依赖版本以 `ds-bot/dev/harness/package.json` 为准。可在新的 Linux 临时目录
复制该文件并运行 `npm install`，然后把 `DSH_HARNESS` 指向该目录；做 A/B
性能对照时，还应固定并核对全部传递依赖版本，不能只核对顶层 DSH 版本。
测试 home 同样应位于 Linux 文件系统，以免 credential 文件权限被挂载选项改变。
保留 `.dsh-test-<name>` 作为指向该临时 home 的专用链接，让 bench 和 smoke 读取
同一份测试数据。

从仓库根目录运行，`<linux-harness>` 须替换成已准备的独立目录：

```sh
export DSH_HARNESS=<linux-harness>
export DSH_CLI="$DSH_HARNESS/node_modules/.bin/dsh"
export NODE_OPTIONS="--import $(pwd)/ds-bot/test/harness-resolve.mjs"
CUA_BENCH_HOME="$(mktemp -d /tmp/dsbot-cua-check.XXXXXX)"
ln -s "$CUA_BENCH_HOME" .dsh-test-cua-check
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 \
  ds-bot/dev/bench.sh cua-check 3199 8899 reset
node ds-bot/dev/smoke.mjs cua-check 3199
ds-bot/dev/bench.sh cua-check 3199 8899 stop
```

先确认端口空闲。即使测试失败也要执行 stop，然后只移除本次创建的 home 和链接。
`reset` 会清空该名称的测试数据，不要复用其他人的 bench 名称。

### 连接重置诊断

需要调查时，在启动 bench 和 smoke 前增加：

```sh
export DS_BOT_HTTP_DIAGNOSTICS=/tmp/dsbot-http
export NODE_OPTIONS="$NODE_OPTIONS --import $(pwd)/ds-bot/dev/http-diagnostics.mjs"
```

每个进程写自己的 `/tmp/dsbot-http-<pid>.jsonl`。记录范围是：

- Bot 与 Computer viewer 路由的请求开始、响应结束和耗时；
- socket 结束/关闭、服务端 timeout 数值、客户端错误码；
- 超过一秒的事件循环阻塞。

不读取或记录 header、cookie、URL query、请求/响应正文，也不监听 `timeout`
事件：给 Node socket 添加该监听会改变默认销毁行为，从而干扰复现。
日志写入失败不会改变 HTTP 结果；关闭诊断会移除监听器和计时器。

`smoke.mjs` 的传输错误会说明真正失败的 endpoint、耗时和错误码。它不会重试
提交动作。某个业务步骤报错，也可能是其后的 `state` 等待失败，应结合两端日志区分。
主线程阻塞期间发出、但没有进入服务端处理的请求，与已经处理后丢失响应的请求，
不能简单按同一种失败处理。

## 真实流式桌面与性能数据

准备固定镜像、独立 Chromium 测试依赖和 Chromium 可执行文件后：

```sh
CUA_TEST_IMAGE=sha256:<prepared-image-id> \
CUA_TEST_TRANSPORT=websocket \
CUA_BROWSER_DEPS=/path/to/browser-test-dependencies \
CUA_CHROME=/path/to/chromium \
CUA_STREAM_REPORT=/tmp/cua-stream-websocket.json \
node ds-bot/dev/computer-stream-smoke.mjs
```

分别用 `websocket`、`fetch`、`blocked` 运行；第三种故意拒绝 upgrade，验证新建
Fetch viewer 的回退路径。`CUA_STREAM_REPORT` 可选，只在整套功能检查通过后写入，
父目录须已存在。测试保留独立网页 marker、拖动、中文文本、断线清理和旧凭据拒绝等
断言，不以时延指标代替功能正确性。

报告包含：

- 已缓存镜像的 guest 启动、页面打开到首帧、观察重连、接管流就绪耗时；
- 10 次真实点击到目标区域像素变色的样本，以及 min、p50、p95、max；
- 失焦与断线后，通过独立 X11 查询确认按键/鼠标松开的耗时。

输入计时从浏览器捕获实际 `mousedown` 开始，以 noVNC canvas 的指定像素变为
预期颜色结束；网页独立 HTTP marker 再确认点击次数。只采样一个像素，避免把
鼠标移动、光标闪烁或 HTTP 请求返回误当成应用画面更新。p95 使用 nearest-rank；
10 个样本时等于该组最大值。

这是本机、缓存镜像、合成页面的人工控制数据，不是互联网网站、Windows Electron、
真实模型回合或模型截图链路的性能保证。报告记录平台、Node、镜像 ID 和传输模式，
不保存截图、用户文件或凭据。可比较证据见
`computer-runtime/evidence/stream-performance.json` 与 `computer-runtime/VALIDATION.md`。


## 组合输入与文件传输

固定镜像下，`computer-smoke.mjs` 通过 DSH 公共工具调用验证 Ctrl+A、双击和
拖拽的独立网页 marker，以及 1 MiB 模型附件的分块导入/导出。
`computer-files-smoke.mjs` 加载真正的 ComputerView 和真实 Broker/guest，
检查浏览器文件选择、下载字节、确认进度、在途块取消和禁止覆盖；不读取用户资料。
同一面板流程还验证删除确认：取消后保留原字节，确认前修改文件则拒绝，
重新列出并确认后才删除；最后直接核对 guest 目录为空。

```sh
node --import ./ds-bot/test/harness-resolve.mjs ds-bot/dev/computer-smoke.mjs sha256:<prepared-image-id>
CUA_TEST_IMAGE=sha256:<prepared-image-id> \
CUA_BROWSER_DEPS=/path/to/browser-test-dependencies \
CUA_CHROME=/path/to/chromium \
node ds-bot/dev/computer-files-smoke.mjs
python3 -m unittest discover -s computer-runtime/test -p files_test.py
```

面板测试会故意暂停一块上传，确认进度仍为 0 后点取消，再放行该块；
取消完成后直接读取 guest 的目录，要求没有部分文件或临时文件。浏览器失败时
输出只含合成测试页面的状态与错误文本，不输出接管凭据或请求正文。

200 MiB 上限的真实面板验收：在上述 `computer-files-smoke.mjs` 命令前增加
`CUA_TEST_FILE_BYTES=209715200`。测试在独立 Linux 临时目录分块生成文件，
通过真实文件选择器上传，再下载并比对长度与 SHA-256。每确认 20 MiB 输出一次
进度；大文件允许较长测试时间，每个业务请求仍遵守生产超时与接管检查。

文件清理的 Python 用例覆盖超出传输上限的稀疏文件、版本过期、同名替换、
符号链接、硬链接、目录/FIFO 和校验后替换叶子链接；最后一项证明不跟随链接，
不表示对 guest 并发改名具有原子 compare-and-delete 保证。

## 桌面服务故障恢复

在真实文件面板命令前增加 `CUA_TEST_RECOVERY=1`。测试用独立入口文件记录自己
启动的 Broker PID，并只终止该进程。两台测试桌面各写入不同 marker；从真实
面板确认服务恢复后，要求两台都停止、旧接管凭据被拒绝，再显式启动并读取原文件。
结束时清理两台测试容器、volume 和临时入口，不接触用户 Broker 或容器。
该测试是原生 Linux Node 链路，不能替代 Windows Electron GUI 或旧 WSL 桥接验收。

## 预构建镜像发行证据

候选发布、独立匿名下载与显式导入 lock，见
[镜像发行操作说明](cua-image-release.md)。本地 fixture 和缓存镜像 smoke
不能证明已有可公开下载的镜像，也不能代替 Windows 全新安装的首次下载验收；
这些结果必须分别记录。
