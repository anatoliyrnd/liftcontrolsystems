import { PHOTO } from "../config.js";

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    // 1. Валидация типа
    if (!file.type.startsWith("image/")) {
      return reject(new Error("Файл не является изображением"));
    }

    // 2. Валидация размера
    if (file.size > PHOTO.MAX_BYTES) {
      return reject(
        new Error(
          `Файл слишком большой (макс. ${PHOTO.MAX_BYTES / 1024 / 1024} МБ)`,
        ),
      );
    }

    let timeoutId;
    let bitmap = null;

    // 3. Таймаут на весь пайплайн
    const timer = new Promise((_, rej) => {
      timeoutId = setTimeout(() => {
        if (bitmap) bitmap.close();
        rej(new Error("Превышено время обработки фото"));
      }, PHOTO.COMPRESS_TIMEOUT_MS);
    });

    const process = async () => {
      try {
        // Декодируем изображение (быстрее и меньше памяти, чем FileReader)
        bitmap = await createImageBitmap(file);

        const canvas = document.createElement("canvas");
        let width = bitmap.width;
        let height = bitmap.height;

        // Масштабирование
        if (width > PHOTO.MAX_WIDTH) {
          height = Math.round((height * PHOTO.MAX_WIDTH) / width);
          width = PHOTO.MAX_WIDTH;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, width, height);

        // Сжимаем в JPEG
        const base64 = canvas.toDataURL("image/jpeg", PHOTO.QUALITY);
        return base64;
      } finally {
        if (bitmap) bitmap.close(); // Освобождаем память
      }
    };

    // Гонка: либо обработка, либо таймаут
    Promise.race([process(), timer])
      .then((base64) => {
        clearTimeout(timeoutId);
        resolve(base64);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}
