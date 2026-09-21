import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { ensureSeeded } from './db/seed'
import { startCrossWindowSync } from './utils/syncBootstrap'
import './styles/base.css'

async function bootstrap() {
  await ensureSeeded()
  // 跨窗口权限同步：其他窗口撤销授权 / 责任交接后，本窗口 store 缓存即时失效重算
  startCrossWindowSync()
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
}

bootstrap()