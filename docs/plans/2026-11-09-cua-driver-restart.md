# CUA 驱动重启后就绪修复

## 现象

私有桌面复用已停止的容器时，面板显示 `The desktop driver did not become ready.`。
现场容器保留了 `/tmp/.X1-lock` 和 `/tmp/.X11-unix/X1`；日志显示 X 服务拒绝启动，
XFCE 无法打开显示，随后容器退出。

## 修复

- 启动已停止桌面时重建一次可丢弃的容器层，保留并复用持久 home volume，
  从而丢弃上一次运行留下的 X display lock/socket。
- 继续通过现有入口等待显示和驱动就绪；新建容器不会携带旧的 `/tmp` 状态。
- 保持已发布镜像与镜像锁不变，重新构建插件捆绑的 Broker。

## 边界

重建仅替换通过归属、镜像、挂载校验的已停止容器。容器层（含 `/tmp`）是临时空间；
`/home/cua`、检查点及运行中的容器保留。输入和文件操作不会重放。

## 验证

从 `ds-bot/` 运行 `CUA_TEST_IMAGE=sha256:<本地镜像ID> node dev/computer-restart-smoke.mjs`。
测试用独立容器验证强制退出和正常停止后的截图及 home 文件保留，也验证对运行中桌面
重复执行启动不会重建容器。测试结束删除其专用容器和卷；Windows Desktop GUI 另行验收。
