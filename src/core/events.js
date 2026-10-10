// Tiny event bus used across engine / gameplay / UI.
class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.off(name, fn);
  }
  once(name, fn) {
    const off = this.on(name, (...a) => { off(); fn(...a); });
    return off;
  }
  off(name, fn) { const s = this.map.get(name); if (s) s.delete(fn); }
  emit(name, payload) {
    const s = this.map.get(name);
    if (s) for (const fn of Array.from(s)) fn(payload);
    const any = this.map.get('*');
    if (any) for (const fn of Array.from(any)) fn(name, payload);
  }
  clear() { this.map.clear(); }
}
export const bus = new Bus();
export default bus;
