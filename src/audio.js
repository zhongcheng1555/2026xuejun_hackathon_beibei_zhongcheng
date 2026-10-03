// 音效：全部用 Web Audio 现场合成，不需要任何音频素材文件
//
// 为什么不用素材：一不用管版权和水印，二不用下载，三能做**按方位声像** ——
// 现在看不到别人的血量、也没有小地图，"听声辨位"正好补上这层信息：
// 左边来的炮弹从左耳响，身后的爆炸从后面闷过来。
//
// Node（无头测试）里没有 AudioContext，所以这个模块整体降级成空操作，不会报错。

import * as THREE from 'three';
import { CONFIG } from './config.js';

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.muted = false;
    this.noise = null;
    this.camPos = new THREE.Vector3();
    this.camRight = new THREE.Vector3(1, 0, 0);
    this._engine = null;
    // 战斗音效只在"战斗进行中"响：菜单页、结算页一律静默，那里只放菜单音乐。
    // 不这么做的话，结算之后引擎底噪会卡在最后一帧的音量上一直嗡嗡响。
    this.battleActive = true;
  }

  // 浏览器要求音频由用户操作启动，所以第一次点"开始战斗"时才真正建上下文
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ok;
    }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch (e) {
      return false;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = CONFIG.audio.volume;
    this.master.connect(ctx.destination);

    // 白噪声缓冲：所有"砰 / 轰 / 沙"都从它派生
    const len = Math.max(1, Math.floor(ctx.sampleRate * 1.0));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this._buildEngine();
    this.ok = true;
    this.setMuted(this.muted);
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  setMuted(on) {
    this.muted = !!on;
    if (this.master) this.master.gain.value = this.muted || !this.battleActive ? 0 : CONFIG.audio.volume;
    return this.muted;
  }

  // 进战斗 / 离开战斗。离开时立刻把总线压到 0，正在拖尾的音效也一起掐掉
  setBattleActive(on) {
    this.battleActive = !!on;
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.battleActive && !this.muted ? CONFIG.audio.volume : 0, t);
    if (!this.battleActive && this._engine) this._engine.gain.gain.setValueAtTime(0, t);
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  // 每帧把镜头的朝向喂进来（用来算左右声道）
  setCamera(camera) {
    this.camPos.copy(camera.position);
    this.camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.camRight.y = 0;
    if (this.camRight.lengthSq() < 1e-6) this.camRight.set(1, 0, 0);
    else this.camRight.normalize();
  }

  // ---------- 内部：起一条"带方位"的声道 ----------
  // 太远的直接不发声（省算力），返回 null 时调用方就应该放弃
  _voice(pos) {
    if (!this.ok || this.muted || !this.battleActive) return null;
    const ctx = this.ctx;
    const cfg = CONFIG.audio;
    let gain = 1;
    if (pos) {
      const dx = pos.x - this.camPos.x;
      const dy = pos.y - this.camPos.y;
      const dz = pos.z - this.camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > cfg.maxDist) return null;
      gain = Math.pow(1 - dist / cfg.maxDist, 1.5);
      if (gain < 0.015) return null;
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    let tail = g;
    if (pos && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      const dx = pos.x - this.camPos.x;
      const dz = pos.z - this.camPos.z;
      const horiz = Math.max(6, Math.hypot(dx, dz));
      p.pan.value = Math.max(-1, Math.min(1, (dx * this.camRight.x + dz * this.camRight.z) / horiz));
      g.connect(p);
      tail = p;
    }
    tail.connect(this.master);
    return g;
  }

  _noiseBurst(dest, t, dur, gain, type, freq, q) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(f).connect(g).connect(dest);
    n.start(t);
    n.stop(t + dur + 0.02);
  }

  _tone(dest, t, dur, gain, type, f0, f1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // ---------- 各种声音 ----------

  // 开炮：噪声爆 + 低频下沉
  cannon(pos, big = false) {
    const g = this._voice(pos);
    if (!g) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(g, t, big ? 0.45 : 0.26, big ? 1.0 : 0.7, 'lowpass', big ? 700 : 1500);
    this._tone(g, t, 0.32, big ? 0.9 : 0.6, 'sine', big ? 85 : 130, 34);
  }

  // 弹着：打地上是闷响，打掩体/空气里对撞是"啪"
  // （打装甲那一下由 Game 在 onTankHit 里调 armorHit，带金属音）
  impactSound(pos, onGround) {
    const g = this._voice(pos);
    if (!g) return;
    const t = this.ctx.currentTime;
    if (onGround) {
      this._noiseBurst(g, t, 0.16, 0.5, 'lowpass', 900);
      this._tone(g, t, 0.12, 0.3, 'sine', 160, 70);
    } else {
      this._noiseBurst(g, t, 0.1, 0.42, 'highpass', 2200);
    }
  }

  // 命中装甲：金属"当"的一声
  armorHit(pos, metal = true) {
    const g = this._voice(pos);
    if (!g) return;
    const t = this.ctx.currentTime;
    if (metal) {
      this._noiseBurst(g, t, 0.12, 0.55, 'highpass', 1800);
      this._tone(g, t, 0.18, 0.35, 'triangle', 1400, 700);
    } else {
      this._noiseBurst(g, t, 0.16, 0.5, 'lowpass', 900);
      this._tone(g, t, 0.12, 0.3, 'sine', 160, 70);
    }
  }

  // 爆炸（坦克被毁、飞机坠地、飞机爆炸都用它）
  explosion(pos, scale = 1) {
    const g = this._voice(pos);
    if (!g) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(g, t, 0.55 + 0.35 * scale, 1.0, 'lowpass', 500);
    this._tone(g, t, 0.6, 1.0, 'sine', 70, 26);
    this._tone(g, t + 0.02, 0.35, 0.5, 'sawtooth', 120, 40);
  }

  // 侦察兵倒下、小动静
  smallPuff(pos) {
    const g = this._voice(pos);
    if (!g) return;
    this._noiseBurst(g, this.ctx.currentTime, 0.14, 0.4, 'lowpass', 1100);
  }

  // 修复时的滴答（每隔一会儿响一下）
  repairTick(pos) {
    const g = this._voice(pos);
    if (!g) return;
    this._tone(g, this.ctx.currentTime, 0.08, 0.22, 'triangle', 900, 700);
  }

  // 飞机从镜头附近掠过
  planePass(pos) {
    const g = this._voice(pos);
    if (!g) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(g, t, 0.7, 0.55, 'bandpass', 1400, 1.2);
    this._tone(g, t, 0.6, 0.18, 'sawtooth', 420, 180);
  }

  // ---------- 引擎底噪：常驻一条，音量跟车速走 ----------
  _buildEngine() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = CONFIG.audio.engineBaseHz;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    this._engine = { gain: g, filter: lp, src };
  }

  // speedRatio：0~1.5 左右；jet=true 时音色更高（飞机）
  engine(speedRatio, jet = false) {
    if (!this._engine) return;
    const cfg = CONFIG.audio;
    const t = this.ctx.currentTime;
    const k = Math.max(0, Math.min(1.5, speedRatio));
    const target = (this.muted || !this.battleActive ? 0 : cfg.engineVolume * (0.25 + 0.75 * Math.min(1, k))) * (jet ? 0.8 : 1);
    this._engine.gain.gain.setTargetAtTime(target, t, 0.15);
    this._engine.filter.frequency.setTargetAtTime(
      (jet ? cfg.engineBaseHz * 2.6 : cfg.engineBaseHz) * (0.8 + 0.5 * Math.min(1, k)),
      t,
      0.2
    );
  }
}

// 菜单主题曲：不是一个音效，是一整首曲子，所以用 <audio> 加载真正的声音文件
// （音效可以现场合成，音乐不行——合成器写出来的旋律没法跟真正的音乐比）。
//
// 几个必须处理的现实问题：
//  1) 浏览器不许网页自动出声，所以第一次点击/按键之前是静音的，调用方要在
//     用户第一次操作时再调一次 play()。
//  2) 文件可能不存在（还没放进去），加载失败要安静跳过，不能报错、不能挡着游戏。
//  3) 换格式很方便：sources 里按顺序试，第一个能加载的就算数。
export class MenuMusic {
  constructor(sources, volume = 0.5) {
    this.sources = sources;
    this.volume = volume;
    this.el = null;
    this.idx = 0;
    this.givenUp = false;
    this.wanted = false;    // 现在"应该"在放（在菜单里）
    this.muted = false;
  }

  _create() {
    if (this.el || this.givenUp) return;
    if (typeof Audio === 'undefined') {
      this.givenUp = true;
      return;
    }
    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    // 这个格式没加载成功就换下一个；全都不行就彻底放弃（静音进游戏，不影响别的）
    el.addEventListener('error', () => {
      this.idx++;
      if (this.idx < this.sources.length) this._load();
      else {
        this.givenUp = true;
        this.el = null;
      }
    });
    this.el = el;
    this._load();
  }

  _load() {
    this.el.src = this.sources[this.idx];
    this.el.load();
  }

  // 播放/停止/静音一律直接给音量，不做任何渐变 ——
  // 音乐文件本身是无缝可循环的，音量忽大忽小反而多余。
  // 返回一个"到底放出来了没有"的 Promise：浏览器允许自动播放时是 true，
  // 被拦下来（还没拿到用户操作）时是 false。调用方可以据此决定要不要留着进场页。
  play() {
    this.wanted = true;
    this._create();
    if (!this.el) return Promise.resolve(false);
    this.el.volume = this.muted ? 0 : this.volume;
    if (!this.el.paused) return Promise.resolve(true);
    return this.el.play().then(() => true, () => false);
  }

  // 开打时叫它：直接停，不做淡出
  stop() {
    this.wanted = false;
    if (!this.el) return;
    this.el.volume = 0;
    this.el.pause();
  }

  setMuted(on) {
    this.muted = !!on;
    if (!this.el) return;
    this.el.volume = this.muted || !this.wanted ? 0 : this.volume;
  }
}
