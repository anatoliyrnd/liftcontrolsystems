import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_TARGET || "http://localhost:8000";

  return {
    base: "/ui/",
    plugins: [
      VitePWA({
        // ВАЖНО: 'prompt' вместо 'autoUpdate'
        registerType: "prompt",

        // Настройки манифеста
        manifest: {
          name: "Lift-Control-Systems",
          short_name: "Лифты",
          description: "Система контроля  лифтов",
          theme_color: "#6366f1",
          background_color: "#edf2f7",
          display: "standalone",
          orientation: "landscape",
          start_url: "/ui/index.html",
          scope: "/ui/",
          icons: [
            {
              src: "icons/icon-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "icons/icon-512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        },

        // Настройки Workbox
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,json,woff2}"],
          cleanupOutdatedCaches: true,
          navigateFallback: "/ui/index.html",
          navigateFallbackDenylist: [/^\/api/, /^\/auth\.php/, /^\/calls\.php/],
        },
      }),
    ],
    // pica@9.x публикуется как UMD/CJS — ESM-сборки в пакете нет.
    // Vite должен предварительно собрать его в ESM-модуль, иначе
    // `import Pica from 'pica'` в браузере упадёт с
    // SyntaxError: Unexpected token 'export'. Для `vite build` работает
    // автоматически (Vite применяет @rollup/plugin-commonjs к node_modules),
    // но для dev и HMR нужен явный include.
    optimizeDeps: {
      include: ["pica"],
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, secure: false },
        "/api.php": { target: apiTarget, changeOrigin: true, secure: false },
        "/auth.php": { target: apiTarget, changeOrigin: true, secure: false },
        "/calls.php": { target: apiTarget, changeOrigin: true, secure: false },
      },
    },
  };
});
