import { cleanText, probe, PROBE_TIMEOUT_MS } from './probe.js'

export const name = 'local-model-check'
const PAGE_MODELS = 20, PAGE_PROVIDERS = 8, PAGE_RESULTS = 10, MAX_BATCH = 50
// Survives plugin disable/re-enable and module reload in the same engine. An
// old adapter ignoring abort must retain the dispatch lease until it exits.
const laneKey = Symbol.for('dsh-go.local-model-check.dispatch-lane.v1')
const lane = globalThis[laneKey] ??= { owner: null, observers: new Set() }
const bind = field => ({ $: `data.${field}` })
const action = (label, id, args) => ({ label, action: args ? { id, args } : id })
const statusNames = { unstarted: '未检测', running: '检测中', success: '成功', truncated: '响应被截断', empty: '无文本', incomplete: '响应不完整', failed: '失败', timeout: '超时', cancelled: '已取消' }
const duration = ms => Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} 秒` : '—'
const pageCount = (items, size) => Math.max(1, Math.ceil(items.length / size))
const beijingClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function formatBeijingTime(value) {
  if (typeof value !== 'string' || !value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const parts = Object.fromEntries(beijingClock.formatToParts(date).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function resultDetails(detail) {
  if (!detail) return []
  const success = detail.status === 'success'
  return [
    ['模型', detail.name], ['模型 ID', cleanText(detail.model, 160)], ['状态', statusNames[detail.status]],
    ['开始时间（北京时间）', formatBeijingTime(detail.startedAt)], ['总耗时', duration(detail.elapsedMs)],
    ['首段文本等待', duration(detail.firstTextMs)],
    // Do not invent HTTP 200 for a successful stream. Only show an unknown
    // status when it helps diagnose an unsuccessful or unfinished request.
    ...(detail.httpStatus || !success ? [['HTTP 状态', detail.httpStatus ? `${detail.httpStatus}${detail.httpStatusSource === 'message' ? '（从错误信息识别）' : ''}` : '未采集（适配器未提供）']] : []),
    ...(!success ? [['错误分类', detail.code ?? '—']] : []),
    ['请求阶段', success ? '已正常完成' : detail.phase === 'prepare' ? '本地请求准备，未派发' : detail.phase === 'stream' ? '适配器调用（不代表服务端已收到）' : '—'],
    ['说明', cleanText(detail.message ?? '尚未开始，不会自动请求。', 190)],
    ...(!success ? [['诊断提示', detail.hint ?? '—']] : []),
  ]
}

// Static v1 layout; lists and buttons are fed through bounded data bindings.
export function checkerView() {
  return { type: 'stack', title: '模型检测', children: [
    { type: 'callout', tone: 'info', text: '检测器 v0.1.2。实际请求可能计费。仅验证本次文本生成，不验证模型身份、识图或工具调用。' },
    { type: 'text', text: bind('providerLabel') },
    { type: 'options', id: 'pick-provider', selected: bind('providerSelected'), options: bind('providerOptions') },
    { type: 'actions', items: bind('providerActions') },
    { type: 'text', text: bind('modelLabel') },
    { type: 'list', items: bind('modelRows') },
    { type: 'actions', items: bind('modelActions') },
    { type: 'text', text: bind('selectionLabel') },
    { type: 'actions', items: bind('runActions') },
    { type: 'stack', children: bind('confirmationView') },
    { type: 'text', text: bind('summary') },
    { type: 'progress', value: bind('completed'), max: bind('total'), label: bind('progressLabel') },
    { type: 'list', items: bind('resultRows') },
    { type: 'actions', items: bind('resultActions') },
    { type: 'keyValue', items: bind('detail') },
    { type: 'text', text: bind('output') },
    { type: 'callout', tone: 'info', text: bind('notice') },
    { type: 'text', tone: 'muted', text: '关闭前请先点停止。断线后订阅最多约 30 秒才回收；取消不保证服务端停止计费。结果仅存内存，重启引擎后清空。' },
  ] }
}

function keyOf(scope = {}) {
  return JSON.stringify(['sessionId', 'turnId', 'messageId', 'callId'].map(k => typeof scope[k] === 'string' ? scope[k] : ''))
}
function abortError() { return Object.assign(new Error('Cancelled'), { name: 'AbortError' }) }
function readChoice(event) { return typeof event?.value?.value === 'string' ? event.value.value : '' }
function readToken(event) { return typeof event?.value?.token === 'string' ? event.value.token : '' }

export function createChecker(ctx, { timeoutMs = PROBE_TIMEOUT_MS, graceMs = 500 } = {}) {
  const states = new Map()
  let active = null, disposed = false, sequence = 0
  const llm = () => ctx.get?.('llm') ?? ctx.llm
  const available = () => {
    const service = llm()
    return service && ['listProviders', 'listModels', 'prepareCall'].every(k => typeof service[k] === 'function') ? service : undefined
  }
  const locked = s => active?.state === s

  function syncProviders(s) {
    s.providerEpoch++
    const service = available()
    s.ready = Boolean(service)
    try {
      const entries = service?.listProviders() ?? []
      s.providers = entries.filter(p => typeof p.id === 'string' && typeof p.name === 'string').map(p => ({ id: p.id, name: cleanText(p.name, 60) }))
      if (!s.providers.some(p => p.id === s.provider)) {
        s.provider = ''; s.models = []; s.selected.clear(); s.modelEpoch++
      }
      s.providerPage = Math.min(s.providerPage, pageCount(s.providers, PAGE_PROVIDERS) - 1)
      s.plan = null
      s.notice = !service ? '当前主机没有可用的模型服务，请检查引擎。' : !s.providers.length ? '没有已启用的渠道，请先到设置 → 模型添加渠道。' : '请选择渠道加载模型；读取列表不代表生成可用。'
    } catch {
      s.providers = []; s.provider = ''; s.models = []; s.selected.clear(); s.modelEpoch++
      s.notice = '读取渠道失败，请检查引擎后刷新。'
    }
  }
  function stateOf(scope) {
    const key = keyOf(scope)
    let s = states.get(key)
    if (s) return s
    // Only evict idle, unsubscribed panels; never evict a task or its observers.
    if (states.size >= 24) {
      for (const [oldKey, old] of states) {
        if (!old.listeners.size && !locked(old) && !old.loading) { states.delete(oldKey); break }
      }
    }
    s = { key, listeners: new Set(), providers: [], provider: '', providerPage: 0, providerEpoch: 0,
      models: [], modelEpoch: 0, modelPage: 0, selected: new Set(), loading: false, loadController: null,
      notice: '', plan: null, run: null, resultPage: 0, detailIndex: 0, ready: false }
    states.set(key, s)
    syncProviders(s)
    return s
  }
  function render(s) {
    const providerStart = s.providerPage * PAGE_PROVIDERS
    const modelStart = s.modelPage * PAGE_MODELS
    const run = s.run
    const rows = run?.rows ?? []
    const completed = rows.filter(r => r.status !== 'unstarted' && r.status !== 'running').length
    const success = rows.filter(r => r.status === 'success').length
    const other = completed - success
    const unstarted = rows.filter(r => r.status === 'unstarted').length
    const busy = locked(s)
    const anyBusy = Boolean(active || lane.owner)
    const pIndex = s.providers.findIndex(p => p.id === s.provider)
    const providerActions = [action('刷新列表', 'refresh-catalog')]
    if (s.providerPage > 0) providerActions.push(action('上一页渠道', 'prev-provider'))
    if (s.providerPage + 1 < pageCount(s.providers, PAGE_PROVIDERS)) providerActions.push(action('下一页渠道', 'next-provider'))
    const modelActions = []
    if (!busy && !s.loading) {
      if (s.modelPage > 0) modelActions.push(action('上一页模型', 'prev-model'))
      if (s.modelPage + 1 < pageCount(s.models, PAGE_MODELS)) modelActions.push(action('下一页模型', 'next-model'))
      modelActions.push(action('全选本页', 'select-page'), action('清空选择', 'clear-selection'))
    }
    const runActions = anyBusy ? (busy ? [action('停止检测', 'stop-run')] : []) : [action('开始检测', 'prepare-run')]
    if (!anyBusy && unstarted && run?.provider === s.provider) runActions.push(action('仅测未开始项', 'prepare-remaining'))
    const resultActions = []
    if (s.resultPage > 0) resultActions.push(action('上一页结果', 'prev-result'))
    if (s.resultPage + 1 < pageCount(rows, PAGE_RESULTS)) resultActions.push(action('下一页结果', 'next-result'))
    const detail = rows[s.detailIndex]
    const confirmation = s.plan ? [
      { type: 'callout', tone: 'warn', text: `即将检测「${s.plan.providerName}」的 ${s.plan.models.length} 个模型，每项最多 256 输出 token，可能计费。不会发送聊天历史。` },
      { type: 'confirm', id: s.plan.nonce, confirmLabel: '确认开始', cancelLabel: '暂不检测' },
    ] : []
    return {
      providerLabel: `渠道 ${s.providerPage + 1}/${pageCount(s.providers, PAGE_PROVIDERS)} · ${s.providers.length} 个`,
      providerSelected: pIndex < 0 ? '' : `${s.providerEpoch}:${pIndex}`,
      providerOptions: s.providers.slice(providerStart, providerStart + PAGE_PROVIDERS).map((p, i) => ({ label: p.name, value: `${s.providerEpoch}:${providerStart + i}` })),
      providerActions: busy ? [] : providerActions,
      modelLabel: s.loading ? '正在加载模型…' : `模型 ${s.modelPage + 1}/${pageCount(s.models, PAGE_MODELS)} · ${s.models.length} 个 · 点按勾选`,
      modelRows: s.models.slice(modelStart, modelStart + PAGE_MODELS).map((m, i) => ({ title: m.name, subtitle: cleanText(m.id, 120), icon: s.selected.has(m.id) ? 'check' : 'model', ...(!busy && !s.loading ? { action: { id: 'toggle-model', args: { token: `${s.modelEpoch}:${modelStart + i}` } } } : {}) })),
      modelActions,
      selectionLabel: `已选 ${s.selected.size} 个；每轮最多 ${MAX_BATCH} 个，串行检测，每项最长 ${Math.round(timeoutMs / 1000)} 秒。`,
      runActions,
      confirmation,
      // Empty stacks become a visible "no data" card. Keep one blank text
      // child instead: the layout stays non-empty without a placeholder card.
      // Pending plans retain their full, literal confirmation components.
      confirmationView: confirmation.length ? confirmation : [{ type: 'text', text: '' }],
      summary: run ? `${run.providerName} · 成功 ${success} · 其他 ${other} · 未检测 ${unstarted}` : '尚无检测结果。',
      completed, total: Math.max(1, rows.length),
      progressLabel: busy ? active.waiting ? '适配器尚未退出，等待清理；禁止新请求。' : `已完成 ${completed}/${rows.length} · ${cleanText(rows[run.current]?.name ?? '准备中', 60)}` : run ? `已完成 ${completed}/${rows.length} · ${run.reason}` : '未开始',
      resultRows: rows.slice(s.resultPage * PAGE_RESULTS, (s.resultPage + 1) * PAGE_RESULTS).map((r, i) => ({ title: r.name, subtitle: `${statusNames[r.status]} · ${duration(r.elapsedMs)}`, tone: r.status === 'success' ? 'good' : r.status === 'unstarted' || r.status === 'running' ? 'info' : 'warn', action: { id: 'show-result', args: { token: `${run.id}:${s.resultPage * PAGE_RESULTS + i}` } } })),
      resultActions,
      detail: resultDetails(detail),
      output: detail?.output ? `返回摘要：\n${detail.output}` : '返回摘要：—',
      notice: anyBusy && !busy ? '其他面板或旧插件请求仍在检测或清理；请等待结束。' : s.notice,
    }
  }
  function publish(s) {
    if (disposed) return
    const data = render(s)
    for (const emit of s.listeners) { try { emit(data) } catch {} }
  }
  function publishAll() { for (const s of states.values()) publish(s) }
  function invalidate(s) { s.plan = null; publish(s) }
  function tokenIndex(token, epoch, length) {
    const match = /^(\d+):(\d+)$/.exec(token)
    if (!match || Number(match[1]) !== epoch) return -1
    const index = Number(match[2])
    return Number.isSafeInteger(index) && index < length ? index : -1
  }
  function loadModels(s, bridgeSignal) {
    const epoch = ++s.modelEpoch
    s.loadController?.abort()
    const controller = s.loadController = new AbortController()
    const abort = () => controller.abort()
    if (bridgeSignal.aborted) abort()
    else bridgeSignal.addEventListener('abort', abort, { once: true })
    const provider = s.provider
    s.loading = true; s.plan = null; publish(s)
    let timer, abortListener
    const wait = new Promise((_, reject) => {
      abortListener = () => reject(abortError())
      if (controller.signal.aborted) abortListener()
      else controller.signal.addEventListener('abort', abortListener, { once: true })
      timer = setTimeout(() => controller.abort(), 15_000)
    })
    const loading = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      const service = available()
      if (!service) throw abortError()
      return service.listModels(provider)
    })
    return Promise.race([loading, wait]).then(models => {
      if (disposed || epoch !== s.modelEpoch || controller.signal.aborted) return
      const seen = new Set()
      s.models = models.filter(m => {
        if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) return false
        seen.add(m.id); return true
      }).map(m => ({ id: m.id, name: cleanText(m.name || m.id, 70) }))
      s.selected = new Set([...s.selected].filter(id => seen.has(id)))
      s.modelPage = Math.min(s.modelPage, pageCount(s.models, PAGE_MODELS) - 1)
      s.notice = s.models.length ? '模型列表已加载。勾选后点开始检测；列表可见不代表模型可用。' : '渠道没有列出模型；请到设置 → 模型手动添加模型 ID。'
    }).catch(() => {
      if (disposed || epoch !== s.modelEpoch) return
      s.models = []; s.selected.clear()
      s.notice = '模型列表加载失败、超时或已取消，请检查渠道后刷新。'
    }).finally(() => {
      clearTimeout(timer)
      bridgeSignal.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', abortListener)
      if (epoch === s.modelEpoch) { s.loading = false; s.loadController = null; publish(s) }
    })
  }
  function deferCatalog(s, setup) {
    if (locked(s)) return { toast: '检测中不能更改渠道。' }
    if (setup && setup() === false) return { toast: '列表已更新，请重新选择。' }
    if (!s.provider) { publish(s); return { toast: s.ready ? '请选择一个渠道。' : '模型服务不可用。' } }
    return { pending: { label: '正在加载模型', timeoutMs: 20_000 }, result: async signal => {
      await loadModels(s, signal)
      return { toast: s.loading ? '较新的列表仍在加载。' : '模型列表加载结束。' }
    } }
  }
  function prepare(s, remaining = false) {
    if (active || lane.owner) return { toast: '已有检测或清理任务，请稍候。' }
    if (s.loading) return { toast: '请等待模型列表加载完成。' }
    const service = available()
    if (!service) return { toast: '当前主机的模型服务不可用。' }
    let models = s.models.filter(m => s.selected.has(m.id))
    if (remaining) {
      if (!s.run || s.run.provider !== s.provider) return { toast: '请先选择上一轮的渠道。' }
      const pendingIds = new Set(s.run.rows.filter(r => r.status === 'unstarted').map(r => r.model))
      models = s.models.filter(m => pendingIds.has(m.id))
    }
    if (!models.length) return { toast: '请至少选择一个尚可检测的模型。' }
    if (models.length > MAX_BATCH) return { toast: '每轮最多选择 50 个模型。' }
    const provider = s.providers.find(p => p.id === s.provider)
    if (!provider) return { toast: '渠道已变更，请刷新列表。' }
    s.plan = { nonce: `confirm-run-${++sequence}`, provider: provider.id, providerName: provider.name, models: models.map(m => ({ ...m })), epoch: s.modelEpoch, createdAt: Date.now() }
    publish(s)
    return { toast: '请在面板内确认请求数量及费用。' }
  }
  function cancel(job, reason = '已停止，剩余模型未检测。') {
    if (!job || active !== job) return
    job.cancelled = true; job.state.run.reason = reason; job.state.notice = reason
    job.controller.abort()
    publishAll()
  }
  function release(job) {
    if (active !== job) return
    active = null
    if (lane.owner === job) lane.owner = null
    for (const notify of lane.observers) notify()
  }
  async function execute(job) {
    const s = job.state, run = s.run
    try {
      for (let i = 0; i < run.rows.length; i++) {
        if (job.cancelled || disposed) break
        if (!s.listeners.size) { cancel(job, '面板订阅已回收，剩余模型未检测。'); break }
        const service = available()
        let registered = false
        try { registered = service?.listProviders().some(p => p.id === run.provider) } catch {}
        if (!registered) { cancel(job, '渠道已移除或模型服务不可用，已停止。'); break }
        const row = run.rows[i]
        run.current = i
        row.status = 'running'; row.startedAt = new Date().toISOString()
        publish(s)
        const outcome = await probe(service, { provider: run.provider, model: row.model }, { signal: job.controller.signal, timeoutMs, graceMs })
        if (outcome.lingering) {
          job.waiting = true
          if (!disposed && active === job) {
            Object.assign(row, outcome.result)
            cancel(job, '适配器尚未确认退出，结果未知；禁止新请求直至清理完成。')
          }
          // Retain the process-wide lease even when this instance was unloaded.
          outcome.cleanup.then(() => {
            if (active !== job) return
            run.reason = '已停止；适配器清理完成。'
            s.notice = '清理完成。取消或超时项不会自动重试，可手动选择后重新检测。'
            release(job)
          })
          return
        }
        if (disposed || active !== job) break
        Object.assign(row, outcome.result)
        publish(s)
        if (row.halt) { cancel(job, row.message); break }
      }
      if (!job.cancelled) { run.reason = '本轮完成'; s.notice = '本轮结束。结果只代表本次短文本请求；没有自动重试。' }
    } catch {
      cancel(job, '本地检测任务异常，已停止；未自动重试。')
    } finally {
      run.current = -1
      if (!job.waiting) release(job)
      publish(s)
    }
  }
  function start(s, event) {
    if (event.value?.confirmed !== true) { s.plan = null; publish(s); return { toast: '未发送请求。' } }
    const plan = s.plan
    s.plan = null
    if (active || lane.owner) { publish(s); return { toast: '已有检测或清理任务，请稍候。' } }
    if (!plan || plan.epoch !== s.modelEpoch || plan.provider !== s.provider || Date.now() - plan.createdAt > 120_000) {
      publish(s); return { toast: '确认已失效，请重新点开始检测。' }
    }
    if (!s.listeners.size) return { toast: '请先打开并连接检测面板。' }
    s.run = { id: ++sequence, provider: plan.provider, providerName: plan.providerName,
      reason: '检测中', current: -1, rows: plan.models.map(m => ({ model: m.id, name: m.name, status: 'unstarted' })) }
    s.resultPage = 0; s.detailIndex = 0; s.notice = '串行检测中；不会发送聊天历史，也不会自动重试。'
    const job = active = { state: s, controller: new AbortController(), cancelled: false, waiting: false }
    lane.owner = job
    for (const notify of lane.observers) notify()
    // The action only admits a user-confirmed job. Progress belongs to the live
    // panel feed, not a single 60-second deferred HTTP invocation.
    Promise.resolve().then(() => execute(job)).catch(() => release(job))
    return { toast: '检测已开始，可随时停止。' }
  }
  function selectPage(s) {
    if (locked(s) || s.loading) return { toast: '请等待当前操作结束。' }
    const page = s.models.slice(s.modelPage * PAGE_MODELS, (s.modelPage + 1) * PAGE_MODELS)
    const next = new Set([...s.selected, ...page.map(m => m.id)])
    if (next.size > MAX_BATCH) return { toast: '每轮最多选择 50 个模型。' }
    s.selected = next; invalidate(s)
    return { toast: '已勾选本页模型。' }
  }
  const actions = {
    'refresh-catalog': scope => {
      const s = stateOf(scope)
      return deferCatalog(s, () => { syncProviders(s) })
    },
    'pick-provider': (scope, event) => {
      const s = stateOf(scope)
      return deferCatalog(s, () => {
        const index = tokenIndex(readChoice(event), s.providerEpoch, s.providers.length)
        if (index < 0) return false
        s.loadController?.abort(); s.provider = s.providers[index].id
        s.models = []; s.selected.clear(); s.modelPage = 0; s.plan = null
      })
    },
    'toggle-model': (scope, event) => {
      const s = stateOf(scope)
      if (locked(s) || s.loading) return { toast: '请等待当前操作结束。' }
      const index = tokenIndex(readToken(event), s.modelEpoch, s.models.length)
      if (index < 0) return { toast: '列表已更新，请重新选择。' }
      const id = s.models[index].id
      if (s.selected.has(id)) s.selected.delete(id)
      else {
        if (s.selected.size >= MAX_BATCH) return { toast: '每轮最多选择 50 个模型。' }
        s.selected.add(id)
      }
      invalidate(s)
      return {}
    },
    'select-page': scope => selectPage(stateOf(scope)),
    'clear-selection': scope => {
      const s = stateOf(scope)
      if (locked(s)) return { toast: '检测期间不能更改选择。' }
      s.selected.clear(); invalidate(s); return {}
    },
    'prepare-run': scope => prepare(stateOf(scope)),
    'prepare-remaining': scope => prepare(stateOf(scope), true),
    'stop-run': scope => {
      const s = stateOf(scope)
      if (!locked(s)) return { toast: '当前面板没有运行中的任务。' }
      cancel(active)
      return { toast: '已请求停止，不再派发后续模型。' }
    },
    'show-result': (scope, event) => {
      const s = stateOf(scope)
      const index = tokenIndex(readToken(event), s.run?.id, s.run?.rows.length ?? 0)
      if (index < 0) return { toast: '结果已更新，请重新点选。' }
      s.detailIndex = index; publish(s); return {}
    },
  }
  for (const [what, size] of [['provider', PAGE_PROVIDERS], ['model', PAGE_MODELS], ['result', PAGE_RESULTS]]) {
    for (const [prefix, delta] of [['prev', -1], ['next', 1]]) {
      actions[`${prefix}-${what}`] = scope => {
        const s = stateOf(scope)
        if (what !== 'result' && locked(s)) return { toast: '检测期间不能更改选择。' }
        const items = what === 'provider' ? s.providers : what === 'model' ? s.models : s.run?.rows ?? []
        s[`${what}Page`] = Math.max(0, Math.min(pageCount(items, size) - 1, s[`${what}Page`] + delta))
        publish(s); return {}
      }
    }
  }
  lane.observers.add(publishAll)
  // Dynamic confirmation IDs carry plan identity; stale UI events cannot
  // authorize a newly prepared plan with a different channel or model count.
  ctx.dshGo.on('checker', (scope, event) => {
    const s = stateOf(scope)
    if (!s.plan || event.action !== s.plan.nonce) return { toast: '确认已失效，请重新点开始检测。' }
    return start(s, event)
  })
  ctx.dshGo.panel('checker', {
    view: checkerView,
    data: (scope, emit) => {
      const s = stateOf(scope)
      s.listeners.add(emit); emit(render(s))
      return () => {
        s.listeners.delete(emit)
        if (!s.listeners.size) {
          s.loadController?.abort()
          if (locked(s)) cancel(active, '面板订阅已回收，剩余模型未检测。')
        }
      }
    },
    actions,
  })
  ctx.effect(() => () => {
    if (active) cancel(active, '插件已卸载，检测已取消。')
    disposed = true
    lane.observers.delete(publishAll)
    for (const s of states.values()) { s.loadController?.abort(); s.listeners.clear() }
    states.clear()
  })
}

export function apply(ctx) {
  ctx.inject(['dshGo'], ctx => createChecker(ctx))
}
