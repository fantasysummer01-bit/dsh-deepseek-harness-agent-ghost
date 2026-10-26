# DSH / DeepSeek Harness Agent-Ghost

DSH 本地身份与记忆插件，npm 插件包名仍为 `dsh-ghost`。

**实验性首版（experimental）0.1.0。** 已通过 28 项核心、设置页、真实 SDK 与隔离 HTTP 测试；最新后台修复仍待生产 Desktop 重新加载后的页面往返与检查点验收。当前不宣称真实模型会话的全链路验收已完成。

在 DSH 的「设置」侧栏新增 **Ghost**，用于调整身份、性格倾向、未完成目标、消息采集范围与上下文预算。插件内核不依赖任何模型供应商，不自动调用外部模型。

## 当前具备的功能

- 单用户、单 Ghost，跨会话持久身份与分支 ID。
- SQLite WAL + FULL 事务、版本化状态与校验账本、检查点和启动恢复。
- 默认关闭消息采集。开启并保存后，记录新发生的真人可见文本；助手回复需另行开启。系统提示、工具、推理块、附件及插件注入不采集。
- 有事件 ID、来源与会话标识的词面检索；中文双字线索和英文词匹配，不是语义搜索。
- 固定 UTF-8 字节上下文上限。没有把字节数当成精确 token 数。
- 设置页显式修改身份/traits/goals 并留下审计；消息本身不能自动改写人格。
- 检查点、校验、JSON 导出及独立核心的一致 SQLite 备份。

软件状态连续性只表示已提交状态可以一致恢复，不表示主观意识。首版尚未实现自动人格演化、离线巩固、删除传播、精确 tokenizer、跨设备写入仲裁及旧版数据迁移。原始事件会保留；正式采集敏感信息前需等待删除管理阶段完善。

## 已核对的宿主版本

已核对 Desktop **0.2.0-rc.2**，commit `04f392c9ddd144fa426da2045178797da6db6c11`；内置 Node 24.18.1。验证环境中的全局 `dsh` 为另一套 0.1.5-rc.3，桌面安装请使用 Desktop 内置 CLI。

插件使用原生 `settings.section`，Host/Client 通过受宿主鉴权的独立 `/ghost` Connection RPC 通信，不额外监听端口。数据默认在 `%USERPROFILE%\.dsh\ghost\ghost.sqlite`；`DSH_HOME` 或 `GHOST_DATA_DIR` 可覆盖路径。不更改全局 AGENTS.md 或既有人格配置；已有身份设定若与 Ghost 内容冲突，请自行在设置页协调。

本地存储不等于永不外发：启用 Ghost 后，身份状态与命中的原始证据片段会进入 DSH 的正常模型请求，并按你当前配置发送给本地或云端模型。Ghost 不额外发起模型调用。

## 制作与检查

```powershell
node --test test/*.test.mjs
node --check lib/index.js
node --check lib/core.js
node --check lib/client.js
node --check lib/transport.js
node scripts/pack.mjs
```

需 Node 24+。也可以使用桌面程序内置 Node（测试不会启动应用界面）：

```powershell
$DesktopRoot = 'C:\Path\To\DeepSeek' # 替换为实际 Desktop 安装目录
$env:ELECTRON_RUN_AS_NODE='1'
& (Join-Path $DesktopRoot 'DeepSeek Harness.exe') --expose-internals --test test/bridge.test.mjs test/core.test.mjs test/client.test.mjs
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

一条命令执行完整测试：`& '.\scripts\Test-Desktop.ps1' -DesktopRoot 'C:\Path\To\DeepSeek'`。脚本使用指定 Desktop 的内置 Node 和 SDK，结束后恢复环境变量。省略参数时采用脚本内的安装目录默认值。

完整真实宿主测试需配置 `DSH_SDK_ROOT`，见 [验收记录](docs/ACCEPTANCE.md)。未配置时对应两项明确跳过，默认测试通过不代表这两项已经执行。

## 安装、运行与停止

先结束 DSH 正在执行的任务并完全退出应用（包括托盘），再运行：

```powershell
$DesktopRoot = 'C:\Path\To\DeepSeek' # 替换为实际 Desktop 安装目录
& '.\scripts\Install-Desktop.ps1' -DesktopCli (Join-Path $DesktopRoot 'resources\runtime\cli\bin\dsh.cmd')
```

脚本只安装本目录的 `dsh-ghost`，先将桌面 profile 的 manifest、锁文件和配置备份到本工程 `artifacts/profile-backups/`。既有启动动画插件和其他依赖由官方包管理器保留。安装后启动 DSH，打开账号菜单 → 设置 → Ghost。采集仍然关闭，按需明确开启并保存。

停止 Ghost：在设置中取消「启用 Ghost」并保存；停止整个宿主：使用 DSH 应用菜单退出。不要在运行时手工复制 SQLite 主文件：WAL 可能还含已提交页面。

## 导出、备份与恢复

设置 → Ghost → 检查点与恢复 → 导出数据，生成带 schema 的 JSON。检查点用于启动校验，**不替代独立备份**。

核心离线工具（先关闭 DSH，避免双写租约）：

```powershell
node scripts/ghost.mjs status
node scripts/ghost.mjs verify
node scripts/ghost.mjs checkpoint
node scripts/ghost.mjs backup 'D:\GhostBackups\ghost-20261026.sqlite'
```

备份目标的父目录须已存在，工具拒绝覆盖现有文件。恢复时关闭 DSH，保留当前整个数据目录供排查，将一致备份复制到一个**新的空目录**并命名 `ghost.sqlite`，用 `GHOST_DATA_DIR` 指向该目录，再先离线 `verify`。校验失败禁止继续写入，也不会凭摘要重建人格。启动默认自动校验所有日志、检查点及尾部状态。

默认同机共享 SQLite 租约阻止同库/同 branch 同时写入，进程终止后系统释放锁。换机器、换用户或刻意更换租约目录不能得到分布式互斥保证；不要将一个身份复制成多个活跃实例。

## 卸载与回退

退出 DSH 后：

```powershell
$DesktopRoot = 'C:\Path\To\DeepSeek' # 替换为实际 Desktop 安装目录
& (Join-Path $DesktopRoot 'resources\runtime\cli\bin\dsh.cmd') plugin --profile desktop remove dsh-ghost
```

此命令移除插件依赖与 bundle，数据目录保留。优先用官方 remove 回退。仅在确认备份后 profile 没有其他新修改时，才考虑恢复 manifest/锁文件备份；不要覆盖整套 profile，不要删除其他插件或聊天历史。本首版不能导入未知旧版 `GhostCore_for_Codex` 数据。

## 仓库与后续更新

项目仓库：[fantasysummer01-bit/dsh-deepseek-harness-agent-ghost](https://github.com/fantasysummer01-bit/dsh-deepseek-harness-agent-ghost)。后续版本继续维护在同一个仓库，保留提交与版本记录。

功能更新应先执行适用测试、更新 [CHANGELOG](CHANGELOG.md) 和必要的版本号，再提交并推送到该仓库。真实 Desktop 验收与普通自动测试分别记录；运行数据库、用户配置、日志和 profile 备份不进入源码仓库。不会因发布更新而自动重启正在执行任务的 DSH。

当前代码标记为 **UNLICENSED**，尚未选择开放源码许可证。GitHub 可见性与代码许可是两件事，不应把公开可见描述为已授予 MIT 等开源许可。

## 实施记录

- [可行性与差距](docs/GAP_ANALYSIS_V02.md)
- [第一阶段计划](docs/PHASE1_PLAN.md)
- [宿主接口核对](docs/DSH_COMPATIBILITY.md)
- [验收实测](docs/ACCEPTANCE.md)

`preview/index.html` 为明确标注的内存演示；不能将其截图当成真实 DSH 安装证据。
