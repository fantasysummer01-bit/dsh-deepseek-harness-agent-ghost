/* Ghost settings contribution. DSH supplies React and authenticated local RPC. */
window.__ModuleLoader__.load({
  id: 'dsh-ghost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const CSS = `
.dsh-ghost{color:var(--dsw-alias-label-primary,#20242c);font-family:inherit;font-size:14px;line-height:1.6;padding:4px 0 24px;--gh-muted:var(--dsw-alias-label-secondary,#727986);--gh-line:var(--dsw-alias-border-primary,#e3e5e8);--gh-bg:var(--dsw-alias-bg-layer-2,#fff);--gh-accent:var(--dsw-alias-brand-primary,#376df0);--gh-danger:var(--dsw-alias-error-primary,#bd4439)}
.dsh-ghost *{box-sizing:border-box}.dsh-ghost h2{margin:0;font-size:24px;font-weight:600;letter-spacing:-.4px}.dsh-ghost h3{margin:0 0 12px;font-size:14px;font-weight:600}.dsh-ghost p{margin:7px 0}.dsh-ghost .gh-head{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:22px}.dsh-ghost .gh-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--gh-muted);white-space:nowrap}.dsh-ghost .gh-dot{height:7px;width:7px;border-radius:50%;background:#9299a4}.dsh-ghost .gh-dot.running{background:#31a77b}.dsh-ghost .gh-dot.error{background:var(--gh-danger)}.dsh-ghost .gh-copy{color:var(--gh-muted);font-size:13px;line-height:1.8;max-width:540px}.dsh-ghost .gh-count{font-size:12px;color:var(--gh-muted);margin-top:18px}.dsh-ghost .gh-actions{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}.dsh-ghost .gh-btn{border:1px solid var(--gh-line);border-radius:8px;padding:9px 16px;font:inherit;font-size:13px;line-height:1.5;color:inherit;background:transparent;cursor:pointer}.dsh-ghost .gh-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-ghost .gh-btn.primary{background:var(--gh-accent);border-color:var(--gh-accent);color:#fff}.dsh-ghost .gh-btn.danger{color:var(--gh-danger);border-color:var(--gh-danger)}.dsh-ghost .gh-btn:disabled{opacity:.45;cursor:default}.dsh-ghost .gh-link{font:inherit;font-size:12px;color:var(--gh-muted);border:0;background:transparent;padding:4px 0;cursor:pointer}.dsh-ghost .gh-link:hover:enabled{text-decoration:underline}.dsh-ghost .gh-link:disabled{opacity:.5;cursor:default}.dsh-ghost .gh-maintenance{border-top:1px solid var(--gh-line);margin-top:30px;padding-top:13px}.dsh-ghost .gh-review{border:1px solid var(--gh-line);border-radius:10px;padding:16px;margin-top:10px}.dsh-ghost .gh-muted{color:var(--gh-muted);font-size:12px;line-height:1.7}.dsh-ghost .gh-error{color:var(--gh-danger);font-size:12px;overflow-wrap:anywhere}.dsh-ghost .gh-alert{padding:13px 15px;border:1px solid var(--gh-line);border-radius:9px;margin:14px 0}.dsh-ghost .gh-details{display:grid;grid-template-columns:76px 1fr;gap:6px 10px;font-size:12px;margin:14px 0}.dsh-ghost .gh-details dt{color:var(--gh-muted)}.dsh-ghost .gh-details dd{margin:0;overflow-wrap:anywhere}.dsh-ghost code{font:11px/1.6 ui-monospace,Consolas,monospace}.dsh-ghost .gh-scope{padding-left:18px;margin:10px 0;font-size:12px;overflow-wrap:anywhere}.dsh-ghost .gh-check{display:flex;gap:9px;align-items:flex-start;font-size:12px;margin:16px 0}.dsh-ghost .gh-check input{margin:5px 0 0;accent-color:var(--gh-accent);flex:none}.dsh-ghost .gh-field{display:flex;flex-direction:column;gap:6px;font-size:12px;margin:14px 0}.dsh-ghost input[type=text]{width:100%;font:13px/1.5 ui-monospace,Consolas,monospace;color:inherit;background:transparent;border:1px solid var(--gh-line);border-radius:7px;padding:8px 10px;outline:none}.dsh-ghost input:focus{border-color:var(--gh-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--gh-accent) 12%,transparent)}.dsh-ghost .gh-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:15px}@media(max-width:620px){.dsh-ghost .gh-head{align-items:flex-start}.dsh-ghost .gh-review{padding:13px}.dsh-ghost .gh-details{grid-template-columns:65px 1fr}}
`;
    function installStyle() {
      if (document.getElementById('dsh-ghost-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-ghost-style'; style.dataset.plugin = 'dsh-ghost'; style.textContent = CSS;
      document.head.appendChild(style);
    }
    function errorText(error) {
      if (['PLAN_EXPIRED', 'UNINSTALL_PLAN_EXPIRED', 'PLAN_STALE', 'UNINSTALL_PLAN_STALE', 'VERSION_CONFLICT'].includes(error?.code)) {
        return '卸载计划已过期或状态发生变化。请重新准备计划并核对后再确认。';
      }
      return String(error?.message || error || '操作失败');
    }
    function Button({ children, primary, danger, ...props }) {
      return h('button', { type: 'button', ...props, className: 'gh-btn' + (primary ? ' primary' : '') + (danger ? ' danger' : '') }, children);
    }
    function timeLabel(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString();
    }
    function Panel({ api }) {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState('load');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [uninstallOpen, setUninstallOpen] = useState(false);
      const [uninstallPlan, setUninstallPlan] = useState(null);
      const [uninstallText, setUninstallText] = useState('');
      const [eraseAcknowledged, setEraseAcknowledged] = useState(false);
      const mounted = useRef(true), operation = useRef(false);
      const run = async (name, work) => {
        if (operation.current) return;
        operation.current = true; setBusy(name); setError(''); setNotice('');
        try { await work(); }
        catch (err) { if (mounted.current) setError(errorText(err)); }
        finally { operation.current = false; if (mounted.current) setBusy(''); }
      };
      const load = () => run('load', async () => {
        const next = await api('status'); if (mounted.current) setState(next);
      });
      useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; }; }, []);
      if (!state) return h('div', { className: 'dsh-ghost' }, h('h2', null, 'Ghost'),
        h('p', { className: 'gh-muted', role: 'status' }, busy ? '正在连接本地 Ghost…' : '尚未连接到 Ghost。'),
        error && h('p', { className: 'gh-error', role: 'alert' }, error),
        !busy && h(Button, { onClick: load }, '重新连接'));
      const pending = !!state.uninstall?.pending;
      const readonly = !!state.health?.readOnly;
      const running = !pending && !readonly && (typeof state.running === 'boolean' ? state.running : !!(state.settings?.enabled && state.settings?.captureEnabled));
      const toggle = () => run(running ? 'stop' : 'start', async () => {
        const next = await api(running ? 'stop' : 'start');
        if (mounted.current) { setState(next); setNotice(running ? 'Ghost 已关闭，已有记忆仍保留在本机。' : 'Ghost 已启动，开始积累后续交流。'); }
      });
      const exportCore = () => run('export', async () => {
        const value = await api('export');
        if (value?.format !== 'dsh-ghost-core' || value.formatVersion !== 1 || !value.state?.ghostId || !value.sha256) {
          throw new Error('未取得有效 Ghost 核心文件 / Invalid Ghost core export');
        }
        const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        try {
          link.href = url; link.download = 'ghost-core-' + String(value.state.ghostId).replace(/[^a-zA-Z0-9-]/g, '') + '.json';
          document.body.appendChild(link); link.click();
          if (mounted.current) setNotice('Ghost 核心文件已生成 / Ghost core export is ready');
        } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
      });
      const prepareUninstall = () => run('uninstallplan', async () => {
        const value = await api('uninstallplan');
        if (!value || typeof value.planId !== 'string' || !Number.isFinite(new Date(value.expiresAt).getTime())
          || !Number.isSafeInteger(value.stateVersion) || value.confirmationText !== 'UNINSTALL GHOST') throw new Error('未能取得有效卸载计划，未执行卸载。');
        if (mounted.current) { setUninstallPlan(value); setUninstallText(''); setEraseAcknowledged(false); }
      });
      const openUninstall = () => { setUninstallOpen(true); return prepareUninstall(); };
      const cancelUninstall = () => {
        setUninstallOpen(false); setUninstallPlan(null); setUninstallText(''); setEraseAcknowledged(false); setError('');
      };
      const planExpired = !!uninstallPlan && new Date(uninstallPlan.expiresAt).getTime() <= Date.now();
      const canConfirm = !!uninstallPlan && !planExpired && eraseAcknowledged && uninstallText === 'UNINSTALL GHOST' && !busy && !pending;
      const confirmUninstall = () => {
        if (!uninstallPlan || !eraseAcknowledged || uninstallText !== 'UNINSTALL GHOST' || pending) return;
        if (new Date(uninstallPlan.expiresAt).getTime() <= Date.now()) { setError('卸载计划已过期。请重新准备计划并核对后再确认。'); return; }
        return run('uninstallconfirm', async () => {
          const result = await api('uninstallconfirm', { planId: uninstallPlan.planId, confirmation: uninstallText,
            eraseData: true, expectedVersion: uninstallPlan.stateVersion });
          if (!result || result.pending !== true) throw new Error('后台未确认卸载已排队，请刷新状态核实。');
          if (mounted.current) {
            setState(previous => ({ ...previous, uninstall: result })); setUninstallPlan(null); setUninstallOpen(false);
            setNotice('Ghost 已停用。请在其他任务结束后正常退出 DSH，卸载将在退出后完成。');
          }
        });
      };
      return h('div', { className: 'dsh-ghost', 'aria-busy': !!busy },
        h('div', { className: 'gh-head' }, h('h2', null, 'Ghost'),
          h('span', { className: 'gh-badge' }, h('span', { className: 'gh-dot' + (pending ? '' : readonly ? ' error' : running ? ' running' : '') }), pending ? '待卸载' : readonly ? '暂不可用' : running ? '运行中' : '已关闭')),
        h('div', { className: 'gh-copy' },
          h('p', null, '所有对话延续同一个 Ghost。以虚拟海马体串联经历、记忆与 LLM，让人格在长期交流中逐步形成。'),
          h('p', null, '近 15 天强化细节，16–60 天保留概要与重点；60 天以上留下梗概与关注瞬间。回忆带入当前人格，区分记得与推演；公共事实需要可靠核验。'),
          h('p', { className: 'gh-muted' }, 'One Ghost across conversations. A virtual hippocampus connects experience, memory and an LLM into an evolving virtual personality. Detailed memories for 15 days, summaries through day 60, then gist and attention snapshots. Recall uses the current personality; inference stays distinct from memory, and public facts require verification.')),
        h('p', { className: 'gh-count' }, '已积累 ' + String(state.counts?.events || 0) + ' 条经历'),
        pending ? h('div', { className: 'gh-alert', role: 'status' },
          h('strong', null, '完全卸载已排队，Ghost 已停用'),
          h('p', { className: 'gh-muted' }, '当前 DSH 任务会继续运行。请在任务结束后通过“应用 → 退出”正常退出 DSH，后台会随后移除插件并删除计划内的本地 Ghost 数据。'),
          state.uninstall.error && h('p', { className: 'gh-error', role: 'alert' }, state.uninstall.error),
          h(Button, { onClick: load, disabled: !!busy }, '刷新卸载状态'))
          : h('div', { className: 'gh-actions' }, h(Button, { primary: !running, disabled: !!busy || readonly, onClick: toggle },
            busy === 'start' ? '启动中…' : busy === 'stop' ? '关闭中…' : running ? '关闭' : '启动 GHOST 系统'),
            readonly && h(Button, { onClick: load, disabled: !!busy }, '刷新状态')),
        readonly && h('p', { className: 'gh-error', role: 'alert' }, state.health.error || '本地状态校验未通过，已停止写入。'),
        state.bridge?.lastCaptureError && h('p', { className: 'gh-error', role: 'alert' }, '最近一条消息未能写入记忆：' + state.bridge.lastCaptureError),
        notice && h('p', { className: 'gh-muted', role: 'status' }, notice),
        !pending && h('div', { className: 'gh-maintenance' },
          !uninstallOpen ? h('div', { className: 'gh-row' },
            h('button', { type: 'button', className: 'gh-link', disabled: !!busy || readonly, onClick: exportCore }, '导出 Ghost 核心'),
            h('button', { type: 'button', className: 'gh-link', disabled: !!busy, onClick: openUninstall }, '卸载 Ghost'))
            : h('div', { className: 'gh-review', 'aria-label': '完全卸载审核' },
              h('h3', null, '完全卸载 Ghost'),
              h('p', { className: 'gh-muted' }, '移除当前 DSH 配置中的 dsh-ghost 插件，并不可恢复地删除当前数据目录里的 Ghost 记忆、身份归纳、性格、目标和检查点。'),
              h('p', { className: 'gh-muted' }, '保留 DSH 聊天、账号、模型、其他插件、项目源码与 GitHub 仓库。手工导出或保存在其他位置的备份不会自动删除。'),
              busy === 'uninstallplan' && h('p', { className: 'gh-muted', role: 'status' }, '正在准备卸载计划…'),
              uninstallPlan && h('div', null,
                h('dl', { className: 'gh-details' },
                  h('dt', null, 'Ghost ID'), h('dd', null, h('code', null, uninstallPlan.ghostId)),
                  h('dt', null, '数据目录'), h('dd', null, h('code', null, uninstallPlan.dataDir)),
                  h('dt', null, '宿主配置'), h('dd', null, h('code', null, uninstallPlan.profileDir)),
                  h('dt', null, '计划有效期'), h('dd', null, timeLabel(uninstallPlan.expiresAt))),
                h('ul', { className: 'gh-scope' }, ...(uninstallPlan.deleteFiles || []).map((file, index) => h('li', { key: index }, typeof file === 'string' ? file : String(file.path || file.name || 'Ghost 自有文件')))),
                uninstallPlan.retained?.length ? h('ul', { className: 'gh-scope' }, ...uninstallPlan.retained.map((item, index) => h('li', { key: index }, String(item)))) : null,
                h('p', { className: 'gh-muted' }, '确认后只停用 Ghost，不会退出或重启 DSH。卸载程序会等待 DSH 正常退出后再移除插件和数据。'),
                planExpired && h('p', { className: 'gh-error', role: 'alert' }, '卸载计划已过期，请重新准备。'),
                h('label', { className: 'gh-check' }, h('input', { type: 'checkbox', checked: eraseAcknowledged, disabled: !!busy,
                  'aria-label': '确认删除 Ghost 本地记忆与状态', onChange: event => setEraseAcknowledged(event.target.checked) }),
                  h('span', null, '我确认不可恢复地删除计划内的 Ghost 本地记忆与状态')),
                h('label', { className: 'gh-field' }, h('span', null, '输入 UNINSTALL GHOST 以确认'),
                  h('input', { type: 'text', value: uninstallText, autoComplete: 'off', spellCheck: false, disabled: !!busy,
                    'aria-label': '卸载确认文字', onChange: event => setUninstallText(event.target.value) })),
                h(Button, { danger: true, disabled: !canConfirm, onClick: confirmUninstall }, busy === 'uninstallconfirm' ? '提交卸载中…' : '确认完全卸载')),
              h('div', { className: 'gh-row' },
                h(Button, { disabled: !!busy, onClick: prepareUninstall }, '重新准备卸载计划'),
                h(Button, { disabled: !!busy, onClick: cancelUninstall }, '取消卸载审核')))),
        error && h('p', { className: 'gh-error', role: 'alert' }, error));
    }
    function apply(ctx) {
      installStyle();
      const api = async (action, payload = {}) => {
        const response = await ctx.connection.rpc.call('/ghost', action, payload);
        if (!response || response.ok !== true) {
          const problem = response?.error || {};
          const error = new Error(problem.message || 'Ghost 暂不可用，请检查插件状态。');
          error.code = problem.code; error.details = problem.details; throw error;
        }
        return response.value;
      };
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'ghost', order: 27, label: 'Ghost' }, () => h(Panel, { api })));
    }
    return { name: 'dsh-ghost', inject: ['slots', 'connection'], apply };
  },
});
