// 主菜单主题曲「暮光激战」的渲染器
//
// 为什么是这么个东西：TRAE 没有音乐生成模型，又不能用别人的曲子（版权），
// 所以这里手写一个合成器，把曲子"作"出来，离线渲染成真正的音频文件。
//   node tools/make-menu-theme.mjs  →  tools/menu-theme.raw.wav
// 再用 macOS 自带的 afconvert 压成 FLAC：
//   afconvert -f flac -d flac tools/menu-theme.raw.wav menu-theme.flac
//
// 曲子设定：D 小调 · 132 BPM · 24 小节（约 43.6 秒）· 无缝循环
//   和声：Dm - Bb - F - C（史诗套路）
//   编制：定音鼓 / 军鼓 / 踩镲 / 镲片 / 低音贝斯 / 铜管主题 / 高音副旋律 / 弦乐铺底 / 铜管重击 / 上升音
//
// 输出是 44.1kHz / 16bit / 立体声。末尾 2.2 秒的余响会被折回开头，
// 这样循环播放时接缝处不会突然断掉。

import { writeFileSync } from 'node:fs';

const SR = 44100;
const BPM = 132;
const SPB = 60 / BPM;          // 一拍的秒数
const BAR = 4 * SPB;           // 一小节
const BARS = 24;
const LOOP = BARS * BAR;
const TAIL = 2.2;              // 余响折回的长度
const N = Math.ceil((LOOP + TAIL) * SR);
const LOOPN = Math.round(LOOP * SR);
const TAILN = N - LOOPN;

const L = new Float32Array(N);
const R = new Float32Array(N);

// 十六分音符的位置（以拍为单位）
const BEAT = (bar, beat) => (bar * BAR + beat * SPB) * SR;

// ---------- 波形表：加性合成，天然不带混叠，省掉逐样本 math.sin ----------
const TSIZE = 2048;
const TMASK = TSIZE - 1;
const SAWH = (h) => 1 / h;
const SQRH = (h) => (h % 2 ? 1 / h : 0);

function makeTable(maxH, harm) {
  const t = new Float32Array(TSIZE + 1);
  for (let i = 0; i < TSIZE; i++) {
    let s = 0;
    for (let h = 1; h <= maxH; h++) {
      const a = harm(h);
      if (a) s += a * Math.sin((2 * Math.PI * h * i) / TSIZE);
    }
    t[i] = s;
  }
  let m = 0;
  for (let i = 0; i < TSIZE; i++) m = Math.max(m, Math.abs(t[i]));
  if (m > 0) for (let i = 0; i <= TSIZE; i++) t[i] /= m;
  t[TSIZE] = t[0];
  return t;
}
// 按音高选表：音越高，能放的谐波越少，这样不会在超声区折叠回来变成噪声
const SAW = [makeTable(90, SAWH), makeTable(46, SAWH), makeTable(23, SAWH), makeTable(11, SAWH), makeTable(5, SAWH)];
const SQR = [makeTable(90, SQRH), makeTable(46, SQRH), makeTable(23, SQRH), makeTable(11, SQRH), makeTable(5, SQRH)];
function pick(set, f) {
  if (f < 220) return set[0];
  if (f < 440) return set[1];
  if (f < 880) return set[2];
  if (f < 1760) return set[3];
  return set[4];
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ---------- 噪声源：4 秒白噪声，循环取用 ----------
let seed = 20261002;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff * 2 - 1;
}
const NOISE = new Float32Array(SR * 4);
for (let i = 0; i < NOISE.length; i++) NOISE[i] = rnd();
const NOISEM = NOISE.length - 1;

// ---------- 立体声写入（等功率声像）----------
function pan(panValue) {
  const a = ((panValue + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

// ---------- 鼓 ----------
// 大鼓：音高从 130Hz 掉到 45Hz，带一点点敲击噪声
function kick(start, amp = 1) {
  const dur = 0.45;
  const n = Math.min(Math.floor(dur * SR), N - start);
  const gdec = Math.exp(-1 / (0.155 * SR));
  const pdec = Math.exp(-1 / (0.045 * SR));
  let g = amp;
  let e = 1;
  let ph = 0;
  let ni = (start * 7) % NOISEM;
  for (let i = 0; i < n; i++) {
    const f = 45 + 85 * e;
    ph += (2 * Math.PI * f) / SR;
    const click = NOISE[ni & NOISEM] * 0.5 * e;
    const v = (Math.sin(ph) + click) * g;
    L[start + i] += v;
    R[start + i] += v;
    g *= gdec;
    e *= pdec;
    ni += 3;
  }
}

// 军鼓：带通噪声 + 一点鼓皮音
function snare(start, amp = 1) {
  const dur = 0.26;
  const n = Math.min(Math.floor(dur * SR), N - start);
  const gdec = Math.exp(-1 / (0.075 * SR));
  const tdec = Math.exp(-1 / (0.045 * SR));
  let g = amp;
  let tg = amp * 0.55;
  let ph = 0;
  let ni = (start * 13) % NOISEM;
  // 一阶带通：先低通再减去更低通，近似出中高频的"啪"
  let lp1 = 0;
  let lp2 = 0;
  const a1 = 1 - Math.exp((-2 * Math.PI * 3800) / SR);
  const a2 = 1 - Math.exp((-2 * Math.PI * 900) / SR);
  for (let i = 0; i < n; i++) {
    const x = NOISE[ni & NOISEM];
    lp1 += (x - lp1) * a1;
    lp2 += (x - lp2) * a2;
    ph += (2 * Math.PI * 195) / SR;
    const v = (lp1 - lp2) * g * 2.2 + Math.sin(ph) * tg;
    L[start + i] += v;
    R[start + i] += v;
    g *= gdec;
    tg *= tdec;
    ni += 1;
  }
}

// 踩镲
function hat(start, amp = 1, open = false) {
  const dur = open ? 0.32 : 0.06;
  const n = Math.min(Math.floor(dur * SR), N - start);
  const gdec = Math.exp(-1 / ((open ? 0.12 : 0.018) * SR));
  let g = amp;
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 6500) / SR);
  let ni = (start * 17) % NOISEM;
  const [gl, gr] = pan(0.25);
  for (let i = 0; i < n; i++) {
    const x = NOISE[ni & NOISEM];
    lp += (x - lp) * a;
    const v = (x - lp) * g;    // 高通 = 原信号减低通
    L[start + i] += v * gl * 1.4;
    R[start + i] += v * gr * 1.4;
    g *= gdec;
    ni += 1;
  }
}

// 镲片：长尾高通噪声
function crash(start, amp = 1) {
  const dur = 2.0;
  const n = Math.min(Math.floor(dur * SR), N - start);
  const gdec = Math.exp(-1 / (0.62 * SR));
  let g = amp;
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 4200) / SR);
  let ni = (start * 29) % NOISEM;
  for (let i = 0; i < n; i++) {
    const x = NOISE[ni & NOISEM];
    lp += (x - lp) * a;
    const v = (x - lp) * g;
    L[start + i] += v * 0.95;
    R[start + i] += v * 1.05;
    g *= gdec;
    ni += 1;
  }
}

// 定音鼓
function timpani(start, freq, amp = 1) {
  const dur = 1.5;
  const n = Math.min(Math.floor(dur * SR), N - start);
  const gdec = Math.exp(-1 / (0.42 * SR));
  const pdec = Math.exp(-1 / (0.09 * SR));
  let g = amp;
  let e = 1;
  let ph = 0;
  let ni = (start * 31) % NOISEM;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * freq * (1 + 0.09 * e)) / SR;
    const thump = NOISE[ni & NOISEM] * 0.25 * e;
    const v = (Math.sin(ph) + Math.sin(ph * 2) * 0.22 + thump) * g;
    L[start + i] += v * 0.9;
    R[start + i] += v * 0.9;
    g *= gdec;
    e *= pdec;
    ni += 5;
  }
}

// ---------- 低音贝斯：锯齿 + 一阶低通 + 轻微过载 ----------
function bass(start, freq, dur, amp = 1, panValue = 0) {
  const n = Math.min(Math.floor(dur * SR), N - start);
  const tb = pick(SAW, freq);
  const step = freq / SR;
  const atk = Math.min(n, Math.floor(0.006 * SR));
  const dec = Math.exp(-1 / (dur * 0.55 * SR));
  const a = 1 - Math.exp((-2 * Math.PI * 620) / SR);
  let ph = 0;
  let lp = 0;
  let g = amp;
  const [gl, gr] = pan(panValue);
  for (let i = 0; i < n; i++) {
    const x = tb[((ph * TSIZE) | 0) & TMASK];
    lp += (x - lp) * a;
    const drive = Math.tanh(lp * 1.6) * 0.8;
    const env = i < atk ? i / atk : g;
    const v = drive * env;
    L[start + i] += v * gl;
    R[start + i] += v * gr;
    if (i >= atk) g *= dec;
    ph += step;
    if (ph >= 1) ph -= 1;
  }
}

// ---------- 铜管：三个失谐锯齿 + 低通 + ADSR ----------
function brass(start, freq, dur, amp = 1, panValue = -0.08) {
  const n = Math.min(Math.floor(dur * SR), N - start);
  const det = [0.9955, 1, 1.0047];
  const tb = det.map((d) => pick(SAW, freq * d));
  const atk = Math.min(n, Math.floor(0.055 * SR));
  const rel = Math.min(n - atk, Math.floor(0.16 * SR));
  const susEnd = n - rel;
  const a = 1 - Math.exp((-2 * Math.PI * 2100) / SR);
  const [gl, gr] = pan(panValue);
  let lp = 0;
  let g = amp;
  let relGain = 1;
  const relStep = rel > 0 ? 1 / rel : 0;
  const ph = [0, 0, 0];
  const step = det.map((d) => (freq * d) / SR);
  for (let i = 0; i < n; i++) {
    const x =
      (tb[0][((ph[0] * TSIZE) | 0) & TMASK] +
        tb[1][((ph[1] * TSIZE) | 0) & TMASK] +
        tb[2][((ph[2] * TSIZE) | 0) & TMASK]) / 3;
    lp += (x - lp) * a;
    let env;
    if (i < atk) env = i / atk;
    else if (i < susEnd) env = 1;
    else env = 1 - (i - susEnd) * relStep;
    const v = Math.tanh(lp * 1.35) * 0.95 * env * g;
    L[start + i] += v * gl;
    R[start + i] += v * gr;
    for (let k = 0; k < 3; k++) {
      ph[k] += step[k];
      if (ph[k] >= 1) ph[k] -= 1;
    }
  }
}

// ---------- 高音副旋律：方波 + 颤音 ----------
function lead(start, freq, dur, amp = 1) {
  const n = Math.min(Math.floor(dur * SR), N - start);
  const tb = pick(SQR, freq);
  const step = freq / SR;
  const atk = Math.min(n, Math.floor(0.03 * SR));
  const rel = Math.min(n - atk, Math.floor(0.14 * SR));
  const susEnd = n - rel;
  const relStep = rel > 0 ? 1 / rel : 0;
  const vibRate = (2 * Math.PI * 5.6) / SR;
  const dep = 0.0055;
  const [gl, gr] = pan(0.3);
  let ph = 0;
  let vib = 0;
  for (let i = 0; i < n; i++) {
    const x = tb[((ph * TSIZE) | 0) & TMASK];
    let env;
    if (i < atk) env = i / atk;
    else if (i < susEnd) env = 1;
    else env = 1 - (i - susEnd) * relStep;
    const v = x * 0.42 * env * amp;
    L[start + i] += v * gl;
    R[start + i] += v * gr;
    ph += step * (1 + Math.sin(vib) * dep);
    if (ph >= 1) ph -= 1;
    vib += vibRate;
  }
}

// ---------- 弦乐铺底：慢起音、宽失谐 ----------
function padNote(start, freq, dur, amp = 1, panValue = 0) {
  const n = Math.min(Math.floor(dur * SR), N - start);
  const det = [0.994, 0.9985, 1.0015, 1.006];
  const tb = det.map((d) => pick(SAW, freq * d));
  const atk = Math.min(n, Math.floor(0.45 * SR));
  const rel = Math.min(n - atk, Math.floor(0.55 * SR));
  const susEnd = n - rel;
  const relStep = rel > 0 ? 1 / rel : 0;
  const a = 1 - Math.exp((-2 * Math.PI * 1500) / SR);
  const [gl, gr] = pan(panValue);
  const ph = [0, 0, 0, 0];
  const step = det.map((d) => (freq * d) / SR);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const x =
      (tb[0][((ph[0] * TSIZE) | 0) & TMASK] +
        tb[1][((ph[1] * TSIZE) | 0) & TMASK] +
        tb[2][((ph[2] * TSIZE) | 0) & TMASK] +
        tb[3][((ph[3] * TSIZE) | 0) & TMASK]) / 4;
    lp += (x - lp) * a;
    let env;
    if (i < atk) env = i / atk;
    else if (i < susEnd) env = 1;
    else env = 1 - (i - susEnd) * relStep;
    const v = lp * 0.3 * env * amp;
    L[start + i] += v * gl;
    R[start + i] += v * gr;
    for (let k = 0; k < 4; k++) {
      ph[k] += step[k];
      if (ph[k] >= 1) ph[k] -= 1;
    }
  }
}

// ---------- 铜管重击（braam）：低音区锯齿堆 + 滤波器往下扫 ----------
function braam(start, freq, amp = 1) {
  const dur = 2.4;
  const n = Math.min(Math.floor(dur * SR), N - start);
  const det = [0.99, 0.995, 1, 1.005, 1.01];
  const tb = det.map((d) => pick(SAW, freq * d));
  const step = det.map((d) => (freq * d) / SR);
  const gdec = Math.exp(-1 / (1.0 * SR));
  const a0 = 1 - Math.exp((-2 * Math.PI * 2600) / SR);
  const a1 = 1 - Math.exp((-2 * Math.PI * 300) / SR);
  const atk = Math.max(1, Math.floor(0.012 * SR));
  const ph = [0, 0, 0, 0, 0];
  let lp = 0;
  let g = amp;
  for (let i = 0; i < n; i++) {
    const x =
      (tb[0][((ph[0] * TSIZE) | 0) & TMASK] +
        tb[1][((ph[1] * TSIZE) | 0) & TMASK] +
        tb[2][((ph[2] * TSIZE) | 0) & TMASK] +
        tb[3][((ph[3] * TSIZE) | 0) & TMASK] +
        tb[4][((ph[4] * TSIZE) | 0) & TMASK]) / 5;
    // 滤波截止从 2600Hz 一路扫到 300Hz，听感上就是"轰"地压下来
    const k = i / n;
    lp += (x - lp) * (a0 + (a1 - a0) * k);
    const env = i < atk ? i / atk : g;
    const v = Math.tanh(lp * 1.9) * 0.9 * env * amp;
    L[start + i] += v * 0.92;
    R[start + i] += v * 1.08;
    if (i >= atk) g *= gdec;
    for (let m = 0; m < 5; m++) {
      ph[m] += step[m];
      if (ph[m] >= 1) ph[m] -= 1;
    }
  }
}

// ---------- 上升音：带通噪声往上扫 + 渐强 ----------
function riser(start, dur, amp = 1) {
  const n = Math.min(Math.floor(dur * SR), N - start);
  let lp = 0;
  let hi = 0;
  let ni = (start * 37) % NOISEM;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const x = NOISE[ni & NOISEM];
    const a = 1 - Math.exp((-2 * Math.PI * (300 + 5200 * k * k)) / SR);
    lp += (x - lp) * a;
    hi += (lp - hi) * a;
    const g = Math.pow(k, 1.7) * amp;
    const v = (lp - hi * 0.7) * g * 1.6;
    L[start + i] += v * 0.85;
    R[start + i] += v * 1.15;
    ni += 1;
  }
}

// ================== 谱面 ==================
// 和声：Dm - Bb - F - C
const PROG = [
  { bass: 38, pad: [62, 65, 69] },   // Dm
  { bass: 34, pad: [58, 62, 65] },   // Bb
  { bass: 41, pad: [57, 60, 65] },   // F
  { bass: 36, pad: [55, 60, 64] },   // C
];
const chordAt = (bar) => PROG[bar % 4];

// 主题旋律：[小节, 拍(0~3), 时值(拍), MIDI 音高]
const MELODY = [
  // 第一句（0-7 小节）：陈述
  [0, 0, 1, 69], [0, 1, 0.5, 69], [0, 1.5, 0.5, 70], [0, 2, 1, 69], [0, 3, 1, 65],
  [1, 0, 1.5, 67], [1, 1.5, 0.5, 69], [1, 2, 1, 70], [1, 3, 1, 69],
  [2, 0, 1, 69], [2, 1, 1, 72], [2, 2, 2, 74],
  [3, 0, 1, 72], [3, 1, 1, 70], [3, 2, 2, 69],
  [4, 0, 1, 69], [4, 1, 0.5, 69], [4, 1.5, 0.5, 70], [4, 2, 1, 69], [4, 3, 1, 65],
  [5, 0, 1.5, 67], [5, 1.5, 0.5, 69], [5, 2, 1, 70], [5, 3, 1, 74],
  [6, 0, 1, 74], [6, 1, 1, 72], [6, 2, 2, 70],
  [7, 0, 2, 69], [7, 2, 2, 74],
  // 第二句（8-15 小节）：翻高八度区，是全曲最"燃"的一段
  [8, 0, 1, 77], [8, 1, 0.5, 76], [8, 1.5, 0.5, 74], [8, 2, 1, 77], [8, 3, 1, 81],
  [9, 0, 1.5, 79], [9, 1.5, 0.5, 77], [9, 2, 2, 74],
  [10, 0, 1, 77], [10, 1, 1, 76], [10, 2, 1, 74], [10, 3, 1, 72],
  [11, 0, 2, 72], [11, 2, 2, 70],
  [12, 0, 1, 77], [12, 1, 0.5, 76], [12, 1.5, 0.5, 74], [12, 2, 1, 77], [12, 3, 1, 81],
  [13, 0, 1.5, 79], [13, 1.5, 0.5, 77], [13, 2, 1, 74], [13, 3, 1, 76],
  [14, 0, 2, 77], [14, 2, 1, 74], [14, 3, 1, 72],
  [15, 0, 4, 74],
  // 第三句（16-23 小节）：回到主题动机，最后一小节留白给滚奏，方便无缝接回开头
  [16, 0, 1, 69], [16, 1, 0.5, 69], [16, 1.5, 0.5, 70], [16, 2, 1, 69], [16, 3, 1, 65],
  [17, 0, 1.5, 67], [17, 1.5, 0.5, 69], [17, 2, 1, 70], [17, 3, 1, 69],
  [18, 0, 1, 69], [18, 1, 1, 72], [18, 2, 2, 74],
  [19, 0, 1, 72], [19, 1, 1, 74], [19, 2, 2, 76],
  [20, 0, 2, 77], [20, 2, 2, 74],
  [21, 0, 2, 72], [21, 2, 2, 70],
  [22, 0, 1, 69], [22, 1, 1, 70], [22, 2, 2, 72],
  [23, 0, 2, 74],
];

// ---------- 铺底贝斯线：八分音符持续轰，隔拍翻八度 ----------
for (let bar = 0; bar < BARS; bar++) {
  const root = chordAt(bar).bass;
  const notes = [root, root, root, root + 12, root, root, root, root + 12];
  for (let k = 0; k < 8; k++) {
    bass(BEAT(bar, k * 0.5), midi(notes[k]), 0.22, k % 2 ? 0.5 : 0.62, 0);
  }
}

// ---------- 弦乐铺底：每小节一整块 ----------
for (let bar = 0; bar < BARS; bar++) {
  const p = chordAt(bar).pad;
  for (let k = 0; k < p.length; k++) {
    padNote(BEAT(bar, 0), midi(p[k]), BAR * 1.05, 0.85, (k - 1) * 0.45);
  }
}

// 低音持续音：整曲一根 D2，把低频粘住
padNote(0, midi(38), LOOP, 0.5, 0);

// ---------- 主题：铜管；8-15 小节叠一层高音副旋律 ----------
for (const [bar, beat, dur, note] of MELODY) {
  const durS = dur * SPB * 0.92;
  brass(BEAT(bar, beat), midi(note), durS, 1.0);
  if (bar >= 8 && bar <= 15) lead(BEAT(bar, beat), midi(note + 12), durS * 0.9, 0.55);
}

// ---------- 鼓组 ----------
for (let bar = 0; bar < BARS; bar++) {
  const heavy = bar % 8 === 0;            // 每 8 小节的段落头
  if (heavy) {
    crash(BEAT(bar, 0), 0.85);
    braam(BEAT(bar, 0), midi(chordAt(bar).bass), 0.75);
    timpani(BEAT(bar, 0), midi(chordAt(bar).bass - 12), 1.0);
  } else {
    timpani(BEAT(bar, 0), midi(chordAt(bar).bass - 12), 0.7);
  }
  // 大鼓：一、三拍；后半拍偶尔补一脚
  kick(BEAT(bar, 0), 1.0);
  kick(BEAT(bar, 2), 0.9);
  if (bar % 2 === 1) kick(BEAT(bar, 3.5), 0.6);
  // 军鼓：二、四拍
  snare(BEAT(bar, 1), 0.8);
  snare(BEAT(bar, 3), 0.85);
  // 踩镲：十六分音符，弱拍轻一点
  if (bar < 22) {
    for (let s = 0; s < 16; s++) {
      const onBeat = s % 4 === 0;
      hat(BEAT(bar, s * 0.25), onBeat ? 0.5 : 0.3, false);
    }
  }
}

// ---------- 收尾两小节：军鼓滚奏 + 上升音，把循环点顶出去 ----------
for (let s = 0; s < 16; s++) {
  const k = s / 15;
  snare(BEAT(22, s * 0.25), 0.25 + 0.75 * k);
}
for (let s = 0; s < 30; s++) {
  const k = s / 29;
  snare(BEAT(23, s * (4 / 30)), 0.4 + 0.7 * k);
}
riser(BEAT(22, 0), BAR * 2, 0.5);
crash(BEAT(23, 3.5), 0.5);

// ================== 混响（Schroeder：4 梳状 + 2 全通）==================
const WET = new Float32Array(N);
for (let i = 0; i < N; i++) WET[i] = L[i] * 0.5 + R[i] * 0.5;

function reverb(src) {
  const out = new Float32Array(src.length);
  const combs = [
    [1687, 0.805],
    [1601, 0.795],
    [2053, 0.788],
    [2251, 0.775],
  ];
  for (const [d, fb] of combs) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < src.length; i++) {
      const y = buf[idx];
      out[i] += y * 0.25;
      buf[idx] = src[i] + y * fb;
      idx++;
      if (idx === d) idx = 0;
    }
  }
  for (const [d, fb] of [
    [556, 0.5],
    [441, 0.5],
    [341, 0.5],
  ]) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const bo = buf[idx];
      const y = -out[i] + bo;
      buf[idx] = out[i] + bo * fb;
      out[i] = y;
      idx++;
      if (idx === d) idx = 0;
    }
  }
  return out;
}

const WETOUT = reverb(WET);
// 混响加回去；右声道延迟 13ms，做出一点空间宽度
const RDELAY = Math.round(0.013 * SR);
for (let i = 0; i < N; i++) {
  const w = WETOUT[i] * 0.5;
  L[i] += w;
  const j = i - RDELAY;
  R[i] += j >= 0 ? WETOUT[j] * 0.52 : 0;
}

// ================== 尾部折回开头，做成无缝循环 ==================
for (let i = 0; i < TAILN; i++) {
  L[i] += L[LOOPN + i];
  R[i] += R[LOOPN + i];
}

// ================== 总线：软限幅 + 归一化 ==================
let peak = 0;
for (let i = 0; i < LOOPN; i++) {
  // 软削波：超过阈值后慢慢压住，不会硬切出爆音
  L[i] = Math.tanh(L[i] * 0.72);
  R[i] = Math.tanh(R[i] * 0.72);
  const a = Math.abs(L[i]);
  const b = Math.abs(R[i]);
  if (a > peak) peak = a;
  if (b > peak) peak = b;
}
const norm = peak > 0 ? 0.89 / peak : 1;

// 淡入淡出：只做 8ms，纯粹为了不让循环点"啪"一下
const FADE = Math.round(0.008 * SR);

const out = Buffer.alloc(44 + LOOPN * 4);
out.write('RIFF', 0);
out.writeUInt32LE(36 + LOOPN * 4, 4);
out.write('WAVE', 8);
out.write('fmt ', 12);
out.writeUInt32LE(16, 16);
out.writeUInt16LE(1, 20);
out.writeUInt16LE(2, 22);
out.writeUInt32LE(SR, 24);
out.writeUInt32LE(SR * 4, 28);
out.writeUInt16LE(4, 32);
out.writeUInt16LE(16, 34);
out.write('data', 36);
out.writeUInt32LE(LOOPN * 4, 40);

let rms = 0;
for (let i = 0; i < LOOPN; i++) {
  let f = 1;
  if (i < FADE) f = i / FADE;
  else if (i >= LOOPN - FADE) f = (LOOPN - i) / FADE;
  const l = Math.max(-1, Math.min(1, L[i] * norm * f));
  const r = Math.max(-1, Math.min(1, R[i] * norm * f));
  rms += l * l + r * r;
  out.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
  out.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
}
rms = Math.sqrt(rms / (LOOPN * 2));

// 每 2 小节的响度轮廓，用来确认结构（前段/高潮/收尾）确实有起伏
const perBar = [];
for (let bar = 0; bar < BARS; bar += 2) {
  let s = 0;
  const from = Math.round(bar * BAR * SR);
  const to = Math.round((bar + 2) * BAR * SR);
  for (let i = from; i < to; i++) s += L[i] * L[i] * norm * norm;
  perBar.push(Math.sqrt(s / (to - from)).toFixed(3));
}

writeFileSync(new URL('./menu-theme.raw.wav', import.meta.url), out);
console.log(`时长 ${LOOP.toFixed(1)}s  峰值 ${(peak * norm).toFixed(3)}  整体 RMS ${rms.toFixed(3)}`);
console.log(`每 2 小节的 RMS 轮廓：${perBar.join('  ')}`);
console.log(`已写出 tools/menu-theme.raw.wav（${(out.length / 1048576).toFixed(1)} MB）`);
