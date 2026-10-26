# DSH 宿主兼容性核查

核查日期：2026-10-26。本文区分源码静态证据、插件实机装载诊断与隔离 Host 传输测试；没有把这些检查称为真实 LLM 会话验收。

## 两套安装必须区分

| 安装 | 实测文件信息 |
| --- | --- |
| Desktop：`<DesktopRoot>\resources\app.asar` | 根 package.json：`@deepseek-ai/dsh-desktop`，`0.2.0-rc.2`；`dshBuildCommit=04f392c9ddd144fa426da2045178797da6db6c11`；`dshBuildDirty=false` |
| Desktop 内置 app-boot | `dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json`：`0.2.0-rc.2` |
| 全局 npm：`<GlobalDshRoot>` | 内部 app-boot/session package.json：`0.1.5-rc.3` |

桌面适配以第一套为准。`app.asar.unpacked/dsh/node_modules/@deepseek-ai` 只包含部分需要落地的包，不能据此认为 session/system-prompt 不存在。

REA 对明确选定的四个接口文件执行了静态只读分析。母证据 ID：`ev_22c32a617cd0e1f8efe7687ab80fe384b45793c9dea0102e905b4055c0b222df`；ASAR SHA-256：`983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2`。只解析了四份 JavaScript；其余文件不在分析范围。之后使用 bundled Electron 的只读 fs API 定点读取了以下接口、版本及桌面代理路径。没有加载插件业务代码、没有附加运行中进程、没有解包或修改安装目录。

## 会话事件与来源

Desktop 包内 `dsh-session/lib/index.js`：

```js
ctx.on('session/event', (session, event) => {
  // event: { type, seq, time, data, surfaceOp?, sourceEventSeqs? }
  // session.id 是会话主键；不能用它替代 Ghost 的 ghost_id。
  if (event.surfaceOp !== 'append') return;
  if (event.type === 'user/message') {
    const message = event.data;
    // message: { id, role:'user', content:ContentBlock[], source }
    if (message.source?.kind !== 'user') return;
  }
  if (event.type === 'assistant/message') {
    const message = event.data.message;
    // data 另有 turn、step、stream 和可选 usage/interrupted。
    if (message.source?.kind !== 'model') return;
  }
});
```

仅采集 `content` 中 `type === 'text'` 的字符串文本。不要采集系统、developer、工具结果、推理块、模型失败 attempt、图片或二进制附件。`surfaceOp:'append'` 表示原始可见事件；替换事件是压缩/模型表面重写，不应再次作为新经历入库。

动态上下文也使用 `user/message`，但来源由生产者标记为 plugin；只看 `role:'user'` 或 `type:'user/message'` 会产生循环。以 `source.kind === 'user'` 为必要条件，未知来源默认不采集。

`session/event` 在会话内存日志追加后发布，监听器失败被包含；它不是 Ghost 已持久化确认。Ghost 写入须自己等待事务提交，并使用稳定 event/message ID 幂等去重。

## 在提示词装配前获得本轮线索

Desktop `dsh-agent/lib/index.js:291`：

```js
function assembleContextFor(agent, signal) {
  return { agent, scope: agent, ...(signal === undefined ? {} : { signal }) };
}
```

所以 `AssembleContext` 没有直接的 `sessionId`；使用 `context.agent.id`。scope 是 Agent 对象，不是会话 ID 字符串。

Desktop `dsh-agent-loop/lib/index.js:902` 的顺序为：

1. `claimed = this.inbox.claim(target, turn)`。
2. `await systemPrompt.assemble(assembleContextFor(this, signal))`。
3. 形成 runtime-context 快照。
4. 执行 `agent/pre-step` waterfall。
5. 后续才提交进入模型的 `user/message`。

`Inbox.claim()` 在返回前同步发布 `agent/inbox/claimed`，载荷为 `{ agent, message, turn }`；可在这个通知中依据 `message.source.kind === 'user'` 更新 `Map<agent.id, query>`，然后在装配时读取同一 ID 的线索。此线索只是本轮检索输入，不应因 claimed 通知而提前记作已进入模型的经历。`agent/disposed` 时清理该会话缓存。

排队的持久事件精确格式：

```text
type: agent/inbox/spliced
data: {
  target: 'next-turn' | 'next-step',
  start: number,
  removedCount?: number,
  inserted: UserMessage[],
  outcome?: 'canceled'
}
```

排队、claim 和最终消息提交语义不同，不能三次入库。同一时刻不同 session 的 query 必须隔离。

## Prompt 注册和双花括号

Desktop `dsh-system-prompt/lib/index.js` 提供 `section()`、`context()`、`variable()`。text provider 是同步字符串函数；HTTP 请求应在异步装配阶段完成或提前准备缓存，不得返回 Promise。

Desktop 0.2.0-rc.2 的 section 已支持 `interpolate:false`，但 `renderContextSections()` 仍无条件执行插值，context 不支持该选项。兼容做法：

```js
ctx.systemPrompt.variable('ghost_context', ac => contextCache.get(ac.agent?.id) ?? '');
ctx.systemPrompt.context({ name:'ghost:memory', order:130, text:'{{ghost_context}}' });
```

插值函数把变量值直接拼入结果，不再次扫描变量值。这样记忆文本中的 `{{...}}` 会按字面保留。旧全局 0.1.5-rc.3 也支持该方式。注册必须在依赖就绪的 Cordis context 下进行；模块可以声明 `inject=['systemPrompt']` 或在 `ctx.inject(['systemPrompt'], callback)` 中注册。

`ctx.get(name)` 返回当前 active service 或 undefined，适用于可选能力探测；不等于等待能力出现。读取必需属性前声明 inject 或使用 `ctx.inject`。注册与监听都应由插件 fiber 持有，卸载自动释放。

## 设置页与 Host 通信

Desktop 实际页面协议是 `dsh-app://app/`。`app.asar/lib/main.js:11542`：静态首页/资产由打包资源提供；其他路径经 `forwardWebRequest()` 发送到宿主。`main.js:7461` 保留原 pathname/search，附加 shell 持有的 Host 认证 cookie；没有仅允许 `/api` 的路径白名单。

客户端可使用独立 `/ghost` Connection wire channel。Host **不要直接调用本版 `connection.rpc.handle()`**：虽然源码内部构造的是 `kind:'prefix', path:'/ghost'`，实机与真实 SDK 测试暴露出它捕获 provider context 后读取 `webServer` 的依赖追踪问题，错误为 `cannot get property webServer without inject`。这会使整个 Host fiber 启动失败，设置页客户端仍可能出现。

最终实现由 `lib/transport.js` 从 Ghost 自己已声明依赖的 context 注册路由，复用宿主的鉴权判断，并实现相同的 Connection 请求/响应 envelope：

```js
// Host：已注入 connection 和 webServer 的插件 context。
// registerGhostRpc 内部使用 ctx.webServer.register({
//   kind:'prefix', path:'/ghost', handler: ...
// })，并在处理前调用 ctx.connection.requestRejection(req)。
import { registerGhostRpc } from './transport.js';
ctx.effect(() => registerGhostRpc(ctx, handler), 'ghost: RPC');

// Client：必需 connection
const result = await ctx.connection.rpc.call('/ghost', 'status', payload, signal);
```

`lib/index.js` 实际使用统一 close 回调持有上述 route disposer，与事件及提示词注册一起卸载。传输层限制 POST、application/json、64 KiB body、方法名与 envelope 一致，并将 rpcId 原样返回。Host handler 再做操作白名单和业务参数校验。

客户端连接实现会请求相对路径 `ghost/status`；桌面 shell 转发 `dsh-app://app/ghost/status`，因此不用从浏览器直接跨域请求 Ghost 独立端口。当前运行时与数据库在 Host 插件内，浏览器不持有额外 Ghost 密钥；生产桌面的认证 cookie 由 shell 管理。

**不要再注册 `connection.rpc.intercept('/api', ...)`**：每个 shared channel 只能有一个 interceptor，Gateway 已占用该位置。独立 `/ghost` 路由避免冲突；由插件自己保存 disposer，卸载必须撤销路由。

`scripts/transport-smoke.mjs` 使用真实 Cordis、WebServer、Connection、local credentials、SessionStore 和 SystemPrompt 构建隔离 loopback Host；测试数据及认证材料只写新建临时目录。该测试已报告通过认证前 401、token exchange 303、认证后 status/configure 200、跨 Origin 403、卸载后 404及写锁释放。它没有替代生产 Desktop renderer、生产 profile、真实会话采集和 LLM 端到端验证；新增 method/body/size 分支的实测结果以测试输出为准。

### 实机 405 的定位

首次实机点击返回 `transport failure for /ghost/status: HTTP 405`。定点核查确认：`dsh-host-frontend-static/lib/index.js:87-95` 的 fallback 对非 GET/HEAD 返回 405；`dsh-host-webserver` 先 exact、后最长 prefix、最后 fallback。Connection 自定义 handler 本身没有 405 分支。因此 405 表示请求没有命中 `/ghost` 注册路由，需要检查 Host 插件依赖和实际启动状态，不能据此断言独立 channel 不支持。

本次先定位到插件依赖误写 `session`。Desktop `dsh-session/lib/index.js:1621` 明确 `super(ctx,'sessions')`，真实服务名是 **`sessions`**；同模块的 Typert lookup 名 `session` 不是 Cordis 服务名。依赖缺失会使 Host fiber 等待而不执行 apply，客户端设置入口仍可能出现。修正后，又定位到上文的 `connection.rpc.handle()` provider context 依赖错误，现已改为 Ghost 自己注册路由。`systemPrompt` 的真实 service key 已从其构造器 `super(ctx,'systemPrompt')` 确认。生产页面重新装载后的结果由实机验收报告记录。

## 官方安装与回滚语义

`dsh-desktop-host/lib/cli.js:91` 的 `runDesktopCli()` 显式设置 `manageDesktopProfile:true`，使用 Desktop 随附 pnpm；普通全局 CLI 不能管理这个保留 profile。

```powershell
$DesktopRoot = 'C:\Path\To\DeepSeek' # 替换为实际 Desktop 安装目录
$DesktopCli = Join-Path $DesktopRoot 'resources\runtime\cli\bin\dsh.cmd'
& $DesktopCli plugin --profile desktop add '<插件目录的绝对路径>'
& $DesktopCli plugin --profile desktop remove '<插件 package.json 的 name>'
```

安装前应完全退出 Desktop（含托盘）。Desktop profile 需已经由 Desktop 初始化。`dsh/lib/bin.js` 把 plugin 子命令剩余参数原样交给包管理器；`add --help` 也会进入管理流程，不应当作只读探测。

安装会更改 profile 的 `package.json` 和 `pnpm-lock.yaml`，bundle 选择保存在 `package.json` 的 `dsh.profile.bundles`。失败/取消安装会恢复这两份预先快照，已下载文件可能仍留在 node_modules/store；诊断记录位于 `.plugin-manager`。移除失败可能保留已经完成的步骤。

最小可回退记录：安装前保存 profile 的 `package.json`、已有 `pnpm-lock.yaml`，并保存/校验已有 `cordis.patch.yml`、`pnpm-workspace.yaml`，记录文件原本不存在的情形；优先使用官方 remove 撤销新增包，保留原有包与数据。不要覆盖全套 profile 或直接删除 node_modules。本节说明官方工具语义，具体安装结果与备份位置应按实际操作记录。


## 0.2.0 更新

原设置编辑器已由黑盒控制页替代；详情以 docs/ACCEPTANCE.md 的 0.2.0 验证边界为准。卸载等待宿主正常退出，不强停任务。已安装的本地 link/junction 随源码更新，运行中的宿主仍需正常重新加载。
