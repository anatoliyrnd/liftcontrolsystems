const STORAGE_KEY = "lift_sync_timestamps";

export const syncTimestamps = {
  getAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  },
  get(key) {
    return this.getAll()[key] || 0;
  },
  setMany(timestampsObj) {
    const data = this.getAll();
    Object.assign(data, timestampsObj);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },
};
