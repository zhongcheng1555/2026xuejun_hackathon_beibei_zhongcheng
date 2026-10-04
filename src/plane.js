// 空中飞机：巡航 → 俯冲扫射 → 拉起。命中率极低，但它也会被打下来

import * as THREE from 'three';
import { CONFIG, COLORS, TEAM } from './config.js';
import { clamp, damp, gauss, rand, randInt, turnTowards, wrapAngle } from './utils.js';

const FORWARD = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _nose = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _fireDir = new THREE.Vector3();
const _euler = new THREE.Euler();
const _box = new THREE.Box3();
// 撞地/挨弹的部位判定用（见 _hitZone / loseWing）
const _local = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _tip = new THREE.Vector3();
const _side = new THREE.Vector3();
const _right = new THREE.Vector3(1, 0, 0);

let planeId = 1;

export class Plane {
  constructor(world, team = TEAM.ALLY) {
    this.world = world;
    this.team = team;
    this.isPlane = true;
    this.id = planeId++;
    this.name = `${team === TEAM.ALLY ? '我方' : '敌方'}空军${this.id}`;
    this.object = new THREE.Group();
    this.pos = this.object.position;
    this.radius = CONFIG.plane.radius;
    this.health = CONFIG.plane.health;
    this.maxHealth = CONFIG.plane.health;
    // 掉机翼 / 平稳落地的状态（机翼本体在 _buildModel 里建）
    this.wingLoss = 0;      // 掉了几片机翼（0~2）
    this.lossSide = 0;      // 断翼在哪边（-1 左 / +1 右）—— 机身往这边滚
    this.lossTimer = 0;     // 掉翼之后过了多久（滚转越来越厉害）
    this.sink = 0;          // 掉翼之后往下沉的速度
    this.burnTimer = 0;     // 趴在地上烧的剩余时间
    this.alive = true;
    this.falling = false;   // 被击落后进入坠落状态（冒着烟往下掉，落地再炸一次）
    this.vel = new THREE.Vector3();
    this.roll = 0;
    this.turnRate = 0;
    this.state = 'cruise';
    this.stateTimer = 0;
    this.target = null;
    this.fireTimer = 0;
    this.burst = 0;
    this.waypoint = new THREE.Vector3();
    // 让开自己人的弹道：evadeTimer > 0 时正在横着躲，evadeCd 是冷却
    this.evadeTimer = 0;
    this.evadeCd = 0;
    this.evadeDir = new THREE.Vector3();
    // 纯空战专用：lives 是还剩几次复活机会（常规局一直是 0），
    // 被打下来后 respawnTimer 开始倒计时，归零就重新升空；retired 表示这次没上场
    this.lives = 0;
    this.respawnTimer = -1;
    this.retired = false;

    // ---------- 玩家操控（isPlayer 时走这一套，不再跑 AI 状态机）----------
    this.isPlayer = false;
    this.aimDir = new THREE.Vector3(0, 0, 1);  // 机头要指向的方向（屏幕上准星那一条）
    this.controlThrottle = 0;                  // W/S 推杆
    this.controlFire = false;                  // 扳机
    this.throttle = 1;                         // 当前油门（相对巡航速度）
    this.fireCooldown = 0;
    this.audioCd = 0;      // 掠过镜头的"呼"声冷却（由 Game 驱动）

    this._buildModel();
    // 记下原始涂装：被击落时换成黑壳，复活时要换回来
    this.wreckMat = new THREE.MeshStandardMaterial({
      color: COLORS.wreck,
      metalness: 0.4,
      roughness: 0.95,
    });
    this.skin = [];
    this.object.traverse((o) => {
      if (o.isMesh) this.skin.push({ mesh: o, mat: o.material });
    });
    this._reset();
    world.scene.add(this.object);
  }

  _buildModel() {
    // 机身涂装分敌我：蓝=我方空军，红=敌方空军
    const bodyColor = this.team === TEAM.ALLY ? COLORS.planeAlly : COLORS.planeEnemy;
    // 机身：铝合金蒙皮（粗糙度低一些，才有金属反光的那道亮边）
    const mat = new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.5, roughness: 0.32 });
    const darkMat = new THREE.MeshStandardMaterial({ color: COLORS.planeDark, metalness: 0.55, roughness: 0.4 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ee, metalness: 0.05, roughness: 0.04 });

    const fuselageGeo = new THREE.CylinderGeometry(0.85, 0.6, 9, 10);
    fuselageGeo.rotateX(Math.PI / 2);
    const fuselage = new THREE.Mesh(fuselageGeo, mat);
    fuselage.castShadow = true;
    this.object.add(fuselage);

    const noseGeo = new THREE.ConeGeometry(0.85, 2.6, 10);
    noseGeo.rotateX(Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, mat);
    nose.position.z = 5.6;
    this.object.add(nose);

    // 左右机翼分成两块，才能单独打掉。撞地、撞障碍、挨弹、两机对撞，
    // 判定落在哪一侧就掉哪一片（见 loseWing / _hitZone）
    this.wings = {};
    const wingGeo = new THREE.BoxGeometry(7.2, 0.34, 2.9);
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo, mat);
      w.position.set(side * 3.9, -0.1, 0.4);
      w.castShadow = true;
      this.object.add(w);
      this.wings[side < 0 ? 'left' : 'right'] = w;
    }

    const tailWing = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.26, 1.5), mat);
    tailWing.position.set(0, 0.05, -3.9);
    this.object.add(tailWing);

    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 2.1, 1.7), mat);
    fin.position.set(0, 1.1, -3.9);
    this.object.add(fin);

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.75, 10, 8), glassMat);
    cockpit.scale.set(0.9, 0.75, 1.5);
    cockpit.position.set(0, 0.7, 1.8);
    this.object.add(cockpit);

    // 螺旋桨
    this.prop = new THREE.Group();
    this.prop.position.z = 6.9;
    const bladeGeo = new THREE.BoxGeometry(0.22, 3.4, 0.12);
    const bladeA = new THREE.Mesh(bladeGeo, darkMat);
    const bladeB = new THREE.Mesh(bladeGeo, darkMat);
    bladeB.rotation.z = Math.PI / 2;
    this.prop.add(bladeA, bladeB);
    this.object.add(this.prop);

    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.6, 8), darkMat);
    engine.rotation.x = Math.PI / 2;
    engine.position.z = 4.2;
    engine.position.y = -0.5;
    this.object.add(engine);
  }

  _reset() {
    const t = CONFIG.plane.altitude;
    const half = this.world.terrain.playable;
    this.pos.set(rand(-half, half), rand(t[0], t[1]), rand(-half, half));
    this.health = this.maxHealth;
    this.alive = true;
    this.falling = false;
    this.landed = false;
    this.deadTimer = 0;
    this.object.visible = true;
    this.object.rotation.set(0, 0, 0);
    // 机翼复位：复活的飞机不许还缺着翅膀
    for (const key in this.wings) this.wings[key].visible = true;
    this.wingLoss = 0;
    this.lossSide = 0;
    this.lossTimer = 0;
    this.sink = 0;
    this.fallTarget = null;
    this.burnTimer = 0;
    for (const s of this.skin) s.mesh.material = s.mat;   // 复活的飞机要恢复涂装，不能还是黑壳
    this.state = 'cruise';
    this.stateTimer = 0;
    this.target = null;
    this.evadeTimer = 0;
    this.evadeCd = 0;
    this.throttle = 1;
    this.controlThrottle = 0;
    this.controlFire = false;
    this.fireCooldown = 0;
    this.burst = CONFIG.playerPlane.burst;
    this._pickWaypoint();
    this.vel.copy(_dir.copy(this.waypoint).sub(this.pos).normalize()).multiplyScalar(CONFIG.plane.speed);
    this._orient(0);
  }

  _pickWaypoint() {
    // 巡逻点必须落在"边界保护线"以内。以前用的是 playable*0.9，
    // 而 _nearEdge 的线是 playable*edgeWarn(0.8) —— 巡逻点能挑到线外面去，
    // 飞机朝着一个越界的目标飞几秒，然后被边界保护硬掰回来，看着就是"突然掉头"。
    // 巡逻点必须落在"边界保护线"以内，而且还要留出**转弯半径**的余量：
    // 40m/s、0.55rad/s 转一圈的半径约 70m（≈0.2 个 playable），
    // 目标点贴着保护线的话，飞机会在冲过去的过程中越过保护线、被硬掰一下。
    // 所以留 0.25 的余量
    const half = this.world.terrain.playable * Math.max(0.2, CONFIG.plane.edgeWarn - 0.25);
    this.waypoint.set(rand(-half, half), rand(CONFIG.plane.altitude[0], CONFIG.plane.altitude[1]), rand(-half, half));
  }

  // 俯冲最低拉到多高：离地 pullUpAlt，而且必须整个飞在隧道岩顶之上。
  // 关键是**改平会继续下沉**：俯冲速度是 54m/s、俯仰转向 0.6rad/s，从俯角改平
  // 那零点几秒里还会再往下掉十几米（实测 10m 上下）。所以只比岩顶高一点点没用，
  // 得留出 pullUpClear 的余量 —— 否则飞机在拉起的瞬间就把机翼剐在岩顶上。
  // 没有隧道的图 roofTopAbs=0，就等于原来的"离地 18m"
  get diveFloor() {
    const t = this.world.terrain;
    const gy = t.heightAt ? t.heightAt(this.pos.x, this.pos.z) : this.pos.y;
    return Math.max(gy + CONFIG.plane.pullUpAlt, (t.roofTopAbs || 0) + CONFIG.plane.pullUpClear);
  }

  // 坦克用 velocity、飞机用 vel。这里给飞机补个别名，
  // 免得共用代码（AI 瞄准提前量、俯冲提前量）拿到飞机时读到 undefined 崩掉
  get velocity() {
    return this.vel;
  }

  // 交给玩家开 / 交还给 AI
  setPlayer(on) {
    this.isPlayer = !!on;
    if (on) {
      this.throttle = 1;
      this.controlThrottle = 0;
      this.controlFire = false;
      this.fireCooldown = 0;
      this.burst = CONFIG.playerPlane.burst;
      this.fireTimer = 0;
    }
  }

  _orient(dt) {
    if (this.vel.lengthSq() < 1e-6) return;
    _dir.copy(this.vel).normalize();
    this.object.quaternion.setFromUnitVectors(FORWARD, _dir);
    let target = clamp(-this.turnRate * 2.4, -1.1, 1.1);
    // 掉了机翼：机身自己往断翼那侧越滚越厉害，滚到最后根本拉不回来
    if (this.wingLoss > 0) {
      target += this.lossSide * CONFIG.plane.wingBankRate * this.lossTimer * this.wingLoss;
    }
    this.roll = damp(this.roll, target, 3, dt);
    this.object.rotateZ(this.roll);
  }

  // 别跟友机挤在一起：撞上就是同归于尽，而且挤成一团也看不清谁是谁
  _separate(desired) {
    const range = CONFIG.plane.sepRange;
    for (const o of this.world.planes.list) {
      if (o === this || !o.alive || o.team !== this.team) continue;
      const dx = this.pos.x - o.pos.x;
      const dy = this.pos.y - o.pos.y;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > range * range || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const k = (1 - d / range) * 2.4;   // 越近推得越狠
      desired.x += (dx / d) * k;
      desired.z += (dz / d) * k;
      desired.y += (dy / d) * k * 0.5;
    }
  }

  // 自己人（含玩家）打出的炮弹，会不会打到我？
  // 只看**同阵营**的弹：让友机别挡自家人的枪口，但敌方不会躲你的弹（不然你就打不着人了）
  _threatInbound() {
    const world = this.world;
    if (!world.bullets) return null;
    const cfg = CONFIG.plane;
    const range2 = cfg.dodgeRange * cfg.dodgeRange;
    for (const b of world.bullets.bullets) {
      if (!b.active || b.team !== this.team || b.owner === this) continue;
      const rx = this.pos.x - b.pos.x;
      const ry = this.pos.y - b.pos.y;
      const rz = this.pos.z - b.pos.z;
      const d2 = rx * rx + ry * ry + rz * rz;
      if (d2 > range2) continue;
      const v2 = b.vel.lengthSq();
      if (v2 < 1e-6) continue;
      // 最近时刻 t 时，弹离我多近
      const t = (rx * b.vel.x + ry * b.vel.y + rz * b.vel.z) / v2;
      if (t < 0 || t > cfg.dodgeTime) continue;
      const cx = rx - b.vel.x * t;
      const cy = ry - b.vel.y * t;
      const cz = rz - b.vel.z * t;
      if (cx * cx + cy * cy + cz * cz > cfg.dodgeMiss * cfg.dodgeMiss) continue;
      return { bx: b.vel.x, bz: b.vel.z, px: b.pos.x, pz: b.pos.z };
    }
    return null;
  }

  // 让开自家人的弹道：垂直于来弹方向横着拉开（往自己本来就在的那一侧躲）
  // 返回 true 表示这一帧的操控权被"让开"接管了
  _evadeFriendly(dt) {
    this.evadeCd -= dt;
    if (this.evadeTimer > 0) {
      this.evadeTimer -= dt;
      // 用副本走 _steer：_steer 里的 _separate 会往传入向量上叠推开量，
      // 直接传 evadeDir 的话它会一帧一帧越积越大，几帧后就拐到不知哪去了
      _desired.copy(this.evadeDir);
      this._steer(_desired, CONFIG.plane.dodgeRate, dt);
      return true;
    }
    if (this.evadeCd > 0) return false;
    const t = this._threatInbound();
    if (!t) return false;
    const vl = Math.hypot(t.bx, t.bz);
    if (vl < 1e-4) return false;
    const ux = t.bx / vl;
    const uz = t.bz / vl;
    const perpX = -uz;
    const perpZ = ux;
    // 我在弹道的哪一侧，就往那一侧躲（继续往外拉，而不是穿过去）
    const side = (this.pos.x - t.px) * perpX + (this.pos.z - t.pz) * perpZ >= 0 ? 1 : -1;
    this.evadeDir.set(perpX * side, 0.18, perpZ * side).normalize();
    this.evadeTimer = CONFIG.plane.dodgeHold;
    this.evadeCd = CONFIG.plane.dodgeCd;
    return true;
  }

  _steer(desiredDir, rate, dt, speedOverride) {
    // 先叠上"别跟友机挤在一起"的让位向量，再走正常的转向。
    // 玩家不叠：杆在玩家手里，不能被友机的推力拽偏（让位交给友机那边做）
    if (!this.isPlayer) this._separate(desiredDir);
    _desired.copy(desiredDir).normalize();
    const speed = speedOverride !== undefined
      ? speedOverride
      : CONFIG.plane.speed * (this.state === 'dive' ? 1.35 : 1);
    _dir.copy(this.vel).normalize();
    const beforeYaw = Math.atan2(_dir.x, _dir.z);
    const afterYaw = Math.atan2(_desired.x, _desired.z);
    // 掉了机翼 = 拉杆拉不动：转向能力大打折扣
    const auth = this.wingLoss > 0 ? CONFIG.plane.wingDropCtrl : 1;
    const newYaw = turnTowards(beforeYaw, afterYaw, rate * auth * dt);
    const beforePitch = Math.asin(clamp(_dir.y, -1, 1));
    const afterPitch = Math.asin(clamp(_desired.y, -1, 1));
    const newPitch = turnTowards(beforePitch, afterPitch, rate * auth * dt);
    this.turnRate = wrapAngle(newYaw - beforeYaw) / Math.max(dt, 1e-3);
    this.vel.set(
      Math.sin(newYaw) * Math.cos(newPitch),
      Math.sin(newPitch),
      Math.cos(newYaw) * Math.cos(newPitch)
    ).multiplyScalar(speed);
  }

  // ---------- 玩家操控 ----------

  // 机头朝视线方向掰，速度由油门定，扳机开炮（一次最多 5 发，打完冷却）
  _playerSteer(dt) {
    const cfg = CONFIG.playerPlane;
    this.throttle = clamp(
      this.throttle + this.controlThrottle * cfg.throttleRate * dt,
      cfg.throttleMin,
      cfg.throttleMax
    );
    this._steer(this.aimDir, cfg.turnRate, dt, CONFIG.plane.speed * this.throttle);

    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    this.fireTimer -= dt;
    if (this.controlFire && this.fireCooldown <= 0 && this.fireTimer <= 0 && this.burst > 0) {
      // 枪口放在"准星方向"上，炮弹朝准星飞
      // （机头会慢慢转到准星上，但炮弹是即时响应的；朝后打时枪口就在机身后面，
      //   所以往哪打都不会打到自己）
      _dir.copy(this.aimDir).normalize();
      _nose.copy(this.pos).addScaledVector(_dir, 8);
      this._fire(_nose, _dir, cfg.gunSigma, cfg.gunDamage);
      this.fireTimer = cfg.gunInterval;
      this.burst--;
      if (this.burst <= 0) {
        this.burst = cfg.burst;
        this.fireCooldown = cfg.burstPause;
      }
    }
  }

  // AI 别自己撞墙：逼近场地边缘就主动掉头回场地中心
  // （玩家没有这层保护 —— 飞太远撞上边界就真的会坠机）
  _nearEdge() {
    const warn = this.world.terrain.playable * CONFIG.plane.edgeWarn;
    return Math.abs(this.pos.x) >= warn || Math.abs(this.pos.z) >= warn;
  }

  _edgeGuard(dt) {
    _desired.set(-this.pos.x, 0, -this.pos.z);
    _desired.y = (CONFIG.plane.airHoldAlt - this.pos.y) * 0.6;
    this._steer(_desired, 1.1, dt);
  }

  _pickTarget() {
    // 只打对面的地面部队：蓝机帮你打红车，红机专打蓝车
    const foe = this.team === TEAM.ALLY ? TEAM.ENEMY : TEAM.ALLY;
    const tanks = this.world.tanks.filter((t) => t.alive && t.team === foe);
    if (!tanks.length) return null;
    const player = this.world.player;
    // 敌机偏爱盯着玩家的**坦克**，友机不针对玩家。
    // 玩家开飞机时不算在这里 —— 俯冲是打地面用的动作，追飞机交给"空中缠斗"那种状态
    // （而且要是不拦一下，俯冲会拿到一架飞机当目标，读它的 velocity 就崩了）
    if (
      this.team === TEAM.ENEMY &&
      player &&
      player.alive &&
      !player.isPlane &&
      player.team === foe &&
      Math.random() < 0.35
    ) {
      return player;
    }
    const far = tanks.filter((t) => Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z) > CONFIG.plane.minTargetDist);
    const pool = far.length ? far : tanks;
    return pool[randInt(0, pool.length - 1)];
  }

  // 找个对面飞机缠斗：要离得近、还得高度差不多（在同一个高度层才叫空战）
  _findAirTarget() {
    if (!this.world.planes) return null;
    // 纯空战里天上就那两架，甩不掉也躲不开：不限距离、不限高度差
    const pureAir = !!this.world.pureAir;
    const foe = this.team === TEAM.ALLY ? TEAM.ENEMY : TEAM.ALLY;
    let best = null;
    let bd = pureAir ? Infinity : CONFIG.plane.airRange;
    for (const p of this.world.planes.list) {
      if (!p.alive || p === this || p.team !== foe) continue;
      const d = this.pos.distanceTo(p.pos);
      if (d > bd) continue;
      if (!pureAir && Math.abs(p.pos.y - this.pos.y) > CONFIG.plane.airAltBand) continue;
      bd = d;
      best = p;
    }
    return best;
  }

  // 直接进入空中缠斗（纯空战开局用：就两架飞机，别让它们各自巡航半天才碰面）
  engageAir(target) {
    if (!target || !target.alive) return;
    this.target = target;
    this.state = 'dogfight';
    this.stateTimer = rand(CONFIG.plane.airDuration[0], CONFIG.plane.airDuration[1]);
    this.fireTimer = 0.3;
    this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
  }

  update(dt) {
    if (this.falling) {
      this._updateFall(dt);
      return;
    }
    if (!this.alive) return;
    // 平稳落地之后：趴在地上慢慢烧，还能开炮（见 _burn）
    if (this.landed) {
      this._burn(dt);
      return;
    }

    this.prop.rotation.z += dt * 34;
    this.stateTimer -= dt;

    if (this.isPlayer) {
      // 玩家自己握着操纵杆，不跑 AI 状态机
      this._playerSteer(dt);
    } else if (this._nearEdge()) {
      // 快出界了：别的都先放一放，专心拐回场地里，别自己撞墙
      this._edgeGuard(dt);
    } else if (this._evadeFriendly(dt)) {
      // 自己人的炮弹正朝我飞过来（比如玩家在追打红机，弹道擦着蓝机）：
      // 横向让开，别替敌人挡了自家人的枪口
    } else if (this.state === 'cruise') {
      const distToWp = Math.hypot(this.waypoint.x - this.pos.x, this.waypoint.z - this.pos.z);
      if (distToWp < 40 || this.stateTimer <= 0) {
        this._pickWaypoint();
        this.stateTimer = rand(4, 9);
      }
      _desired.copy(this.waypoint).sub(this.pos);
      _desired.y = (this.waypoint.y - this.pos.y) * 0.6;
      this._steer(_desired, 0.55, dt);

      // 巡航时也可能遇上对面的飞机 → 高空平飞缠斗（俯冲中绝不参与）
      // 纯空战里天上就两架，几乎一直咬在一起，所以这里按"每帧都找"来
      const dogChance = this.world.pureAir ? 1 : CONFIG.plane.dogfightChance;
      if (this.pos.y > CONFIG.plane.airMinAlt && Math.random() < dogChance * dt) {
        const foePlane = this._findAirTarget();
        if (foePlane) {
          this.engageAir(foePlane);
        }
      }

      // 挑一个地面目标俯冲。平时是"每秒 5% 的概率"，掷不到就继续巡航。
      //
      // 但纯空战里天上已经没有对手时不能还靠掷骰子：场上往往还有敌方的地面部队
      // （纯空战里你开的那辆坦克、或者随机出的那几辆），此时 AI 飞机会一直绕圈巡航，
      // 只有 5%/秒 的概率才想起来去俯冲一次 —— 玩家看到的就是
      // "两架飞机一直在盘旋，没有一个主动开始"。所以天空一空就直接压下去打
      const noAirFoe = this.world.pureAir && !this._findAirTarget();
      if (Math.random() < (noAirFoe ? 1 : CONFIG.plane.diveChance) * dt) {
        const target = this._pickTarget();
        if (target) {
          this.target = target;
          this.state = 'dive';
          this.stateTimer = CONFIG.plane.diveDuration;
          this.fireTimer = 0.25;
          this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
        }
      }
    } else if (this.state === 'dogfight') {
      // 空中对射：两架都在动、横向高速对穿，是全场最难打的仗
      const foePlane = this.target;
      if (!foePlane || !foePlane.alive || this.pos.distanceTo(foePlane.pos) > CONFIG.plane.airRange * 1.35) {
        this.target = null;
        this.state = 'cruise';
        this.stateTimer = rand(3, 7);
      } else {
        _toTarget.copy(foePlane.pos);
        const dist = this.pos.distanceTo(_toTarget);
        _toTarget.addScaledVector(foePlane.vel, dist / 200);   // 提前量（机炮 200 m/s）
        _desired.copy(_toTarget).sub(this.pos);
        _desired.y = (CONFIG.plane.airHoldAlt - this.pos.y) * 0.8;  // 只在高空平飞，不往下扎
        this._steer(_desired, 0.5, dt);

        _nose.copy(this.pos).addScaledVector(_dir.copy(this.vel).normalize(), 8);
        _fireDir.copy(_toTarget).sub(_nose).normalize();
        const facing = _fireDir.dot(_dir);
        this.fireTimer -= dt;
        if (facing > 0.9 && this.fireTimer <= 0 && this.burst > 0) {
          this._fire(_nose, _fireDir, CONFIG.plane.airHitSigma);
          this.fireTimer = CONFIG.plane.gunInterval;
          this.burst--;
          if (this.burst <= 0) {
            this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
            this.fireTimer = rand(0.5, 1.1);
          }
        }
        if (this.stateTimer <= 0) {
          this.target = null;
          this.state = 'cruise';
          this.stateTimer = rand(4, 8);
        }
      }
    } else if (this.state === 'dive') {
      if (!this.target || !this.target.alive) this.target = this._pickTarget();
      if (this.target) {
        _toTarget.copy(this.target.pos);
        _toTarget.y += 1.8;
        // 提前量
        const dist = this.pos.distanceTo(_toTarget);
        _toTarget.addScaledVector(this.target.velocity, dist / 190);
        _desired.copy(_toTarget).sub(this.pos);
        this._steer(_desired, 0.85, dt);

        // 对准了才开火，而且弹道误差很大
        _nose.copy(this.pos).addScaledVector(_dir.copy(this.vel).normalize(), 8);
        _fireDir.copy(_toTarget).sub(_nose).normalize();
        const facing = _fireDir.dot(_dir);
        this.fireTimer -= dt;
        if (facing > 0.86 && this.fireTimer <= 0 && this.burst > 0) {
          this._fire(_nose, _fireDir);
          this.fireTimer = CONFIG.plane.gunInterval;
          this.burst--;
          if (this.burst <= 0) {
            this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
            this.fireTimer = rand(0.35, 0.8);
          }
        }
      }
      // 拉起的线见 diveFloor（离地高度 与 全图最高障碍物 取大）
      if (this.stateTimer <= 0 || this.pos.y < this.diveFloor) {
        this.state = 'pullup';
        this.stateTimer = CONFIG.plane.pullUpDuration;
      }
    } else {
      const alt = rand(CONFIG.plane.altitude[0], CONFIG.plane.altitude[1]);
      _desired.copy(this.waypoint).sub(this.pos);
      _desired.y = (alt - this.pos.y) * 1.2;
      this._steer(_desired, 0.6, dt);
      if (this.stateTimer <= 0 && this.pos.y > CONFIG.plane.altitude[0]) {
        this.state = 'cruise';
        this.stateTimer = rand(4, 8);
      }
    }

    this.pos.addScaledVector(this.vel, dt);

    // 掉了一片机翼：一边滚一边往下沉，而且越沉越快 —— 逐渐失去飞行控制
    if (this.wingLoss > 0) {
      this.lossTimer += dt;
      this.sink += CONFIG.plane.wingSinkRate * this.wingLoss * dt;
      this.pos.y -= this.sink * dt;
    }

    // 撞上场地边界就报废（撞墙撞的是机身，直接完）
    const limit = this.world.terrain.playable * 1.15;
    if (Math.abs(this.pos.x) > limit || Math.abs(this.pos.z) > limit) {
      this.pos.x = clamp(this.pos.x, -limit, limit);
      this.pos.z = clamp(this.pos.z, -limit, limit);
      this._destroy(null, 'edge');
      return;
    }

    // 撞地：机翼蹭到只掉翅膀，机身直接撞上才完；平稳落地的不炸，改成趴地上烧
    this._groundContact();

    this._orient(dt);
  }

  // 飞机和地面的接触判定。老版本这里是"离地 18 米硬托底"（下限），
  // 现在下限去掉了：贴到地上就真的会发生撞击，分机翼和机身两种结果
  _groundContact() {
    const t = this.world.terrain;
    for (const side of ['left', 'right']) {
      if (!this.wings[side].visible) continue;
      _tip.set(side === 'left' ? -6.5 : 6.5, -0.1, 0.4)
        .applyQuaternion(this.object.quaternion)
        .add(this.pos);
      const g = t.heightAt(_tip.x, _tip.z);
      const blocked = t.hitCollider ? t.hitCollider(_tip.x, _tip.y, _tip.z) : null;
      const roof = t.roofAt ? t.roofAt(_tip.x, _tip.y, _tip.z) : false;
      if (blocked || roof) this.loseWing(side, 'obstacle');
      else if (_tip.y < g + 0.2) this.loseWing(side, 'ground');
    }
    const gy = t.heightAt(this.pos.x, this.pos.z);
    // 一头扎进隧道岩顶：和撞地一个下场（飞机想钻隧道就得自己担着）
    const inRoof = t.roofAt ? t.roofAt(this.pos.x, this.pos.y, this.pos.z) : false;
    if (!inRoof && this.pos.y >= gy + CONFIG.plane.bodyClear) return;
    if (!inRoof && -this.vel.y < CONFIG.plane.softLandVy) {
      this._land();                       // 稳稳落下来：不炸，慢慢烧
    } else {
      this.pos.y = gy + CONFIG.plane.bodyClear;
      this._destroy(null, 'crash');       // 直接扎到地上 / 撞岩顶：当场完
    }
  }

  _fire(nose, aimDir, sigma, damage) {
    _fireDir.copy(aimDir);
    const e = sigma || CONFIG.plane.hitSigma;
    _fireDir.x += gauss() * e;
    _fireDir.y += gauss() * e;
    _fireDir.z += gauss() * e;
    _fireDir.normalize();

    this.world.bullets.spawn({
      pos: nose.clone(),
      dir: _fireDir.clone(),
      speed: 200,
      damage: damage || CONFIG.plane.gunDamage,
      owner: this,
      team: this.team,
      kind: 'air',
    });
    this.world.effects.muzzleFlash(nose, _fireDir);
  }

  // 挨弹：打在机身上（含机头、座舱）＝当场完；打在机翼上＝那片机翼掉，
  // 飞机还活着，只是开始失去平衡（这就是"打到机翼不会直接忽略"）
  damage(amount, source, hitPoint) {
    if (!this.alive) return false;
    // 趴在地上烧的那架（平稳落地、还没烧完）是个活靶子：不再免伤 ——
    // 之前这里带着 `|| this.landed`，子弹打上去一点反应都没有，等于无敌。
    // 它已经贴地了，也不再按机翼分部位判：打中就打爆
    if (this.landed) {
      this.health -= amount;
      if (this.health <= 0) {
        this._destroy(source);
        return true;
      }
      return false;
    }
    const zone = hitPoint ? this._hitZone(hitPoint) : null;
    if (zone) {
      this.loseWing(zone, 'shot');
      return false;
    }
    this.health -= amount;
    if (this.health <= 0) {
      this._destroy(source);
      return true;
    }
    return false;
  }

  // 撞点/弹着点落在哪一片机翼上（没落在机翼上就返回 null = 打在/撞在机身上）
  _hitZone(point) {
    _local.copy(point).sub(this.pos).applyQuaternion(_qInv.copy(this.object.quaternion).invert());
    if (Math.abs(_local.x) < CONFIG.plane.wingZone) return null;
    const side = _local.x < 0 ? 'left' : 'right';
    return this.wings[side].visible ? side : null;
  }

  // 掉一片机翼：飞机会往那一侧滚、往下沉，操控权也变小 —— 逐渐失去飞行控制，
  // 但还没掉下来之前照样能开炮（见 _burn / AI 的状态机）
  loseWing(side, cause = 'hit') {
    const w = this.wings[side];
    if (!w || !w.visible) return false;
    w.visible = false;
    this.wingLoss++;
    this.lossSide = side === 'left' ? -1 : 1;
    // 断翼的那一片飞出去：原地炸一小团当碎片
    _tip.copy(this.pos).addScaledVector(_side.copy(_right).applyQuaternion(this.object.quaternion), this.lossSide * 6);
    this.world.effects.explosion(_tip.clone(), 0.55);
    if (this.world.onPlaneWingLost) this.world.onPlaneWingLost(this, side, cause);
    return true;
  }

  // 平稳落地：不炸，趴在地上慢慢烧 —— 烧的过程中还能开炮
  _land() {
    if (this.landed) return;
    this.landed = true;
    this.state = 'ground';
    this.burnTimer = CONFIG.plane.burnTime;
    this.landX = this.pos.x;
    this.landZ = this.pos.z;
    this.vel.set(0, 0, 0);
    this.smokeTimer = 0;
    this.target = null;
    this.stateTimer = 0;
    this._wreckBlast();                      // 压在下面的侦察兵一起砸死
    if (this.world.onPlaneLanded) this.world.onPlaneLanded(this);
  }

  // 坠机砸在地上：底下压着的侦察兵全砸死（不管敌我的，砸下来又不长眼）。
  // blast 自己有"高空炸的不算"的判据，所以空中被打爆不会误伤地面的侦察兵
  _wreckBlast() {
    const sc = this.world.scouts;
    if (sc && sc.blast) sc.blast(this.pos, CONFIG.plane.wreckHitRadius + 2, this);
  }

  // 趴在地上烧：一直冒烟，烧够 burnTime 就烧完。
  // 这段时间里照样能开炮 —— 玩家用鼠标掰机头、扣扳机（等于一个地面炮台），
  // AI 自己找目标扫（见 _groundCombat）
  _burn(dt) {
    this.prop.rotation.z += dt * 4;     // 螺旋桨还在慢慢转
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.2;
      this.world.effects.wreckSmoke(this.pos);
    }
    this.burnTimer -= dt;
    if (this.burnTimer <= 0) {
      this._destroy(null, 'burn');
      return;
    }
    // 注意：趴在地上烧的这架**不再对旁边的坦克造成持续伤害**。
    // 它没有目标、也不分敌我，纯粹靠"站在旁边"就一直在烧队友/敌人，
    // 玩家反馈这不合理，去掉了（砸中那一下的伤害见 wreckDamage，不受影响）
    const gy = this.world.terrain.heightAt(this.landX, this.landZ) + 0.9;
    if (this.isPlayer) {
      this._playerSteer(dt);                 // 机头还能转（用视线方向），扳机还能开
      this.pos.set(this.landX, gy, this.landZ);
    } else {
      this._groundCombat(dt);
      this.pos.set(this.landX, gy, this.landZ);
    }
    this.vel.set(0, 0, 0);
  }

  // 趴地上还能打：把机头掰向最近的目标（相当于一个固定炮台），搂一梭子
  _groundCombat(dt) {
    this.stateTimer -= dt;
    if (this.stateTimer <= 0 || !this.target || !this.target.alive) {
      this.stateTimer = 2.2;
      this.target = this._findAirTarget() || this._pickTarget();
    }
    const t = this.target;
    if (!t || !t.alive) return;
    _toTarget.copy(t.pos).sub(this.pos);
    const dist = _toTarget.length();
    if (dist > CONFIG.plane.airRange) return;
    _fireDir.copy(_toTarget).normalize();
    this.object.quaternion.setFromUnitVectors(FORWARD, _fireDir);   // 机头（连机身）掰过去
    this.fireTimer -= dt;
    if (this.fireTimer <= 0 && this.burst > 0) {
      _nose.copy(this.pos);
      this._fire(_nose, _fireDir, CONFIG.plane.hitSigma);
      this.fireTimer = CONFIG.plane.gunInterval;
      this.burst--;
      if (this.burst <= 0) {
        // 打完一轮要歇一下再补弹 —— 少了这一句就是无限机枪（见 config 的 groundBurstPause）
        this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
        this.fireTimer = rand(CONFIG.plane.groundBurstPause[0], CONFIG.plane.groundBurstPause[1]);
      }
    }
  }

  _destroy(source, cause = 'shot') {
    this.alive = false;
    this.falling = true;                      // 不直接消失，改成往下坠
    this.deadTimer = CONFIG.plane.corpseTime; // 烧成黑壳后保留 5 秒，再自己消失
    this.landed = false;
    this.fallVel = this.vel.clone().multiplyScalar(0.3);
    this.fallSpin = rand(-3.5, 3.5);
    // 坠落途中还能开火：给残骸留半梭子（打完要歇着补弹，见 _fallCombat）
    this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
    this.fireTimer = 0.35;
    this.fallTarget = null;                   // 要砸的那辆敌车（_diveAtTank 每帧更新）
    this.smokeTimer = 0;
    this._char();                             // 机身立刻变黑
    this.world.effects.explosion(this.pos.clone(), 1.2);
    this._wreckBlast();                       // 贴地炸开的顺带把侦察兵掀了
    this.world.onPlaneDestroyed(this, source, cause);
  }

  // 被击落就烧成黑壳
  _char() {
    for (const s of this.skin) s.mesh.material = this.wreckMat;
  }

  // 坠落：冒烟翻滚往下掉，砸到地面再炸一次，然后烧够 5 秒才消失
  _updateFall(dt) {
    this.deadTimer -= dt;

    if (this.landed) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        this.smokeTimer = 0.28;
        this.world.effects.wreckSmoke(this.pos);
      }
      if (this.deadTimer <= 0) {
        this.object.visible = false;
        this.falling = false;
      }
      return;
    }

    if (!this.fallVel) this.fallVel = new THREE.Vector3();
    this.fallVel.y -= 26 * dt;
    // 死也要拉一个：一边掉一边朝最近的**敌**车扎过去
    this._diveAtTank(dt);
    this.pos.addScaledVector(this.fallVel, dt);
    // 打转改成绕机身自转（roll）：这样"机头掰过去打谁"和"打转"能同时存在
    this.object.rotateZ((this.fallSpin || 0) * dt);
    // 坠落途中照样开炮：天上有敌机就打敌机，没有就打我正砸着的那辆敌车
    this._fallCombat(dt);

    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.08;
      this.world.effects.wreckSmoke(this.pos);
    }

    const ground = this.world.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= ground) {
      this._crashPose(ground);                // 摆好坠毁姿态再停下来
      this.landed = true;
      this.fallVel.set(0, 0, 0);
      this.smokeTimer = 0;
      this.world.effects.explosion(new THREE.Vector3(this.pos.x, ground + 1.5, this.pos.z), 1.4);
      this.world.effects.crater(this.pos);
    }
  }

  // 坠落时的水平引导（带限速）：先挑一辆**敌**车扎过去。
  // 不这么做的话坠机砸坦克全靠运气，几乎永远砸不到，等于没这个玩法。
  // 注意只能砸敌人 —— 原来这里挑的是"最近的坦克"、不分敌我，
  // 断翼的飞机会一头扎在自己队友头上，比摔了还难看
  _diveAtTank(dt) {
    const cfg = CONFIG.plane;
    const a = cfg.wreckDiveAccel;
    let gx = 0;
    let gz = 0;
    let best = null;
    let bestD = Infinity;
    for (const t of this.world.tanks) {
      if (!t.alive || t.team === this.team) continue;
      const ddx = t.pos.x - this.pos.x;
      const ddz = t.pos.z - this.pos.z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < bestD) {
        bestD = d2;
        best = t;
      }
    }
    this.fallTarget = best;
    if (best) {
      const d = Math.sqrt(bestD);
      if (d > 0.5) {
        gx = (best.pos.x - this.pos.x) / d;
        gz = (best.pos.z - this.pos.z) / d;
      }
    } else {
      // 附近没有敌车：至少躲开自己人 —— 绝不砸在队友头上
      for (const t of this.world.tanks) {
        if (!t.alive || t.team !== this.team) continue;
        const dx = t.pos.x - this.pos.x;
        const dz = t.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > cfg.wreckAvoidMate || d < 0.5) continue;
        gx -= dx / d;
        gz -= dz / d;
      }
      const len = Math.hypot(gx, gz);
      if (len < 0.001) return;     // 四面八方都是自己人（或者一个都没有）：那就直着掉
      gx /= len;
      gz /= len;
    }
    this.fallVel.x += gx * a * dt;
    this.fallVel.z += gz * a * dt;

    // 限速：不然越追越快，残骸会横着飞出去老远
    const max = cfg.wreckDiveMax;
    const hs = Math.hypot(this.fallVel.x, this.fallVel.z);
    if (hs > max) {
      const k = max / hs;
      this.fallVel.x *= k;
      this.fallVel.z *= k;
    }
  }

  // 坠落途中天上的敌机里，挑一个最近的（**不卡高度差**：
  // 已经在往下掉了，高度带一卡就永远选不到人）
  _fallAirTarget() {
    const range = CONFIG.plane.fallAirRange;
    let best = null;
    let bestD = Infinity;
    for (const p of this.world.planes.list) {
      if (!p.alive || p === this || p.team === this.team) continue;
      const d = this.pos.distanceTo(p.pos);
      if (d > range || d < 3) continue;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // 坠落途中照样开炮：反正已经要摔了，能拉一个是一个。
  // ① 天上有敌机 → 机头掰过去打（把最后一次机会用掉）
  // ② 没有 → 打我正在砸下去的那辆敌车
  _fallCombat(dt) {
    // 只有"断了翅膀、还在往下硬撑"的那架才在坠落里继续反击；
    // 被一发打爆、机翼完好的那架，一死就哑火（玩家反馈：不该还补射）
    if (this.wingLoss <= 0) return;
    const cfg = CONFIG.plane;
    const air = this._fallAirTarget();
    const t = air || (this.fallTarget && this.fallTarget.alive ? this.fallTarget : null);
    if (!t || !t.alive) return;
    _toTarget.copy(t.pos).sub(this.pos);
    const dist = _toTarget.length();
    if (dist > (air ? cfg.fallAirRange : cfg.airRange) || dist < 3) return;
    _fireDir.copy(_toTarget).normalize();
    // 机头（连机身）掰向目标：坠落时舵面几乎失效，这是"尽力而为"
    this.object.quaternion.setFromUnitVectors(FORWARD, _fireDir);
    this.fireTimer -= dt;
    if (this.fireTimer <= 0 && this.burst > 0) {
      _nose.copy(this.pos);
      this._fire(_nose, _fireDir, air ? CONFIG.plane.airHitSigma : cfg.hitSigma, cfg.gunDamage);
      this.fireTimer = cfg.gunInterval;
      this.burst--;
      if (this.burst <= 0) {
        // 打空一轮也要歇着补弹（不能变成无限机枪）
        this.burst = randInt(CONFIG.plane.burst[0], CONFIG.plane.burst[1]);
        this.fireTimer = rand(cfg.groundBurstPause[0], cfg.groundBurstPause[1]);
      }
    }
  }

  // 落地那一刻的姿态：机头朝原航向、轻微侧倾、机头略沉，再按真实包围盒抬到地面上。
  // （不做这一步的话，残骸会保持空中最后一帧的角度，机头扎进土里，看着像穿模）
  _crashPose(ground) {
    _dir.set(0, 0, 1).applyQuaternion(this.object.quaternion);
    const yaw = Math.atan2(_dir.x, _dir.z);
    _euler.set(rand(-0.25, -0.08), yaw, (Math.random() < 0.5 ? -1 : 1) * rand(0.18, 0.42));
    this.object.quaternion.setFromEuler(_euler);

    // 量一下这个姿态下机身最低点在哪，整体抬起来贴住地面
    this.object.updateMatrixWorld(true);
    _box.setFromObject(this.object);
    this.pos.y += ground + 0.15 - _box.min.y;
  }
}

export class PlaneManager {
  constructor(world, count = CONFIG.plane.count) {
    this.world = world;
    this.list = [];
    const allyCount = Math.ceil(count / 2);
    this.poolAlly = allyCount;          // 池子里备着的架数（上限）
    this.poolEnemy = count - allyCount;
    for (let i = 0; i < count; i++) {
      const p = new Plane(world, i < allyCount ? TEAM.ALLY : TEAM.ENEMY);
      p.pos.y += i * 6;
      this.list.push(p);
    }
    // 这一局实际登场几架：常规局全上，纯空战每边只留 1 架
    this.allyCount = this.poolAlly;
    this.enemyCount = this.poolEnemy;
    this.respawn = false;               // 纯空战：被打下来还能重新升空
    this._nameAll();
  }

  // 每局开打前配置：每边几架、要不要复活。传 null/不传 = 池子里全部上场
  configure(allyCount, enemyCount, respawn) {
    this.allyCount = clamp(allyCount === null || allyCount === undefined ? this.poolAlly : allyCount, 0, this.poolAlly);
    this.enemyCount = clamp(enemyCount === null || enemyCount === undefined ? this.poolEnemy : enemyCount, 0, this.poolEnemy);
    this.respawn = !!respawn;
  }

  // 每局重新编号：我方空军1、敌方空军1 …，不会攒出「空军57」这种
  // （纯空战里没登场的那些不编号，名字留空）
  _nameAll() {
    let ally = 0;
    let enemy = 0;
    for (const p of this.list) {
      if (p.retired) {
        p.name = '';
      } else if (p.team === TEAM.ALLY) {
        p.name = `我方空军${++ally}`;
      } else {
        p.name = `敌方空军${++enemy}`;
      }
    }
  }

  // 换地图 / 开新局：把该登场的飞机撒到新战场上，没登场的那几架先收起来
  reset() {
    let ally = 0;
    let enemy = 0;
    for (const p of this.list) {
      const idx = p.team === TEAM.ALLY ? ally++ : enemy++;
      p.retired = idx >= (p.team === TEAM.ALLY ? this.allyCount : this.enemyCount);
      p.lives = this.respawn ? CONFIG.mode.planeLives : 0;
      p.respawnTimer = -1;
      if (p.retired) {
        p.alive = false;
        p.falling = false;
        p.object.visible = false;
      } else {
        p._reset();
      }
    }
    this._nameAll();
  }

  update(dt) {
    for (const p of this.list) {
      if (p.retired) continue;
      if (p.alive || p.falling) p.update(dt);
    }
    this._checkCollisions();
    this._checkWreckHits();
    this._stepRespawn(dt);
  }

  // 纯空战：被打下来的飞机等几秒重新升空，直到复活机会用完再彻底出局。
  // 残骸 5 秒消失、复活等 6 秒，正好接上。常规局里这里是空的 ——
  // 飞机还是打一架少一架（respawn 一直是 false）
  _stepRespawn(dt) {
    if (!this.respawn) return;
    for (const p of this.list) {
      if (p.retired || p.alive || p.lives <= 0) continue;
      if (p.respawnTimer < 0) {
        // 玩家那架要"黑屏一秒就回天上"，等不了残骸落地；
        // AI 那几架照旧，等残骸落完再出来（天上黑壳还没掉完就又飞回来会很怪）
        p.respawnTimer = p.isPlayer ? CONFIG.mode.playerRespawnDelay : CONFIG.mode.respawnDelay;
      }
      p.respawnTimer -= dt;
      if (p.respawnTimer > 0) continue;
      if (p.falling && !p.isPlayer) continue;   // AI 的残骸还在天上掉，先等它落完
      p.lives--;
      p.respawnTimer = -1;
      p._reset();               // 涂装/状态/位置全部恢复成刚出厂
      if (this.world.onPlaneRespawn) this.world.onPlaneRespawn(p);
    }
  }

  // 坠落的飞机砸到坦克：不致命，只是把坦克震得短时间跑不动。
  // （砸死就太狠了 —— 飞机已经被打下来了，还能顺手带走一辆坦克说不过去）
  _checkWreckHits() {
    const cfg = CONFIG.plane;
    for (const p of this.list) {
      if (!p.falling || p.landed) continue;          // 只在往下掉的途中算
      for (const t of this.world.tanks) {
        if (!t.alive || t.slowTimer > 0) continue;   // 已经被砸慢的别再叠一层
        const dx = p.pos.x - t.pos.x;
        const dz = p.pos.z - t.pos.z;
        const r = p.radius + t.radius + cfg.wreckHitRadius;
        if (dx * dx + dz * dz > r * r) continue;
        const ground = this.world.terrain.heightAt(t.pos.x, t.pos.z);
        if (p.pos.y - ground > cfg.wreckSlowHeight) continue;   // 还在高空，不算砸到
        t.slowBy(cfg.wreckSlowTime);
        // 砸中是真疼：一次掉一大截血（以前只减速、不掉血）
        t.damage(cfg.wreckDamage, p);
        if (this.world.onWreckHit) this.world.onWreckHit(t, p);
      }
    }
  }

  // 两架飞机撞在一起：按"撞上的是机翼还是机身"分结果 ——
  //   · 撞在对方机翼上 → 对方那片机翼掉（自己机头没事，算是擦了一下）
  //   · 两边都撞在对方机翼上（平时最常见的情况）→ 两边各掉一片
  //   · 真·对头（谁也没撞到机翼，是机身对机身）→ 同归于尽
  _checkCollisions() {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive || a.landed) continue;
      if (this._crashIntoTank(a)) continue;   // 一头撞在坦克上：当场坠机
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive || b.landed) continue;
        // 判定距离用"机翼半边"：翼尖擦到就算撞上（飞机本来就 15 米宽）
        const r = CONFIG.plane.wingCrash;
        if (a.pos.distanceToSquared(b.pos) >= r * r) continue;
        const aw = a._hitZone(b.pos);
        const bw = b._hitZone(a.pos);
        if (aw) a.loseWing(aw, 'crash');
        if (bw) b.loseWing(bw, 'crash');
        if (!aw && !bw) {
          a._destroy(b, 'crash');
          b._destroy(a, 'crash');
          continue;
        }
        // 擦身而过：把两架推开一点，免得贴着连续判
        _tip.copy(a.pos).sub(b.pos).setY(0);
        if (_tip.lengthSq() < 1e-4) _tip.set(1, 0, 0);
        _tip.normalize();
        a.pos.addScaledVector(_tip, 3);
        b.pos.addScaledVector(_tip, -3);
      }
    }
  }

  // 飞机贴着地面撞上坦克 = 当场坠机，坦克挨一记和"被坠机砸中"一样重的
  // （45 血 + 短时间跑不动）。撞机不长眼：敌我坦克一样挨。
  _crashIntoTank(a) {
    const gy = this.world.terrain.heightAt(a.pos.x, a.pos.z);
    if (a.pos.y - gy > CONFIG.plane.bodyClear + 2.5) return false;   // 还在高空掠过，不算
    for (const tk of this.world.tanks) {
      if (!tk.alive) continue;
      const r = CONFIG.plane.wingCrash * 0.6 + tk.radius;
      if (a.pos.distanceToSquared(tk.pos) >= r * r) continue;
      // 先记上"被砸中"：这样接下来那架残骸往下掉时不会对同一辆坦克再算一遍
      tk.slowBy(CONFIG.plane.wreckSlowTime);
      tk.damage(CONFIG.plane.wreckDamage, a);
      if (this.world.onWreckHit) this.world.onWreckHit(tk, a);
      a.pos.y = gy + CONFIG.plane.bodyClear;
      a._destroy(tk, 'crash');
      return true;
    }
    return false;
  }

  // 把某一架飞机交给玩家开
  takeForPlayer(team) {
    for (const p of this.list) {
      if (p.retired || p.team !== team || !p.alive) continue;
      p.setPlayer(true);
      return p;
    }
    return null;
  }
}
