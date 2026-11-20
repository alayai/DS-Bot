# DS-Bot：公开 Bot 显式云端导出

日期：2026-11-18。范围：dsh-server 融合阶段三的首个本地导出切片。

## 已实现

- Host 注册公开的 `botExport` v1 provider，独立于 `botReadOnly` 摘要接口。
- 只有已加载且 `private !== true` 的 Bot 可以导出；未初始化、找不到 Bot、私有 Bot 和超长定义分别返回明确原因。
- 导出结果是脱离本地运行时的声明式定义：`schemaVersion`、名称、角色、指令和 `requiredCapabilities`。
- 明确不导出模型引用、API key、凭据、本地目录、技能、连接器、记忆、历史、Session、头像或本地文件。
- DSH Client 第一次点击只读取完整定义并显示预览，第二次确认才使用随机幂等键创建新的 Workspace Bot；不会自动上传本地 Bot 或历史。
- 服务端 revision 保存 `local-export` 来源、来源 Bot ID、导出版本、导出时间和定义 SHA-256 摘要；控制台可查看这些信息。

## 验证

```bash
node --test test/cloud-export.test.js test/read-only.test.js
```

当前结果：5/5 通过。DSH Host TypeScript 检查通过；DSH Vitest 受工作区缺少 Linux Rolldown 原生 binding 阻断，未将该套件标记为通过。

## 后续边界

本切片不提供双向同步、私有 Bot override、技能或连接器迁移、模型凭据迁移、头像/文件迁移、跨重启的本地更新同步、主聊天投影或真实供应商模型验收。当前面板会用定义摘要提示本次面板生命周期内的本地变化；持久化更新检测和云端实际运行仍需单独验收。
