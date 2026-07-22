class ComponentRegistry {
  constructor() {
    this._components = new Map();
  }

  register(name, { weight, calculate }) {
    if (this._components.has(name)) {
      throw new Error(`Component '${name}' is already registered`);
    }
    if (typeof calculate !== 'function') {
      throw new Error(`Component '${name}' must provide a calculate function`);
    }
    this._components.set(name, { weight, calculate });
    return this;
  }

  get(name) {
    return this._components.get(name) || null;
  }

  has(name) {
    return this._components.has(name);
  }

  clear() {
    this._components.clear();
    return this;
  }

  get size() {
    return this._components.size;
  }

  entries() {
    return this._components.entries();
  }

  values() {
    return this._components.values();
  }

  [Symbol.iterator]() {
    return this._components[Symbol.iterator]();
  }
}

module.exports = { ComponentRegistry };
