class EventBus {
  constructor() {
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
  }

  emit(event, ...args) {
    if (!this.listeners[event]) return;
    for (const cb of this.listeners[event]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`EventBus: listener error on "${event}":`, err.message);
      }
    }
  }

  async emitAsync(event, ...args) {
    if (!this.listeners[event]) return;
    for (const cb of this.listeners[event]) {
      await cb(...args);
    }
  }
}

module.exports = { EventBus };
