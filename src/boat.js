// 炮艇：第三种载具（海战用）。低模就行 —— 一个扁船体 + 四棱锥船头 + 甲板/舱室 + 炮塔。
//
// 直接继承 Tank：炮塔瞄准、开炮、装填、受伤、被砸、结算这一整套都能原样复用，
// 只改两件事：
//   1) 模型换成船；
//   2) 出行方式 —— 深水不是墙（ignoreWater），反过来它必须**待在水里**，
//      所以每帧把船沿着海岸线拉到湖面椭圆以内（_keepInWater），开不上岸。

import * as THREE from 'three';
import { CONFIG, COLORS, TEAM } from './config.js';
import { Tank } from './tank.js';
import { rand, clamp } from './utils.js';

export class Boat extends Tank {
  constructor(world, opts = {}) {
    super(world, { ...opts, ignoreWater: true });
    this.isBoat = true;
    this.name = opts.name || `炮艇${this.id}`;

    // 海战的数值：皮薄、炮慢、跑得快（航速 / 转向玩家和 AI 共用，见 config）
    this.maxHealth = CONFIG.boat.health;
    this.health = this.maxHealth;
    this.radius = CONFIG.boat.radius;
    this.speed = CONFIG.boat.speed;
    this.turnSpeed = CONFIG.boat.turnSpeed;
    this.magazine = CONFIG.boat.magazine;
    this.rounds = this.magazine;
    this.loadTime = this.isPlayer
      ? CONFIG.boat.loadPerShell
      : rand(CONFIG.boat.aiLoadPerShell[0], CONFIG.boat.aiLoadPerShell[1]);
    this.draft = CONFIG.boat.draft;
    this.barrelBaseY = 2.9;

    // 一开始就摆到水面上（Tank 构造里是按地形高度放的，海里那是盆底）
    this._keepInWater();
    const level = world.terrain.waterLevelAt ? world.terrain.waterLevelAt(this.pos.x, this.pos.z) : null;
    if (level !== null) this.pos.y = level - this.draft;
  }

  // ---------- 模型（低模）----------

  _buildModel() {
    const isEnemy = this.team === TEAM.ENEMY;
    const hullColor = this.isPlayer ? COLORS.player : isEnemy ? COLORS.enemy : COLORS.ally;
    const turretColor = this.isPlayer ? COLORS.playerTurret : isEnemy ? COLORS.enemyTurret : COLORS.allyTurret;

    this.bodyMaterials = [];
    const mkMat = (color, metal = 0.25, rough = 0.65) => {
      const m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
      this.bodyMaterials.push(m);
      return m;
    };

    // 船体：扁盒子，吃水线以下的部分就藏在水里
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 7.0), mkMat(hullColor, 0.25, 0.6));
    hull.position.y = 0.9;
    hull.castShadow = true;
    this.object.add(hull);

    // 船头：四棱锥（低模就是棱角分明的意思），尖朝前
    const bowGeo = new THREE.ConeGeometry(1.9, 3.2, 4);
    bowGeo.rotateX(Math.PI / 2);
    bowGeo.rotateY(Math.PI / 4);
    const bow = new THREE.Mesh(bowGeo, mkMat(hullColor, 0.3, 0.55));
    bow.position.set(0, 1.6, 4.1);
    bow.castShadow = true;
    this.object.add(bow);

    // 甲板
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.42, 5.6), mkMat(hullColor, 0.34, 0.5));
    deck.position.set(0, 1.85, -0.4);
    deck.castShadow = true;
    this.object.add(deck);

    // 舰桥
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.25, 1.9), mkMat(hullColor, 0.42, 0.44));
    cabin.position.set(0, 2.6, -1.9);
    cabin.castShadow = true;
    this.object.add(cabin);

    // 炮塔 + 炮管：字段名和坦克完全一致，所以瞄准/开炮/避障那一套直接能用
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.set(0, 2.05, 1.9);   // 前甲板上的主炮
    this.object.add(this.turretGroup);

    const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 1.0, 8), mkMat(turretColor, 0.4, 0.46));
    turret.position.y = 0.5;
    turret.castShadow = true;
    this.turretGroup.add(turret);

    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.y = 0.55;
    this.turretGroup.add(this.barrelPivot);

    const barrelGeo = new THREE.CylinderGeometry(0.17, 0.22, 5.2, 8);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, 2.6);
    this.barrel = new THREE.Mesh(barrelGeo, mkMat(COLORS.barrel, 0.55, 0.24));
    this.barrel.position.z = 1.1;
    this.barrel.castShadow = true;
    this.barrelPivot.add(this.barrel);

    this.muzzleDummy = new THREE.Object3D();
    this.muzzleDummy.position.set(0, 0, 6.3 + 1.1);
    this.barrelPivot.add(this.muzzleDummy);

    this.barrelMaxDist = 6.3 + 1.1;
    this.barrelDist = this.barrelMaxDist;

    // 玩家脚下光环（水上也得看得见自己）
    if (this.isPlayer) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(4.2, 4.9, 28),
        new THREE.MeshBasicMaterial({ color: 0x6fe3ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.35;
      this.object.add(ring);
      this.markerRing = ring;
    }

    this.wreckMat = new THREE.MeshStandardMaterial({ color: COLORS.wreck, metalness: 0.35, roughness: 0.9 });
  }

  // ---------- 出行 ----------

  update(dt) {
    super.update(dt);
    // 别开出海面：贴着海岸线里侧滑，不会搁浅在滩上
    this._keepInWater();
  }

  // 把船拉回"真实水线"以内。
  // 注意不能拿湖面那个椭圆当边界 —— 椭圆比水面大得多，靠外那一圈其实是滩
  // （湖盆是从椭圆边平滑挖下去的，地面到 k≈0.8 才刚沉到水面以下）。
  // 所以这里按方向读 terrain 存好的水线（waterRing），再往里留一点余量。
  // 拉的时候角度不变 —— 等于沿着海岸线滑，而不是硬顶在原处。
  _keepInWater() {
    const t = this.world.terrain;
    if (!t.lakes || !t.lakes.length) return;
    let best = null;
    let bestK = Infinity;
    for (const L of t.lakes) {
      const k = Math.hypot((this.pos.x - L.x) / L.rx, (this.pos.z - L.z) / L.rz);
      if (k < bestK) {
        bestK = k;
        best = L;
      }
    }
    if (!best) return;
    let ux = (this.pos.x - best.x) / best.rx;
    let uz = (this.pos.z - best.z) / best.rz;
    const len = Math.hypot(ux, uz);
    if (len < 1e-4) { ux = 1; uz = 0; } else { ux /= len; uz /= len; }
    const lim = this._shoreLimit(best, Math.atan2(uz, ux));
    if (bestK <= lim) return;
    this.pos.x = best.x + ux * lim * best.rx;
    this.pos.z = best.z + uz * lim * best.rz;
    // 撞到海岸线 = 撞到东西：AI 靠 blocked 知道自己在顶岸，会绕
    this.blocked = true;
    this.blockPush.x = 0;
    this.blockPush.z = 0;
    this.blockPush.hit = true;
  }

  // 这个方向上船能跑到的最外侧 = 水线 × keepIn（留余量，别把船头搁在滩上）
  _shoreLimit(L, th) {
    const t = this.world.terrain;
    const k = t.ringAt ? t.ringAt(L, th) : 0.85;
    return k * CONFIG.boat.keepIn;
  }

  // 海战里"能不能修"照旧（附近没敌人就能修）—— Tank 那套判断不用改
}

// 在湖面上找几个出生点：我方在西侧、敌方在东侧。
// 关键是**按真实水线摆** —— 湖面的椭圆比水大得多，直接按椭圆比例摆会把人摆到滩上。
export function waterSpawns(terrain, team, count) {
  const out = [];
  if (!terrain.lakes || !terrain.lakes.length) return out;
  const L = terrain.lakes[0];
  const dir = team === TEAM.ALLY ? -1 : 1;    // 我方在西、敌方在东
  // 出生点离岸多远：海图比湖图大得多，用同一个比例会让两军隔 400 多米，所以图可以自己调
  const frac = terrain.biome && terrain.biome.boatSpawnFrac !== undefined
    ? terrain.biome.boatSpawnFrac
    : CONFIG.boat.spawnFrac;
  const ringAt = (th) => (terrain.ringAt ? terrain.ringAt(L, th) : 0.8);
  const put = (ux, uz) => {
    const len = Math.hypot(ux, uz) || 1;
    const nx = (dir * ux) / len;
    const nz = uz / len;
    const th = Math.atan2(nz, nx);
    let lim = Math.max(0.1, ringAt(th) * frac);
    // 别把船生在礁岛上：真压上去了就往湖心方向收
    const islands = terrain.islands || [];
    for (let s = 0; s < 8; s++) {
      const x = L.x + nx * lim * L.rx;
      const z = L.z + nz * lim * L.rz;
      const hit = islands.some((I) => Math.hypot(I.x - x, I.z - z) < I.shore + 12);
      if (!hit) break;
      lim *= 0.78;
    }
    out.push(new THREE.Vector3(L.x + nx * lim * L.rx, 0, L.z + nz * lim * L.rz));
  };
  // 沿湖的短轴上下错开，别让两条船叠在一条线上
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    put(1, side * (0.34 + 0.28 * Math.floor(i / 2)));
  }
  for (const v of out) {
    const level = terrain.waterLevelAt(v.x, v.z);
    v.y = level === null ? terrain.heightAt(v.x, v.z) : level - CONFIG.boat.draft;
  }
  return out;
}
