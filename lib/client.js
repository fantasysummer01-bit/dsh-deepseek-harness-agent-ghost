/* Ghost settings contribution. DSH supplies React and the authenticated RPC. */
window.__ModuleLoader__.load({
  id: 'dsh-ghost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const CSS = `
.dsh-ghost{color:var(--dsw-alias-label-primary,#20242c);font-family:inherit;font-size:14px;line-height:1.55;padding-bottom:20px;--ghost-muted:var(--dsw-alias-label-secondary,#707783);--ghost-line:var(--dsw-alias-border-primary,#e3e5e8);--ghost-bg:var(--dsw-alias-bg-layer-2,#fff);--ghost-accent:var(--dsw-alias-brand-primary,#3b73ed)}
.dsh-ghost *{box-sizing:border-box}.dsh-ghost .gh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 18px}.dsh-ghost h2{font-size:21px;line-height:1.35;margin:0 0 5px;font-weight:600}.dsh-ghost p{margin:5px 0}.dsh-ghost .gh-muted{color:var(--ghost-muted);font-size:12px;line-height:1.6}.dsh-ghost .gh-badge{display:inline-flex;align-items:center;white-space:nowrap;gap:6px;border:1px solid var(--ghost-line);border-radius:20px;padding:4px 10px;font-size:12px}.dsh-ghost .gh-dot{width:6px;height:6px;border-radius:50%;background:#3aa77b}.dsh-ghost .gh-dot.off{background:#969ca7}.dsh-ghost .gh-dot.error{background:#d5594e}.dsh-ghost .gh-group{border:1px solid var(--ghost-line);border-radius:10px;padding:16px;margin:0 0 14px;background:var(--ghost-bg)}.dsh-ghost h3{margin:0 0 13px;font-size:14px;font-weight:600}.dsh-ghost .gh-field{display:flex;flex-direction:column;gap:5px;margin-bottom:13px}.dsh-ghost .gh-field:last-child{margin-bottom:0}.dsh-ghost .gh-label{font-size:12px;font-weight:500}.dsh-ghost input[type=text],.dsh-ghost input[type=number],.dsh-ghost textarea{width:100%;border:1px solid var(--ghost-line);border-radius:7px;background:transparent;color:inherit;padding:8px 10px;font:inherit;font-size:13px;line-height:1.5;outline:none}.dsh-ghost input:focus,.dsh-ghost textarea:focus{border-color:var(--ghost-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ghost-accent) 12%,transparent)}.dsh-ghost textarea{resize:vertical;min-height:74px}.dsh-ghost input:disabled,.dsh-ghost textarea:disabled{opacity:.5}.dsh-ghost .gh-check{display:flex;gap:9px;align-items:flex-start;margin:11px 0}.dsh-ghost .gh-check input{accent-color:var(--ghost-accent);margin:5px 0 0;flex:none}.dsh-ghost .gh-check span{display:block}.dsh-ghost .gh-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.dsh-ghost .gh-trait{display:grid;grid-template-columns:65px 1fr 38px;align-items:center;gap:10px;margin:12px 0}.dsh-ghost .gh-trait label{font-size:13px}.dsh-ghost input[type=range]{width:100%;accent-color:var(--ghost-accent)}.dsh-ghost .gh-number{text-align:right;font-variant-numeric:tabular-nums;color:var(--ghost-muted);font-size:12px}.dsh-ghost .gh-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.dsh-ghost .gh-btn{border:1px solid var(--ghost-line);border-radius:7px;padding:7px 12px;cursor:pointer;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1.5}.dsh-ghost .gh-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-ghost .gh-btn:disabled{opacity:.45;cursor:default}.dsh-ghost .gh-btn.primary{color:white;background:var(--ghost-accent);border-color:var(--ghost-accent)}.dsh-ghost .gh-btn.primary:hover:enabled{filter:brightness(.95)}.dsh-ghost .gh-footer{position:sticky;bottom:-24px;background:var(--ghost-bg);padding:13px 0;border-top:1px solid var(--ghost-line);z-index:1;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dsh-ghost .gh-notice{color:var(--ghost-muted);font-size:12px}.dsh-ghost .gh-error{color:var(--dsw-alias-error-primary,#bd4439);font-size:12px;overflow-wrap:anywhere}.dsh-ghost .gh-alert{padding:11px 13px;border:1px solid var(--ghost-line);border-radius:8px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}.dsh-ghost .gh-details{display:grid;grid-template-columns:80px 1fr;gap:5px 10px;font-size:12px;margin:0}.dsh-ghost .gh-details dt{color:var(--ghost-muted)}.dsh-ghost .gh-details dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.dsh-ghost code{font-family:ui-monospace,Consolas,monospace;font-size:11px}.dsh-ghost .gh-result{border-top:1px solid var(--ghost-line);padding:12px 0 2px;margin-top:12px}.dsh-ghost .gh-source{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--ghost-muted);font-size:11px}.dsh-ghost .gh-quote{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;font-size:13px}.dsh-ghost .gh-search{display:flex;gap:8px}.dsh-ghost .gh-search input{min-width:0;flex:1}.dsh-ghost .gh-search button{flex:none}.dsh-ghost .gh-small{font-size:11px}.dsh-ghost .gh-rule{margin:12px 0;border:0;border-top:1px solid var(--ghost-line)}
@media(max-width:640px){.dsh-ghost .gh-grid{grid-template-columns:1fr}.dsh-ghost .gh-head{flex-wrap:wrap}.dsh-ghost .gh-group{padding:13px}.dsh-ghost .gh-footer{bottom:-24px}.dsh-ghost .gh-details{grid-template-columns:65px 1fr}}
`;

    function installStyle() {
      if (document.getElementById('dsh-ghost-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-ghost-style';
      style.dataset.plugin = 'dsh-ghost';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function draftFrom(state) {
      return {
        name: state.name || '', identity: state.identity || '',
        traits: { ...state.traits },
        goalsText: (state.goals || []).map(value => typeof value === 'string' ? value : value.title || '').join('\n'),
        settings: { ...state.settings },
        sessionsText: (state.settings.allowedSessions || []).join('\n'),
      };
    }

    function errorText(error) {
      if (error && error.code === 'VERSION_CONFLICT') {
        return '状态已被其他窗口更新。请重新加载后再修改；本次修改尚未保存。';
      }
      return String(error && error.message || error || '操作失败');
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'gh-field' },
        h('span', { className: 'gh-label' }, label), children,
        hint && h('span', { className: 'gh-muted' }, hint));
    }
    function Group({ title, children }) {
      return h('section', { className: 'gh-group' }, h('h3', null, title), children);
    }
    function Check({ label, hint, checked, disabled, onChange }) {
      return h('label', { className: 'gh-check' },
        h('input', { type: 'checkbox', checked: !!checked, disabled, onChange: event => onChange(event.target.checked) }),
        h('span', null, h('span', null, label), hint && h('span', { className: 'gh-muted' }, hint)));
    }
    function Button({ children, primary, ...props }) {
      return h('button', { type: 'button', ...props, className: 'gh-btn' + (primary ? ' primary' : '') }, children);
    }
    function timeLabel(value) {
      if (!value) return '尚未创建';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function Panel({ api }) {
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState('');
      const [baseVersion, setBaseVersion] = useState(null);
      const [busy, setBusy] = useState('load');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [query, setQuery] = useState('');
      const [results, setResults] = useState(null);
      const mounted = useRef(true);
      const operation = useRef(false);

      const setLoaded = value => {
        const next = draftFrom(value);
        setState(value); setDraft(next); setBaseline(JSON.stringify(next)); setBaseVersion(value.version);
      };
      const run = async (name, work) => {
        if (operation.current) return;
        operation.current = true; setBusy(name); setError(''); setNotice('');
        try { await work(); }
        catch (err) { if (mounted.current) setError(errorText(err)); }
        finally { operation.current = false; if (mounted.current) setBusy(''); }
      };
      const load = () => run('load', async () => {
        const next = await api('status');
        if (mounted.current) setLoaded(next);
      });
      useEffect(() => {
        mounted.current = true;
        load();
        return () => { mounted.current = false; };
      }, []);

      if (!state || !draft) return h('div', { className: 'dsh-ghost' },
        h('h2', null, 'Ghost'), h('p', { className: 'gh-muted', role: 'status' }, busy ? '正在读取本地状态…' : '尚未连接到 Ghost。'),
        error && h('p', { className: 'gh-error', role: 'alert' }, error),
        !busy && h(Button, { onClick: load }, '重新连接'));

      const dirty = JSON.stringify(draft) !== baseline;
      const readonly = !!(state.health && state.health.readOnly);
      const disabled = !!busy || readonly;
      const settings = draft.settings;
      const patch = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
      const setting = (key, value) => setDraft(previous => ({ ...previous, settings: { ...previous.settings, [key]: value } }));
      const save = () => run('save', async () => {
        const parsed = {
          name: draft.name.trim(), identity: draft.identity,
          traits: { ...draft.traits },
          goals: draft.goalsText.split('\n').map(value => value.trim()).filter(Boolean),
          settings: { ...settings, allowedSessions: [...new Set(draft.sessionsText.split('\n').map(value => value.trim()).filter(Boolean))] },
        };
        // A status/verification refresh must not silently rebase an unsaved edit.
        const next = await api('configure', { patch: parsed, expectedVersion: baseVersion });
        if (mounted.current) { setLoaded(next); setNotice('已保存，状态变更已写入本地账本。'); }
      });
      const search = event => {
        if (event) event.preventDefault();
        run('search', async () => {
          const value = await api('search', { query });
          if (mounted.current) setResults(Array.isArray(value) ? value : value.events || value.results || []);
        });
      };
      const checkpoint = () => run('checkpoint', async () => {
        await api('checkpoint');
        const next = await api('status');
        if (mounted.current) { setState(next); setNotice('已创建并校验检查点。'); }
      });
      const verify = () => run('verify', async () => {
        const result = await api('verify');
        const next = await api('status');
        if (mounted.current) {
          setState(next);
          if (result && (result.ok === false || result.valid === false)) setError(result.error || '状态校验未通过。请保留数据并查看诊断。');
          else setNotice('校验通过：账本、检查点与当前状态一致。');
        }
      });
      const download = () => run('export', async () => {
        const value = await api('export');
        if (!mounted.current) return;
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = 'ghost-' + String(state.ghostId).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('已生成导出文件，其中包含授权采集的原始消息，请妥善保存。');
      });
      const cp = state.lastCheckpoint;
      const cpTime = cp && (cp.createdAt || cp.created_at || cp.timestamp);
      return h('div', { className: 'dsh-ghost', 'aria-busy': !!busy },
        h('div', { className: 'gh-head' },
          h('div', null, h('h2', null, 'Ghost'), h('p', { className: 'gh-muted' }, '持续的身份，有来源的记忆。')),
          h('span', { className: 'gh-badge' }, h('span', { className: 'gh-dot' + (readonly ? ' error' : !state.settings.enabled ? ' off' : '') }), readonly ? '只读诊断' : state.settings.enabled ? '本地运行' : '已停用')),
        readonly && h('div', { className: 'gh-alert', role: 'alert' },
          h('strong', null, '状态校验失败，已停止写入'),
          h('p', { className: 'gh-error' }, state.health.error || '请保留现有数据，排查恢复问题后重新启动。')),
        state.bridge && state.bridge.lastCaptureError && h('div', { className: 'gh-alert', role: 'alert' },
          h('strong', null, '最近一条消息未能写入记忆'),
          h('p', { className: 'gh-error' }, state.bridge.lastCaptureError)),
        h(Group, { title: '基本设置' },
          h(Check, { label: '启用 Ghost', hint: '身份与命中的记忆会随 DSH 请求发送给当前配置的模型。停用后保留本机数据。', checked: settings.enabled, disabled, onChange: value => setting('enabled', value) }),
          h(Check, { label: '记录后续可见消息', hint: '保存后开始采集；不读取旧聊天、系统提示词或工具秘密。原始记录存储在本机，命中片段按上方说明用于模型上下文。', checked: settings.captureEnabled, disabled, onChange: value => setting('captureEnabled', value) }),
          settings.captureEnabled && h(Check, { label: '同时记录助手回复', hint: '助手回复标记为模型输出，不作为外界事实或自动人格变化的依据。', checked: settings.captureAssistant, disabled, onChange: value => setting('captureAssistant', value) }),
          h(Field, { label: '授权会话范围', hint: '每行填写一个会话 ID。留空表示授权全部会话的后续新消息；填写后仅采集列出的会话。' },
            h('textarea', { value: draft.sessionsText, disabled, rows: 2, placeholder: '留空：全部后续会话', onChange: event => patch('sessionsText', event.target.value) })),
          h('div', { className: 'gh-grid' },
            h(Field, { label: '上下文上限（UTF-8 字节）', hint: '固定上限，用于限制每轮注入。字节数不等同于 token 数。' },
              h('input', { type: 'number', min: 512, max: 12000, step: 256, value: settings.contextBudgetBytes, disabled, onChange: event => setting('contextBudgetBytes', Number(event.target.value)) })),
            h(Field, { label: '每次最多召回条数', hint: '只返回命中的原始证据。' },
              h('input', { type: 'number', min: 1, max: 8, value: settings.topK, disabled, onChange: event => setting('topK', Number(event.target.value)) })))),
        h(Group, { title: '身份' },
          h(Field, { label: '名称', hint: '新会话仍使用同一 Ghost 身份。修改名称会记录状态版本。' },
            h('input', { type: 'text', value: draft.name, maxLength: 64, disabled, onChange: event => patch('name', event.target.value) })),
          h(Field, { label: '身份与行为边界', hint: '由你明确设定。聊天内容不会自动改写这里。' },
            h('textarea', { value: draft.identity, disabled, rows: 4, maxLength: 4000, placeholder: '你希望 Ghost 以怎样的身份与你协作？', onChange: event => patch('identity', event.target.value) }))),
        h(Group, { title: '性格与未完成目标' },
          h('p', { className: 'gh-muted' }, '这些数值是可调整的行为倾向，不代表客观情绪。当前版本由你手动调整并记录变更。'),
          ...[['curiosity', '好奇心'], ['initiative', '主动性'], ['caution', '谨慎度']].map(([key, label]) => h('div', { className: 'gh-trait', key },
            h('label', { htmlFor: 'ghost-trait-' + key }, label),
            h('input', { type: 'range', id: 'ghost-trait-' + key, min: 0, max: 1, step: 0.01, value: draft.traits[key] ?? 0.5, disabled, onChange: event => patch('traits', { ...draft.traits, [key]: Number(event.target.value) }) }),
            h('output', { className: 'gh-number', htmlFor: 'ghost-trait-' + key }, Number(draft.traits[key] ?? 0.5).toFixed(2)))),
          h('hr', { className: 'gh-rule' }),
          h(Field, { label: '未完成目标', hint: '每行一个目标，随状态保存，重启后恢复。' },
            h('textarea', { value: draft.goalsText, disabled, rows: 3, placeholder: '例如：继续完善 Ghost 的记忆策略', onChange: event => patch('goalsText', event.target.value) }))),
        h(Group, { title: '记忆检索' },
          h('p', { className: 'gh-muted' }, '按关键词查看已保存的证据。没有记录的细节，不会补成回忆。'),
          h('form', { className: 'gh-search', onSubmit: search },
            h('input', { type: 'text', value: query, maxLength: 200, 'aria-label': '检索已保存记忆', placeholder: '输入关键词，例如「公园」', disabled: !!busy, onChange: event => setQuery(event.target.value) }),
            h(Button, { type: 'submit', disabled: !!busy || !query.trim() }, busy === 'search' ? '检索中…' : '检索')),
          results && (results.length ? results.map((row, index) => h('article', { className: 'gh-result', key: row.eventId || index },
            h('div', { className: 'gh-source' },
              h('span', null, row.role === 'assistant' ? '助手输出 · 非外界事实' : '用户原话'),
              h('span', null, timeLabel(row.timestamp))),
            h('p', { className: 'gh-quote' }, row.text),
            h('div', { className: 'gh-source' }, h('code', null, row.eventId), row.sessionId && h('span', null, '会话 ' + row.sessionId))))
            : h('p', { className: 'gh-muted', role: 'status' }, '未找到匹配证据。'))),
        h(Group, { title: '检查点与恢复' },
          h('dl', { className: 'gh-details' },
            h('dt', null, '状态版本'), h('dd', null, 'v' + state.version),
            h('dt', null, 'Ghost ID'), h('dd', null, h('code', null, state.ghostId)),
            h('dt', null, '分支 ID'), h('dd', null, h('code', null, state.branchId)),
            h('dt', null, '已存事件'), h('dd', null, String(state.counts && state.counts.events || 0) + ' 条'),
            h('dt', null, '检查点'), h('dd', null, cp ? timeLabel(cpTime) : '尚未创建')),
          h('p', { className: 'gh-muted', style: { marginTop: 12, marginBottom: 12 } }, '启动时自动校验并恢复已提交状态。检查点不等于备份；校验失败时保留数据并进入只读诊断。'),
          h('div', { className: 'gh-row' },
            h(Button, { onClick: checkpoint, disabled: disabled || dirty }, busy === 'checkpoint' ? '创建中…' : '创建检查点'),
            h(Button, { onClick: verify, disabled: !!busy }, busy === 'verify' ? '校验中…' : '校验状态'),
            h(Button, { onClick: download, disabled: !!busy }, busy === 'export' ? '导出中…' : '导出数据')),
          dirty && h('p', { className: 'gh-muted' }, '先保存当前修改，再创建检查点。')),
        h('p', { className: 'gh-muted gh-small' }, '第一阶段：本地身份、可追溯事件、状态账本与恢复。不自动调用外部模型。软件状态连续性不代表主观意识。'),
        h('div', { className: 'gh-footer' },
          h(Button, { primary: true, onClick: save, disabled: disabled || !dirty }, busy === 'save' ? '保存中…' : '保存修改'),
          h(Button, { onClick: load, disabled: !!busy }, dirty ? '放弃修改并重新加载' : '刷新状态'),
          dirty && !error && h('span', { className: 'gh-notice' }, '有未保存的修改'),
          notice && h('span', { className: 'gh-notice', role: 'status' }, notice),
          error && h('span', { className: 'gh-error', role: 'alert' }, error)));
    }

    function apply(ctx) {
      installStyle();
      const api = async (action, payload = {}) => {
        const response = await ctx.connection.rpc.call('/ghost', action, payload);
        if (!response || response.ok !== true) {
          const problem = response && response.error || {};
          const error = new Error(problem.message || 'Ghost 暂不可用，请检查插件状态。');
          error.code = problem.code; error.details = problem.details;
          throw error;
        }
        return response.value;
      };
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'ghost', order: 27, label: 'Ghost' },
        () => h(Panel, { api })));
    }

    return { name: 'dsh-ghost', inject: ['slots', 'connection'], apply };
  },
});
