// 跨窗口数据变更同步：
// 一个窗口执行授权撤销 / 责任交接 / 共享链接撤销等权限变更后，其他已打开页面的内存缓存
// （Pinia store、详情页本地快照）仍停留在变更前，会继续展示受限正文、命中搜索与问答。
// 各 store 在写库后广播变更的表名，其余窗口收到后统一 reload 对应缓存，让收回即时生效。
//
// 通道选择：优先 BroadcastChannel（同源多窗口）；不支持时回退 localStorage storage 事件
// （storage 事件天然只在其他窗口触发，不会自发自收）。本模块两种实现都只向其他窗口派发。

export const SYNC_CHANNEL = 'knowbase:sync'
// 变更类型 → 受影响的表（广播方写库后发出，接收方据此刷新对应 store）
export const SYNC_SCOPE = {
  access: ['accessRequests'],
  handover: ['handovers', 'docs', 'accessRequests', 'reviews', 'freshnessTickets'],
  docs: ['docs'],
  shares: ['shares'],
  review: ['reviews', 'docs'],
  gap: ['gapTickets'],
  freshness: ['freshnessTickets', 'docs'],
  retirement: ['retirements', 'docs', 'shares', 'gapTickets']
}

let channel = null
const listeners = new Map() // fn -> 窗口标记（仅进程内总线模式使用）
let fallbackReady = false
// 进程内事件总线模式（无 BroadcastChannel 的测试/SSR 环境）下的「当前窗口」标记：
// 真实 BroadcastChannel 不会自发自收，测试用它把多个监听者区分为不同窗口
let currentWindow = 'default'

function dispatch(payload, sourceWindow) {
  for (const [fn, win] of listeners) {
    // 进程内模式按窗口标记过滤，模拟 BroadcastChannel 只投递给其他窗口
    if (sourceWindow && win === sourceWindow) continue
    try { fn(payload) } catch { /* 单个监听器异常不影响其他窗口刷新 */ }
  }
}

// 测试/SSR 环境（无 window 或 BroadcastChannel、localStorage）下降级为进程内事件总线，
// 保证 store 逻辑在 fake-indexeddb 回归中仍可验证
function hasWindow() {
  return typeof window !== 'undefined'
}

function ensureChannel() {
  if (!hasWindow()) return
  if (typeof BroadcastChannel === 'function') {
    const bc = new BroadcastChannel(SYNC_CHANNEL)
    bc.onmessage = (ev) => { if (ev.data) dispatch(ev.data, null) }
    channel = bc
    return
  }
  // 回退方案：localStorage storage 事件只在其他窗口触发
  if (typeof localStorage !== 'undefined') {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== SYNC_CHANNEL || !ev.newValue) return
      try { dispatch(JSON.parse(ev.newValue), null) } catch { /* 忽略损坏的广播 */ }
    })
    fallbackReady = true
  }
}

// 登记变更监听器，返回取消登记函数。win 仅在进程内总线模式下用于区分窗口
export function onSync(fn, win = 'default') {
  if (!channel && !fallbackReady && hasWindow()) ensureChannel()
  listeners.set(fn, win)
  return () => listeners.delete(fn)
}

// 进程内总线模式（测试）下切换当前窗口标记：之后注册的监听器归属该窗口
export function setTestWindow(win) {
  currentWindow = win
}

// 向其他窗口广播一次变更（本窗口不触发监听）。tables 为实际写过的表名
export function broadcast(type, tables) {
  const payload = { type, tables: tables || SYNC_SCOPE[type] || [], at: Date.now() }
  if (channel) {
    channel.postMessage(payload)
    return
  }
  // localStorage 回退：写一个带时间戳的值触发其他窗口 storage 事件
  if (hasWindow() && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(SYNC_CHANNEL, JSON.stringify(payload)) } catch { /* 配额/隐私模式忽略 */ }
    return
  }
  // 进程内总线（测试环境）：按窗口标记投递给其他窗口的监听器
  dispatch(payload, currentWindow)
}

// 表名集合 → 需要 reload 的 store 名称。接收方只刷新自己已加载过的缓存，避免无谓读库
const TABLE_STORE_MAP = {
  accessRequests: 'access',
  handovers: 'handover',
  docs: 'kb',
  shares: 'share',
  reviews: 'review',
  gapTickets: 'gap',
  freshnessTickets: 'freshness',
  retirements: 'retirement'
}

export function storesForTables(tables) {
  const names = new Set()
  for (const t of tables || []) {
    const name = TABLE_STORE_MAP[t]
    if (name) names.add(name)
  }
  return [...names]
}
