import { ApiService } from "./api-service.js";
import { API } from "./config.js";

// Создаем единый экземпляр для всего мобильного приложения
export const api = new ApiService(API.URL, { local: false });
