/**
 * Сжатие фото перед отправкой на сервер (только онлайн-путь).
 *
 * Требования API_syncCommands.md v4.2 (разд. 11.4):
 *   - resize до 1280×1280 max с сохранением пропорций;
 *   - JPEG, качество 0.7 → 0.3 (подбор);
 *   - декодированный размер ≤ 500 КБ;
 *   - если не уложились — throw (вызывающий блокирует отправку).
 *
 * Использует pica (высококачественный LANCZOS downsample).
 * Архитектурный задел на SW: используется createImageBitmap (доступен в SW).
 * Сейчас работает в main thread, FileReader для base64.
 */

import Pica from "pica";

const pica = Pica();

const DEFAULTS = {
  maxDim: 1280,
  maxBytes: 500 * 1024,
  qualities: [0.7, 0.6, 0.5, 0.4, 0.3],
  maxSourceBytes: 20 * 1024 * 1024,
  resizeQuality: 2,
};

const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);

export async function compressPhoto(file, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  if (!file || !file.type) {
    throw new Error("Файл не выбран или не является изображением");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(
      `Неподдерживаемый формат: ${file.type}. Разрешены JPEG и PNG.`,
    );
  }
  if (file.size > cfg.maxSourceBytes) {
    throw new Error(
      `Исходный файл слишком большой (${Math.round(file.size / 1024 / 1024)} МБ). Максимум ${Math.round(cfg.maxSourceBytes / 1024 / 1024)} МБ.`,
    );
  }

  let img;
  try {
    img = await createImageBitmap(file);
  } catch (e) {
    throw new Error("Не удалось прочитать изображение: файл повреждён?");
  }

  try {
    const scale = Math.min(cfg.maxDim / img.width, cfg.maxDim / img.height, 1);
    const targetW = Math.max(1, Math.round(img.width * scale));
    const targetH = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;

    await pica.resize(img, canvas, { quality: cfg.resizeQuality });

    let lastBlob = null;
    for (const q of cfg.qualities) {
      const blob = await canvasToBlob(canvas, "image/jpeg", q);
      if (!blob) continue;
      lastBlob = blob;
      if (blob.size <= cfg.maxBytes) {
        const base64 = await blobToBase64(blob);
        return {
          base64,
          size: blob.size,
          width: targetW,
          height: targetH,
        };
      }
    }

    const lastSize = lastBlob ? lastBlob.size : 0;
    throw new Error(
      `Не удалось сжать фото до ${Math.round(cfg.maxBytes / 1024)} КБ (получилось ${Math.round(lastSize / 1024)} КБ). Выберите другое фото.`,
    );
  } finally {
    if (img && typeof img.close === "function") {
      try {
        img.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), type, quality);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Ошибка кодирования изображения"));
    reader.readAsDataURL(blob);
  });
}
