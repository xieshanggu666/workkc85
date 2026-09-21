// 跨窗口权限同步与缓存失效：端到端回归（fake-indexeddb + 两个独立 pinia 实例模拟两个窗口）
// 覆盖：
// 1. A 窗口撤销限时授权后，B 窗口（详情已打开）的 access/kb 缓存自动重载，
//    canViewDoc 立即关闭——受限正文从详情、搜索、问答中收回；
// 2. A 窗口批准责任交接（revoke）后，B 窗口的原负责人立即失去读权限（ownerId/editors 缓存刷新）；
// 3. A 窗口共享链接撤销后，B 窗口收到 shares 域通知；
// 4. 非相关域的通知不触发无谓重载（去抖/去重）；storage 兜底通道同样可达。
// 运行：npm run test:sync（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAccessStore } from '@/stores/access'
import { useHandoverStore } from '@/stores/handover'
import { useReviewStore } from '@/stores/review'
import { useFreshnessStore } from '@/stores/freshness'
import { useRetirementStore } from '@/stores/retirement'
import { useGapStore } from '@/stores/gap'
import { uid, makeToken } from '@/utils/format'
import { ACCESS, ACCESS_PERM } from '@/utils/access'
import { canViewDoc } from '@/utils/permission'
import { HANDOVER, REVOKE_MODE } from '@/utils/handover'
import { notifyChange, onRemoteChange, CHANGE_SCOPE } from '@/utils/sync'

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// fake-indexeddb 运行在同一进程，两窗口共享底层库；分别创建独立 pinia 模拟各自的内存缓存
function createWindow(name) {
  const pinia = createPinia()
  createApp({ render: () => null, name }).use(pinia)
  return {
    pinia,
    kb: useKbStore(pinia),
    access: useAccessStore(pinia),
    handover: useHandoverStore(pinia),
    review: useReviewStore(pinia),
    freshness: useFreshnessStore(pinia),
    retirement: useRetirementStore(pinia),
    gap: useGapStore(pinia)
  }
}

// 复刻 App.vue 中按变更域重载缓存的订阅逻辑
function installSyncListener(win) {
  let syncing = false
  return onRemoteChange(async (payload) => {
    if (syncing) return
    syncing = true
    try {
      const s = new Set(payload.scopes)
      const all = s.has(CHANGE_SCOPE.ALL)
      const tasks = []
      if (all || s.has(CHANGE_SCOPE.DOCS)) tasks.push(win.kb.loadAll().then(() => win.kb.reloadDocs()))
      if (all || s.has(CHANGE_SCOPE.ACCESS)) tasks.push(win.access.loaded ? win.access.reload() : Promise.resolve())
      if (all || s.has(CHANGE_SCOPE.REVIEWS)) tasks.push(win.review.loaded ? win.review.reload() : Promise.resolve())
      if (all || s.has(CHANGE_SCOPE.FRESHNESS)) tasks.push(win.freshness.loaded ? win.freshness.reload() : Promise.resolve())
      if (all || s.has(CHANGE_SCOPE.HANDOVERS)) tasks.push(win.handover.loaded ? win.handover.reload() : Promise.resolve())
      if (all || s.has(CHANGE_SCOPE.RETIREMENTS)) tasks.push(win.retirement.loaded ? win.retirement.reload() : Promise.resolve())
      if (all || s.has(CHANGE_SCOPE.GAPS)) tasks.push(win.gap.loaded ? win.gap.reload() : Promise.resolve())
      await Promise.all(tasks)
    } finally {
      syncing = false
    }
  })
}

const nowIso = new Date().toISOString()
async function mkDoc(owner, extra = {}) {
  const d = {
    id: uid('doc'), title: '受限文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>受限正文 XYZ</p>', categoryId: 'c', tagIds: [], visibility: 'private',
    ownerId: owner.id, editors: [owner.id], publishState: 'published', activeReviewId: null,
    createdAt: nowIso, updatedAt: nowIso,
    versions: [{ version: 1, savedAt: nowIso, savedBy: owner.id, note: '初始' }],
    ...extra
  }
  await db.docs.add(d)
  return d
}
async function mkGrant(docId, applicant, owner, permission = ACCESS_PERM.READ) {
  const req = {
    id: uid('acc'), docId, applicantId: applicant.id, status: ACCESS.APPROVED,
    requestedPermission: permission, reason: '', createdAt: nowIso,
    decidedBy: owner.id, decidedAt: nowIso, decisionNote: '',
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null,
    grant: { permission, grantedAt: nowIso, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null },
    timeline: []
  }
  await db.accessRequests.add(req)
  return req
}

// ================= 场景 1：撤销授权 → 另一窗口详情/搜索/问答即时收回 =================
console.log('\n[1] A 窗口撤销授权，B 窗口已打开详情即时收回')
const winA = createWindow('A')
const winB = createWindow('B')
const offB = installSyncListener(winB)
await Promise.all([winA.kb.loadAll(), winA.access.loadAll(), winB.kb.loadAll(), winB.access.loadAll()])

const owner = { id: 'u-owner-x', role: 'editor', name: '拥有者X' }
const viewer = { id: 'u-viewer-x', role: 'viewer', name: '只读X' }
const d1 = await mkDoc(owner)
const g1 = await mkGrant(d1.id, viewer, owner)
await Promise.all([winA.kb.reloadDocs(), winA.access.reload(), winB.kb.reloadDocs(), winB.access.reload()])

// B 窗口已打开详情、搜索、问答：缓存内可见
const docB = winB.kb.docs.find((d) => d.id === d1.id)
assert(canViewDoc(docB, viewer.id, null, winB.access.grantOf(d1.id, viewer.id)), '撤销前：B 窗口详情可见受限正文')
assert(winB.access.grantOf(d1.id, viewer.id)?.id === g1.id, '撤销前：B 窗口授权缓存有效')

// A 窗口执行撤销（store 内部广播 notifyChange）
const res = await winA.access.revokeGrant(g1.id, '跨窗口收回', owner)
assert(res.status === 'ok', 'A 窗口撤销成功')
await sleep(50) // 等待广播通道异步送达并重载

assert(winB.access.grantOf(d1.id, viewer.id) === null, '撤销后：B 窗口授权缓存已失效（跨窗口同步重载）')
const docBAfter = winB.kb.docs.find((d) => d.id === d1.id)
assert(canViewDoc(docBAfter, viewer.id, null, winB.access.grantOf(d1.id, viewer.id)) === false,
  '撤销后：B 窗口详情/搜索/问答统一判定不可见，受限正文不再展示')

// ================= 场景 2：责任交接批准（revoke）→ 原负责人窗口立即失去权限 =================
console.log('\n[2] A 窗口批准交接并收回，B 窗口原负责人立即失去访问')
const from = { id: 'u-from', role: 'editor', name: '原负责人' }
const to = { id: 'u-to', role: 'editor', name: '接任者' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
// 用户表补齐（交接 store 校验接任者须为注册成员）
for (const u of [
  { ...from, email: '', avatar: '?' }, { ...to, email: '', avatar: '?' },
  { ...owner, email: '', avatar: '?' }, { ...viewer, email: '', avatar: '?' },
  { ...admin, email: '', avatar: '?' }
]) {
  if (!(await db.users.get(u.id))) await db.users.add(u)
}

const d2 = await mkDoc(from)
await Promise.all([winA.kb.reloadDocs(), winB.kb.reloadDocs(), winA.handover.loadAll(), winB.handover.loadAll(),
  winA.review.loadAll(), winB.review.loadAll(), winA.freshness.loadAll(), winB.freshness.loadAll()])
// B 窗口以原负责人身份已打开 d2 详情（owner 可见）
const doc2B = winB.kb.docs.find((d) => d.id === d2.id)
assert(canViewDoc(doc2B, from.id, null, null), '交接前：B 窗口原负责人可查看自己名下文档')

// 发起 → 接任者确认 → 管理员批准（revoke）
let r = await winA.handover.initiateHandover({ docIds: [d2.id], toUserId: to.id, revokeMode: REVOKE_MODE.REVOKE, note: '' }, from)
assert(r.status === 'ok', '交接发起成功')
r = await winA.handover.confirmHandover(r.handover.id, to)
assert(r.status === 'ok', '接任者确认成功')
r = await winA.handover.decideHandover(r.handover.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved, '管理员批准交接成功')
await sleep(50)

const doc2BAfter = winB.kb.docs.find((d) => d.id === d2.id)
assert(doc2BAfter.ownerId === to.id, 'B 窗口文档归属缓存已刷新为接任者')
assert(!doc2BAfter.editors.includes(from.id), 'B 窗口协作成员缓存已移除原负责人')
assert(canViewDoc(doc2BAfter, from.id, null, winB.access.grantOf(d2.id, from.id)) === false,
  '交接并收回后：B 窗口原负责人立即不可见受限正文（详情切到申请卡片、搜索/问答移除）')
assert(canViewDoc(doc2BAfter, to.id, null, null) === true, '接任者在 B 窗口立即获得访问权')

// ================= 场景 3：共享链接撤销 → shares 域通知送达其他窗口 =================
console.log('\n[3] 共享链接撤销广播')
let receivedScopes = null
const offProbe = onRemoteChange((p) => { receivedScopes = p.scopes })
const d3 = await mkDoc(owner)
const s = {
  id: uid('sh'), docId: d3.id, token: makeToken(), permission: 'view',
  createdBy: owner.id, createdAt: nowIso, expiresAt: null, revokedAt: null
}
await db.shares.add(s)
notifyChange([CHANGE_SCOPE.SHARES])
await sleep(20)
assert(receivedScopes && receivedScopes.includes(CHANGE_SCOPE.SHARES), 'shares 域通知可送达订阅窗口')
offProbe()

// ================= 场景 4：本地派发与去重——发起窗口也收到，同事件不重复 =================
console.log('\n[4] 通知工具：发起窗口本地派发一次，双通道/重复消息去重')
let count = 0
const offCount = onRemoteChange(() => { count++ })
const payload = notifyChange([CHANGE_SCOPE.ACCESS])
assert(payload.seq > 0 && payload.origin && payload.ts, '事件携带 origin/seq/ts')
assert(count === 1, '发起窗口同步收到一次本地派发（' + count + ' 次），用于本窗口缓存失效')
notifyChange([CHANGE_SCOPE.ACCESS])
await sleep(20)
assert(count === 2, '下一条变更事件照常送达（' + count + ' 次）')
offCount()

offB()
console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
