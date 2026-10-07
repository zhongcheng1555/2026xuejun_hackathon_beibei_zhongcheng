// 坦克实体：玩家、友军 AI、敌方 AI 用同一套模型，只换颜色

import * as THREE from 'three';
import { CONFIG, COLORS, TEAM, LAVA } from './config.js';
import { clamp, rand, turnTowards, wrapAngle } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
let idCounter = 1;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class Tank {
  constructor(world, opts = {}) {
    this.world = world;
    this.team = opts.team;
    this.isPlayer = !!opts.isPlayer;
    // 水里的载具（炮艇）：深水不是墙，反而是它唯一能跑的地方（见 boat.js）
    this.ignoreWater = !!opts.ignoreWater;
    this.id = idCounter++;
    this.name = opts.name || `坦克${this.id}`;

    this.maxHealth = CONFIG.tank.health;
    this.health = this.maxHealth;
    this.radius = CONFIG.tank.radius;
    this.alive = true;
    this.kills = 0;
    // 行驶参数：坦克用这套默认值，炮艇之类的子类在构造函数里覆盖（见 boat.js）。
    // speed / turnSpeed 玩家和 AI 是**同一个数** —— 见 config 里那一段说明
    this.speed = CONFIG.tank.speed;
    this.turnSpeed = CONFIG.tank.turnSpeed;
    this.draft = CONFIG.tank.waterDraft;   // 浮在水里时沉下去多少
    this.barrelBaseY = 2.97;               // 炮塔枢轴离地多高（炮管避障用）

    this.yaw = opts.yaw ?? rand(0, Math.PI * 2);
    this.turretYaw = this.yaw;
    this.turretPitch = 0;
    this.magazine = CONFIG.tank.magazine;  // 弹夹容量（个别坦克会被单独调小，比如纯空战那辆）
    this.rounds = this.magazine;           // 弹夹里已经装好的弹
    this.shotTimer = 0;                  // 连发间隔计时
    // 弹链式装填：不是"打空才换弹夹"，而是一颗一颗往弹夹里压
    this.loadTimer = 0;
    this.loadTime = this.isPlayer
      ? CONFIG.tank.loadPerShell
      : rand(CONFIG.tank.aiLoadPerShell[0], CONFIG.tank.aiLoadPerShell[1]);
    this.hitFlash = 0;
    this.recoil = 0;
    // 被坠落飞机砸中后的"跑不动"倒计时（不致命，只是短时间挪不快）
    this.slowTimer = 0;
    this.precise = false;   // 玩家：false=移动模式，true=瞄准模式（慢、准、有虚线弹道）
    // 瞄准模式的减速倍率。正常是 aimSpeed；AI 在"追着飞机打"时会临时调成 1，
    // 免得开着瞄准模式慢慢蹭，永远追不到天上的飞机
    this.aimSpeedMul = CONFIG.player.aimSpeed;
    // 应急修复：累计伤害的一半可以修回来，另一半永久损失
    this.damageTaken = 0;
    this.repairTimer = 0;
    this.repairRate = 0;

    // 想去的方向：玩家用 controlForward / controlTurn，AI 用 moveIntent（世界方向×强度）
    this.controlForward = 0;
    this.controlTurn = 0;
    this.moveIntent = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    // 这一帧被障碍推了多少 / 推开后得到的墙面法线 / 是否正贴着障碍。
    // AI 靠它沿墙面滑行（不然就会顶着石头原地磨，森林丘陵花园都吃亏）
    this.blockPush = { x: 0, z: 0, hit: false };
    this.blockNormal = new THREE.Vector3();
    this.blocked = false;

    this.object = new THREE.Group();
    this.object.name = this.name;
    this.pos = this.object.position;

    this._buildModel();
    const p = opts.position || new THREE.Vector3();
    this.pos.copy(p);
    this.pos.y = world.terrain.heightAt(p.x, p.z);
    world.scene.add(this.object);

    // 头顶什么也不挂：没有血条，也没有阵营箭头。
    // 认敌我只看车体涂装 —— 藏在树后面的敌车，涂装被挡住就真的看不出来了（要的就是这个）
    this._applyTurret();
    this.update(0);
  }

  // ---------- 模型 ----------

  _buildModel() {
    const isEnemy = this.team === TEAM.ENEMY;
    const bodyColor = this.isPlayer ? COLORS.player : isEnemy ? COLORS.enemy : COLORS.ally;
    const turretColor = this.isPlayer ? COLORS.playerTurret : isEnemy ? COLORS.enemyTurret : COLORS.allyTurret;

    this.bodyMaterials = [];
    // 材质参数：这里是"看着像什么"的关键。
    // 注意整个场景没有环境贴图，金属度给太高反而会发黑（金属只反射环境光），
    // 所以金属件靠"低粗糙度 + 中等金属度"出高光，布料/橡胶件靠高粗糙度走哑光
    const mkMat = (color, metal = 0.3, rough = 0.6) => {
      const m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
      this.bodyMaterials.push(m);
      return m;
    };

    const trackMat = mkMat(COLORS.track, 0.45, 0.42);   // 履带：磨得发亮的钢，会反一道高光

    // 履带
    const trackGeo = new THREE.BoxGeometry(1.15, 1.3, 6.9);
    for (const sx of [-1.55, 1.55]) {
      const track = new THREE.Mesh(trackGeo, trackMat);
      track.position.set(sx, 0.65, 0);
      track.castShadow = true;
      this.object.add(track);
    }

    // 车体
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.5, 6.2), mkMat(bodyColor, 0.3, 0.6));
    hull.position.y = 1.3;
    hull.castShadow = true;
    this.object.add(hull);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.55, 4.4), mkMat(bodyColor, 0.34, 0.52));
    deck.position.set(0, 2.1, -0.2);
    deck.castShadow = true;
    this.object.add(deck);

    // 前装甲块，让车头有辨识度
    const plow = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.0, 0.9), mkMat(bodyColor, 0.4, 0.46));
    plow.position.set(0, 1.35, 3.3);
    plow.castShadow = true;
    this.object.add(plow);

    // 炮塔
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.y = 2.35;
    this.object.add(this.turretGroup);

    const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.55, 1.15, 8), mkMat(turretColor, 0.4, 0.46));
    turret.position.y = 0.55;
    turret.castShadow = true;
    this.turretGroup.add(turret);

    const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.42, 8), mkMat(turretColor, 0.45, 0.4));
    cupola.position.set(-0.45, 1.3, -0.35);
    cupola.castShadow = true;
    this.turretGroup.add(cupola);

    // 炮管
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.y = 0.62;
    this.turretGroup.add(this.barrelPivot);

    const barrelGeo = new THREE.CylinderGeometry(0.19, 0.24, 5.2, 8);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, 2.6);
    this.barrel = new THREE.Mesh(barrelGeo, mkMat(COLORS.barrel, 0.55, 0.24));
    this.barrel.position.z = 1.1;
    this.barrel.castShadow = true;
    this.barrelPivot.add(this.barrel);

    this.muzzleDummy = new THREE.Object3D();
    this.muzzleDummy.position.set(0, 0, 6.3 + 1.1);
    this.barrelPivot.add(this.muzzleDummy);

    // 炮口离车心的距离。贴着障碍物时炮管会缩短（见 _clearBarrel），
    // 所以分两个值：barrelMaxDist 是几何上限，barrelDist 是当前实际长度
    this.barrelMaxDist = 6.3 + 1.1;
    this.barrelDist = this.barrelMaxDist;

    // 玩家脚下光环
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

  // ---------- 状态 ----------

  get aliveCheck() {
    return this.alive;
  }

  setMoveIntent(x, z, mag = 1) {
    const len = Math.hypot(x, z);
    if (len < 1e-4) {
      this.moveIntent.set(0, 0, 0);
      return;
    }
    this.moveIntent.set((x / len) * mag, 0, (z / len) * mag);
  }

  aimAtPoint(target, dt) {
    // 弹道解算要用"炮口"当原点：炮口在车头前方约 7.4 米，用车身中心算会白白差几米
    const cp = Math.cos(this.turretPitch);
    const muzzleX = this.pos.x + Math.sin(this.turretYaw) * this.barrelDist * cp;
    const muzzleZ = this.pos.z + Math.cos(this.turretYaw) * this.barrelDist * cp;
    const muzzleY = this.pos.y + 2.97 + Math.sin(this.turretPitch) * this.barrelDist;

    const dx = target.x - muzzleX;
    const dz = target.z - muzzleZ;
    const desiredYaw = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    this.turretYaw = turnTowards(this.turretYaw, desiredYaw, CONFIG.tank.turretSpeed * this.turretMul * dt);

    const distXZ = Math.max(1, Math.hypot(dx, dz));
    const flight = distXZ / CONFIG.bullet.speed;
    const drop = 0.5 * CONFIG.bullet.gravity * flight * flight;
    const desiredPitch = Math.atan2(target.y - muzzleY + drop, distXZ);
    this.turretPitch = clamp(
      turnTowards(this.turretPitch, desiredPitch, CONFIG.tank.turretPitchSpeed * dt),
      CONFIG.tank.turretPitchMin,
      CONFIG.tank.turretPitchMax
    );
    this._applyTurret();
  }

  aimAtDirection(dir, dt) {
    const desiredYaw = Math.atan2(dir.x, dir.z);
    this.turretYaw = turnTowards(this.turretYaw, desiredYaw, CONFIG.tank.turretSpeed * this.turretMul * dt);
    const len = Math.hypot(dir.x, dir.z);
    const desiredPitch = Math.atan2(dir.y, Math.max(0.001, len));
    this.turretPitch = clamp(
      turnTowards(this.turretPitch, desiredPitch, CONFIG.tank.turretPitchSpeed * dt),
      CONFIG.tank.turretPitchMin,
      CONFIG.tank.turretPitchMax
    );
    this._applyTurret();
  }

  _applyTurret() {
    this.turretGroup.rotation.y = wrapAngle(this.turretYaw - this.yaw);
    this.barrelPivot.rotation.x = -this.turretPitch;
  }

  // 炮管别伸进障碍物里。
  // 炮口离车心 7.4 米，而车体的碰撞半径只有 3.4 米 —— 所以贴着树篱/墙的时候，
  // 炮口会整个穿到障碍物那边去。这有两个后果：一是看着穿模；二是**开炮时炮弹
  // 直接生在墙背面**，等于"贴着墙就能隔墙打人"。这里从炮塔往外探，撞到第一个
  // 障碍物就把炮管缩到那个位置，炮口标记也跟着缩，于是开炮点永远在墙的这一侧。
  _clearBarrel() {
    const maxD = this.barrelMaxDist;
    const cp = Math.cos(this.turretPitch);
    const dx = Math.sin(this.turretYaw) * cp;
    const dy = Math.sin(this.turretPitch);
    const dz = Math.cos(this.turretYaw) * cp;
    const baseY = this.pos.y + this.barrelBaseY;
    let d = maxD;
    // 0.8 米一步往外走，撞上就退半步。起点 2.6 —— 车体半径 3.4 以内不可能有障碍物
    for (let s = 2.6; s < maxD; s += 0.8) {
      if (this.world.terrain.hitCollider(this.pos.x + dx * s, baseY + dy * s, this.pos.z + dz * s)) {
        d = s - 0.4;
        break;
      }
    }
    this.barrelDist = Math.max(1.8, d);
  }

  // 按 barrelDist 缩短炮管模型，并把炮口标记挪过去（开炮点 = 炮口标记的位置）
  _applyBarrel() {
    const span = 5.2;     // 炮管几何长度
    const base = 1.1;     // 炮管根部在枢轴上的 z
    const len = Math.max(0.5, Math.min(span, this.barrelDist - base));
    this.barrel.scale.z = len / span;
    this.muzzleDummy.position.z = this.barrelDist;
  }

  getBarrelDir(out) {
    const cp = Math.cos(this.turretPitch);
    return out.set(Math.sin(this.turretYaw) * cp, Math.sin(this.turretPitch), Math.cos(this.turretYaw) * cp).normalize();
  }

  getMuzzlePos(out) {
    this.object.updateMatrixWorld(true);
    return this.muzzleDummy.getWorldPosition(out);
  }

  aimErrorTo(target) {
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const desiredYaw = Math.atan2(dx, dz);
    return Math.abs(wrapAngle(desiredYaw - this.turretYaw));
  }

  // ---------- 开炮 ----------

  // 弹夹没满就一直在压弹
  get loading() {
    return this.rounds < this.magazine;
  }

  fire() {
    if (!this.alive) return false;
    if (this.rounds <= 0) return false;         // 弹夹空了，等下一颗压进来
    if (this.shotTimer > 0) return false;       // 连发间隔还没到

    if (this.repairTimer > 0) this.cancelRepair();   // 一开炮就中断修复
    this.shotTimer = CONFIG.tank.shotInterval;
    this.rounds--;
    const muzzle = this.getMuzzlePos(_v1);
    const dir = this.getBarrelDir(_v2).clone();

    // 散布：玩家和 AI **共用同一套倍率**（CONFIG.spread），不能再一边一个
    const spreadMul = this.precise ? CONFIG.spread.aim : CONFIG.spread.move;
    const spread = CONFIG.bullet.spread * spreadMul;
    dir.x += rand(-spread, spread);
    dir.y += rand(-spread, spread);
    dir.z += rand(-spread, spread);
    dir.normalize();

    this.world.bullets.spawn({
      pos: muzzle.clone(),
      dir,
      speed: CONFIG.bullet.speed,
      damage: CONFIG.bullet.damage,
      owner: this,
      team: this.team,
      kind: 'shell',
    });
    this.world.effects.muzzleFlash(muzzle, dir);
    this.recoil = 1;
    return true;
  }

  // 被坠落的飞机砸中：不扣血，只是短时间跑不动
  slowBy(sec) {
    if (!this.alive) return false;
    this.slowTimer = Math.max(this.slowTimer, sec);
    return true;
  }

  damage(amount, source) {
    if (!this.alive) return false;
    this.damageTaken += amount;
    this.health -= amount;
    this.hitFlash = 1;
    this.lastHitBy = source || null;
    this.lastHitTimer = 3.5;
    // 修复期间挨打：修复**不中断**（血照常扣、接着修），
    // 但 10 秒的计时和修复速率要按"新的血量和新的上限"重新算一遍。
    // 不然会变成"边挨打边白赚进度"：速率还是照着开修那一刻算的，
    // 挨打之后血量掉了、上限也掉了（上限随累计伤害下降），进度却接着往上走。
    if (this.repairing) this._recalcRepair();
    if (this.health <= 0) {
      this.health = 0;
      this._destroy(source);
      return true;
    }
    return false;
  }

  heal(amount) {
    this.health = clamp(this.health + amount, 0, this.maxHealth);
  }

  // ---------- 应急修复 ----------

  // 修复上限：累计伤害的一半是永久损失，怎么修都修不回来
  get repairCeiling() {
    return Math.max(0, this.maxHealth - this.damageTaken * CONFIG.tank.repairRatio);
  }

  get repairing() {
    return this.repairTimer > 0;
  }

  // 两栖坦克：泡在水里（大湖 / 河道）。水里能开、能打，但很难受：
  // 跑得慢（terrain 的 speedFactorAt 管）、不能修车、炮塔转得迟钝
  get inWater() {
    const t = this.world.terrain;
    return !!(t.isWater && t.isWater(this.pos.x, this.pos.z));
  }

  // 炮塔转向速率：水里打折
  get turretMul() {
    return this.inWater ? CONFIG.tank.waterTurretMul : 1;
  }

  get canRepair() {
    // 泡在水里不能修：车底泡着，维修兵下不去手
    return this.alive && !this.repairing && !this.inWater && this.health < this.repairCeiling - 0.5;
  }

  // 这次修复要花多久：按"每秒最多修 repairSpeed 点"算，
  // 但再少也要 repairMinTime 秒 —— 只能修 1 点血就 1 秒出头，
  // 不会像以前那样不管修多修少都罚站 10 秒
  get repairDuration() {
    const amount = Math.max(0, this.repairCeiling - this.health);
    return Math.max(CONFIG.tank.repairMinTime, amount / CONFIG.tank.repairSpeed);
  }

  // 定下这次的耗时和速率（速率 = 要修的量 ÷ 这次的时间，正好在这段时间里修完）
  _beginRepair() {
    const amount = Math.max(0, this.repairCeiling - this.health);
    const dur = this.repairDuration;
    this.repairTimer = dur;
    this.repairRate = amount / dur;
  }

  startRepair() {
    if (!this.canRepair) return false;
    this._beginRepair();
    return true;
  }

  cancelRepair() {
    this.repairTimer = 0;
    this.repairRate = 0;
  }

  // 修复期间挨打之后重新算账：按"当前血量 → 新的上限"重算耗时和速率。
  // 已经修回来的血不退回（修复本来就不中断），只是进度得重新攒。
  // 如果这一下把上限打到低于当前血量（累计伤害的一半是永久损失），就直接结束修复。
  _recalcRepair() {
    const target = this.repairCeiling;
    if (this.health >= target - 0.5) {
      this.cancelRepair();
      return;
    }
    this._beginRepair();
  }

  _updateRepair(dt) {
    if (this.repairTimer <= 0) return false;
    // 一动车或一开炮就中断（修好的那部分保留，之后还能接着修）
    const moving = this.isPlayer
      ? this.controlForward !== 0 || this.controlTurn !== 0
      : this.moveIntent.lengthSq() > 0.01;
    if (moving) {
      this.cancelRepair();
      return false;
    }
    const target = this.repairCeiling;
    this.health = Math.min(target, this.health + this.repairRate * dt);
    this.repairTimer -= dt;
    if (this.repairTimer <= 0 || this.health >= target - 0.01) {
      this.health = Math.min(target, this.health);
      this.cancelRepair();
    }
    return true;
  }

  _destroy(killer) {
    this.alive = false;
    this.world.effects.explosion(_v1.copy(this.pos).setY(this.pos.y + 2.2), 1.5);
    this.object.traverse((o) => {
      if (o.isMesh) {
        o.material = this.wreckMat;
        o.castShadow = false;
      }
    });
    this.turretGroup.rotation.z = rand(-0.3, 0.3);
    this.barrelPivot.rotation.x = 0.35;
    this.pos.y = this.world.terrain.heightAt(this.pos.x, this.pos.z) - 0.4;
    if (this.markerRing) this.markerRing.visible = false;
    this.world.onTankDestroyed(this, killer);
  }

  dispose() {
    this.world.scene.remove(this.object);
    this.object.traverse((o) => {
      if (o.isMesh) o.geometry.dispose?.();
    });
  }

  // ---------- 每帧 ----------

  update(dt) {
    if (!this.alive) {
      if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 2);
      return;
    }

    if (this.shotTimer > 0) this.shotTimer = Math.max(0, this.shotTimer - dt);
    if (this.repairTimer > 0) this._updateRepair(dt);
    // 弹链装填：只要弹夹没满就一直在压弹，压好一颗立刻接着压下一颗
    if (this.rounds < this.magazine) {
      if (this.loadTimer <= 0) this.loadTimer = this.loadTime;
      this.loadTimer -= dt;
      if (this.loadTimer <= 0) {
        this.loadTimer = 0;
        this.rounds++;
      }
    } else {
      this.loadTimer = 0;
    }
    if (this.lastHitTimer > 0) this.lastHitTimer -= dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 4);
    this.barrel.position.z = 1.1 - this.recoil * 0.75;

    const isPlayer = this.isPlayer;
    // AI 的倒车意图由 AI 每帧设一次，这里用完就清掉（不清的话它会一直倒）
    const reverseIntent = !!this.reverseIntent;
    this.reverseIntent = false;
    let dirX = 0;
    let dirZ = 0;
    let speed = 0;

    if (isPlayer) {
      // 坦克开法：A/D 原地转车体（停下来也能原地掉头），W/S 沿车头方向前进/后退
      this.yaw = wrapAngle(this.yaw - this.controlTurn * this.turnSpeed * dt);
      const fwd = this.controlForward;
      if (fwd !== 0) {
        speed = fwd > 0 ? this.speed : this.speed * CONFIG.tank.reverseSpeed;
        if (this.precise) speed *= this.aimSpeedMul;  // 瞄准模式走得很慢（追飞机时例外）
        const sign = fwd > 0 ? 1 : -1;
        dirX = Math.sin(this.yaw) * sign;
        dirZ = Math.cos(this.yaw) * sign;
      }
    } else if (reverseIntent) {
      // AI 倒车：不转头，直接沿车尾方向退。
      // 掉头要一秒多，泡在岩浆里被石头顶住的时候等不起那么久 —— 直着退最快。
      const mag = Math.min(1, this.moveIntent.length());
      speed = this.speed * mag * CONFIG.tank.reverseSpeed;
      dirX = -Math.sin(this.yaw);
      dirZ = -Math.cos(this.yaw);
    } else {
      // AI：朝战术方向转车头，然后往前压
      const mag = Math.min(1, this.moveIntent.length());
      if (mag > 0.05) {
        const targetYaw = Math.atan2(this.moveIntent.x, this.moveIntent.z);
        this.yaw = turnTowards(this.yaw, targetYaw, this.turnSpeed * dt);
        const align = Math.cos(wrapAngle(targetYaw - this.yaw));
        speed = this.speed * mag * clamp(align, 0.2, 1);
        if (this.precise) speed *= this.aimSpeedMul;  // AI 进瞄准模式也会变慢（追飞机时例外）
        dirX = Math.sin(this.yaw);
        dirZ = Math.cos(this.yaw);
      }
    }

    const prevX = this.pos.x;
    const prevZ = this.pos.z;

    if (speed > 0.01) {
      // 地形影响：上坡慢、下坡快，涉水更慢
      const factor = this.world.terrain.speedFactorAt(this.pos.x, this.pos.z, dirX, dirZ);
      // 被坠机砸中会短时间跑不动 —— 乘在最后，跟涉水的减速叠加
      const slow = this.slowTimer > 0 ? CONFIG.plane.wreckSlowMul : 1;
      this.pos.x += dirX * speed * factor * slow * dt;
      this.pos.z += dirZ * speed * factor * slow * dt;
    }
    if (this.slowTimer > 0) this.slowTimer -= dt;
    this.blockPush.x = 0;
    this.blockPush.z = 0;
    this.blockPush.hit = false;
    this.world.terrain.resolveCircle(this.pos, this.radius, this.blockPush, this.ignoreWater);
    this._separateFromOtherTanks();
    // 互相推开之后可能又被挤进墙里（迷宫这种窄通道很容易），再解一次障碍
    this.world.terrain.resolveCircle(this.pos, this.radius, this.blockPush, this.ignoreWater);
    // 记下这一帧总共被障碍推了多少（AI 用它来判断"我正贴着哪面墙"）
    if (this.blockPush.hit) {
      const pl = Math.hypot(this.blockPush.x, this.blockPush.z) || 1;
      this.blockNormal.x = this.blockPush.x / pl;
      this.blockNormal.z = this.blockPush.z / pl;
      this.blocked = true;
    } else {
      this.blocked = false;
    }

    this.velocity.set((this.pos.x - prevX) / Math.max(dt, 1e-4), 0, (this.pos.z - prevZ) / Math.max(dt, 1e-4));

    // 雪地履带印：每开出一段距离就压一道（只有开了 tracks 的地形上才有）
    // 走位会留在雪地上，别人能从痕迹判断你刚才往哪去了
    const tracks = this.world.treads;
    if (tracks && tracks.enabled) {
      this.treadAcc = (this.treadAcc || 0) + Math.hypot(this.pos.x - prevX, this.pos.z - prevZ);
      if (this.treadAcc >= CONFIG.tracks.gap) {
        this.treadAcc = 0;
        tracks.add(this.pos, this.yaw);
      }
    }

    // 贴地与随坡倾斜。两栖坦克在水里是"浮"着的：不沉到湖底，浮在水面下一点点
    const groundY = this.world.terrain.heightAt(this.pos.x, this.pos.z);
    const t2 = this.world.terrain;
    const level = t2.waterLevelAt ? t2.waterLevelAt(this.pos.x, this.pos.z) : null;
    const floating = level !== null && level > groundY;
    this.pos.y = floating ? level - this.draft : groundY;

    // 岩浆里会持续被烧（别的地形上这个值恒为 0）
    const burn = this.world.terrain.hazardAt(this.pos.x, this.pos.z);
    if (burn > 0) {
      this.damage(burn * dt, LAVA);
      if (Math.random() < dt * 4) this.world.effects.wreckSmoke(this.pos);  // 冒烟：看得出来它在被烧
    }
    const n = floating ? UP : this.world.terrain.normalAt(this.pos.x, this.pos.z, _v1);
    _q1.setFromUnitVectors(UP, n);
    _q2.setFromAxisAngle(UP, this.yaw);
    this.object.quaternion.copy(_q1).multiply(_q2);

    this._applyTurret();
    this._clearBarrel();
    this._applyBarrel();

    // 被击中时闪红
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3);
      for (const m of this.bodyMaterials) {
        m.emissive.setRGB(this.hitFlash * 0.6, this.hitFlash * 0.05, this.hitFlash * 0.02);
      }
    }
  }

  _separateFromOtherTanks() {
    const tanks = this.world.tanks;
    for (let i = 0; i < tanks.length; i++) {
      const other = tanks[i];
      if (other === this || !other.alive) continue;
      const dx = this.pos.x - other.pos.x;
      const dz = this.pos.z - other.pos.z;
      const dist = Math.hypot(dx, dz);
      const minDist = this.radius + other.radius;
      if (dist < minDist && dist > 1e-4) {
        const push = (minDist - dist) * 0.5;
        const nx = dx / dist;
        const nz = dz / dist;
        this.pos.x += nx * push;
        this.pos.z += nz * push;
        other.pos.x -= nx * push;
        other.pos.z -= nz * push;
      }
    }
  }
}
