// Keyboard / mouse / gamepad input with action mapping + pointer lock.
import bus from './events.js';

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft'],
  crouch: ['ControlLeft', 'KeyC'],
  walk: ['AltLeft'],
  reload: ['KeyR'],
  interact: ['KeyE', 'KeyF'],
  melee: ['KeyV'],
  ads: ['Mouse2'],
  fire: ['Mouse0'],
  grenade: ['KeyG'],
  heal: ['KeyH'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weaponNext: ['KeyQ'],
  cycleWeapon: ['MouseWheel'],
  squadFollow: ['Digit4'],
  squadHold: ['Digit5'],
  squadAttack: ['Digit6'],
  map: ['KeyM', 'Tab'],
  inventory: ['KeyI'],
  journal: ['KeyJ'],
  skills: ['KeyK'],
  pause: ['Escape'],
  flashlight: ['KeyL'],
  nightvision: ['KeyN'],
  camera: ['KeyP'],
};

export class Input {
  constructor(dom = window) {
    this.dom = dom;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.down = new Set();      // raw codes currently down
    this.pressedSet = new Set();// raw codes pressed this frame
    this.releasedSet = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0, x: 0, y: 0, left: false, right: false };
    this.locked = false;
    this.enabled = true;
    this.gamepad = null;
    this._bind();
  }

  _bind() {
    const canvas = document.getElementById('game-canvas') || document.body;
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // let the browser handle devtools / refresh shortcuts
      if (e.code === 'F12' || e.ctrlKey || e.metaKey) return;
      if (this.enabled) {
        this.down.add(e.code);
        this.pressedSet.add(e.code);
      }
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      bus.emit('input:key', e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.releasedSet.add(e.code);
    });
    window.addEventListener('blur', () => { this.down.clear(); this.mouse.left = this.mouse.right = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      const code = 'Mouse' + e.button;
      this.down.add(code);
      this.pressedSet.add(code);
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
      bus.emit('input:mousedown', e.button);
    });
    window.addEventListener('mouseup', (e) => {
      const code = 'Mouse' + e.button;
      this.down.delete(code);
      this.releasedSet.add(code);
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      bus.emit('input:lock', this.locked);
    });
    window.addEventListener('gamepadconnected', (e) => { this.gamepad = e.gamepad.index; });
  }

  /** raw key-code helpers (used by gameplay code) */
  codeDown(code) { return this.down.has(code); }
  codePressed(code) { return this.pressedSet.has(code); }
  codeReleased(code) { return this.releasedSet.has(code); }
  get mouseDX() { return this.mouse.dx; }
  get mouseDY() { return this.mouse.dy; }
  get wheel() { return this.mouse.wheel; }

  requestLock() {
    if (!this.locked && this.canvas.requestPointerLock) this.canvas.requestPointerLock();
  }
  exitLock() { if (document.exitPointerLock) document.exitPointerLock(); }

  isDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }
  pressed(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.pressedSet.has(c)) return true;
    return false;
  }
  released(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.releasedSet.has(c)) return true;
    return false;
  }
  /** movement vector in local space: x = strafe, y = forward */
  moveAxis() {
    let x = 0, y = 0;
    if (this.isDown('forward')) y += 1;
    if (this.isDown('back')) y -= 1;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    const g = this.pollGamepad();
    if (g) { x += g.x; y += g.y; }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }
  pollGamepad() {
    if (this.gamepad === null || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[this.gamepad];
    if (!gp) return null;
    const dz = 0.18;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    if (Math.abs(ax) < dz && Math.abs(ay) < dz) return null;
    return { x: ax, y: -ay };
  }
  /** call at end of frame */
  endFrame() {
    this.pressedSet.clear();
    this.releasedSet.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }
}

export const input = new Input();
export default input;
