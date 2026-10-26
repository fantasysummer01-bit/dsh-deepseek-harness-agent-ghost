# Ghost v0.2 实施审计（2026-10-26）

用户目标：分析可行性并制作；后续明确为 DSH 插件，在设置侧栏增加 Ghost 调整页。三份附件是设计参考，其示例任务和历史测试结果不视为本次已执行结果。

## 实际起点

- `<Workspace>` 初始为空，没有旧工程、SQLite 数据或测试。
- 在已检查的工程和下载目录中未找到 `GhostCore_for_Codex`。不能声称迁移完成，也不能重现参考文档所称的旧版八项测试。
- PATH 中没有 Python 命令；Codex 附带 Python 3.12.14 / SQLite 3.53.1 支持 FTS5。Node.js 为 24.19.0。
- 全局 DSH CLI：`<GlobalDshRoot>`，0.1.5-rc.3。
- 桌面程序：`<DesktopRoot>\DeepSeek Harness.exe`。其内置 CLI `resources\runtime\cli\bin\dsh.cmd --version` 实测 0.2.0-rc.2；runtime versions.json 标记 Node 24.18.1。
- 截图中 v1.1.0 属于 `dsh-startup-screen` 插件，并非宿主版本。
- 桌面 profile 已有启动动画插件。没有修改其配置、全局人格文件、密钥和聊天历史。

## 可行性判断

**Go：本地原型。** 稳定身份、SQLite 事务、状态版本、追加账本、检查点和恢复都是成熟的软件机制。用户要求 DSH 内调整，采用 Node 核心与 Host 插件同进程运行，避免额外 Python 服务和端口；核心不依赖 DSH，保留未来宿主适配能力。

**不能据此承诺：** 主观意识、无限记忆、自动人格成长质量、跨设备双写互斥、旧数据兼容，以及未经测试的宿主版本兼容性。人格连续性在本工程仅指已提交软件状态的一致恢复。

## 差距与首版边界

| 参考设计 | 首版处理 |
| --- | --- |
| 跨会话身份、版本化状态 | 单用户单 Ghost，独立 SQLite 权威源 |
| 账本、checkpoint/recovery | 原子事务、哈希校验、损坏后只读诊断 |
| 分叉防护 | 同机单写者；离线副本与跨设备分叉不能仅靠本地锁彻底阻止 |
| 可追溯记忆 | 仅授权后新发生的可见文本；区分真人与模型；不回读旧会话 |
| 固定上下文预算 | UTF-8 字节上限；不把字节数冒称 tokenizer 的精确 token 数 |
| DSH 接入 | 正式 `settings.section` + Connection RPC + Session/SystemPrompt 扩展点 |
| 自动性格变化 | 首版只由设置页手动调整并审计，无在线训练 |
| 删除传播、备份擦除 | 尚需单独实现和验收；当前不宣称满足隐私删除全链路 |
| 向量检索、离线巩固 | 后续阶段；当前无自动云模型调用 |
| 旧版兼容迁移 | 未取得旧源码与 schema；不自动打开或修改旧数据库 |

## 上游核查

官方源码存在 [Session 事件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/index.ts) 和 [System Prompt 扩展](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md)。当前上游与本机版本不同，具体适配以本机接口与测试为依据。

借鉴 [澜记忆](https://github.com/kiefeng/dsh-lan-memory) 的来源分层和预算思路、[dsh-soul](https://github.com/Aliuyanfeng/dsh-soul) 的审批审计思路。本次不移植社区代码，也不将其作为依赖。
