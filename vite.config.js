import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend", // Локальная папка с исходниками (как вы её склонировали)
  base: "/ui/", // Базовый URL на продакшене
  build: {
    outDir: "../dist", // Собранные файлы (Vite положит их в dist/ в корне репо)
    emptyOutDir: true,
  },
});
