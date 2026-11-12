import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(rootDir, "frontend");

/**
 * Единственный конфиг проекта. frontend/vite.config.js удалён.
 * root = frontend, сборка в корневой dist, .env читаются из frontend.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, appDir, "");
  const apiTarget = env.VITE_API_TARGET || "http://localhost:8000";

  const proxyEntry = {
    target: apiTarget,
    changeOrigin: true,
    secure: false,
  };

  return {
    root: appDir,
    base: "/ui/",
    envDir: appDir,
    publicDir: resolve(appDir, "public"),

    build: {
      outDir: resolve(rootDir, "dist"),
      emptyOutDir: true,
      sourcemap: false,
      target: "es2020",
    },

    plugins: [
      VitePWA({
        registerType: "prompt",
        includeAssets: [
          "favicon.ico",
          "icons/icon-192.png",
          "icons/icon-512.png",
        ],
        manifest: {
          name: "Lift-Control-Systems",
          short_name: "Лифты",
          description: "Система контроля лифтов",
          lang: "ru",
          theme_color: "#6366f1",
          background_color: "#edf2f7",
          display: "standalone",
          orientation: "landscape",
          start_url: "/ui/index.html",
          scope: "/ui/",
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "icons/icon-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,json,woff2}"],
          cleanupOutdatedCaches: true,
          navigateFallback: "/ui/index.html",
          navigateFallbackDenylist: [/^\/api/, /^\/auth\.php/, /^\/calls\.php/],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],

    optimizeDeps: {
      // pica@9.x — UMD/CJS, нужен предварительный бандлинг в ESM.
      include: ["pica"],
    },

    server: {
      port: 5173,
      host: true,
      proxy: {
        "/api.php": proxyEntry,
        "/api": proxyEntry,
        "/auth.php": proxyEntry,
        "/calls.php": proxyEntry,
      },
    },

    preview: {
      port: 4173,
      host: true,
    },
  };
});
