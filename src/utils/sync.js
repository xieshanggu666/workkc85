// 跨窗口权限/数据同步：
// 任一窗口完成会影响「详情 / 搜索 / 问答」可见性的写操作（授权审批/撤销、责任交接批准等）后，
// 通过 notifyChange 广播变更；所有窗口（含发起窗口）的订阅者收到后统一重载相关 store，
// 让已收回的权限即时在所有窗口生效，无需刷新。
//
// 传输双通道（自动降级，Node/测试环境均安全）：
// - BroadcastChannel（首选）：同源多标签页实时消息（按规范不回传发送实例，
//   发起窗口的一次投递由下方本地派发补齐，其他窗口由通道送达）；
// - localStorage storage 事件（兜底）：不支持 BroadcastChannel 的环境仍可跨窗口。
// 以 origin+seq 签名去重：任一条通知在每个窗口恰好派发一次，不会因双通道重复。
//
// 变更域（payload.scope）：
// - 'docs'    文档归属/正文/可见性等变化（交接批准、删除等）
// - 'access'  访问申请/限时授权变化（审批、撤销、交接联动收回）
// - 'shares'  共享链接变化（创建/撤销/退役批量撤销）
// - 'reviews' 评审单变化（锁定状态）
// - 'freshness' 保鲜复核单变化（问答引用暂停/恢复）
// - 'handovers' 交接单变化
// - 'retirements' 退役单变化（搜索/问答引用闸门）
// - 'gaps'     缺口工单变化
// - 'all'     不确定或多项联动时全量重载

export const CHANGE_SCOPE = {
  DOCS: 'docs',
  ACCESS: 'access',
  SHARES: 'shares',
  REVIEWS: 'reviews',
  FRESHNESS: 'freshness',
  HANDOVERS: 'handovers',
  RETIREMENTS: 'retirements',
  GAPS: 'gaps',
  ALL: 'all'
}

const CHANNEL_NAME = 'knowbase:change'
const STORAGE_KEY = 'kb:change:event'

let channel = null
const listeners = new Set()

// 订阅跨窗口变更；返回取消订阅函数。handler 收到的 payload 形如 { scopes: string[], ts, origin }
export function onRemoteChange(handler) {
  listeners.add(handler)
  ensureTransport()
  return () => listeners.delete(handler)
}

// 广播变更给所有窗口并在本窗口派发一次（各窗口按 origin+seq 去重，恰好处理一次）。
// scopes 为变更域数组；返回 payload（可用于测试断言）
let seq = 0
export function notifyChange(scopes) {
  const payload = {
    scopes: Array.isArray(scopes) ? scopes : [scopes || CHANGE_SCOPE.ALL],
    ts: Date.now(),
    seq: ++seq,
    origin: id()
  }
  ensureTransport()
  try {
    if (channel) channel.postMessage(payload)
  } catch { /* 通道异常时退回到 storage 事件 */ }
  try {
    // storage 事件只在其他窗口触发；写入一个带序号的新值保证重复事件也能送达
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    }
  } catch { /* 隐私模式等场景忽略 */ }
  // 本窗口：BroadcastChannel/storage 按规范都不回传发送者，这里本地派发补齐。
  // 与远端消息共用同一去重签名，双通道或重复调用都不会让同一事件被处理两次
  dispatch(payload)
  return payload
}

let ensured = false
function ensureTransport() {
  if (ensured) return
  ensured = true
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
      channel.onmessage = (ev) => dispatch(ev.data)
    } catch { channel = null }
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== STORAGE_KEY || !ev.newValue) return
      let payload
      try { payload = JSON.parse(ev.newValue) } catch { return }
      dispatch(payload)
    })
  }
}

function dispatch(payload) {
  if (!payload || !Array.isArray(payload.scopes)) return
  // 双传输通道 + 本地派发可能让同一条消息多次到达：按 origin+seq 去重（保留近期签名，容忍乱序）
  const sig = payload.origin + ':' + payload.seq
  if (seenSigs.has(sig)) return
  seenSigs.add(sig)
  if (seenSigs.size > 100) seenSigs.delete(seenSigs.keys().next().value)
  for (const fn of listeners) {
    try { fn(payload) } catch { /* 单个订阅者异常不影响其余 */ }
  }
}
const seenSigs = new Set()

// 窗口实例标识：仅用于去重，不参与权限判定
function id() {
  if (!instanceId) {
    instanceId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  }
  return instanceId
}
let instanceId = ''
