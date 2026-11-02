import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// ... ваши импорты плагинов (например, vue(), react() и т.д.)

export default defineConfig(({ mode }) => {
  // Загружаем переменные окружения в зависимости от режима (development или production)
  const env = loadEnv(mode, process.cwd(), '');
  
  // Берем URL бэкенда из .env.development, либо используем localhost по умолчанию
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:8000'; 

  return {
     base: '/ui/', 
      plugins: [
      // <-- 2. Добавляем плагин в конфигурацию
      VitePWA({
        // 'autoUpdate' — SW обновится в фоне и перезагрузит страницу
        // 'prompt' — покажет уведомление "Доступна новая версия" (лучше для форм)
        registerType: 'autoUpdate',
        
        // Настройки манифеста (перенесено из вашего manifest.json)
        manifest: {
          name: 'LiftControlSystems',
          short_name: 'Лифты',
          description: 'Система контроля лифтов',
          theme_color: '#6366f1',
          background_color: '#edf2f7',
          display: 'standalone',
          orientation: 'landscape',
          start_url: '/ui/index.html', // Важно: указываем с учётом base
          scope: '/ui/',
          icons: [
            {
              src: 'icons/icon-192.png', // Путь относительно /ui/
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ],
          // Опционально: скриншоты
          screenshots: [
            {
              src: 'icons/screen-wide.png',
              sizes: '1920x1080',
              type: 'image/png',
              form_factor: 'wide',
              label: 'Журнал открытых заявок'
            }
          ]
        },
        
        // Настройки Workbox (движок кэширования под капотом)
        workbox: {
          // Какие файлы кэшировать (автоматически подставит хешированные имена!)
          globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff2}'],
          
          // Важно: включаем очистку старых кэшей при обновлении
          cleanupOutdatedCaches: true,
          
          // Автоматически активировать новый SW
          skipWaiting: true,
          clientsClaim: true,
          
          // Настройка для запросов, которые не были предварительно закэшированы
          // Например, для API запросов (хотя они у вас идут на другой домен, но на всякий случай)
          navigateFallback: '/ui/index.html',
          
          // Игнорируем запросы к API (они не должны кэшироваться)
          navigateFallbackDenylist: [/^\/api/, /^\/auth\.php/, /^\/calls\.php/]
        }
      })
    ],
    server: {
      port: 5173,
      host: true, // Позволяет заходить с других устройств в локальной сети
   proxy: {
  // Проксируем запросы к API (с точкой и без)
  '/api': {
    target: apiTarget,
    changeOrigin: true,
    secure: false,
  },
  '/api.php': {
    target: apiTarget,
    changeOrigin: true,
    secure: false,
  },
  '/auth.php': {
    target: apiTarget,
    changeOrigin: true,
    secure: false,
  },
  // Добавляем legacy-эндпоинт
  '/calls.php': {
    target: apiTarget,
    changeOrigin: true,
    secure: false,
  }
}
    }
  };
});