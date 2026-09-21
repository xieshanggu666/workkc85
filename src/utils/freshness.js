// 知识保鲜：复核周期、复核单状态、权限判定、到期/引用判定与留痕工具（均为纯函数，便于测试）
// 流转：负责人（拥有者/管理员）设置复核周期 → 到期自动生成复核单（open，暂停问答引用）→
// 编辑者修订送审（submitted，复用评审单锁定/审批通道）→ 管理员批准（approved，恢复引用并重算周期）
// / 驳回（rejected，继续整改，可修订后重新送审）；每轮复核单与 timeline 全程保留。
import { ROLE } from './permission'

// 复核单状态（每轮一条：驳回不是终态，修订后在同一条复核单上重新送审；approved 为本轮已通过）
export const FRESH = {
  OPEN: 'open', // 待整改：周期到点已生成复核单，问答引用暂停
  SUBMITTED: 'submitted', // 复核送审中：编辑者已修订送审，等待管理员批准
  REJECTED: 'rejected', // 已驳回：管理员驳回，继续整改后重新送审（引用仍暂停）
  APPROVED: 'approved', // 已通过：内容确认有效/已修订，恢复引用并重算周期
  CANCELLED: 'cancelled' // 已取消：负责人关闭保鲜，当前复核单作废（记录保留）
}

export const DAY_MS = 24 * 3600 * 1000

// 可选复核周期（天）
export const FRESH_CYCLES = [
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天（季度）' },
  { days: 180, label: '180 天（半年）' },
  { days: 365, label: '365 天（年度）' }
]

export function cycleDaysLabel(days) {
  const hit = FRESH_CYCLES.find((c) => c.days === days)
  if (hit) return hit.label
  return days ? days + ' 天' : '未设置'
}

export function freshStatusLabel(status) {
  return { open: '待整改', submitted: '复核送审中', rejected: '已驳回待整改', approved: '已通过', cancelled: '已取消' }[status] || status
}

export function freshStatusCls(status) {
  return { open: 'st-open', submitted: 'st-review', rejected: 'st-no', approved: 'st-ok', cancelled: 'st-off' }[status] || ''
}

// 计算下一次复核到期点：基准时间（批准/设置时刻）+ 周期天数
export function calcDueAt(days, from) {
  const n = Number(days)
  if (!n || n <= 0) return null
  return new Date(new Date(from).getTime() + n * DAY_MS).toISOString()
}

// 文档是否启用了知识保鲜（设置了有效周期）
export function isFreshnessEnabled(doc) {
  return !!doc?.freshness && Number(doc.freshness.cycleDays) > 0
}

// 当前流转中的复核单（open/submitted/rejected 均会暂停问答引用；approved/cancelled 为本轮终态）
export function isFreshTicketOpen(ticket) {
  return !!ticket && (ticket.status === FRESH.OPEN || ticket.status === FRESH.SUBMITTED || ticket.status === FRESH.REJECTED)
}

// 复核周期是否已到点（启用且 nextDueAt <= at）
export function isFreshDue(doc, at = new Date()) {
  if (!isFreshnessEnabled(doc) || !doc.freshness.nextDueAt) return false
  return new Date(doc.freshness.nextDueAt).getTime() <= new Date(at).getTime()
}

// 是否已有流转中的复核单（到期生成前判重，保证一个周期一张单）
export function hasOpenFreshTicket(doc, activeTicket) {
  const t = activeTicket ?? doc?.freshness?.activeTicket
  return isFreshTicketOpen(t)
}

// 是否可被问答引用（核心保鲜闸门）：
// 启用保鲜且「周期已到点」或「存在流转中复核单」时一律暂停引用；
// 未启用保鲜、或本轮已通过（周期已重算）的文档正常引用。
// 暂停只影响问答引用：文档详情、搜索、侧边栏入口仍可正常访问。
export function isDocCitable(doc, activeTicket, at = new Date()) {
  if (!doc) return false
  if (!isFreshnessEnabled(doc)) return true
  if (isFreshTicketOpen(activeTicket ?? doc?.freshness?.activeTicket)) return false
  if (isFreshDue(doc, at)) return false
  return true
}

// 设置/调整复核周期资格：仅文档拥有者或管理员（负责人）。
// 编辑者/只读成员、限时协作者、访客均不能设置他人文档的保鲜周期。
export function canManageFreshness(doc, userId, role) {
  if (!doc || !userId || userId === 'u-guest') return false
  if (role === ROLE.ADMIN) return true
  return doc.ownerId === userId
}

// 关闭保鲜时是否允许同时作废当前复核单（仅负责人；存在流转中复核单时需要确认）
export function canDisableFreshness(doc, userId, role) {
  return canManageFreshness(doc, userId, role)
}

// 保鲜复核单的审批（通过/驳回）复用内容评审的管理员通道，见 utils/review.canReviewDecision

// 保鲜复核留痕：动作 + 操作人 + 说明 + 时间，复核单 timeline 全程保留
export function buildFreshTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function freshTimelineLabel(action) {
  return {
    due: '周期到点 · 自动生成复核单',
    submit: '修订内容送审',
    'submit-nochange': '确认内容无需修订 · 直接送审',
    approve: '复核通过 · 恢复引用并重算周期',
    reject: '复核驳回 · 继续整改',
    resubmit: '修订后重新送审',
    withdraw: '撤回复核送审 · 继续整改',
    setting: '设置复核周期',
    change: '调整复核周期',
    disable: '关闭知识保鲜',
    cancel: '作废复核单',
    handover: '负责人交接 · 保鲜责任转移'
  }[action] || action
}

// 版本记录上的保鲜标记
export function freshVersionBadge(v) {
  if (!v || !v.freshReview) return null
  if (v.freshReview.noChange) return { text: '保鲜确认 v' + v.freshReview.round, cls: 'fresh' }
  return { text: '保鲜修订 v' + v.freshReview.round, cls: 'fresh' }
}

// 距今文案：到期点剩余/逾期描述
export function dueText(doc, activeTicket, at = new Date()) {
  if (!isFreshnessEnabled(doc)) return ''
  const t = isFreshTicketOpen(activeTicket) ? activeTicket : null
  const dueAt = t?.dueAt || doc.freshness.nextDueAt
  if (!dueAt) return ''
  const diff = new Date(dueAt).getTime() - new Date(at).getTime()
  const day = DAY_MS
  const abs = Math.abs(diff)
  const n = Math.floor(abs / day)
  const span = n >= 1 ? n + ' 天' : Math.max(1, Math.floor(abs / (3600 * 1000))) + ' 小时'
  if (t) return '已逾期 ' + span
  return diff <= 0 ? '已到点' : span + '后到期'
}
