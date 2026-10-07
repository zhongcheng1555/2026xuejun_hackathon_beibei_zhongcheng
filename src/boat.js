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

// 齐射时复用的临时量（别每帧 new）
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _mz = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

export class Boat extends Tank {
  constructor(world, opts = {}) {
    super(world, { ...opts, ignoreWater: true });
    this.isBoat = true;
    this.name = opts.name || `炮艇${this.id}`;

    // 炮艇的数值（见 config.boat 那一段的定位说明）：
    //   快、皮薄、转向笨；一轮齐射糊脸 + 舰炮准 + 能抬头打飞机
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
    // —— 三样载具各有的活法，炮艇这一份 ——
    this.salvo = CONFIG.boat.salvo;               // 一次扳机打几发
    this.salvoSpread = CONFIG.boat.salvoSpread;   // 扇形半角
    this.shellSpeed = CONFIG.boat.shellSpeed;     // 舰炮：初速更高、弹道更平
    this.shellDamage = CONFIG.boat.shellDamage;
    this.aimErrorMul = CONFIG.boat.aimErrorMul;   // 远距离的瞄准误差只有坦克的四成
    this.pitchMax = CONFIG.boat.turretPitchMax;   // 仰角更大：能抬头打低空飞机

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

    // 三根炮管并排：一轮齐射就是这三根同时出膛（低模，三根管子比一根好认）
    const barrelGeo = new THREE.CylinderGeometry(0.17, 0.22, 5.2, 8);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, 2.6);
    this.barrelSide = 0.62;                     // 相邻炮管的横向间距
    this.barrels = [];
    for (const bx of [-this.barrelSide, 0, this.barrelSide]) {
      const b = new THREE.Mesh(barrelGeo, mkMat(COLORS.barrel, 0.55, 0.24));
      b.position.set(bx, 0, 1.1);
      b.castShadow = true;
      this.barrelPivot.add(b);
      this.barrels.push(b);
    }
    // Tank 那一套（瞄准虚线、炮口避障）只认一根炮管：拿中间那根当"主炮口"
    this.barrel = this.barrels[1];

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

  // ---------- 舰炮齐射 ----------
  //
  // 和坦克最大的区别就在这儿：坦克是"一发一发精确点射"（弹夹 10 发，能一直压着打），
  // 炮艇是"一轮三发一起出膛"，呈固定的扇形铺开、三根炮管各出一发。
  // 近距离糊脸特别狠（三发全中就是 54 点），打移动目标容错也高；
  // 代价是这三发共用一次装填 —— 打空之后有几秒钟完全没火力，只能绕圈躲
  fire() {
    if (!this.alive) return false;
    if (this.rounds < this.salvo) return false;   // 不满一轮齐射就不放（半轮打出去更亏）
    if (this.shotTimer > 0) return false;

    if (this.repairTimer > 0) this.cancelRepair();
    this.shotTimer = CONFIG.tank.shotInterval;
    this.rounds -= this.salvo;

    const n = this.salvo;
    const spreadMul = this.precise ? CONFIG.spread.aim : CONFIG.spread.move;
    const spread = CONFIG.bullet.spread * spreadMul;
    const baseDir = this.getBarrelDir(_dir).clone();

    // 三根管子的横向方向：拿炮塔的世界姿态算，海面倾斜也不影响
    this.barrelPivot.updateMatrixWorld(true);
    this.barrelPivot.getWorldQuaternion(_quat);
    _side.set(1, 0, 0).applyQuaternion(_quat);

    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;                  // -1 / 0 / +1
      // 扇形：以炮口方向为中心左右各偏一点（固定角度，不随机 —— 所以远处也是窄窄一撮）
      const dir = baseDir.clone().applyAxisAngle(_up, k * this.salvoSpread);
      dir.x += rand(-spread, spread);             // 再叠上坦克那套随机散布
      dir.y += rand(-spread, spread);
      dir.z += rand(-spread, spread);
      dir.normalize();
      const muzzle = this.getMuzzlePos(_mz).clone().addScaledVector(_side, k * this.barrelSide);
      this.world.bullets.spawn({
        pos: muzzle,
        dir,
        speed: this.shellSpeed,
        damage: this.shellDamage,
        owner: this,
        team: this.team,
        kind: 'shell',
      });
    }
    this.world.effects.muzzleFlash(this.getMuzzlePos(_mz), baseDir, 1.25);
    this.recoil = 1;
    return true;
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
