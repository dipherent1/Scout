import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import App from './App.vue'
import './style.css'

createApp(App).use(createPinia()).mount('#app')

// Service worker caches the app shell, the exhibitor bundle and (later) the detector model.
if (import.meta.env.PROD) registerSW({ immediate: true })
