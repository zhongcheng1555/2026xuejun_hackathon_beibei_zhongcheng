// 通用数学与随机工具

export const TWO_PI = Math.PI * 2;
export const UP = null; // 由 three 提供，这里不用

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

export function rand(a = 1, b) {
  return b === undefined ? Math.random() * a : a + Math.random() * (b - a);
}

export function randInt(a, b) {
  return Math.floor(rand(a, b + 1));
}

export function randSign() {
  return Math.random() < 0.5 ? -1 : 1;
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 高斯随机：让弹道偏差集中在小范围，而不是均匀撒开
export function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}

export function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

export function turnTowards(current, target, maxStep) {
  return current + clamp(wrapAngle(target - current), -maxStep, maxStep);
}

export function dist2D(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

// 角度版阻尼：走最短弧，不会绕远路
export function dampAngle(current, target, lambda, dt) {
  return current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
}

// 点 P 到线段 AB 的最短距离平方，用于高速弹丸的连续碰撞检测（防穿透）
export function pointSegmentDist2(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-9) t = clamp((apx * abx + apy * aby + apz * abz) / len2, 0, 1);
  const cx = ax + abx * t - px;
  const cy = ay + aby * t - py;
  const cz = az + abz * t - pz;
  return cx * cx + cy * cy + cz * cz;
}

// 经典 Perlin 噪声，用于随机地形
export function makeNoise(seed = 1337) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed >>> 0) || 1;
  const xorshift = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(xorshift() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };

  function noise2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const X = xi & 255;
    const Y = yi & 255;
    const xf = x - xi;
    const yf = y - yi;
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 0.72;
  }

  noise2.fbm = (x, y, octaves = 5, lacunarity = 2.02, gain = 0.5) => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };

  return noise2;
}
