// 跨窗口同步引导：应用启动时登记一次。
// 任一窗口写库后广播受影响的表，其他窗口据此只 reload「已加载过」的对应 store——
// 权限相关 store（access / kb / review / freshness / retirement / gap / handover）刷新后，
// 详情页、搜索、问答中依赖这些 store 的 computed 授权闸门会在同一渲染周期内自动重算，
// 被撤销的授权、交接后的归属变化即时生效，已打开页面不再停留展示受限正文。
import { onSync, storesForTables } from '@/utils/sync'

// 表 → 对应 store 的加载器（动态引入规避 store 间循环依赖）。
// shares 无独立 store（ShareView 直接读库），由该页面自己的 onSync 监听处理
const STORE_LOADERS = {
  kb: async () => (await import('@/stores/kb')).useKbStore(),
  access: async () => (await import('@/stores/access')).useAccessStore(),
  review: async () => (await import('@/stores/review')).useReviewStore(),
  gap: async () => (await import('@/stores/gap')).useGapStore(),
  freshness: async () => (await import('@/stores/freshness')).useFreshnessStore(),
  retirement: async () => (await import('@/stores/retirement')).useRetirementStore(),
  handover: async () => (await import('@/stores/handover')).useHandoverStore()
}

let started = false

export function startCrossWindowSync() {
  if (started) return
  started = true
  // 串行刷新同批变更，避免多个 store 并发 reload 时交错读到中间态
  onSync(async (payload) => {
    const names = storesForTables(payload.tables)
    for (const name of names) {
      try {
        const loader = STORE_LOADERS[name]
        if (!loader) continue // 如 shares：无独立 store，由使用方页面自行监听
        const store = await loader()
        // 仅刷新本窗口已加载过的缓存：未加载的页面下次 loadAll 会直接读库取最新
        if (store && store.loaded && typeof store.reload === 'function') await store.reload()
      } catch { /* 单个 store 刷新失败不阻断其余缓存失效 */ }
    }
  })
}
