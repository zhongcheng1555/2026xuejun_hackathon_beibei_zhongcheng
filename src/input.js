// 键鼠输入：WASD 开车、鼠标转视角与瞄准、左键/空格开炮

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.pointerLocked = false;
    this.firePressed = false;
    this.fireHeld = false;
    this.dragging = false;
    this.enabled = true;
    this.lastLookTime = 0;
    this.modeTogglePressed = false;
    this.repairPressed = false;

    this._onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();  // 别让方向键把页面滚了
      if (k === 'f') this.modeTogglePressed = true;
      if (k === 'r') this.repairPressed = true;
      this.keys.add(k);
      if (k === ' ') this.firePressed = true;
    };
    this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this._onBlur = () => this.keys.clear();

    this._onMouseMove = (e) => {
      if (!this.enabled) return;
      // 不管有没有拿到指针锁定，鼠标移动都用来转视角
      // （预览窗口/iframe 里常常拿不到指针锁定，之前会被这里过滤掉，导致视角永远朝北）
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
      this.lastLookTime = performance.now();
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) {
        this.firePressed = true;
        this.fireHeld = true;
        this.dragging = true;
        if (!this.pointerLocked) this.requestLock();
      }
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) {
        this.fireHeld = false;
        this.dragging = false;
      }
    };
    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.dragging = false;
    };
    // 滚轮：上帝视角拉远 / 拉近（观战的时候最需要它 —— 空战离得远，看不清）
    this._onWheel = (e) => {
      if (!this.enabled) return;
      this.wheelDelta += e.deltaY;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('wheel', this._onWheel, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // 取走这一帧攒下的滚轮量（取完清零）
  takeWheelDelta() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  requestLock() {
    if (this.canvas.requestPointerLock) {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  releaseLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  get forward() {
    return (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0);
  }

  get turn() {
    return (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
  }

  // 键盘转视角：Q/E 或 左右方向键
  get camTurn() {
    const left = this.keys.has('q') || this.keys.has('arrowleft');
    const right = this.keys.has('e') || this.keys.has('arrowright');
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  // 键盘调瞄准高低：上下方向键
  get camPitchAdjust() {
    return (this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('arrowdown') ? 1 : 0);
  }

  takeMouseDelta() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeFire() {
    const f = this.firePressed || this.keys.has(' ');
    this.firePressed = false;
    return f;
  }

  // F 键切换移动/瞄准模式（点 HUD 上的按钮也行）
  consumeModeToggle() {
    const v = this.modeTogglePressed;
    this.modeTogglePressed = false;
    return v;
  }

  // R 键应急修复
  consumeRepair() {
    const v = this.repairPressed;
    this.repairPressed = false;
    return v;
  }
}
