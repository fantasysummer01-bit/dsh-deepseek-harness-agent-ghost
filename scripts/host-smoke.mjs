import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Ghost from '../lib/index.js';
import { GhostStore } from '../lib/core.js';
import { invokeRoute } from './testing/rpc-probe.mjs';

const ACTIVE = 2;
const DISPOSED = 4;

function readPackage(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
}

async function loadSdk(root, name) {
  const metadata = readPackage(root, name);
  return { metadata, module: await import(pathToFileURL(path.resolve(root, name, metadata.main || 'lib/index.js')).href) };
}

/**
 * Uses installed Cordis, SessionStore and SystemPrompt implementations. Only the
 * authenticated transport edge is replaced: no HTTP listener, IPC or LLM call.
 * DSH_SDK_ROOT is the directory containing @deepseek-ai packages, not its parent.
 * For app.asar, run with the desktop Electron executable in RUN_AS_NODE mode.
 */
export async function runHostSmoke({ sdkRoot = process.env.DSH_SDK_ROOT } = {}) {
  if (!sdkRoot) {
    return { status: 'SKIP', reason: 'DSH_SDK_ROOT is unset; no real Cordis Host test was run. This is not a pass.' };
  }
  const root = path.resolve(sdkRoot);
  const [cordisSdk, sessionSdk, promptSdk, toolsSdk] = await Promise.all([
    loadSdk(root, 'cordis'), loadSdk(root, 'dsh-session'), loadSdk(root, 'dsh-system-prompt'),
    loadSdk(root, 'dsh-tools'),
  ]);
  const { Context } = cordisSdk.module;
  const { SessionStore } = sessionSdk.module;
  const { SystemPrompt, renderContextSnapshot } = promptSdk.module;
  const { ToolRuntime } = toolsSdk.module;
  assert.equal(typeof Context, 'function', 'SDK does not export Context');
  assert.equal(typeof SessionStore, 'function', 'SDK does not export SessionStore');
  assert.equal(typeof SystemPrompt, 'function', 'SDK does not export SystemPrompt');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ghost-real-host-'));
  const dataDir = path.join(workspace, 'ghost-data');
  const ctx = new Context();
  const rpcHandlers = new Map();
  let rpcDisposals = 0;
  let fiber;
  let reopened;
  try {
    // This mock ends at the transport boundary. Context dependency resolution,
    // effect tracking, Session event dispatch, prompt assembly and unload are real.
    ctx.provide('connection', { requestRejection() { return undefined; } });
    ctx.provide('webServer', {
      register(route) {
        assert.equal(route.path, '/ghost');
        assert.equal(route.kind, 'prefix');
        assert.ok(!rpcHandlers.has('/ghost'), 'duplicate Ghost route');
        rpcHandlers.set('/ghost', route);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true; rpcHandlers.delete('/ghost'); rpcDisposals++;
        };
      },
      tapIndex() { throw new Error('Host smoke must not modify an HTML entry point'); },
    });

    const sessionsFiber = ctx.plugin(SessionStore);
    const promptFiber = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
    await Promise.all([sessionsFiber.await(), promptFiber.await()]);
    assert.equal(sessionsFiber.state, ACTIVE, 'real SessionStore fiber did not become active');
    assert.equal(promptFiber.state, ACTIVE, 'real SystemPrompt fiber did not become active');
    assert.ok(ctx.sessions, 'real sessions service is missing');
    assert.ok(ctx.systemPrompt, 'real systemPrompt service is missing');

    const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' });
    await toolsFiber.await();
    assert.equal(toolsFiber.state, ACTIVE, 'real tool runtime did not become active');

    fiber = ctx.plugin(Ghost, { dataDir });
    await fiber.await();
    assert.equal(fiber.state, ACTIVE,
      `Ghost did not apply; state=${fiber.state}, declared inject=${JSON.stringify(Ghost.inject)}. Check actual Cordis service names.`);
    assert.deepEqual([...rpcHandlers.keys()], ['/ghost']);
    const call = async (endpoint, payload = {}) => {
      const route = rpcHandlers.get('/ghost');
      assert.ok(route, 'Ghost native RPC was not registered');
      return invokeRoute(route, endpoint, payload);
    };
    const boot = await call('status');
    assert.equal(boot.ok, true);
    assert.equal(boot.value.health.ok, true);
    assert.equal(boot.value.settings.captureEnabled, false);
    const saved = await call('configure', {
      expectedVersion: boot.value.version,
      patch: { name: 'Ghost real Host smoke', settings: { enabled: true, captureEnabled: true } },
    });
    assert.equal(saved.ok, true);

    const session = ctx.sessions.create('ghost-host-smoke-root');
    const input = {
      id: 'ghost-host-smoke-input', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '请帮我完成公园里那只猫的观察报告。' }],
    };
    const committed = session.append('user/message', input, { surfaceOp: 'append' });
    assert.equal((await call('status')).value.counts.events, 1,
      'real SessionStore event publication did not reach Ghost capture');
    const evidence = await call('search', { query: '我们在公园看到的动物是什么' });
    assert.equal(evidence.ok, true);
    assert.equal(evidence.value.length, 1);
    assert.equal(evidence.value[0].eventId, `dsh:${session.id}:${committed.seq}:user/message`);

    // A minimal Agent carrier is sufficient for the real prompt registry; no
    // agent driver or model is created. Its session is the real live Session.
    const assembled = await ctx.systemPrompt.assemble({ agent: { id: session.id, session } });
    const rendered = renderContextSnapshot(assembled);
    assert.match(rendered, /ghost:memory|Ghost persistent context/);
    assert.match(rendered, /公园/);
    assert.match(rendered, /untrusted DATA/);
    const carrier = { id: session.id, session };
    assert.ok(ctx.tools.get('ghost_state', carrier), 'Ghost state tool missing from real scoped registry');
    assert.ok(ctx.tools.get('ghost_task', carrier), 'Ghost task tool missing from real scoped registry');
    assert.ok(ctx.tools.schemas(carrier).some(tool => tool.name === 'ghost_task'), 'Ghost schema missing from real tool surface');
    const signal = new AbortController().signal;
    const toolCall = (name, args, agent = carrier) => ctx.tools.execute({
      name, arguments: args, callId: 'ghost-smoke-' + name, signal,
      ...(agent === null ? {} : { agent }),
    });
    const subject = await toolCall('ghost_state', {});
    assert.equal(subject.isError, false, 'real Ghost state execution failed');
    assert.equal(subject.value.ghostId, boot.value.ghostId);
    assert.equal(subject.value.channel.sessionId, session.id);
    const ongoing = subject.value.channelTasks.find(task => !['completed', 'cancelled'].includes(task.status));
    assert.ok(ongoing, 'visible task did not become persistent Ghost work');
    const proposed = { action: 'update', taskId: ongoing.id, status: 'completed', note: 'Model reports the observation report is ready.',
      expectedSubjectVersion: subject.value.subjectVersion, evidenceIds: [evidence.value[0].eventId] };
    const reported = await toolCall('ghost_task', proposed);
    assert.equal(reported.isError, false, 'real Ghost task report failed');
    assert.notEqual(reported.value.channelTasks.find(task => task.id === ongoing.id).status, 'completed', 'model text incorrectly verified completion');
    const stale = await toolCall('ghost_task', proposed);
    assert.equal(stale.isError, true, 'stale subject write overwrote a later state');
    assert.equal((await toolCall('ghost_state', {}, null)).isError, true, 'unscoped tool unexpectedly exposed Ghost');
    const child = ctx.sessions.create('ghost-host-smoke-child', { meta: { origin: 'subagent' } });
    const childContext = await ctx.systemPrompt.assemble({ agent: { id: child.id, session: child } });
    assert.equal(renderContextSnapshot(childContext), '', 'subagent unexpectedly received Ghost context');

    const childTool = await toolCall('ghost_state', {}, { id: child.id, session: child });
    assert.equal(childTool.isError, true, 'subagent unexpectedly accessed Ghost subject tools');
    assert.equal((await call('stop')).ok, true);
    assert.equal((await toolCall('ghost_state', {})).isError, true, 'closed Ghost still exposed subject tools');

    await fiber.dispose();
    assert.equal(fiber.state, DISPOSED);
    assert.equal(rpcHandlers.size, 0, 'RPC channel survived plugin unload');
    assert.equal(rpcDisposals, 1, 'RPC channel was not released exactly once');
    assert.equal(ctx.tools.get('ghost_state', carrier), undefined, 'Ghost state tool survived unload');
    assert.equal(ctx.tools.get('ghost_task', carrier), undefined, 'Ghost task tool survived unload');
    reopened = new GhostStore({ dataDir });
    assert.equal(reopened.status().health.ok, true, 'writer lease survived real Cordis unload');
    assert.equal(reopened.status().ghostId, boot.value.ghostId);
    assert.equal(reopened.status().counts.events, 1);
    reopened.close();
    reopened = undefined;

    const afterUnload = await ctx.systemPrompt.assemble({ agent: { id: session.id, session } });
    assert.equal(renderContextSnapshot(afterUnload), '', 'prompt contribution survived real Cordis unload');
    return {
      status: 'PASS', suite: 'real-cordis-host-contract',
      sdkVersions: {
        cordis: cordisSdk.metadata.version,
        session: sessionSdk.metadata.version,
        systemPrompt: promptSdk.metadata.version,
        tools: toolsSdk.metadata.version,
      },
      node: process.version,
      verified: ['real dependency activation', 'RPC registration/status', 'real committed Session event capture',
        'real SystemPrompt assembly', 'real scoped tool registration and execution', 'subject task report and stale version rejection',
        'subagent exclusion', 'closed Ghost denial', 'real fiber unload', 'RPC/prompt/tool cleanup', 'writer lease release'],
      limits: 'Connection RPC transport and webServer are mocks. No live desktop window, HTTP/IPC, Agent driver or LLM was exercised.',
    };
  } finally {
    reopened?.close();
    if (fiber && fiber.state !== DISPOSED) await fiber.dispose();
    await ctx.fiber.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(JSON.stringify(await runHostSmoke(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`FAIL real-cordis-host-contract: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
