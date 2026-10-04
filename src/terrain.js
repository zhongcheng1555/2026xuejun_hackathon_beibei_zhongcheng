// 随机地形：按生物群系生成高度场、配色、掩体，可能还会有一条小溪

import * as THREE from 'three';
import { CONFIG, BIOMES } from './config.js';
import { clamp, lerp, rand, randInt, smoothstep } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Terrain {
  constructor(scene, noise, biome = BIOMES[0]) {
    this.scene = scene;
    this.noise = noise;
    this.biome = biome;

    this.size = biome.size;
    this.seg = Math.round(
      clamp(this.size / CONFIG.terrain.cell, CONFIG.terrain.minSeg, CONFIG.terrain.maxSeg)
    );
    this.half = this.size / 2;
    this.step = this.size / this.seg;
    this.row = this.seg + 1;
    this.heights = new Float32Array(this.row * this.row);

    this.colliders = [];
    this.grid = new Map();
    this.cell = 24;
    this.playable = this.half * 0.78;

    // 火山地形：真的堆一座火山出来 —— 直接算进高度场（见 rawHeight），
    // 所以坦克撞得到、炮弹打得到、AI 也会自己绕开，不用额外的碰撞体。
    // 摆在地图正中：两队从南北两头往里打，火从中间往外推，两边被挤的余地一样
    this.volcano = null;
    if (biome.id === 'volcano') {
      const v = CONFIG.volcano;
      this.volcano = { x: 0, z: 0, r: v.r, rim: v.rim, crater: v.crater, depth: v.craterDepth };
    }
    // 喷发状态（火只在火山这张图上会烧起来，见 startEruption）
    this.fireActive = false;
    this.fireRadius = 0;
    this._firePainted = 0;
    this.fireDamage = 0;

    // 水带：沿着 z 方向蜿蜒的一条带子，随机决定这局有没有
    // kind 决定它是什么：普通河水 / 冰面 / 岩浆
    this.stream = null;
    if (biome.stream && Math.random() < biome.stream.chance) {
      const s = biome.stream;
      this.stream = {
        width: s.width,
        depth: s.depth,
        kind: s.kind || 'water',
        color: s.color || 0x35678a,
        glow: !!s.glow,                 // 自发光（岩浆）
        damage: s.damage || 0,          // 每秒掉多少血（岩浆）
        speedMul: s.speedMul,           // 走在上面的速度倍率（缺省用全局 waterSpeed）
        // 水带只铺地图中间的这一段。1 = 从头贯到尾；
        // 岩浆河必须小于 1，否则一条河会把战场劈成两半，两队永远碰不到面、残局收不掉
        span: s.span === undefined ? 1 : s.span,
        baseX: rand(-0.25, 0.25) * this.size,
        amp1: this.size * rand(0.12, 0.2),
        f1: rand(0.006, 0.011),
        p1: rand(0, Math.PI * 2),
        amp2: this.size * rand(0.03, 0.07),
        f2: rand(0.02, 0.04),
        p2: rand(0, Math.PI * 2),
      };
    }

    // 隧道（山谷用）：通道上面盖一层岩顶。空的时候所有查询都是白跑，别的图不受影响
    this.tunnels = [];
    this.waterPlants = { lilies: 0, reeds: 0, weeds: 0 };   // 水生植物数量（没有海的图恒为 0）
    this.roofTop = 0;
    this.roofBot = 0;

    // 大湖：一大片水面，不是一条带子 —— 它把战场切成几条通道，坦克得绕着走，
    // 或者当两栖车硬趟过去（能过但很慢，见 tank.js 的涉水处理）。
    // 位置用"相对地图半宽的比例"给，spots 里每一项是 [-1,1] 的 (x,z)。
    this.lakes = [];
    if (biome.lake) {
      const L = biome.lake;
      if (Math.random() < (L.chance === undefined ? 1 : L.chance)) {
        const n = Math.max(1, L.count || 1);
        for (let i = 0; i < n; i++) {
          let rx = 0;
          let rz = 0;
          if (L.spots && L.spots[i]) { rx = L.spots[i][0]; rz = L.spots[i][1]; }
          else if (n > 1) { rx = (i - (n - 1) / 2) * (L.gap || 0.5); }
          this.lakes.push({
            x: rx * this.half,
            z: rz * this.half,
            rx: L.rx * this.size,      // 横向半径（米）
            rz: L.rz * this.size,      // 纵向半径（米）
            depth: L.depth,
            color: L.color || 0x2e6f96,
            speedMul: L.speedMul,
            level: null,               // 水面高度：等地面高度场建好才能定，见 _buildLakeSurface
          });
        }
      }
    }

    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    this._buildGround();
    this._buildCrater();      // 火山口里那池岩浆（只有火山图有）
    this._buildStreamSurface();
    this._buildLakeSurface(); // 大湖的水面（只有带 lake 配置的图有）
    this._buildWadeRing();    // "浅滩能趟到哪儿"的岸线（同上，必须在水位定好之后）
    this._buildWaterPlants(); // 水里的荷叶/芦苇/海草（同上）
    // 城市废墟走"街区"布局，花园迷宫走"挖通道"布局，其他地形是随机撒掩体
    if (biome.maze) this._buildMaze();
    else if (biome.city) this._buildCity();
    else this._scatterObstacles();

    // 这张图最高障碍物的顶（含隧道岩顶）。飞机用它决定"最低能飞到哪" ——
    // 山谷的岩壁有 24m 高，只按"离地 18m 拉起来"会让俯冲中的飞机撞在岩壁顶上掉翅膀。
    // 必须等掩体都建好之后才能算
    this.obstacleTop = 0;
    this.roofTopAbs = 0;      // 隧道岩顶最高处：飞机必须整个飞在它上面
    for (const c of this.colliders) this.obstacleTop = Math.max(this.obstacleTop, c.y + c.h);
    for (const r of this.tunnels) {
      this.obstacleTop = Math.max(this.obstacleTop, r.yt);
      this.roofTopAbs = Math.max(this.roofTopAbs, r.yt);
    }
  }

  // 岩浆/冰面这类"需要单独一层材质"的水带，铺一层薄薄的表面
  // 河水靠地面顶点色就够了，所以默认不铺
  _buildStreamSurface() {
    const s = this.stream;
    if (!s) return;
    if (s.kind === 'water') return;

    const cols = 60;
    const z0 = -this.size * 0.5 * s.span;
    const z1 = this.size * 0.5 * s.span;
    const pos = new Float32Array(cols * 2 * 3);
    const idx = [];
    for (let i = 0; i < cols; i++) {
      const z = z0 + (i / (cols - 1)) * (z1 - z0);
      const cx = this.streamCenterX(z);
      const w = s.width * 0.78;
      // 贴着水面高度
      const y = this.rawHeight(cx, z) + s.depth * 0.55;
      pos[(i * 2) * 3] = cx - w;
      pos[(i * 2) * 3 + 1] = y;
      pos[(i * 2) * 3 + 2] = z;
      pos[(i * 2 + 1) * 3] = cx + w;
      pos[(i * 2 + 1) * 3 + 1] = y;
      pos[(i * 2 + 1) * 3 + 2] = z;
      if (i < cols - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: s.color,
      roughness: s.glow ? 0.55 : 0.25,
      metalness: 0,
      emissive: s.glow ? s.color : 0x000000,
      emissiveIntensity: s.glow ? 0.85 : 0,
    });
    this.streamMesh = new THREE.Mesh(geo, mat);
    this.streamMesh.name = 'stream';
    this.group.add(this.streamMesh);

    if (s.glow) {
      // 岩浆在夜里是主要光源。
      // 注意挂到 group 上而不是 scene 上：每局都会重建地形，挂 scene 上的话
      // 每打一局就多留一盏灯（旧地图销毁了灯还在），几局之后场景里就一堆光源
      this.streamLight = new THREE.PointLight(s.color, 1.1, 130, 2);
      this.streamLight.name = 'lavaLight';
      this.group.add(this.streamLight);
    }
  }

  // 大湖的水面：一片贴着水位高度的椭圆面。
  // 湖盆是挖出来的（见 rawHeight），所以水面盖住盆底、露出岸线。
  // 得等 _buildGround 把高度场填好才能定水位，所以放在它后面调。
  _buildLakeSurface() {
    if (!this.lakes.length) return;
    for (const L of this.lakes) {
      // 水位 = 湖心（已挖过的）盆底 + 大半个深度 —— 比湖沿低一点，岸线露在外面
      L.level = this.heightAt(L.x, L.z) + L.depth * 0.78;
      const geo = new THREE.CircleGeometry(1, 64);
      geo.rotateX(-Math.PI / 2);
      geo.scale(L.rx, 1, L.rz);
      geo.translate(L.x, L.level, L.z);
      const mat = new THREE.MeshStandardMaterial({
        color: L.color,
        roughness: 0.12,     // 又滑又亮 —— 一眼就认得出是水
        metalness: 0.15,
        transparent: true,
        opacity: 0.78,       // 留一点透，能看见水下的海草
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'lake';
      mesh.renderOrder = 1;
      this.group.add(mesh);
    }
  }

  // 湖的"浅滩能趟到哪儿"：沿 32 个方向从岸边往里扫，记下"水深刚好还没超过
  // wadeDepth"的那条线（归一化椭圆距离）。
  // 为什么要它：湖盆是平滑挖出来的，水面是固定高度的一块平面 ——
  // **露出水面的岸线其实在椭圆里面**（大约 k≈0.87），而原来的墙就是椭圆边本身。
  // 于是坦克会停在离水二三十米的干地上，"一点水都不让沾"。现在墙换成这条
  // 真正的水深线：浅滩能开进去（浮起来、变慢），只有比 wadeDepth 更深才算墙。
  _buildWadeRing() {
    if (!this.lakes.length) return;
    const N = 32;
    const wade = CONFIG.tank.wadeDepth;
    const maxFrac = CONFIG.tank.wadeMaxFrac;
    for (const L of this.lakes) {
      const ring = new Float32Array(N);
      const water = new Float32Array(N);   // 真实水线（地面刚低于水面）——炮艇用它当"海岸"
      for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2;
        const cx = Math.cos(th);
        const cz = Math.sin(th);
        let kWater = 1.02;      // 露出来的水线（水刚从这儿开始盖住地面）
        let kWade = 1.02;       // 水深还没超过 wadeDepth 的最里面那条线
        let seenWater = false;
        for (let s = 1; s <= 90; s++) {
          const kk = 1.02 - s * 0.012;       // 从岸边一直扫到接近湖心
          const h = this.heightAt(L.x + cx * L.rx * kk, L.z + cz * L.rz * kk);
          const d = L.level - h;
          if (!seenWater && d > 0.15) { seenWater = true; kWater = kk; }
          if (d > wade) break;               // 比这深了：就停在上一步
          kWade = kk;
        }
        // 取更靠外的那条：既要水深够浅，也不能一口气趟进湖心
        // （湖底是起伏的，有些方向上"浅水"能一直延伸到很里面）
        ring[i] = Math.max(kWade, kWater - maxFrac);
        water[i] = kWater;
      }
      L.wadeRing = ring;
      L.waterRing = water;   // 水面那圈（椭圆本身比水大得多 —— 椭圆里靠外这一圈其实是滩）
    }
  }

  // 水生植物：荷叶浮在水面、芦苇从浅水边长出来、海草长在水下。
  // 全部是**装饰**，不登记碰撞体 —— 不挡子弹也不挡车，纯粹让海看起来是活的。
  // 必须等水位定好（_buildLakeSurface）之后才能摆，所以放它后面调
  _buildWaterPlants() {
    if (!this.lakes.length) return;
    const parts = this.biome.parts || {};
    const lilies = [];
    const reeds = [];
    const weeds = [];
    for (const L of this.lakes) {
      // 荷叶：湖里随机撒，一小片片贴着水面
      const nLily = Math.round((L.rx * L.rz) / 1100);
      for (let i = 0; i < nLily; i++) {
        const a = rand(0, Math.PI * 2);
        const r = Math.sqrt(Math.random()) * 0.92;
        lilies.push({
          x: L.x + Math.cos(a) * L.rx * r,
          z: L.z + Math.sin(a) * L.rz * r,
          y: L.level + 0.06, ry: rand(0, Math.PI * 2),
          s: rand(1.5, 3.2), tint: rand(0.85, 1.12),
        });
      }
      // 芦苇丛：贴着浅水边（归一化 0.86~1.0），露出水面一大截
      const nReed = Math.round((L.rx + L.rz) / 11);
      for (let i = 0; i < nReed; i++) {
        const a = rand(0, Math.PI * 2);
        const k = rand(0.86, 1.0);
        reeds.push({
          x: L.x + Math.cos(a) * L.rx * k,
          z: L.z + Math.sin(a) * L.rz * k,
          y: L.level - 0.5, ry: rand(0, Math.PI * 2),
          s: rand(0.7, 1.5), tint: rand(0.85, 1.15),
        });
      }
      // 海草：长在湖底，从水下冒上来（水面留了透明度，能看见一片片黑影）
      const nWeed = Math.round((L.rx * L.rz) / 3000);
      for (let i = 0; i < nWeed; i++) {
        const a = rand(0, Math.PI * 2);
        const r = Math.sqrt(Math.random()) * 0.88;
        const x = L.x + Math.cos(a) * L.rx * r;
        const z = L.z + Math.sin(a) * L.rz * r;
        weeds.push({
          x, z, y: this.heightAt(x, z) + 0.3, ry: rand(0, Math.PI * 2),
          s: rand(0.8, 1.6), tint: rand(0.8, 1.1),
        });
      }
    }

    const leaf = parts.leaf || 0x3f6f2c;
    // 记个数：测试和调试要用（也能一眼看出这张图到底摆了没有）
    this.waterPlants = { lilies: lilies.length, reeds: reeds.length, weeds: weeds.length };
    if (lilies.length) {
      const geo = new THREE.CircleGeometry(1, 9);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({
        color: parts.lily || leaf, roughness: 0.85, side: THREE.DoubleSide,
      });
      this._instanced(geo, mat, lilies, (s, o) => s.set(o.s, 1, o.s), false);
    }
    if (reeds.length) {
      const geo = new THREE.CylinderGeometry(0.09, 0.16, 7, 4);
      geo.translate(0, 3.5, 0);            // 底边落在物体位置上
      const mat = new THREE.MeshStandardMaterial({
        color: parts.reed || leaf, roughness: 1, flatShading: true,
      });
      this._instanced(geo, mat, reeds, (s, o) => s.set(o.s * 0.9, o.s, o.s * 0.9), true);
    }
    if (weeds.length) {
      const geo = new THREE.ConeGeometry(0.55, 11, 5);
      geo.translate(0, 5.5, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: parts.weed || 0x2f6b4a, roughness: 1, flatShading: true,
      });
      this._instanced(geo, mat, weeds, (s, o) => s.set(o.s, o.s, o.s), false);
    }
  }

  // 每帧：让岩浆微微呼吸（热量感），并把光源挂到玩家附近
  update(dt, focus) {
    const s = this.stream;
    // 夜里的岩浆要比白天更亮（它是光源）。这个倍率由 main.js 每局设一次
    const lit = this.night ? (CONFIG.night.lavaLightMul || 1) : 1;
    if (this.craterLight) this.craterLight.intensity = 1.3 * lit;
    if (!s || !s.glow || !this.streamMesh) return;
    this._glowT = (this._glowT || 0) + dt;
    const k = 0.8 + Math.sin(this._glowT * 1.7) * 0.12 + Math.sin(this._glowT * 4.3) * 0.05;
    this.streamMesh.material.emissiveIntensity = k * (this.night ? (CONFIG.night.lavaGlowMul || 1) : 1);
    if (this.streamLight && focus) {
      // 点光源跟着镜头附近的岩浆段，不跟着玩家就照不到
      this.streamLight.position.set(this.streamCenterX(focus.z), this.heightAt(this.streamCenterX(focus.z), focus.z) + 6, focus.z);
      this.streamLight.intensity = k * 1.15 * (this.night ? (CONFIG.night.lavaLightMul || 1) : 1);
    }
  }

  // 站在这里每秒掉多少血（岩浆 / 火山喷发的火；别的地方恒为 0）
  hazardAt(x, z) {
    const s = this.stream;
    if (s && s.damage && this.streamDistance(x, z) < s.width * 0.8) return s.damage;
    return this.inFire(x, z) ? this.fireDamage : 0;
  }

  // 火线里吗（火山喷发之后才有）。喷发的火走的是和岩浆同一套判定，
  // 所以坦克会掉血 + 跑不动，AI 也会像躲岩浆那样主动往外躲
  inFire(x, z) {
    if (!this.fireActive || !this.volcano) return false;
    const dx = x - this.volcano.x;
    const dz = z - this.volcano.z;
    return dx * dx + dz * dz < this.fireRadius * this.fireRadius;
  }

  // ---------- 火山 ----------

  // 火山口里那池岩浆 + 一盏火山光。喷发之前它就是这张图的地标
  _buildCrater() {
    const v = this.volcano;
    if (!v) return;
    const color = (this.stream && this.stream.color) || 0xe0500f;
    const geo = this.mesh && this.mesh.geometry;
    // 不另摆一块平板当岩浆（碗形地形上平板会穿帮），直接把火山口范围内的
    // 地面顶点染成岩浆色 —— 贴着地形起伏，看着就是锅里的一池岩浆
    if (geo && this._baseColors) {
      const pos = geo.attributes.position;
      const col = geo.attributes.color;
      const lava = new THREE.Color(color);
      const tmp = new THREE.Color();
      const cr = v.crater * 0.92;
      const r2 = cr * cr;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - v.x;
        const dz = pos.getZ(i) - v.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const k = 1 - Math.sqrt(d2) / cr;
        tmp.setRGB(this._baseColors[i * 3], this._baseColors[i * 3 + 1], this._baseColors[i * 3 + 2])
          .lerp(lava, 0.55 + 0.45 * k);
        col.setXYZ(i, tmp.r, tmp.g, tmp.b);
      }
      col.needsUpdate = true;
    }
    // 地面顶点色只改"颜色"，不发光 —— 夜里没太阳，那一池岩浆就只是一团暗红。
    // 这里再贴着碗形地形叠一层**加法混合**的发光面（中心最亮、边缘淡出），
    // 它不吃光照也不吃雾，所以白天夜里都是"一池会发光的岩浆"。
    // 不用平板：平板在碗形地形上会穿帮，所以按网格采样 heightAt 贴着地面铺。
    const seg = 20;
    const cr2 = v.crater * 0.95;
    const vpos = [];
    const vcol = [];
    const vidx = [];
    const lavaC = new THREE.Color(color);
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const x = v.x + ((i / seg) - 0.5) * 2 * cr2;
        const z = v.z + ((j / seg) - 0.5) * 2 * cr2;
        const d = Math.hypot(x - v.x, z - v.z);
        vpos.push(x, this.heightAt(x, z) + 0.3, z);
        if (d >= cr2) { vcol.push(0, 0, 0); continue; }
        const k = 1 - d / cr2;
        const b = 0.3 + 0.7 * k * k;
        vcol.push(lavaC.r * b, lavaC.g * b, lavaC.b * b);
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i;
        vidx.push(a, a + 1, a + seg + 1, a + 1, a + seg + 2, a + seg + 1);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(vpos, 3));
    gg.setAttribute('color', new THREE.Float32BufferAttribute(vcol, 3));
    gg.setIndex(vidx);
    const gm = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,          // 加法混合下再叠雾会糊成一团，直接不吃雾
    });
    this.craterGlow = new THREE.Mesh(gg, gm);
    this.craterGlow.name = 'craterGlow';
    this.craterGlow.renderOrder = 2;
    this.group.add(this.craterGlow);

    const y = this.heightAt(v.x, v.z);
    this.craterLight = new THREE.PointLight(color, 1.3, 170, 2);
    this.craterLight.position.set(v.x, y + 12, v.z);
    this.group.add(this.craterLight);
  }

  // 喷发：火焰从火山口外缘开始往外爬（不会一上来就点着火山口里那池岩浆）
  startEruption() {
    if (!this.volcano || this.fireActive) return false;
    const s = this.stream;
    this.fireDamage = (s && s.damage) || 9;      // 和岩浆一个烧法
    this.fireActive = true;
    this.fireRadius = CONFIG.volcano.lag;
    this._firePainted = 0;
    this._repaintFire();
    if (!this.fireLight) {
      const y = this.heightAt(this.volcano.x, this.volcano.z);
      this.fireLight = new THREE.PointLight(0xff6a22, 0, 460, 2);
      this.fireLight.position.set(this.volcano.x, y + 45, this.volcano.z);
      this.group.add(this.fireLight);
    }
    return true;
  }

  // 火线一帧帧往外推。喷发起 fullAt - eruptAt 秒之后，半径正好够到地图四角
  updateFire(dt) {
    if (!this.fireActive) return;
    const v = CONFIG.volcano;
    const full = Math.hypot(this.half, this.half);
    this.fireRadius = Math.min(full, this.fireRadius + ((full - v.lag) / Math.max(1, v.fullAt - v.eruptAt)) * dt);
    // 每推进 2 米才重染一次地面（每帧染几万个顶点没必要）
    if (this.fireRadius - this._firePainted > 2) {
      this._firePainted = this.fireRadius;
      this._repaintFire();
    }
    if (this.fireLight) {
      this.fireLight.intensity = 2.6 * clamp((this.fireRadius - v.lag) / 40, 0, 1);
    }
  }

  // 把"已经烧到"的地面顶点染红。用的是地面自己的顶点色，
  // 所以火是贴着地形起伏在爬，不会像贴一张平板那样穿帮
  _repaintFire() {
    const base = this._baseColors;
    const geo = this.mesh && this.mesh.geometry;
    if (!base || !geo || !this.volcano) return;
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    const fire = new THREE.Color(0xff5514);
    const tmp = new THREE.Color();
    const r2 = this.fireRadius * this.fireRadius;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - this.volcano.x;
      const dz = pos.getZ(i) - this.volcano.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;                       // 还没烧到，保持底色
      const k = 1 - Math.sqrt(d2) / Math.max(1, this.fireRadius);
      tmp.setRGB(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]).lerp(fire, 0.5 + 0.5 * k);
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  }

  // ---------- 高度 ----------

  streamCenterX(z) {
    const s = this.stream;
    return s.baseX + Math.sin(z * s.f1 + s.p1) * s.amp1 + Math.sin(z * s.f2 + s.p2) * s.amp2;
  }

  streamDistance(x, z) {
    const s = this.stream;
    if (!s) return Infinity;
    // 只在地图中间那一段有水带，两头是干的（这样才绕得过去）
    if (s.span < 1 && Math.abs(z) > s.span * this.size * 0.5) return Infinity;
    return Math.abs(x - this.streamCenterX(z));
  }

  // ---------- 大湖 ----------

  // 归一化椭圆距离：<1 在湖里，0 在湖心。不在任何湖里返回 Infinity
  lakeK(x, z) {
    let best = Infinity;
    for (const L of this.lakes) {
      const k = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
      if (k < best) best = k;
    }
    return best;
  }

  inLake(x, z) {
    return this.lakes.length > 0 && this.lakeK(x, z) < 1;
  }

  // 湖面高度（不在湖里返回 null）—— 坦克用它决定"浮多高"，而不是沉到盆底
  waterLevelAt(x, z) {
    for (const L of this.lakes) {
      if (Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz) < 1) return L.level;
    }
    return null;
  }

  // 泡在水里的速度倍率（不在水里返回 1）
  waterSpeedMulAt(x, z) {
    for (const L of this.lakes) {
      if (Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz) < 1) {
        return L.speedMul !== undefined ? L.speedMul : CONFIG.terrain.waterSpeed;
      }
    }
    if (this.stream && this.stream.kind !== 'ice' && this.streamDistance(x, z) < this.stream.width * 0.8) {
      return this.stream.speedMul !== undefined ? this.stream.speedMul : CONFIG.terrain.waterSpeed;
    }
    return 1;
  }

  // 水覆盖到这里了吗（溪流 + 大湖）——用来避免把坦克/掩体刷进水里
  onStream(x, z) {
    if (this.stream && this.streamDistance(x, z) < this.stream.width * 0.8) return true;
    return this.inLake(x, z);
  }

  // 会减速的水：河水 / 岩浆 / 大湖。冰面是硬地，按正常速度走
  isWater(x, z) {
    if (this.stream && this.stream.kind !== 'ice' && this.streamDistance(x, z) < this.stream.width * 0.8) {
      return true;
    }
    return this.inLake(x, z);
  }

  rawHeight(x, z) {
    const n = this.noise;
    const s = this.biome.noiseScale;
    let h = n.fbm(x * s, z * s, 5) * this.biome.heightScale;
    h += n.fbm(x * s * 3.1 + 100, z * s * 3.1 - 55, 3) * this.biome.ridge;

    const d = Math.max(Math.abs(x), Math.abs(z)) / this.half;
    const t = smoothstep((d - CONFIG.map.wallStart) / (1 - CONFIG.map.wallStart));
    h += t * t * CONFIG.map.wallHeight;

    // 火山本体：外坡从山脚升到火山口边缘，火山口再往下挖一个碗
    if (this.volcano) {
      const v = this.volcano;
      const dv = Math.hypot(x - v.x, z - v.z);
      if (dv <= v.crater) {
        h += v.rim - v.depth * (1 - (dv / v.crater) ** 2);
      } else if (dv < v.r) {
        const k = (v.r - dv) / (v.r - v.crater);   // 0 山脚 → 1 火山口边缘
        h += v.rim * k ** 0.8;
      }
    }

    if (this.stream) {
      const dist = this.streamDistance(x, z);
      if (dist < this.stream.width) {
        const k = 1 - dist / this.stream.width;
        h -= this.stream.depth * k * k + 1.1 * k;
      }
    }
    // 大湖：挖一个盆。边缘 45% 的范围内平滑入水，中间是平底 ——
    // 不然盆壁太陡，坦克从水里爬上岸时会卡住
    for (const L of this.lakes) {
      const k = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
      if (k >= 1) continue;
      const t = clamp((1 - k) / 0.45, 0, 1);
      h -= L.depth * t * t * (3 - 2 * t);
    }
    return h;
  }

  heightAt(x, z) {
    const gx = clamp((x + this.half) / this.step, 0, this.seg - 0.0001);
    const gz = clamp((z + this.half) / this.step, 0, this.seg - 0.0001);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const tx = gx - x0;
    const tz = gz - z0;
    const i0 = z0 * this.row + x0;
    const i1 = i0 + this.row;
    const h00 = this.heights[i0];
    const h10 = this.heights[i0 + 1];
    const h01 = this.heights[i1];
    const h11 = this.heights[i1 + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = this.step;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  slopeAt(x, z) {
    const n = this.normalAt(x, z, new THREE.Vector3());
    return 1 - n.y;
  }

  // 移动速度系数：上坡慢、下坡快，涉水更慢。dir 需要是单位向量
  speedFactorAt(x, z, dirX, dirZ) {
    let f = 1;
    if (this.inFire(x, z)) {
      f *= CONFIG.volcano.slowMul;          // 火里跑不动（"锅上的蚂蚁"就是这种感觉）
    } else if (this.isWater(x, z)) {
      f *= this.waterSpeedMulAt(x, z);
    }
    if (dirX !== 0 || dirZ !== 0) {
      const ahead = 7;
      const ha = this.heightAt(x + dirX * ahead, z + dirZ * ahead);
      const hb = this.heightAt(x - dirX * ahead, z - dirZ * ahead);
      const grade = (ha - hb) / (ahead * 2); // 正值 = 上坡
      f *= clamp(1 - grade * CONFIG.terrain.uphillSlow, CONFIG.terrain.speedMin, CONFIG.terrain.speedMax);
    }
    return f;
  }

  // ---------- 地面网格 ----------

  _buildGround() {
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.seg, this.seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.rawHeight(x, z);
      pos.setY(i, h);
      const ix = Math.round((x + this.half) / this.step);
      const iz = Math.round((z + this.half) / this.step);
      this.heights[iz * this.row + ix] = h;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const g = this.biome.ground;
    const base = new THREE.Color(g.base);
    const second = new THREE.Color(g.second);
    const rock = new THREE.Color(g.rock);
    const high = new THREE.Color(g.high);
    const wetBank = base.clone().multiplyScalar(this.stream && this.stream.kind === 'ice' ? 0.86 : 0.7);
    const water = new THREE.Color(this.lakes.length ? this.lakes[0].color : (this.stream ? this.stream.color : 0x35678a));

    const nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const slope = 1 - nrm.getY(i);

      const patch = this.noise(x * 0.02 + 7, z * 0.02 - 3) * 0.5 + 0.5;
      c.copy(base).lerp(second, clamp(patch, 0, 1));

      const edge = smoothstep((Math.max(Math.abs(x), Math.abs(z)) / this.half - 0.7) / 0.3);
      const rockBlend = clamp(smoothstep((slope - 0.28) / 0.35) + edge * 0.9, 0, 1);
      c.lerp(rock, rockBlend);
      c.lerp(high, clamp((y - 16) / 18, 0, 1) * 0.85);

      // 溪流：岸边湿土 → 中间变成水面
      if (this.stream) {
        const w = this.stream.width;
        const dist = this.streamDistance(x, z);
        if (dist < w * 1.15) {
          const k = clamp((w * 1.15 - dist) / (w * 0.9), 0, 1);
          c.lerp(wetBank, k * 0.5);
          c.lerp(water, clamp((k - 0.45) / 0.55, 0, 1) * 0.9);
        }
      }

      // 大湖：湖底也染成水的颜色（水面网格盖在上面，湖底只是从岸边浅水透出来）
      if (this.lakes.length) {
        for (const L of this.lakes) {
          const k = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
          if (k >= 1.1) continue;
          const t = clamp((1.06 - k) / 0.5, 0, 1);
          c.lerp(wetBank, clamp(t * 1.4, 0, 1) * 0.5);
          c.lerp(water, clamp((t - 0.3) / 0.7, 0, 1) * 0.9);
        }
      }

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // 存一份底色：火山喷发时要按"火焰烧到哪"把地面重新染色（见 _repaintFire）
    this._baseColors = colors.slice();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.02,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ground';
    this.group.add(this.mesh);

    // 远景色：战场**四周**继续延伸出去的平地，一直铺到雾里。
    // 没有它的话，从高山或高空看过去，世界会在地平线处"断掉"露出虚空。
    //
    // 关键：必须铺成"回"字形（中间留空），不能是一整块大平板 ——
    // 它的高度（39.6m）比森林/沙漠/草原/丘陵的内部地形都高，
    // 一整块会像天花板一样盖在战场上方，观战的上帝视角从上往下看
    // 只能看见这块纯色平板，地形全被挡住（看上去"一片黄"）。
    const half = this.half;
    const outer = CONFIG.map.backdrop * 0.5;
    const bgMat = new THREE.MeshStandardMaterial({
      color: this.biome.ground.high,
      roughness: 1,
      metalness: 0,
    });
    const strips = [
      [CONFIG.map.backdrop, outer - half, 0, -(half + outer) / 2],      // 北
      [CONFIG.map.backdrop, outer - half, 0, (half + outer) / 2],       // 南
      [outer - half, half * 2, -(half + outer) / 2, 0],                 // 西
      [outer - half, half * 2, (half + outer) / 2, 0],                  // 东
    ];
    for (const [w, d, x, z] of strips) {
      const geo = new THREE.PlaneGeometry(w, d);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, bgMat);
      m.position.set(x, CONFIG.map.wallHeight * CONFIG.map.backdropLevel, z);
      m.name = 'backdrop';
      this.group.add(m);
    }
  }

  // ---------- 掩体 ----------

  // 这里离水太近吗（避免把树种到海里 / 河边）。margin 传障碍物自己的半径，
  // 免得一棵树"站在水里、树冠露出水面"
  tooCloseToWater(x, z, margin = 0) {
    if (this.stream && this.streamDistance(x, z) < this.stream.width * 1.05 + margin) return true;
    for (const L of this.lakes) {
      const k = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
      if (k < 1 + margin / Math.min(L.rx, L.rz)) return true;
    }
    return false;
  }

  _scatterObstacles() {
    const b = this.biome;
    const parts = b.parts;
    const trees = [];
    const rocks = [];
    const bushes = [];
    const bags = [];

    const tryPlace = (r, tries = 24) => {
      for (let i = 0; i < tries; i++) {
        const x = rand(-this.playable * 1.02, this.playable * 1.02);
        const z = rand(-this.playable * 1.02, this.playable * 1.02);
        if (this.slopeAt(x, z) > 0.42) continue;
        if (this.tooCloseToWater(x, z, r)) continue;   // 河边 / 海里都不放东西
        let ok = true;
        for (const c of this.colliders) {
          const dx = c.x - x;
          const dz = c.z - z;
          const minD = c.r + r + 2.5;
          if (dx * dx + dz * dz < minD * minD) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        return { x, z, y: this.heightAt(x, z) };
      }
      return null;
    };

    const addCollider = (x, z, y, r, h, kind) => this._pushCollider(x, z, y, r, h, kind);

    for (let i = 0; i < b.trees; i++) {
      const p = tryPlace(2.2);
      if (!p) continue;
      const scale = rand(0.75, 1.5);
      trees.push({ ...p, ry: rand(0, Math.PI * 2), s: scale, tint: rand(0.75, 1.15) });
      addCollider(p.x, p.z, p.y, 1.7 * scale, 12 * scale, 'tree');
    }
    for (let i = 0; i < b.rocks; i++) {
      const p = tryPlace(3.0);
      if (!p) continue;
      const scale = rand(0.8, 2.0);
      rocks.push({ ...p, ry: rand(0, Math.PI * 2), s: scale, tint: rand(0.8, 1.2) });
      addCollider(p.x, p.z, p.y, 2.4 * scale, 2.6 * scale, 'rock');
    }
    for (let i = 0; i < b.bushes; i++) {
      const p = tryPlace(1.6);
      if (!p) continue;
      const scale = rand(0.7, 1.4);
      bushes.push({ ...p, ry: rand(0, Math.PI * 2), s: scale, tint: rand(0.8, 1.15) });
    }
    for (let i = 0; i < b.sandbags; i++) {
      const p = tryPlace(3.0);
      if (!p) continue;
      const s = rand(0.9, 1.3);
      bags.push({ ...p, ry: rand(0, Math.PI * 2), s, tint: 1 });
      addCollider(p.x, p.z, p.y, 2.2 * s, 1.5 * s, 'sandbag');
    }

    if (trees.length) {
      const trunkGeo = new THREE.CylinderGeometry(0.5, 0.75, 5.5, 6);
      trunkGeo.translate(0, 2.75, 0);
      const trunkMat = new THREE.MeshStandardMaterial({ color: parts.trunk, roughness: 1 });
      this._instanced(trunkGeo, trunkMat, trees, (s, o) => s.setScalar(o.s * 0.9), true);

      const leafGeo = new THREE.ConeGeometry(3.3, 9.5, 7);
      leafGeo.translate(0, 9.4, 0);
      const leafMat = new THREE.MeshStandardMaterial({ color: parts.leaf, roughness: 1, flatShading: true });
      this._instanced(leafGeo, leafMat, trees, (s, o) => s.set(o.s * 1.05, o.s, o.s * 1.05), true);

      // 雪原的雪松：树冠顶上再压一层雪 —— 一小段比树冠略宽、略高的白色锥，
      // 底边卡在树冠六成高处、锥尖比树冠尖冒出去一点，看着就是"雪盖在树尖上"。
      // 只有写了 parts.snowCap 的生物群系才长雪（别的图这行不执行）
      if (parts.snowCap) {
        const capGeo = new THREE.ConeGeometry(1.45, 4.3, 7);
        capGeo.translate(0, 12.5, 0);   // 底 10.35 / 尖 14.65（树冠尖在 14.15）
        const capMat = new THREE.MeshStandardMaterial({
          color: parts.snowCap, roughness: 0.62, metalness: 0, flatShading: true,
        });
        this._instanced(capGeo, capMat, trees, (s, o) => s.set(o.s * 1.05, o.s, o.s * 1.05), true);
      }
    }

    if (rocks.length) {
      const rockGeo = new THREE.IcosahedronGeometry(2.1, 0);
      rockGeo.translate(0, 1.2, 0);
      const rockMat = new THREE.MeshStandardMaterial({ color: parts.rock, roughness: 0.86, metalness: 0.05, flatShading: true });
      this._instanced(rockGeo, rockMat, rocks, (s, o) => s.set(o.s, o.s * rand(0.6, 0.95), o.s), true);
    }

    if (bushes.length) {
      const bushGeo = new THREE.IcosahedronGeometry(1.5, 1);
      bushGeo.translate(0, 1.0, 0);
      const bushMat = new THREE.MeshStandardMaterial({ color: parts.bush, roughness: 1, flatShading: true });
      this._instanced(bushGeo, bushMat, bushes, (s, o) => s.set(o.s * 1.2, o.s * 0.8, o.s * 1.2), true);
    }

    if (bags.length) {
      const bagGeo = new THREE.BoxGeometry(4.2, 1.5, 2.6);
      bagGeo.translate(0, 0.75, 0);
      const bagMat = new THREE.MeshStandardMaterial({ color: parts.sandbag, roughness: 1 });
      this._instanced(bagGeo, bagMat, bags, (s, o) => s.setScalar(o.s), true);
    }
  }

  _instanced(geo, mat, list, scaleFn, shadow) {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);
    const color = new THREE.Color();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      pos.set(o.x, o.y, o.z);
      q.setFromAxisAngle(UP, o.ry || 0);
      sc.set(1, 1, 1);
      scaleFn(sc, o);
      m4.compose(pos, q, sc);
      mesh.setMatrixAt(i, m4);
      color.setScalar(o.tint === undefined ? 1 : o.tint);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (shadow) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    this.group.add(mesh);
    return mesh;
  }

  // ---------- 碰撞体登记 ----------

  _pushCollider(x, z, y, r, h, kind = 'building') {
    const col = { x, z, y, r, h, kind };
    this.colliders.push(col);
    const cx = Math.floor((x + this.half) / this.cell);
    const cz = Math.floor((z + this.half) / this.cell);
    const key = `${cx},${cz}`;
    if (!this.grid.has(key)) this.grid.set(key, []);
    this.grid.get(key).push(col);
    return col;
  }

  // 一个方盒建筑：现有碰撞系统只认圆，所以用 4 个圆近似它的四个角
  _boxCollider(x, z, w, d, ry, h) {
    const y = this.heightAt(x, z);
    const hw = w * 0.32;
    const hd = d * 0.32;
    const r = Math.min(w, d) * 0.42;
    const ca = Math.cos(ry);
    const sa = Math.sin(ry);
    for (const [ux, uz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      this._pushCollider(x + ca * ux * hw + sa * uz * hd, z - sa * ux * hw + ca * uz * hd, y, r, h);
    }
    // 中间再补一个，免得坦克从四个圆之间挤进去
    this._pushCollider(x, z, y, Math.min(w, d) * 0.5, h);
  }

  // 一道长墙：沿墙身等距摆一串圆
  _lineCollider(x, z, len, ry, r, h) {
    const y = this.heightAt(x, z);
    const n = Math.max(2, Math.round(len / (r * 1.5)));
    const dx = Math.cos(ry);
    const dz = -Math.sin(ry);
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1) - 0.5) * Math.max(0, len - r * 2);
      this._pushCollider(x + dx * t, z + dz * t, y, r, h);
    }
  }

  // ---------- 城市废墟 ----------
  //
  // 不随机撒掩体，而是按"街区 + 街道"的网格摆：
  // 每个街区里放 1~3 栋建筑（塌楼 / 断墙 / 集装箱），街区之间留出街道。
  // 街道是坦克的主要机动路线，也是巷战的交战区；楼房挡住视线，
  // 所以在街谷里很难被飞机发现。
  _buildCity() {
    const parts = this.biome.parts;
    const ruins = [];
    const slabs = [];
    const walls = [];
    const crates = [[], [], [], []];
    const rubble = [];

    const N = this.biome.cityBlocks || 5;
    const span = this.playable * 1.9;
    const cell = span / N;
    const blockMax = cell * 0.58;   // 街区里可用的范围，剩下的是街道
    const base = -this.playable * 0.95;

    const mk = (x, z) => ({ x, z, y: this.heightAt(x, z), ry: 0, tint: rand(0.82, 1.12) });

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const cx = base + (i + 0.5) * cell;
        const cz = base + (j + 0.5) * cell;
        const n = randInt(1, 3);
        for (let k = 0; k < n; k++) {
          const ox = cx + rand(-0.5, 0.5) * blockMax;
          const oz = cz + rand(-0.5, 0.5) * blockMax;
          if (this.slopeAt(ox, oz) > 0.42 || this.onStream(ox, oz)) continue;
          const roll = Math.random();

          if (roll < 0.38) {
            // 塌楼：方楼 + 顶上歪着的一块断板（看起来像被打塌了）
            const w = rand(9, 15);
            const d = rand(9, 15);
            const h = rand(7, 13);
            const ry = rand(0, Math.PI * 2);
            ruins.push({ ...mk(ox, oz), ry, sx: w, sy: h, sz: d });
            slabs.push({
              ...mk(ox + rand(-2.5, 2.5), oz + rand(-2.5, 2.5)),
              ry: ry + rand(-0.6, 0.6),
              y: this.heightAt(ox, oz) + h,
              sx: w * rand(0.45, 0.8), sy: rand(0.7, 1.6), sz: d * rand(0.45, 0.8),
            });
            this._boxCollider(ox, oz, w, d, ry, h);
          } else if (roll < 0.7) {
            // 断墙：一长条矮墙（坦克打得到墙那边的目标，但走不过去）
            const len = rand(15, 27);
            const th = rand(1.1, 1.9);
            const h = rand(3.8, 6.2);
            const ry = rand(0, Math.PI * 2);
            walls.push({ ...mk(ox, oz), ry, sx: len, sy: h, sz: th });
            this._lineCollider(ox, oz, len, ry, th * 0.75, h);
          } else {
            // 集装箱：并排或叠起来，颜色分组
            const cn = randInt(1, 3);
            const ry = Math.random() < 0.5 ? 0 : Math.PI / 2;
            const cols = parts.container || [parts.concrete || 0x8a8782];
            for (let m = 0; m < cn; m++) {
              const along = (m % 2 === 0 ? -0.5 : 0.5) * 6.4;
              const up = Math.floor(m / 2) * 2.7;
              const px = ox + Math.cos(ry) * along;
              const pz = oz - Math.sin(ry) * along;
              if (this.slopeAt(px, pz) > 0.42 || this.onStream(px, pz)) continue;
              crates[m % cols.length].push({
                x: px, z: pz, y: this.heightAt(px, pz) + up, ry,
                sx: 6.1, sy: 2.6, sz: 2.45, tint: rand(0.88, 1.06),
              });
              this._pushCollider(px, pz, this.heightAt(px, pz), 1.8, 2.9);
            }
          }
        }
        // 街角撒瓦砾
        for (let k = 0; k < 5; k++) {
          const ox = cx + rand(-0.5, 0.5) * cell;
          const oz = cz + rand(-0.5, 0.5) * cell;
          if (this.onStream(ox, oz)) continue;
          rubble.push({ ...mk(ox, oz), s: rand(0.55, 1.5) });
        }
      }
    }

    // ---- 摆出来 ----
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);   // 原点挪到底面中心，这样缩放就是从地面往上长

    if (ruins.length) {
      const mat = new THREE.MeshStandardMaterial({ color: parts.concrete || parts.rock, roughness: 0.95 });
      this._instanced(boxGeo, mat, ruins, (s, o) => s.set(o.sx, o.sy, o.sz), true);
    }
    if (slabs.length) {
      const mat = new THREE.MeshStandardMaterial({ color: parts.concrete || parts.rock, roughness: 0.95, flatShading: true });
      this._instanced(boxGeo, mat, slabs, (s, o) => s.set(o.sx, o.sy, o.sz), true);
    }
    if (walls.length) {
      const mat = new THREE.MeshStandardMaterial({ color: parts.concrete || parts.rock, roughness: 1 });
      this._instanced(boxGeo, mat, walls, (s, o) => s.set(o.sx, o.sy, o.sz), true);
    }
    const cols = parts.container || [parts.concrete || 0x8a8782];
    for (let g = 0; g < crates.length; g++) {
      if (!crates[g].length) continue;
      const mat = new THREE.MeshStandardMaterial({ color: cols[g % cols.length], roughness: 0.5, metalness: 0.45 });
      this._instanced(boxGeo, mat, crates[g], (s, o) => s.set(o.sx, o.sy, o.sz), true);
    }
    if (rubble.length) {
      const geo = new THREE.IcosahedronGeometry(1.7, 0);
      geo.translate(0, 0.7, 0);
      const mat = new THREE.MeshStandardMaterial({ color: parts.rock, roughness: 1, flatShading: true });
      this._instanced(geo, mat, rubble, (s, o) => s.set(o.s, o.s * rand(0.4, 0.7), o.s), true);
    }
  }

  // ---------- 花园迷宫 ----------
  //
  // 大块绿色植物围成格子，通道在格子之间 —— 真的很像迷宫。
  // 生成用"挖通道法"（随机深度优先），从任意一格出发都能走到其他所有格，
  // 保证不会出现坦克走不到的死区；之后再随机多打通一点，留些回路。
  //
  // 关键：把迷宫结构记录下来交给 AI 寻路（ai.js 的 _mazeWaypoint）。
  // 不做这一步的话，坦克只会朝目标直线冲，会整整齐齐地顶在树篱上寸步难行。
  _buildMaze() {
    const N = this.biome.mazeBlocks || 8;
    const span = this.playable * 1.9;
    const pitch = span / N;
    const corridor = Math.min(this.biome.mazeCorridor || 20, pitch * 0.72);
    const t = Math.max(5, pitch - corridor);         // 树篱厚度（比通道还厚，看着就是一大坨植物）
    const h = this.biome.mazeHeight || 9.5;
    const origin = -this.playable * 0.95;

    // openV[i][j]：能从 (i,j) 往 +x 走进 (i+1,j)；openH 同理往 +z
    const openV = [];
    const openH = [];
    const seen = [];
    for (let i = 0; i < N; i++) {
      openV.push(new Array(N).fill(false));
      openH.push(new Array(N).fill(false));
      seen.push(new Array(N).fill(false));
    }
    const stack = [[randInt(0, N - 1), randInt(0, N - 1)]];
    seen[stack[0][0]][stack[0][1]] = true;
    while (stack.length) {
      const [i, j] = stack[stack.length - 1];
      const nbr = [];
      if (i + 1 < N && !seen[i + 1][j]) nbr.push([1, 0]);
      if (i - 1 >= 0 && !seen[i - 1][j]) nbr.push([-1, 0]);
      if (j + 1 < N && !seen[i][j + 1]) nbr.push([0, 1]);
      if (j - 1 >= 0 && !seen[i][j - 1]) nbr.push([0, -1]);
      if (!nbr.length) {
        stack.pop();
        continue;
      }
      const [dx, dz] = nbr[randInt(0, nbr.length - 1)];
      if (dx === 1) openV[i][j] = true;
      else if (dx === -1) openV[i - 1][j] = true;
      else if (dz === 1) openH[i][j] = true;
      else openH[i][j - 1] = true;
      seen[i + dx][j + dz] = true;
      stack.push([i + dx, j + dz]);
    }
    // 再随机打通一些墙：纯迷宫全是死胡同，坦克进去就出不来，打着也不痛快
    const extra = this.biome.mazeOpen === undefined ? 0.12 : this.biome.mazeOpen;
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < N; j++) if (!openV[i][j] && Math.random() < extra) openV[i][j] = true;
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - 1; j++) if (!openH[i][j] && Math.random() < extra) openH[i][j] = true;
    }

    // ---- 节点空地（山谷用）----
    // 山谷要的是"很窄的走廊 + 一个个路口，路口的 8 个方向都能走"。
    // 只打通格子自己的四面墙只是十字路口（4 向）；要能斜着走，必须把
    // **墙角上那两堵墙**也拿掉 —— 所以这里有两种挖法：
    //   · 节点空地（mazePlazas）：拿掉这一格自己的四面墙 → 一个十字路口
    //   · 转角打通（mazeCorners）：拿掉墙角相交的那几堵墙 → 斜向穿过去
    // 花园迷宫两个都没写，所以完全不受影响。
    const carve = [];   // { x, z, r }
    const plazaRate = this.biome.mazePlazas || 0;
    if (plazaRate > 0) {
      for (let i = 1; i < N - 1; i++) {
        for (let j = 1; j < N - 1; j++) {
          if (Math.random() >= plazaRate) continue;
          // 边上那一圈不开口，免得把地图边缘捅穿
          if (i > 0) openV[i - 1][j] = true;
          if (i < N - 1) openV[i][j] = true;
          if (j > 0) openH[i][j - 1] = true;
          if (j < N - 1) openH[i][j] = true;
          // 0.78*pitch：够得到自己那四面墙（在 0.5*pitch），够不到隔壁那圈（1.5*pitch）
          carve.push({ x: origin + (i + 0.5) * pitch, z: origin + (j + 0.5) * pitch, r: pitch * 0.78 });
        }
      }
    }
    const cornerRate = this.biome.mazeCorners || 0;
    if (cornerRate > 0) {
      for (let i = 1; i < N; i++) {
        for (let j = 1; j < N; j++) {
          if (Math.random() >= cornerRate) continue;
          // 0.6*pitch：正好够到"在这个墙角相交的那四堵墙"（都在 0.5*pitch 处），
          // 把角让开之后，斜对面那一格就能直接穿过去 —— 这才是 8 个方向
          carve.push({ x: origin + i * pitch, z: origin + j * pitch, r: pitch * 0.6 });
        }
      }
    }
    // 每个节点都必须有一条斜的通道（山谷要的）。
    // 按概率挖墙角的话，总有节点的四个角一个都没挖开 —— 那种节点就只能走横竖。
    // 所以这里再兜一遍：谁一个角都没开，就随便给它开一个
    if (this.biome.mazeDiagonalAll) {
      const cornerAt = (ci, cj) =>
        carve.some((c) => Math.abs(c.x - (origin + ci * pitch)) < 0.5 && Math.abs(c.z - (origin + cj * pitch)) < 0.5);
      for (let i = 1; i <= N - 2; i++) {
        for (let j = 1; j <= N - 2; j++) {
          const cs = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]];
          if (cs.some(([ci, cj]) => cornerAt(ci, cj))) continue;
          const [ci, cj] = cs[randInt(0, 3)];
          carve.push({ x: origin + ci * pitch, z: origin + cj * pitch, r: pitch * 0.6 });
        }
      }
    }
    const inPlaza = (cx, cz) => {
      for (const c of carve) {
        if (Math.abs(cx - c.x) < c.r && Math.abs(cz - c.z) < c.r) return true;
      }
      return false;
    };

    // ---- 墙体清单 ----
    const walls = [];   // { cx, cz, len, vertical, ry }
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < N; j++) {
        if (openV[i][j]) continue;
        const cx = origin + (i + 1) * pitch;
        const cz = origin + (j + 0.5) * pitch;
        if (inPlaza(cx, cz)) continue;
        walls.push({ cx, cz, len: pitch + t, ry: -Math.PI / 2 });
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - 1; j++) {
        if (openH[i][j]) continue;
        const cx = origin + (i + 0.5) * pitch;
        const cz = origin + (j + 1) * pitch;
        if (inPlaza(cx, cz)) continue;
        walls.push({ cx, cz, len: pitch + t, ry: 0 });
      }
    }
    // 四周围一圈，把迷宫封起来
    for (let j = 0; j < N; j++) {
      walls.push({ cx: origin, cz: origin + (j + 0.5) * pitch, len: pitch + t, ry: -Math.PI / 2 });
      walls.push({ cx: origin + N * pitch, cz: origin + (j + 0.5) * pitch, len: pitch + t, ry: -Math.PI / 2 });
    }
    for (let i = 0; i < N; i++) {
      walls.push({ cx: origin + (i + 0.5) * pitch, cz: origin, len: pitch + t, ry: 0 });
      walls.push({ cx: origin + (i + 0.5) * pitch, cz: origin + N * pitch, len: pitch + t, ry: 0 });
    }

    // ---- 建出来 ----
    const parts = this.biome.parts;
    const items = [];
    const lumps = [];
    for (const w of walls) {
      const y = this.heightAt(w.cx, w.cz);
      const sx = w.ry === 0 ? w.len : t;
      const sz = w.ry === 0 ? t : w.len;
      items.push({ x: w.cx, z: w.cz, y, ry: 0, sx, sy: h, sz, tint: rand(0.9, 1.08) });
      // 顶上撒一团团新叶，看着像植物而不是水泥墩
      const n = Math.max(2, Math.round(w.len / 7));
      for (let k = 0; k < n; k++) {
        const off = (k / (n - 1) - 0.5) * (w.len - t * 0.6) + rand(-1.2, 1.2);
        lumps.push({
          x: w.cx + (w.ry === 0 ? off : rand(-t * 0.4, t * 0.4)),
          z: w.cz + (w.ry === 0 ? rand(-t * 0.4, t * 0.4) : off),
          y: y + h - rand(0.4, 1.6),
          ry: rand(0, Math.PI * 2),
          s: rand(2.6, 4.4),
        });
      }
      // 碰撞：沿墙身摆一串圆（现有碰撞只认圆）
      this._lineCollider(w.cx, w.cz, w.len, w.ry, t * 0.5, h);
    }

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    // 墙的材质：花园是树篱（全哑光），山谷是岩壁（略低的粗糙度，出一点岩面的反光）
    const wallRough = parts.wallRough || 1;
    const wallMetal = parts.wallMetal || 0;
    const hedgeMat = new THREE.MeshStandardMaterial({ color: parts.hedge, roughness: wallRough, metalness: wallMetal });
    this._instanced(boxGeo, hedgeMat, items, (s, o) => s.set(o.sx, o.sy, o.sz), true);

    const lumpGeo = new THREE.IcosahedronGeometry(1, 1);
    const lumpMat = new THREE.MeshStandardMaterial({
      color: parts.hedgeTop, roughness: wallRough, metalness: wallMetal, flatShading: true,
    });
    this._instanced(lumpGeo, lumpMat, lumps, (s, o) => s.set(o.s, o.s * 0.6, o.s), true);

    // ---- 隧道：节点之间的通道盖上岩顶（山谷用）----
    // 路口（节点）露天，通道盖顶 → 头顶有岩顶，飞机从上面往下打会被岩顶吃掉，
    // 坦克在隧道里也打不出去。只有走到路口那段才露头，在那里照样会被飞机咬。
    this.tunnels = [];
    if (this.biome.tunnels) {
      const rOpen = corridor * 0.8;     // 路口附近留出来的露天段
      const hw = corridor * 0.5;        // 通道半宽（正好是两墙之间那道缝）
      const cX = (i) => origin + (i + 0.5) * pitch;
      const rects = [];
      for (let i = 0; i < N - 1; i++) {
        for (let j = 0; j < N; j++) {
          if (!openV[i][j]) continue;
          const a = cX(i) + rOpen;
          const b = cX(i + 1) - rOpen;
          if (b - a >= 3) rects.push([a, b, cX(j) - hw, cX(j) + hw]);
        }
      }
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N - 1; j++) {
          if (!openH[i][j]) continue;
          const a = cX(j) + rOpen;
          const b = cX(j + 1) - rOpen;
          if (b - a >= 3) rects.push([cX(i) - hw, cX(i) + hw, a, b]);
        }
      }
      const thickness = Math.min(3, h * 0.16);
      this.roofTop = h;
      this.roofBot = h - thickness;
      const roofItems = [];
      for (const [x0, x1, z0, z1] of rects) {
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const gy = this.heightAt(cx, cz);
        this.tunnels.push({ x0, x1, z0, z1, yb: gy + this.roofBot, yt: gy + this.roofTop });
        roofItems.push({ x: cx, z: cz, y: gy + this.roofBot, ry: 0, sx: x1 - x0, sy: thickness, sz: z1 - z0 });
      }
      if (roofItems.length) {
        const roofMat = new THREE.MeshStandardMaterial({
          color: parts.hedgeTop, roughness: wallRough, metalness: wallMetal, flatShading: true,
        });
        this._instanced(boxGeo, roofMat, roofItems, (s, o) => s.set(o.sx, o.sy, o.sz), true);
      }
    }

    // 交给 AI 寻路用的结构
    this.maze = {
      n: N,
      origin,
      pitch,
      openV,
      openH,
      plazas: carve,      // 被挖开的节点空地 / 转角（每个节点至少有一个，山谷用）
      cellAt(x, z) {
        const i = Math.floor((x - origin) / pitch);
        const j = Math.floor((z - origin) / pitch);
        if (i < 0 || j < 0 || i >= N || j >= N) return null;
        return { i, j };
      },
      centerX: (i) => origin + (i + 0.5) * pitch,
      centerZ: (j) => origin + (j + 0.5) * pitch,
    };
  }

  // 两点之间有没有"墙"挡着（楼、树篱这类高掩体）。
  // 树、石头、沙袋不算 —— 树林里枝叶挡不住炮弹，不然子弹会平白无故打不出来
  losBlocked(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    // 按距离决定采样密度（约每 12 米一个点）：隔着几百米也只取 6 个点的话，
    // 中间那栋楼会整栋被跳过去，AI 就会对着墙放炮
    const dist = Math.hypot(dx, dy, dz);
    const n = clamp(Math.round(dist / 12), 4, 34);
    for (let k = 1; k <= n; k++) {
      const s = k / (n + 1);
      const px = from.x + dx * s;
      const py = from.y + dy * s;
      const pz = from.z + dz * s;
      if (this.roofAt(px, py, pz)) return true;      // 隧道岩顶：上面打不进去
      const c = this.hitCollider(px, py, pz);
      if (c && c.kind === 'building') return true;
    }
    return false;
  }

  // 相机用：从 from 到 to 这条路上，第一个"大障碍"挡在哪个比例处（1 = 一路畅通）。
  // 只认楼/墙这类大障碍（树、石头、沙袋不算，不然树林里镜头会一直往前蹦）。
  // 采样要够密：城里最薄的墙只有 2 米多厚，隔得太稀会从两采样点中间漏过去。
  blockFraction(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    const n = clamp(Math.round(dist / 1.4), 8, 26);
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      const c = this.hitCollider(from.x + dx * s, from.y + dy * s, from.z + dz * s);
      if (c && c.kind === 'building') return (i - 1) / n;
    }
    return 1;
  }

  // 这一点离最近的障碍物还有多远（负数 = 已经在里面了）
  gapAt(x, z) {
    let g = Infinity;
    for (const c of this.colliders) {
      const d = Math.hypot(c.x - x, c.z - z) - c.r;
      if (d < g) g = d;
    }
    return g;
  }

  // ---------- 碰撞查询 ----------

  // ignoreWater 给炮艇用：水里才是它的地盘，不能把它从水里推出去（见 boat.js）
  resolveCircle(pos, radius, out, ignoreWater = false) {
    const cx = Math.floor((pos.x + this.half) / this.cell);
    const cz = Math.floor((pos.z + this.half) / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const c of arr) {
          if (pos.y > c.y + c.h) continue;
          const ddx = pos.x - c.x;
          const ddz = pos.z - c.z;
          const dist = Math.hypot(ddx, ddz);
          const minDist = c.r + radius;
          if (dist < minDist) {
            const nx = dist > 1e-4 ? ddx / dist : 1;
            const nz = dist > 1e-4 ? ddz / dist : 0;
            const bx = pos.x;
            const bz = pos.z;
            pos.x = c.x + nx * minDist;
            pos.z = c.z + nz * minDist;
            // 把"被推了多少"记下来：AI 靠它知道自己在贴着哪面墙，
            // 好沿着墙面滑行过去，而不是原地硬顶
            if (out) {
              out.x += pos.x - bx;
              out.z += pos.z - bz;
              out.hit = true;
            }
          }
        }
      }
    }
    if (!ignoreWater) this._pushOutOfWater(pos, radius, out);
    const limit = this.playable;
    pos.x = clamp(pos.x, -limit, limit);
    pos.z = clamp(pos.z, -limit, limit);
  }

  // 深水（海 / 大湖）是硬障碍：坦克、侦察兵开不进去，会被推回岸上。
  // 注意**小溪不算** —— 那是能趟的浅水。要是把河也变成墙，森林/草原/雪原那几张图
  // 中间就横着一堵过不去的墙，而 AI 的寻路完全没为"绕河"做过准备。
  // 海域才是用来"把战场切开"的那种隔离
  _pushOutOfWater(pos, radius, out) {
    if (!this.lakes.length) return;
    // 两遍：两个湖挨着的时候，被 A 推出去可能正好推进 B 里
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const L of this.lakes) {
        // 归一化椭圆距离：湖心 0、岸边 1
        let ux = (pos.x - L.x) / L.rx;
        let uz = (pos.z - L.z) / L.rz;
        const len = Math.hypot(ux, uz);
        if (len < 1e-4) { ux = 1; uz = 0; } else { ux /= len; uz /= len; }
        // 这个方向上的"深水线"（浅滩能趟到哪儿，见 _buildWadeRing）
        let lim = 1.0;
        if (L.wadeRing) {
          const N = L.wadeRing.length;
          let idx = Math.round((Math.atan2(uz, ux) / (Math.PI * 2)) * N);
          idx = ((idx % N) + N) % N;
          lim = L.wadeRing[idx];
        }
        // 判定线和推出线是同一条：坦克**停在浅滩边上**（连续、不跳），
        // 而不是"探进水里一点就被瞬移甩回来"（那是玩家反馈的"自动倒退"）
        if (len >= lim) continue;
        const bx = pos.x;
        const bz = pos.z;
        pos.x = L.x + ux * L.rx * lim;
        pos.z = L.z + uz * L.rz * lim;
        if (out) {
          out.x += pos.x - bx;
          out.z += pos.z - bz;
          out.hit = true;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  // 这一点是不是在隧道的岩顶里（头顶那层石头）。
  // 坦克的炮弹、飞机的子弹、飞机本身撞上它都会被挡下 ——
  // 这就是"飞机从上面打不到隧道里的坦克"。别的图没有隧道，直接 false
  roofAt(x, y, z) {
    for (const r of this.tunnels) {
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      if (y >= r.yb && y <= r.yt) return true;
    }
    return false;
  }

  // 这一点头顶的岩顶下沿（不在隧道里返回 null）—— 相机把镜头压在隧道里面用
  roofBottomAt(x, z) {
    let best = null;
    for (const r of this.tunnels) {
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      if (best === null || r.yb < best) best = r.yb;
    }
    return best;
  }

  hitCollider(x, y, z) {
    const cx = Math.floor((x + this.half) / this.cell);
    const cz = Math.floor((z + this.half) / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const c of arr) {
          if (y < c.y || y > c.y + c.h) continue;
          if (Math.hypot(x - c.x, z - c.z) < c.r) return c;
        }
      }
    }
    return null;
  }

  randomSpawnPoint(minDistFrom, minDist) {
    // 一个点行不行：不在陡坡、不在水里、不在障碍物里、离已有单位够远
    const okPoint = (x, z) => {
      if (this.slopeAt(x, z) > 0.3) return false;
      if (this.onStream(x, z)) return false;
      for (const c of this.colliders) {
        if (Math.hypot(c.x - x, c.z - z) < c.r + 5) return false;
      }
      if (minDistFrom) {
        for (const p of minDistFrom) {
          if (Math.hypot(p.x - x, p.z - z) < minDist) return false;
        }
      }
      return true;
    };
    const lim = this.playable * 0.95;
    for (let i = 0; i < 60; i++) {
      const x = rand(-lim, lim);
      const z = rand(-lim, lim);
      if (okPoint(x, z)) return new THREE.Vector3(x, this.heightAt(x, z), z);
    }
    // 兜底：随机挑不中就系统性地把整个战场扫一遍（约 5.5 米一格）。
    // 迷宫那种"一大半面积都是树篱"的图会走到这里 ——
    // 原来的兜底是"随便给个中心附近的点"，会把坦克直接塞进障碍物里。
    const n = 64;
    const step = (lim * 2) / (n - 1);
    const off = randInt(0, n - 1);
    const at = (k) => ({ x: -lim + (k % n) * step, z: -lim + Math.floor(k / n) * step });
    for (let i = 0; i < n * n; i++) {
      const p = at((i + off) % (n * n));
      if (okPoint(p.x, p.z)) return new THREE.Vector3(p.x, this.heightAt(p.x, p.z), p.z);
    }
    // 真的挤爆了（理论上不会）：退一步，只要求"不站在障碍物里"
    for (let i = 0; i < n * n; i++) {
      const p = at((i + off) % (n * n));
      if (this.gapAt(p.x, p.z) >= CONFIG.tank.radius) {
        return new THREE.Vector3(p.x, this.heightAt(p.x, p.z), p.z);
      }
    }
    return new THREE.Vector3(0, this.heightAt(0, 0), 0);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else if (o.material) o.material.dispose();
    });
    this.colliders.length = 0;
    this.grid.clear();
  }
}
