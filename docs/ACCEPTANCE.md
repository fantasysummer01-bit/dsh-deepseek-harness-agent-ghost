# Ghost 0.1.0 实测记录

测试日期：2026-10-26。以下区分独立核心、真实 SDK、真实 HTTP 和桌面 UI，不能互相替代。

## 环境

- Windows，PowerShell。
- Node 24.19.0；Desktop 内置 Node 24.18.1。
- Desktop 0.2.0-rc.2，Cordis 4.0.4；Session/SystemPrompt/WebServer/Connection 0.2.0-rc.2。

## 自动测试

在 Desktop 自带 Node 和 SDK 下运行：

```powershell
$DesktopRoot = 'C:\Path\To\DeepSeek' # 替换为实际 Desktop 安装目录
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_SDK_ROOT=Join-Path $DesktopRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai'
& (Join-Path $DesktopRoot 'DeepSeek Harness.exe') --expose-internals --test test/bridge.test.mjs test/core.test.mjs test/client.test.mjs test/host.test.mjs test/transport.test.mjs
```

28 项通过，0 失败，0 跳过。无 `DSH_SDK_ROOT` 时，真实 SDK / transport 两项明确 SKIP，不能计为通过。

覆盖：稳定身份与状态重启、批准设置的版本控制、事件去重和冲突、未授权拒绝、事务插入失败回滚、checkpoint + tail 恢复、篡改检测后只读、schema 不明拒绝猜测、同库与副本双写冲突、一致备份、UTF-8 预算、词面召回、强制杀进程后恢复、来源过滤、子代理隔离、设置页错误与冲突处理、失败加载释放租约。

## 真实 Host 契约

`scripts/host-smoke.mjs` 使用实际 Cordis / SessionStore / SystemPrompt。实际 Session.append 能触发捕获；实际 prompt 装配能得到证据；实际 fiber 卸载移除贡献并释放租约。这项测试的传输边界是内存 fixture。

## 真实鉴权与 HTTP

`scripts/transport-smoke.mjs` 使用实际 WebServer、Connection 和临时目录中的 LocalCredentialProvider。只启动隔离的 loopback 临时测试服务，退出后清理；不修改生产账号或 profile，不打印 token/cookie。

| 场景 | 实测 |
| --- | --- |
| 未登录 POST | 401 |
| 宿主 launch token 交换 | 303，取得签名 cookie（不输出凭据） |
| 已登录 status / configure | 200 |
| 旧版本覆盖设置 | VERSION_CONFLICT，未覆盖 |
| 异站 Origin | 403 |
| 错误 HTTP 方法 | 405 |
| 错误 Content-Type | 415 |
| 无效 JSON | 400 |
| 超过 64 KiB | 413 |
| 卸载后访问 | 404 |

实机发现并修复：服务依赖名须为 `sessions`；当前 SDK 的嵌套 `connection.rpc.handle` 在访问 `webServer` 时触发 Cordis 依赖追踪错误。插件改为从自己的注入 context 注册 `/ghost` 路由，调用 `connection.requestRejection` 复用宿主鉴权，并严格实现原有 Connection RPC wire envelope。没有修改宿主内核。

## 桌面安装与 UI

- 使用内置官方 CLI 成功添加本地 `dsh-ghost` 依赖与 bundle。
- 配置备份：`artifacts/profile-backups/<timestamp>/`（仅本地保存，不进入源码仓库）。
- 真实桌面设置侧栏已出现 Ghost，位置在「启动动画」下方。
- 首次桌面读取状态暴露后台启动错误；通过真实 transport 测试定位修复。
- 最新桌面页往返和检查点验证：尚待生产 Desktop 重启加载修复后完成；没有为验收强制中断现有宿主任务。
- 原有启动动画依赖仍在；无旧聊天采集，采集开关保持默认关闭。

预览页面另外验证了浅色/深色、590px 窄布局、保存、检索、检查点、校验，JavaScript 错误为 0；预览明确使用演示数据，不能作为实机后台通过的证据。

## 尚未验收

真实模型对话的跨会话回忆与幻觉率对照；1万/10万事件性能；删除传播；自动巩固；神经网络；跨设备分叉仲裁；未知旧版数据迁移。没有运行这些项目，也没有把它们写为完成。
