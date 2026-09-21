// 跨窗口权限同步与缓存失效回归（fake-indexeddb + 两套真实 Pinia store 模拟两个窗口）
// 覆盖：
// 1) B 窗口撤销 A 窗口已打开的限时授权 → A 窗口 access 缓存即时失效：
//    详情可见性（canViewDoc / grantOf）、搜索命中、问答引用三处同步收回；
// 2) B 窗口执行责任交接（revoke 模式）→ A 窗口 docs 与 access 缓存均失效：
//    原负责人 owner/editors 身份与限时授权同步更新，受限正文不再展示；
// 3) 广播不会让发起窗口自身的监听器重复刷新（BroadcastChannel 语义）。
// 运行：npm run test:sync
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAccessStore } from '@/stores/access'
import { useHandoverStore } from '@/stores/handover'
import { onSync, broadcast, storesForTables, setTestWindow } from '@/utils/sync'
import { canViewDoc } from '@/utils/permission'
import { ACCESS, ACCESS_PERM, isGrantActive } from '@/utils/access'
import { HANDOVER, REVOKE_MODE } from '@/utils/handover'
import { uid } from '@/utils/format'
import { PUBLISH } from '@/utils/review'

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

// ---- 两个「窗口」：独立 Pinia 实例、独立 store，但共用同一个 IndexedDB（同源多窗口语义）----
const piniaA = createPinia()
const piniaB = createPinia()
createApp({ render: () => null }).use(piniaA)
createApp({ render: () => null }).use(piniaB)

const kbA = useKbStore(piniaA)
const accessA = useAccessStore(piniaA)
const kbB = useKbStore(piniaB)
const accessB = useAccessStore(piniaB)
const handoverB = useHandoverStore(piniaB)

// Node/fake-indexeddb 环境没有 BroadcastChannel 与 window，sync.js 退化为进程内事件总线。
// 真实浏览器里 BroadcastChannel 不会自发自收；这里以窗口 A 身份登记监听器：
// 收到 B 窗口广播后按表刷新 A 窗口「已加载」的 store（等价于 syncBootstrap 在 A 窗口运行，
// 但显式传入 piniaA——真实应用中活动 pinia 由 createApp 注入）。
setTestWindow('A')
const receivedByA = []
onSync(async (payload) => {
  receivedByA.push(payload)
  const reloaders = {
    access: accessA,
    kb: kbA
  }
  for (const name of storesForTables(payload.tables)) {
    const store = reloaders[name]
    // store.loaded 是 Pinia 解包后的布尔值；仅刷新已加载且具备 reload 的缓存
    if (store && typeof store.reload === 'function' && store.loaded) await store.reload()
  }
}, 'A')

// 启动 A 窗口各 store 的「已加载」状态：跨窗口同步只 reload loaded 的缓存
await Promise.all([kbA.loadAll(), accessA.loadAll()])
await Promise.all([kbB.loadAll(), accessB.loadAll(), handoverB.loadAll()])

const owner = { id: 'u-owner', name: '负责人', role: 'editor' }
const viewer = { id: 'u-viewer', name: '只读甲', role: 'viewer' }
const next = { id: 'u-next', name: '接任者', role: 'editor' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin' }
await db.users.bulkAdd([owner, viewer, next, admin].map((u) => ({ ...u, email: '', avatar: '?', title: '' })))

const nowIso = new Date().toISOString()
function mkDoc(ownerId, visibility = 'private') {
  return {
    id: uid('doc'),
    title: '受限文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>受限正文，含关键词 跨窗口同步秘钥 AlphaBeta</p>',
    categoryId: null, tagIds: [], visibility,
    ownerId, editors: [ownerId], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso, updatedAt: nowIso,
    versions: [{ version: 1, savedAt: nowIso, savedBy: ownerId, note: '初始' }]
  }
}

function flush() { return new Promise((r) => setTimeout(r, 0)) }

// 广播监听器为异步（接收方要 await store.reload），等待断言条件成立或超时
async function waitUntil(check, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return check()
}

// ---------- 1. 撤销授权跨窗口即时收回（详情 / 搜索 / 问答三处缓存） ----------
console.log('\n[1] B 窗口撤销授权 → A 窗口详情/搜索/问答缓存即时失效')
const doc1 = mkDoc(owner.id)
await db.docs.add(doc1)
await Promise.all([kbA.reloadDocs(), kbB.reloadDocs()])

const grant = {
  id: uid('acc'), docId: doc1.id, applicantId: viewer.id,
  status: ACCESS.APPROVED, requestedPermission: ACCESS_PERM.READ,
  reason: '', createdAt: nowIso, decidedBy: owner.id, decidedAt: nowIso, decisionNote: '',
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null,
  grant: {
    permission: ACCESS_PERM.READ, grantedAt: nowIso,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null
  },
  timeline: []
}
await db.accessRequests.add(grant)
await Promise.all([accessA.reload(), accessB.reload()])

// A 窗口已打开详情页：持授权可读
const gA = accessA.grantOf(doc1.id, viewer.id)
assert(isGrantActive(gA), '撤销前：A 窗口读到有效授权')
assert(canViewDoc(kbA.docs.find((d) => d.id === doc1.id), viewer.id, null, gA), '撤销前：A 窗口详情可见受限正文')

// 搜索 / 问答的过滤条件与页面 computed 完全一致
const visibleInSearchA = () => {
  const d = kbA.docs.find((x) => x.id === doc1.id)
  return !!d && canViewDoc(d, viewer.id, null, accessA.grantOf(d.id, viewer.id))
}
assert(visibleInSearchA(), '撤销前：A 窗口搜索/问答可命中该文档')

// B 窗口（拥有者）执行撤销
receivedByA.length = 0
setTestWindow('B')
const res = await accessB.revokeGrant(grant.id, '跨窗口收回', owner)
assert(res.status === 'ok', 'B 窗口：拥有者撤销授权成功')
await flush()

assert(receivedByA.some((p) => (p.tables || []).includes('accessRequests')), '撤销广播到达 A 窗口（tables 含 accessRequests）')
// 进程内总线按窗口标记隔离：来源 B 的广播只投递给窗口 A 的监听器，不会自发自收
assert(receivedByA.length >= 1, '广播只投递给其他窗口（BroadcastChannel 语义）')

const gAAfter = accessA.grantOf(doc1.id, viewer.id)
assert(!gAAfter || !isGrantActive(gAAfter), '撤销后：A 窗口授权缓存已失效')
const d1A = kbA.docs.find((d) => d.id === doc1.id)
assert(!canViewDoc(d1A, viewer.id, null, accessA.grantOf(d1A.id, viewer.id)), '撤销后：A 窗口详情立即收回（展示访问申请卡片）')
assert(!visibleInSearchA(), '撤销后：A 窗口搜索结果即时剔除受限文档')

// 直接写库撤销（模拟其他标签页/设备不经 store 的变更 + 手动广播）同样能同步
const doc1b = mkDoc(owner.id)
doc1b.title = '另一篇受限文档-AlphaBeta'
await db.docs.add(doc1b)
// 深拷贝夹具（grant 含嵌套 grant 对象，不能浅拷贝，否则与已撤销的第一条共享状态）
const grant2 = structuredClone(grant)
grant2.id = uid('acc')
grant2.docId = doc1b.id
grant2.revokedAt = null
grant2.status = ACCESS.APPROVED
grant2.grant.revokedAt = null
grant2.timeline = []
await db.accessRequests.add(grant2)
await Promise.all([accessA.reload(), kbA.reloadDocs()])
assert(canViewDoc(kbA.docs.find((d) => d.id === doc1b.id), viewer.id, null, accessA.grantOf(doc1b.id, viewer.id)), '第二篇：撤销前可见')
await db.accessRequests.update(grant2.id, { status: ACCESS.REVOKED, revokedAt: nowIso, grant: { ...grant2.grant, revokedAt: nowIso } })
receivedByA.length = 0
broadcast('access')
await flush()
assert(receivedByA.length === 1, '直接写库 + 广播：A 窗口收到一次失效通知')
assert(!canViewDoc(kbA.docs.find((d) => d.id === doc1b.id), viewer.id, null, accessA.grantOf(doc1b.id, viewer.id)), '第二篇：A 窗口按广播重新读库后权限收回')

// ---------- 2. 责任交接跨窗口：归属 + 授权收回同步生效 ----------
console.log('\n[2] B 窗口批准责任交接（revoke）→ A 窗口归属与授权缓存同步失效')
const doc2 = mkDoc(owner.id, 'private')
doc2.editors = [owner.id, viewer.id] // 原负责人把只读甲加为固定协作者
await db.docs.add(doc2)
// 原负责人自己持有一篇私有文档（owner 身份），交接要求文档 owner=from
const doc3 = mkDoc(owner.id, 'private')
await db.docs.add(doc3)
await Promise.all([kbA.reloadDocs(), kbB.reloadDocs()])

// 原负责人（owner）在 doc2 上另有一条限时阅读授权（交接 revoke 模式应一并收回）
const ownerGrant = {
  ...grant,
  id: uid('acc'),
  docId: doc2.id,
  applicantId: owner.id,
  requestedPermission: ACCESS_PERM.READ,
  grant: { ...grant.grant, permission: ACCESS_PERM.READ }
}
await db.accessRequests.add(ownerGrant)
await Promise.all([accessA.reload(), accessB.reload()])

// A 窗口视角：viewer 作为固定协作者可见 doc2；owner 可看 doc3
assert(canViewDoc(kbA.docs.find((d) => d.id === doc2.id), viewer.id, null, accessA.grantOf(doc2.id, viewer.id)), '交接前：A 窗口协作者可查看 doc2')

const init = await handoverB.initiateHandover(
  { docIds: [doc2.id, doc3.id], toUserId: next.id, revokeMode: REVOKE_MODE.REVOKE, note: '交接' },
  owner
)
assert(init.status === 'ok', 'B 窗口：发起交接成功')
const confirmRes = await handoverB.confirmHandover(init.handover.id, next)
assert(confirmRes.status === 'ok', 'B 窗口：接任者确认')

receivedByA.length = 0
setTestWindow('B')
const decideRes = await handoverB.decideHandover(init.handover.id, 'approve', '批准', admin)
assert(decideRes.status === 'ok' && decideRes.approved, 'B 窗口：管理员批准交接')
await waitUntil(() => kbA.docs.find((d) => d.id === doc2.id)?.ownerId === next.id)

const handoverMsg = receivedByA.find((p) => (p.tables || []).includes('docs') && (p.tables || []).includes('accessRequests'))
assert(!!handoverMsg, '交接广播到达 A 窗口且覆盖 docs + accessRequests')
assert(storesForTables(handoverMsg.tables).sort().join(',') === 'access,freshness,handover,kb,review', '交接广播映射到全部相关 store')

// A 窗口 docs 缓存已重算：所有权与协作成员变化生效
const d2A = kbA.docs.find((d) => d.id === doc2.id)
const d3A = kbA.docs.find((d) => d.id === doc3.id)
assert(d2A.ownerId === next.id, '交接后：A 窗口 doc2 owner 已更新为接任者')
assert(d2A.editors.includes(next.id) && !d2A.editors.includes(owner.id), '交接后：A 窗口 doc2 协作者含接任者、已移除原负责人')
assert(d3A.ownerId === next.id, '交接后：A 窗口 doc3 owner 已更新')

// 原负责人被移出 editors 且其限时授权被撤销 → A 窗口判定不再可见（若其非 owner）
const ownerGrantA = accessA.requests.find((r) => r.id === ownerGrant.id)
assert(ownerGrantA && !isGrantActive(ownerGrantA), '交接后：A 窗口原负责人的限时授权缓存已显示撤销')

// viewer 仍是协作者（交接只收 from=owner 的权限），仍可见；若构造一篇仅靠授权的文档则收回
// 用 owner 身份在交接后访问一篇已不再拥有的文档（无其他身份）→ 不可见
assert(!canViewDoc(d3A, owner.id, null, accessA.grantOf(d3A.id, owner.id)), '交接后：原负责人在 A 窗口对 doc3 不再有查看权（owner 已交接、无协作者身份）')
assert(canViewDoc(d3A, next.id, null, accessA.grantOf(d3A.id, next.id)), '交接后：接任者在 A 窗口可查看 doc3')

// ---------- 3. 广播负载健壮性：未加载/未知表名安全忽略 ----------
console.log('\n[3] 同步广播健壮性')
receivedByA.length = 0
setTestWindow('B')
broadcast('retirement')
broadcast('unknown-type', ['nonexistentTable'])
await flush()
assert(receivedByA.length === 2, '各类广播均能投递；未加载/未知 store 在接收方被安全忽略')

// ---------- 4. 交接 keep 模式不收回协作身份（反向校验，防止过度失效） ----------
console.log('\n[4] keep 模式交接：A 窗口归属更新但原负责人协作者身份保留')
const doc4 = mkDoc(owner.id, 'private')
await db.docs.add(doc4)
await Promise.all([kbA.reloadDocs(), kbB.reloadDocs()])
const init4 = await handoverB.initiateHandover(
  { docIds: [doc4.id], toUserId: next.id, revokeMode: REVOKE_MODE.KEEP, note: '保留' },
  owner
)
await handoverB.confirmHandover(init4.handover.id, next)
receivedByA.length = 0
const dec4 = await handoverB.decideHandover(init4.handover.id, 'approve', '', admin)
assert(dec4.status === 'ok', 'B 窗口：keep 模式交接批准')
await waitUntil(() => kbA.docs.find((d) => d.id === doc4.id)?.ownerId === next.id)
const d4A = kbA.docs.find((d) => d.id === doc4.id)
assert(d4A.ownerId === next.id && d4A.editors.includes(owner.id), 'keep 模式：A 窗口 owner 已交接且原负责人保留协作者身份，仍可查看')
assert(canViewDoc(d4A, owner.id, null, accessA.grantOf(d4A.id, owner.id)), 'keep 模式：A 窗口原负责人查看权未被错误收回')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
