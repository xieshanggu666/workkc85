<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from '@/components/topbar/TopBar.vue'
import SideBar from '@/components/sidebar/SideBar.vue'
import { useAuthStore } from '@/stores/auth'
import { useKbStore } from '@/stores/kb'
import { useEngagementStore } from '@/stores/engagement'
import { useReviewStore } from '@/stores/review'
import { useGapStore } from '@/stores/gap'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useHandoverStore } from '@/stores/handover'
import { useRetirementStore } from '@/stores/retirement'
import { onRemoteChange, CHANGE_SCOPE } from '@/utils/sync'

const route = useRoute()
const auth = useAuthStore()
const kb = useKbStore()
const engagement = useEngagementStore()
const reviewStore = useReviewStore()
const gapStore = useGapStore()
const accessStore = useAccessStore()
const freshnessStore = useFreshnessStore()
const handoverStore = useHandoverStore()
const retirementStore = useRetirementStore()

const isSharePage = () => route.name === 'share'

// 其他窗口发生权限/数据变更后，按变更域重载本窗口对应的内存缓存。
// 详情/搜索/问答的可见性全部基于这些 store 的响应式状态计算，
// 重载后已打开页面中被收回的受限正文即时消失，无需刷新页面。
let syncing = false
async function reloadScopes(scopes) {
  // 收到过期/撤销事件可能在本窗口尚未完成首屏加载前；串行重入保护避免重复扫描
  if (syncing) return
  syncing = true
  try {
    const s = new Set(scopes)
    const all = s.has(CHANGE_SCOPE.ALL)
    const tasks = []
    // docs 变更可能同时带新分类/标签/评论；已首屏加载过时 loadAll 仅补拉分类/标签/评论，
    // 文档本身用 reloadDocs 拿最新，避免重复全量
    if (all || s.has(CHANGE_SCOPE.DOCS)) tasks.push(kb.loadAll().then(() => kb.reloadDocs()))
    if (all || s.has(CHANGE_SCOPE.ACCESS)) tasks.push(accessStore.loaded ? accessStore.reload() : Promise.resolve())
    if (all || s.has(CHANGE_SCOPE.REVIEWS)) tasks.push(reviewStore.loaded ? reviewStore.reload() : Promise.resolve())
    if (all || s.has(CHANGE_SCOPE.FRESHNESS)) tasks.push(freshnessStore.loaded ? freshnessStore.reload() : Promise.resolve())
    if (all || s.has(CHANGE_SCOPE.HANDOVERS)) tasks.push(handoverStore.loaded ? handoverStore.reload() : Promise.resolve())
    if (all || s.has(CHANGE_SCOPE.RETIREMENTS)) tasks.push(retirementStore.loaded ? retirementStore.reload() : Promise.resolve())
    if (all || s.has(CHANGE_SCOPE.GAPS)) tasks.push(gapStore.loaded ? gapStore.reload() : Promise.resolve())
    // 共享链接无独立 store：使用方（共享页）直接读库，此处仅推动依赖权限的文档数据刷新
    await Promise.all(tasks)
    if (auth.user) await engagement.refresh(auth.user.id)
  } finally {
    syncing = false
  }
}

let offRemoteChange = null
function onVisible() {
  if (document.visibilityState !== 'visible') return
  // 兜底：窗口重新可见时全量核对一次权限相关缓存（覆盖广播通道失效的极端环境）
  reloadScopes([CHANGE_SCOPE.ALL])
}

onMounted(async () => {
  offRemoteChange = onRemoteChange((payload) => reloadScopes(payload.scopes))
  document.addEventListener('visibilitychange', onVisible)
  await Promise.all([auth.loadUsers(), kb.loadAll(), reviewStore.loadAll(), gapStore.loadAll(), accessStore.loadAll(), freshnessStore.loadAll(), handoverStore.loadAll(), retirementStore.loadAll()])
  // 默认以管理员登录，便于完整演示；可通过「账号与权限」切换角色
  if (!auth.user) await auth.login('admin')
  await engagement.load(auth.user?.id)
})

onBeforeUnmount(() => {
  offRemoteChange?.()
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <div class="app-shell">
    <div class="body" :class="{ 'is-share': isSharePage() }">
      <TopBar v-if="!isSharePage()" />
      <div class="content">
        <SideBar v-if="!isSharePage()" />
        <main class="main">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-shell { height: 100%; display: flex; flex-direction: column; }
.body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.body.is-share .content { max-width: 860px; margin: 0 auto; }
.content { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.main { flex: 1; overflow: auto; padding: 24px; }
</style>