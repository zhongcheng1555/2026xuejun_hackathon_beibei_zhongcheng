// 坦克 AI：巡逻 → 发现目标 → 机动到射程 → 瞄准 → 开火 → 残血撤退
// 关键点：瞄准带常驻偏差（会打偏）、反应有延迟、还有概率把友军误判成敌人

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, gauss, rand, randInt } from './utils.js';

const _aimPoint = new THREE.Vector3();
const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();

export class TankAI {
  constructor(tank, world) {
    this.tank = tank;
    this.world = world;
    this.target = null;
    this.reactionLeft = 0;
    this.aimOffset = new THREE.Vector3();
    this.aimOffsetTarget = new THREE.Vector3();
    this.offsetTimer = 0;
    this.patrolPoint = new THREE.Vector3();
    this.patrolTimer = 0;
    this.strafeTimer = 0;
    this.strafeSign = Math.random() < 0.5 ? -1 : 1;
    // AI 不扫射：一轮点射几发就停一下，玩家可以按住猛打
    this.burstLeft = randInt(CONFIG.tank.aiBurst[0], CONFIG.tank.aiBurst[1]);
    this.burstPause = 0;
    this.stuckTimer = 0;      // 统计窗口计时
    // 交火节奏：停车开火 / 挪一段（见 config.ai.aimHold）。从"停车"那一段开始
    this.aimHold = rand(CONFIG.ai.aimHold[0], CONFIG.ai.aimHold[1]);
    this.aimHoldOn = true;
    this.movedAccum = 0;      // 窗口内实际挪了多少米
    this.blockedAccum = 0;    // 窗口内贴着障碍物的时间（判"卡住"的第二个条件）
    this.healing = false;   // 正在应急修复
    this.lastPos = new THREE.Vector3().copy(tank.pos);
    this.moving = false;
    this.mopUp = false;   // 敌方地面清空后的"搜剿飞机"状态（只影响打飞机的准头）
    this.unstick = 0;     // 顶在障碍物上时的脱困计时
    this.unstickAngle = 0; // 脱困时相对目标方向要偏转的角度
    this.lastUnstickAt = -1e9;   // 上一次脱困的时刻（用来判断"该不该换边绕"）
    // 贴墙滑行"往哪一边绕"。必须持久，且换边要慢：
    // 坦克掉头要 1.65 秒，而脱困判据 1.3 秒就会响一次 —— 每响一次就换边的话，
    // 坦克永远转不完那半圈，只会原地拧（泡在岩浆里就是把血烧光）
    this.slideSign = Math.random() < 0.5 ? -1 : 1;
    this.slideHold = 0;   // 换边冷却：这段时间内不重新选边
    this.lavaStuck = 0;   // 泡在岩浆里又走不动的累计时间
    this.reverseHold = 0; // 倒车保持时间（倒起来就至少倒一会儿，免得来回抖）
    this.retreatTime = 0; // 已经连续撤退了多久（甩不掉追兵就回头打）
    // 这辆坦克会不会"抬头防空"（一部分会，见 config 里 antiairChance 的说明）
    this.antiair = Math.random() < CONFIG.plane.antiairChance;
    // 夜战里会隔一阵子"看不见"天上的目标（_airBlind 为真时完全不看天上）
    this._airBlind = false;
    this._blindTimer = 0;
    this.mazeTimer = 0;   // 迷宫寻路的重新规划计时
    this.mazeSig = '';    // 上次规划时"我在哪格→目标在哪格"
    this.mazeNext = null; // 规划结果：下一个该去的格子中心
    this._pickPatrolPoint();
  }

  _pickPatrolPoint() {
    const half = this.world.terrain.playable * 0.9;
    // 队友通报过最近交火位置就往那边赶，免得两拨人在大地图上永远碰不到
    const contact = this.world.lastContact && this.world.lastContact[this.tank.team];
    if (contact && contact.age < 30) {
      const spread = 65;
      this.patrolPoint.set(
        clamp(contact.x + rand(-spread, spread), -half, half),
        0,
        clamp(contact.z + rand(-spread, spread), -half, half)
      );
      this.patrolTimer = rand(6, 12);
      return;
    }
    // 没有情报就朝敌方半场压过去
    const enemySide = this.tank.team === 'enemy' ? -1 : 1;
    const z = rand(-half, half) * 0.6 + enemySide * half * 0.35 * rand(0.2, 1);
    this.patrolPoint.set(rand(-half, half), 0, clamp(z, -half, half));
    this.patrolTimer = rand(8, 16);
  }

  _distanceTo(t) {
    return Math.hypot(t.pos.x - this.tank.pos.x, t.pos.z - this.tank.pos.z);
  }

  // 最近的一辆敌方**坦克**（不看飞机）。换目标时用：贴到脸前的敌人优先级最高
  _nearestFoeTank(range = Infinity) {
    let best = null;
    let bd = range;
    for (const t of this.world.tanks) {
      if (!t.alive || t === this.tank || t.team === this.tank.team) continue;
      const d = this._distanceTo(t);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  // 搜索范围：平时 200m；到了残局就放大，不然幸存者会各自在地图上逛，谁也碰不到谁
  _searchRange() {
    let foes = 0;
    for (const t of this.world.tanks) {
      if (t.alive && t.team !== this.tank.team) foes++;
      if (foes > 2) break;
    }
    if (foes <= 0) return CONFIG.ai.viewRange;   // 只剩飞机了，交给打飞机那套逻辑
    if (foes === 1) {
      // 就剩最后一辆了：直接放到整张地图（对角线约 2.83×半径，这里给 3 倍留点余量）。
      // 不然两个幸存者各自缩在对角，隔着 500m 互相看不见，仗永远打不完
      return Math.max(CONFIG.ai.lateGameViewRange, this.world.terrain.playable * 3);
    }
    return foes === 2 ? CONFIG.ai.lateGameViewRange : CONFIG.ai.viewRange;
  }

  // 敌方地面单位是否已经清空（只剩飞机）——残局就是靠这个判断该不该转职打飞机
  _noEnemyGround() {
    const team = this.tank.team;
    return !this.world.tanks.some((t) => t.alive && t.team !== team);
  }

  // 夜战：天上的目标隔一阵子会"跟丢"。
  // 白天永远看得见 —— 所以白天这段什么都不做，行为与原来完全一致。
  _updateNightSight(dt) {
    if (!this.world.night) {
      if (this._airBlind) {
        this._airBlind = false;
        this._blindTimer = 0;
      }
      return;
    }
    this._blindTimer -= dt;
    if (this._blindTimer > 0) return;
    const n = CONFIG.night;
    this._airBlind = !this._airBlind;
    this._blindTimer = this._airBlind
      ? rand(n.blindFor[0], n.blindFor[1])
      : rand(n.blindEvery[0], n.blindEvery[1]);
  }

  // 这个敌方侦察兵是不是已经有别的**友军坦克**在打了。
  // 侦察兵只有一滴血、又小又快，一堆坦克挤过去追同一个既浪费人手，
  // 又容易在它旁边互相打到自家车 —— 所以谁先盯上就算谁的，别抢
  _scoutTaken(s) {
    const ais = this.world.ais;
    if (!ais) return false;
    for (const other of ais) {
      if (other === this) continue;
      if (!other.tank || !other.tank.alive) continue;
      if (other.tank.team !== this.tank.team) continue;
      if (other.target === s) return true;
    }
    return false;
  }

  // 手边最近的敌方侦察兵（狩猎范围内），**而且是还没有人认领的**。
  // 侦察兵会一直补人，所以这活儿永远不会断 —— 坦克闲着的时候不至于干站着
  _findFoeScout() {
    const list = this.world.scouts && this.world.scouts.list;
    if (!list) return null;
    const tank = this.tank;
    let best = null;
    let bestD = Infinity;
    for (const s of list) {
      if (!s.alive || s.team === tank.team) continue;
      if (this._scoutTaken(s)) continue;          // 已经有人去了，别一窝蜂
      const d = Math.hypot(s.pos.x - tank.pos.x, s.pos.z - tank.pos.z);
      if (d < bestD && d <= CONFIG.ai.scoutHuntRange) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // 夜里跟丢的那几秒：把天上的目标丢掉（地面目标不受影响）。
  // 残局（地面已清空）不丢 —— 不然这局永远收不掉
  _dropBlindAirTarget() {
    if (!this._airBlind || !this.target || !this.target.isPlane) return false;
    if (this._noEnemyGround()) return false;
    this.target = null;
    return true;
  }

  _findTarget() {
    const tank = this.tank;
    const range = this._searchRange();
    let best = null;
    let bestDist = Infinity;
    const noEnemyGround = this._noEnemyGround();
    // 夜战跟丢的这几秒：完全不看天上（残局例外，不然收不了场）
    const blind = this._airBlind && !noEnemyGround;
    // 夜里也看不清远处的飞机：防空交战距离在夜里缩到一半不到
    const airRange = CONFIG.plane.antiairRange * (this.world.night ? CONFIG.night.antiairRangeMul : 1);

    // 防空：会抬头的坦克，看到低空目标就先打它（打不打得中另说，至少飞机不能白刷）。
    // 放在地面目标前面 —— 飞得低的才有威胁，飞得高就够不着（想安全就爬升）
    if (this.antiair && this.world.planes && !blind) {
      for (const p of this.world.planes.list) {
        if (!p.alive || p.team === tank.team) continue;
        const d = Math.hypot(p.pos.x - tank.pos.x, p.pos.z - tank.pos.z);
        if (d > airRange) continue;
        if (p.pos.y - tank.pos.y > CONFIG.plane.antiairAlt) continue;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
    }

    for (const t of this.world.tanks) {
      if (!t.alive || t === tank) continue;
      if (t.team === tank.team) continue;
      const d = this._distanceTo(t);
      if (d < bestDist && d <= range) {
        bestDist = d;
        best = t;
      }
    }

    // 地面没目标了才朝天上看一眼：不打飞机的话，残局会永远收不掉
    if (!best && this.world.planes && !blind) {
      // 敌方地面单位已经清空时，放开视野、专心搜剿空中的。
      // 平时（含夜战）就按地面视野来，夜里还要再缩 —— 不然"夜里看不远"只挡得住主防空那条路，
      // 这条兜底路照样隔着两百米就把飞机锁上了
      const planeRange = noEnemyGround
        ? CONFIG.ai.mopUpRange
        : range * (this.world.night ? CONFIG.night.antiairRangeMul : 1);
      for (const p of this.world.planes.list) {
        if (!p.alive || p.team === tank.team) continue;
        const d = Math.hypot(p.pos.x - tank.pos.x, p.pos.z - tank.pos.z);
        if (d < bestDist && d <= planeRange) {
          bestDist = d;
          best = p;
        }
      }
    }
    return best;
  }

  _updateAimOffset(dt) {
    this.offsetTimer -= dt;
    if (this.offsetTimer <= 0) {
      this.offsetTimer = rand(0.7, 1.9);
      // 瞄准偏差倍率：普通车是 1；BOSS 移动中误差很小、进瞄准模式零误差
      let mul = 1;
      if (this.tank.aimErrorMul !== undefined) {
        mul = this.tank.precise ? (this.tank.aimErrorMulPrecise || 0) : this.tank.aimErrorMul;
      }
      const e = (CONFIG.ai.aimError + (this.moving ? CONFIG.ai.aimErrorMoving : 0)) * mul;
      this.aimOffsetTarget.set(gauss() * e, gauss() * e * 0.5, gauss() * e);
    }
    this.aimOffset.lerp(this.aimOffsetTarget, 1 - Math.exp(-2.2 * dt));
  }

  // 射线上有没有自己人（有就收手，绝不故意朝友军开火）
  //
  // 这里有两个原先漏掉的口子，都是"走廊里排队"时最容易出事的：
  //  1) 原来把 4m 以内的友军**排除**在外。可坦克半径就有 3.4m、炮管长 7.4m ——
  //     贴着正前方 3m 站着的那个，开炮等于把炮口怼在人家脸上，却是最危险的
  //  2) 原来只看到"目标距离"为止。炮弹是带散布的，打偏了会从目标头顶飞过去，
  //     目标背后一小段里站着自己人一样会挨
  _friendlyInLine(ux, uz, targetDist) {
    const tank = this.tank;
    for (const f of this.world.tanks) {
      if (f === tank || !f.alive || f.team !== tank.team) continue;
      const dx = f.pos.x - tank.pos.x;
      const dz = f.pos.z - tank.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > targetDist + CONFIG.ai.allyLineBehind) continue;
      const dot = (dx * ux + dz * uz) / (d || 1);
      if (dot > 0.9) return true; // 夹角约 25° 内，算挡在射线上
    }
    return false;
  }

  // 靠近地图边界时把方向往内侧掰一点：不然贴着墙根开，位置被边界夹住就动弹不得
  _keepInside(dx, dz) {
    const limit = this.world.terrain.playable;
    const margin = 16;
    const px = this.tank.pos.x;
    const pz = this.tank.pos.z;
    if (px > limit - margin) dx -= (px - (limit - margin)) / margin;
    else if (px < -limit + margin) dx += (-limit + margin - px) / margin;
    if (pz > limit - margin) dz -= (pz - (limit - margin)) / margin;
    else if (pz < -limit + margin) dz += (-limit + margin - pz) / margin;
    if (Math.hypot(dx, dz) < 1e-3) {   // 两个方向都被顶住（墙角）：直接朝场地中心走
      dx = -px;
      dz = -pz;
    }
    return [dx, dz];
  }

  // 脱困：把参考方向旋转 unstickAngle 后开出去（坦克不能倒车，只能转个方向走）
  _unstickMove(ux, uz) {
    const c = Math.cos(this.unstickAngle);
    const s = Math.sin(this.unstickAngle);
    const [ix, iz] = this._keepInside(ux * c - uz * s, ux * s + uz * c);
    this._move(ix, iz, 1);
  }

  // 统一的移动出口。
  //
  // 泡在岩浆里的时候优先上岸，方向要选对：
  //   目标在我这一岸 → 往回退出去
  //   目标在对岸   → 咬牙冲过去（不然一条岩浆河就把两队永远隔开，仗永远打不完）
  //
  // 关键：这里**不能再用 return 把后面的逻辑跳过去**。
  // 原来泡在岩浆里就直接 return 一个纯 ±x 方向，等于把下面的"贴墙滑行"和
  // 脱困全关掉了 —— 只要岸边正好有块石头或墙，坦克就会顶着它一直泡在岩浆里
  // 烧，直到烧死（实测 6 局有 4 辆是这么死的，单次最长泡了 9.1 秒）。
  // 现在照常往下走：先定一个"朝岸边"的方向，再让贴墙滑行去处理障碍。
  _move(ax, az, mag) {
    const t = this.world.terrain;
    const tank = this.tank;
    const inLava = t.hazardAt && t.hazardAt(tank.pos.x, tank.pos.z) > 0;

    if (inLava) {
      // 实在出不来就倒车：直着沿车尾退回去，不转头。
      // 坦克掉头要 1.65 秒，被岸边的石头顶住时一直转就是一直烧，等不起。
      if (this.reverseHold > 0) {
        tank.reverseIntent = true;
        tank.setMoveIntent(Math.sin(tank.yaw), Math.cos(tank.yaw), 1);
        return;   // 倒车时不走贴墙滑行：就是要一条直线退出去
      }
      // 危险区分两种：岩浆河（一条带子）和**火山喷发的火**（从火山口往外铺的一片）。
      // 原来这里只会按"我在河的哪一边"来躲，直接调 streamCenterX ——
      // 可火山那张图有 5% 的概率根本不生成岩浆河，那时候 stream 是 null，
      // 而且火一样会让 hazardAt > 0，于是每帧抛一次
      // "Cannot read properties of null (reading 'baseX')"，整个 AI 全停。
      // 所以要按"到底是什么在烧我"分开处理
      const inFire = t.inFire ? t.inFire(tank.pos.x, tank.pos.z) : false;
      if (inFire && t.volcano) {
        // 火是圆的：方向就是"背离火山口"，一直往外走
        const dx = tank.pos.x - t.volcano.x;
        const dz = tank.pos.z - t.volcano.z;
        const len = Math.hypot(dx, dz) || 1;
        ax = dx / len;
        az = dz / len;
        mag = 1;
      } else if (t.stream) {
        const cx = t.streamCenterX(tank.pos.z);
        const mySide = tank.pos.x >= cx ? 1 : -1;
        let dir = mySide;
        const tgt = this.target;
        if (tgt && tgt.pos) {
          // 注意：两边都用"我这里"的河道中线当参照。河是弯的，
          // 各算各的中线会让"哪一边"来回跳，坦克就会在河岸上原地打摆子
          const foeSide = tgt.pos.x >= cx ? 1 : -1;
          if (foeSide !== mySide) dir = foeSide;
        }
        // 这里不看 unstick：泡在岩浆里只有一个目标 —— 上岸
        ax = dir;
        az = 0;
        mag = 1;
        // 可岸边被一堆石头堵住了：光靠"贴墙滑行"容易在几块石头之间来回蹭，
        // 最后活活烧死。直接试 8 个方向，挑一个"前面足够空、又不往岩浆深处走"的
        if (tank.blocked) {
          const base = Math.atan2(ax, az);
          let bestA = base;
          let bestScore = -Infinity;
          for (let i = 0; i < 8; i++) {
            const a = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 4);
            const dx = Math.sin(a);
            const dz = Math.cos(a);
            let clear = 1;
            for (let s = 3; s <= 15; s += 4) {
              if (t.hitCollider(tank.pos.x + dx * s, tank.pos.y + 1, tank.pos.z + dz * s)) {
                clear = 0;
                break;
              }
            }
            const score = clear * 2 + dx * ax + dz * az;   // 空 + 朝外
            if (score > bestScore) {
              bestScore = score;
              bestA = a;
            }
          }
          ax = Math.sin(bestA);
          az = Math.cos(bestA);
        }
      } else {
        // 兜底：既没有河也没有火山（理论上不该发生），往场地中间退
        const len = Math.hypot(tank.pos.x, tank.pos.z) || 1;
        ax = -tank.pos.x / len;
        az = -tank.pos.z / len;
        mag = 1;
      }
    } else if (t.stream && t.stream.damage > 0 && this._crossingInto(t, ax, az)) {
      // 下水**之前**先看一眼（别等泡进去了才想办法）：
      //   · 目标不在对岸 → 没理由下水，沿着岸边走
      //   · 目标在对岸，但对岸出口被大石头/一堆石头堵住 → 也别下水，
      //     冲进去只会顶在岸边的石头上一直烧血（实测这是"烧死在岩浆里"的主因）
      //   · 目标在对岸、出口是通的 → 正常穿过去
      const p = tank.pos;
      const cx = t.streamCenterX(p.z);
      const mySide = p.x >= cx ? 1 : -1;
      const tgt = this.target;
      const foeSide = tgt && tgt.pos ? (tgt.pos.x >= cx ? 1 : -1) : mySide;
      const clear = foeSide !== mySide && !this._exitBlocked(t, cx, foeSide, p.z);
      if (!clear) {
        const s = az > 0.15 ? 1 : az < -0.15 ? -1 : (this.strafeSign >= 0 ? 1 : -1);
        // 河是弯的，光沿岸走会被弯出来的河身擦到，所以顺带往远离河心的一侧偏一点
        const bias = Math.abs(p.x - cx) < 16 ? 0.7 : 0.25;
        ax = mySide * bias;
        az = s;
      }
    }

    // 贴着障碍物时**沿着它的表面滑行**，而不是顶着磨。
    // 做法：把"往墙里顶"的那个分量减掉，剩下的就是切向（贴墙滑过去）。
    // 这是森林/丘陵/花园三张图慢局的根因 —— 原来 AI 只会瞎转个角度继续顶，
    // 顶不动就再瞎转，于是原地磨到天荒地老。
    if (tank.blocked) {
      const d = Math.hypot(ax, az);
      if (d > 1e-4) {
        const ux = ax / d;
        const uz = az / d;
        const nx = tank.blockNormal.x;
        const nz = tank.blockNormal.z;
        const into = ux * nx + uz * nz;   // 负数 = 正在往墙里开
        if (into < -0.08) {
          const sx = ux - nx * into;
          const sz = uz - nz * into;
          const sl = Math.hypot(sx, sz);
          if (sl > 0.2) {
            ax = sx / sl;
            az = sz / sl;
          } else {
            // 正对着撞上去（切向退化了）：挑一边绕。
            // 方向必须**一条道走到黑**，不能每帧按车头重算 —— 坦克朝着 A 边转、
            // 车头一偏选择就翻到 B 边，于是原地来回拧，永远转不完那半圈。
            // 所以用独立的 slideSign，只在"贴着墙又几乎没动"满 3 秒时才换边。
            const s = this.slideSign >= 0 ? 1 : -1;
            ax = -nz * s;
            az = nx * s;
          }
        }
      }
    }
    this.tank.setMoveIntent(ax, az, mag);
  }

  // 沿这个方向再开 7 米，会不会进岩浆
  _crossingInto(t, ax, az) {
    const p = this.tank.pos;
    const reach = t.stream.width * 0.8 + 3;   // 危险区外留 3 米余量
    return t.streamDistance(p.x + ax * 7, p.z + az * 7) < reach;
  }

  // 对岸的出口通不通：在那边岸上横向扫 5 个点，撞到碰撞体就算被堵住了。
  // （河里生成时不放障碍物，但**岸上**会堆石头/建筑）
  _exitBlocked(t, cx, foeSide, z) {
    const exitX = cx + foeSide * (t.stream.width * 0.8 + 4);
    for (let k = -2; k <= 2; k++) {
      const zz = z + k * 5;
      if (t.hitCollider(exitX, t.heightAt(exitX, zz) + 3, zz)) return true;
    }
    return false;
  }

  // ---------- 迷宫寻路 ----------
  //
  // 花园里不能直线冲：树篱是墙，直冲只会顶着墙原地磨。
  // 做法：把迷宫格子当节点图跑 BFS，算出"朝目标该先去的下一个格子"。
  // 每 0.3 秒（或"我在哪格/目标在哪格"变了）才重算一次，不用每帧算。
  //
  // 返回 null 表示不需要：不是迷宫地形、或者已经和目标同一格（那就正常交战）。
  _mazeNav(dt, tx, tz) {
    const m = this.world.terrain.maze;
    if (!m) return null;
    const c = m.cellAt(this.tank.pos.x, this.tank.pos.z);
    const g = m.cellAt(tx, tz);
    if (!c || !g) return null;
    if (c.i === g.i && c.j === g.j) return null;

    this.mazeTimer -= dt;
    const sig = `${c.i},${c.j}>${g.i},${g.j}`;
    if (this.mazeTimer <= 0 || this.mazeSig !== sig) {
      this.mazeTimer = 0.3;
      this.mazeSig = sig;
      this.mazeNext = this._bfsMaze(m, c, g);
    }
    return this.mazeNext;
  }

  _bfsMaze(m, from, to) {
    const N = m.n;
    const idx = (i, j) => j * N + i;
    const start = idx(from.i, from.j);
    const goal = idx(to.i, to.j);
    const prev = new Int16Array(N * N).fill(-1);
    const seen = new Uint8Array(N * N);
    const queue = [start];
    seen[start] = 1;
    let found = false;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (cur === goal) {
        found = true;
        break;
      }
      const i = cur % N;
      const j = (cur - i) / N;
      // 四个方向各走一步，前提是那面墙是通的
      if (i + 1 < N && m.openV[i][j]) {
        const k = idx(i + 1, j);
        if (!seen[k]) { seen[k] = 1; prev[k] = cur; queue.push(k); }
      }
      if (i - 1 >= 0 && m.openV[i - 1][j]) {
        const k = idx(i - 1, j);
        if (!seen[k]) { seen[k] = 1; prev[k] = cur; queue.push(k); }
      }
      if (j + 1 < N && m.openH[i][j]) {
        const k = idx(i, j + 1);
        if (!seen[k]) { seen[k] = 1; prev[k] = cur; queue.push(k); }
      }
      if (j - 1 >= 0 && m.openH[i][j - 1]) {
        const k = idx(i, j - 1);
        if (!seen[k]) { seen[k] = 1; prev[k] = cur; queue.push(k); }
      }
    }
    if (!found) return null;
    // 从终点回溯，找到"起点之后的第一格"
    let cur = goal;
    while (prev[cur] !== start && prev[cur] !== -1) cur = prev[cur];
    const ni = cur % N;
    const nj = (cur - ni) / N;
    return { x: m.centerX(ni), z: m.centerZ(nj) };
  }

  _checkStuck(dt) {
    const tank = this.tank;
    const moved = Math.hypot(tank.pos.x - this.lastPos.x, tank.pos.z - this.lastPos.z);
    this.lastPos.copy(tank.pos);
    this.movedAccum += moved;
    this.stuckTimer += dt;
    if (tank.blocked) this.blockedAccum += dt;

    // 判"卡住"要**同时**满足两条：
    //   ① 位移小（在原地磨）
    //   ② 这段时间里确实顶着障碍物
    // 只看①是不行的：丘陵又陡又慢，坦克正常爬坡/慢速推进也会低于那个绝对阈值，
    // 于是"慢"被当成"卡住"——实测一局误触发近百次，每次又强制偏 90°~180° 开走
    // 1~2 秒，结果坦克左绕右绕、一直没有进度。加上②之后，只是慢不会被误判，
    // 真顶着石头磨的照样能脱困。
    if (this.stuckTimer > 1.3) {
      const grinding = this.movedAccum < 1.6 && this.blockedAccum > this.stuckTimer * 0.35;
      if (grinding) {
        this._pickPatrolPoint();
        this.patrolTimer = rand(3, 6);
        // 换边要慢：掉头要 1.65 秒，而这个判据 1.3 秒就响一次，每响一次就换边
        // 的话坦克永远转不完那半圈，只会原地拧。所以 3 秒内保持同一边。
        const now = performance.now();
        if (this.slideHold <= 0) {
          this.slideSign *= -1;
          this.strafeSign *= -1;
          this.slideHold = 3.0;
        }
        this.lastUnstickAt = now;
        // 交火时不会去巡逻，光换个巡逻点没用 —— 记一个脱困计时，逼它先横着蹭开障碍
        this.unstick = rand(1.0, 2.0);
        this.unstickAngle = (this.slideSign >= 0 ? 1 : -1) * rand(Math.PI * 0.5, Math.PI);
      }
      this.stuckTimer = 0;
      this.movedAccum = 0;
      this.blockedAccum = 0;
    }

    // 泡在岩浆里又走不动（被岸边的石头/墙顶住）：攒够 1.5 秒就倒车退出去。
    // 倒起来之后至少保持 1.2 秒，否则一倒车速度上来了就取消、又原地拧。
    this.reverseHold = Math.max(0, this.reverseHold - dt);
    const hazard = this.world.terrain.hazardAt && this.world.terrain.hazardAt(tank.pos.x, tank.pos.z) > 0;
    if (hazard && tank.velocity.length() < 2.0) {
      this.lavaStuck += dt;
      if (this.lavaStuck > 1.5) {
        this.reverseHold = 1.2;
        this.lavaStuck = 0;
      }
    } else {
      this.lavaStuck = 0;
    }
  }

  update(dt) {
    const tank = this.tank;
    if (!tank.alive) return;

    this._updateAimOffset(dt);
    this.slideHold = Math.max(0, this.slideHold - dt);
    this._checkStuck(dt);
    this.unstick = Math.max(0, this.unstick - dt);
    tank.aimSpeedMul = CONFIG.player.aimSpeed;   // 默认瞄准模式照常减速，下面按需覆盖
    // 泡在岩浆里就别端着瞄准镜慢慢挪了：全速冲出去，少烧一点是一点。
    // 实测端着慢速过河要 5~6 秒 ≈ 50 血，全速只要 2.5 秒左右。
    if (this.world.terrain.hazardAt && this.world.terrain.hazardAt(tank.pos.x, tank.pos.z) > 0) {
      tank.aimSpeedMul = 1;
    }

    const prevTarget = this.target;
    this._updateNightSight(dt);
    if (
      !this.target ||
      !this.target.alive ||
      // 追侦察兵是最低优先级：每帧重新评估，真敌人一出现立刻让位
      this.target.isScout ||
      this._distanceTo(this.target) > this._searchRange() * 1.25
    ) {
      this.target = this._findTarget();
      if (this.target && this.target !== prevTarget) {
        this.reactionLeft = rand(CONFIG.ai.reaction[0], CONFIG.ai.reaction[1]);
      }
    }
    // 夜里跟丢了就把天上的目标丢掉（等"看见"了会重新锁上）
    this._dropBlindAirTarget();

    // 有敌人凑到脸前就换目标。原来只要老目标还活着、还在射程里，AI 就一直咬死它，
    // 于是别人可以贴到它鼻子底下白打（玩家反馈：一辆车开到另一辆面前，
    // 它还在打原来的目标）。这里要求"新目标明显更近（不到 0.6 倍）"才换，避免来回抖。
    if (this.target && !this.target.isPlane && !this.target.isScout) {
      const curD = this._distanceTo(this.target);
      const near = this._nearestFoeTank();
      if (near && near !== this.target) {
        const nd = this._distanceTo(near);
        if (nd < curD * 0.6 && nd < CONFIG.ai.engageMax) {
          this.target = near;
          this.reactionLeft = Math.min(this.reactionLeft, 0.5);
        }
      }
    }

    // 挨打之后会转向攻击来源。但只还击敌人、而且只还击地面目标：
    // 友军本来就可能不小心打到自己，回头去打自己人是最蠢的事；飞机也追不上，不值得放下地面目标
    const attacker = tank.lastHitBy;
    if (
      tank.lastHitTimer > 0 &&
      attacker &&
      attacker.alive &&
      attacker.team !== tank.team &&
      !attacker.isPlane &&
      attacker !== this.target
    ) {
      if (!this.target || this._distanceTo(attacker) < this._distanceTo(this.target)) {
        this.target = attacker;
        this.reactionLeft = Math.min(this.reactionLeft, 0.7);
      }
    }

    // 身上有伤、这一带又够安全 → 先停下来修车（不必等"周围一个人都没有"）。
    // 注意不能只挂在下面的"没目标"分支里：视野 200m 之内几乎总有敌人，
    // 坦克就几乎永远有目标，那样它一辈子都不会去修车
    if (this._tryRepair()) return;

    if (!this.target) {
      // 闲着也是闲着：把敌方侦察兵清掉（它们会一直补人，所以总有活干）。
      // 放在修车之后 —— 有伤先修，别为了追个侦察兵把自己搭进去
      const scout = this._findFoeScout();
      if (!scout) {
        this.moving = true;
        this._patrol(dt);
        return;
      }
      this.target = scout;
    }

    // 打飞机：它飞得快，追是追不上的，所以边按巡逻路线走边朝天打。
    // 平时大家都忙着打地面目标，只有手头没活儿的（以及残局里剩下来的）才会抬头。
    if (this.target.isPlane) {
      tank.precise = true;
      // 敌方地面单位已经清空 → 全员转职高炮，认真打剩下的飞机
      // 不然"必须把飞机也打光"这条规则会让残局永远收不掉
      this.mopUp = this._noEnemyGround();
      // 搜剿阶段要全速追赶（飞机 40m/s，坦克再慢慢蹭就永远追不上）；
      // 只是把"打得准"留着，不影响命中
      if (this.mopUp) tank.aimSpeedMul = 1;
      this.patrolTimer -= dt;
      // 搜剿阶段直接追着飞机的航迹跑（跟到下面去打，距离近了才打得准）；
      // 平时按巡逻路线走 —— 追也追不上，还会把自己送到敌人炮口下。
      // **迷宫地形例外**：花园/山谷里追飞机是白费劲（走廊拐来拐去，飞机从头顶过），
      // 而且很容易顶在树篱上变成"对着墙开炮"。所以迷宫里只巡逻 + 朝天打
      const inMaze = !!(this.world.terrain && this.world.terrain.maze);
      const chase = this.mopUp && !inMaze;
      const tx = chase ? this.target.pos.x : this.patrolPoint.x;
      const tz = chase ? this.target.pos.z : this.patrolPoint.z;
      const ax = tx - tank.pos.x;
      const az = tz - tank.pos.z;
      if (Math.hypot(ax, az) < 18 || this.patrolTimer <= 0) {
        if (!this.mopUp) this._pickPatrolPoint();
      }
      if (this.unstick > 0) {
        // 卡住了先转个方向绕出来，别一直顶着障碍物朝天干瞪眼
        const l = Math.hypot(ax, az) || 1;
        this._unstickMove(ax / l, az / l);
      } else {
        const [ix, iz] = this._keepInside(ax, az);
        this._move(ix, iz, this.mopUp ? 0.95 : 0.75);
      }
      this._aimAndFire(dt, this._distanceTo(this.target));
      return;
    }
    this.mopUp = false;

    // 把交火位置通报给全队
    if (this.world.lastContact) {
      this.world.lastContact[this.tank.team] = { x: this.target.pos.x, z: this.target.pos.z, age: 0 };
    }

    const dist = this._distanceTo(this.target);
    const lowHealth = tank.health < tank.maxHealth * 0.3;
    this.moving = true;
    // 残血想拉开距离去修车。但追兵速度差不多，真被咬住时就会变成"同速无限长跑"：
    // 追不上也甩不掉，两个人跑一辈子。所以撤退有上限，甩不掉就回头拼命。
    if (!lowHealth || dist > CONFIG.ai.engageMax * 1.6) {
      this.retreatTime = 0;                 // 没受伤 / 已经拉开了 → 重新计时
    } else {
      this.retreatTime += dt;
    }
    const lastStand = lowHealth && this.retreatTime >= CONFIG.ai.maxRetreat;
    if (lowHealth && !lastStand) this._retreat(dt, dist);
    else this._engage(dt, dist);
    // 瞄准模式由 _engage 自己定（只有"停车开火"那一段才是瞄准模式）。
    // 这里只兜底两条：追侦察兵、以及撤退时不端着慢慢瞄 ——
    // 侦察兵跑得快又只有一滴血，全速压过去比站住瞄靠谱
    if (lowHealth || this.target.isScout) tank.precise = false;
    this._aimAndFire(dt, dist);
  }

  _nearestFoeDist() {
    let best = Infinity;
    for (const t of this.world.tanks) {
      if (!t.alive || t.team === this.tank.team) continue;
      best = Math.min(best, Math.hypot(t.pos.x - this.tank.pos.x, t.pos.z - this.tank.pos.z));
    }
    return best;
  }

  // 这一带够不够安全，能停下来修车？
  // 原来要求"最近的敌人远在 120 米外"才敢动手 —— 实战里几乎永远不满足，
  // 所以坦克看着就像从来不修车。现在改成两条：
  //   ① 附近一个敌人都没有 → 安心修（"附近没敌人就能修"）
  //   ② 附近自己人明显比敌人多、而且最近的敌人还没贴脸 → 缩在队友后面修
  _safeToRepair() {
    const tank = this.tank;
    const R = CONFIG.ai.repairSafeRange;
    let foes = 0;
    let mates = 0;
    let nearestFoe = Infinity;
    for (const t of this.world.tanks) {
      if (!t.alive || t === tank) continue;
      const d = Math.hypot(t.pos.x - tank.pos.x, t.pos.z - tank.pos.z);
      if (d > R) continue;
      if (t.team === tank.team) {
        mates++;
        continue;
      }
      foes++;
      if (d < nearestFoe) nearestFoe = d;
    }
    // 飞机也算威胁：坦克打不着它，但它会俯冲扫射
    const pl = this.world.planes && this.world.planes.list;
    if (pl) {
      for (const p of pl) {
        if (!p.alive || p.team === tank.team) continue;
        const d = Math.hypot(p.pos.x - tank.pos.x, p.pos.z - tank.pos.z);
        if (d <= R) {
          foes++;
          if (d < nearestFoe) nearestFoe = d;
        }
      }
    }
    if (foes === 0) return true;
    return mates >= foes * CONFIG.ai.repairMateRatio && nearestFoe > CONFIG.ai.repairFoeDist;
  }

  // 身上有伤、这一带又够安全时停下来修车；返回 true 表示这一帧在修车，别干别的
  _tryRepair() {
    const tank = this.tank;
    if (tank.health >= tank.repairCeiling - 6) {
      this.healing = false;
      return false;
    }
    // 已经决定修了却被打断（被撞开、挨打等）→ 放弃，回去打仗
    if (this.healing && !tank.repairing) {
      this.healing = false;
      return false;
    }
    if (!this._safeToRepair()) {
      if (tank.repairing) tank.cancelRepair();
      this.healing = false;
      return false;
    }
    // 泡在岩浆里就更别修了：这边修 10 秒，那边一直烧，白修
    const terr = this.world.terrain;
    if (terr.hazardAt && terr.hazardAt(tank.pos.x, tank.pos.z) > 0) {
      if (tank.repairing) tank.cancelRepair();
      this.healing = false;
      return false;
    }
    if (!this.healing) {
      this.healing = tank.startRepair();
      if (!this.healing) return false;
    }
    // 一定要先站住：修复期间一动就中断，顺序反了会变成每帧重启
    tank.setMoveIntent(0, 0, 0);
    tank.precise = true;
    return true;
  }

  // 战斗时别站在友军的炮口正前方。
  // _friendlyInLine 只在**开炮前**收手，管的是"我瞄的时候你正好在弹道上"；
  // 可现实里更容易出事的是反过来 —— 自己开车怼进了友军的弹道，
  // 人家炮弹已经飞出去了，我再让开也来不及。
  // 所以这里在走位上主动给一个横向偏移，把自己从别人的车道上挪出去。
  _dodgeAllyLine(mx, mz) {
    const tank = this.tank;
    let ax = 0;
    let az = 0;
    const gap = CONFIG.ai.allyLineGap;
    for (const f of this.world.tanks) {
      if (f === tank || !f.alive || f.team !== tank.team) continue;
      const fai = f.ai;
      // 只有"正在交火"的友军才算：没目标的在巡逻，它的炮口方向不算数，
      // 否则满场都是要躲的车道，谁都走不动
      if (!fai || !fai.target || !fai.target.alive) continue;
      const fdx = fai.target.pos.x - f.pos.x;
      const fdz = fai.target.pos.z - f.pos.z;
      const flen = Math.hypot(fdx, fdz);
      if (flen < 1) continue;
      const fuX = fdx / flen;
      const fuZ = fdz / flen;
      const rx = tank.pos.x - f.pos.x;
      const rz = tank.pos.z - f.pos.z;
      const proj = rx * fuX + rz * fuZ;
      // 我在它身后、或者已经越过它的目标 —— 都不算挡着
      if (proj <= 0 || proj >= flen) continue;
      const perpX = rx - fuX * proj;
      const perpZ = rz - fuZ * proj;
      const perp = Math.hypot(perpX, perpZ);
      if (perp >= gap) continue;
      let nx;
      let nz;
      if (perp > 0.4) {
        // 往"离弹道更远"的那一侧挪
        nx = perpX / perp;
        nz = perpZ / perp;
      } else {
        // 正好踩在弹道上（横向几乎为 0）：按车号分左右，
        // 免得两辆车同时选同一侧、又撞在一起
        const s = tank.id % 2 ? 1 : -1;
        nx = -fuZ * s;
        nz = fuX * s;
      }
      const k = 1 - perp / gap;    // 越贴近弹道，推得越急
      // 乘 (1+k)：贴着弹道时（k→1）力度翻倍，能压过原本的战术机动（横移/推进），
      // 快让到位时（k→0）又把控制权交还给战术机动。不然力度恒定的话，
      // 战术机动一直把人往回拽，最后只在弹道边上磨 2~3 米，等于没让开
      const push = CONFIG.ai.allyLinePush * (1 + k);
      ax += nx * push;
      az += nz * push;
    }
    if (ax === 0 && az === 0) return [mx, mz];
    // 只做"侧向偏一点"，不该盖过原来的战术机动（前进/后退/绕行还得照做）
    return [mx + ax, mz + az];
  }

  _patrol(dt) {
    const tank = this.tank;
    this.patrolTimer -= dt;
    let dx = this.patrolPoint.x - tank.pos.x;
    let dz = this.patrolPoint.z - tank.pos.z;
    if (Math.hypot(dx, dz) < 18 || this.patrolTimer <= 0) {
      this._pickPatrolPoint();
      dx = this.patrolPoint.x - tank.pos.x;
      dz = this.patrolPoint.z - tank.pos.z;
    }
    // 迷宫地形：巡逻也得绕走廊，不能对着树篱直冲
    const nav = this._mazeNav(dt, this.patrolPoint.x, this.patrolPoint.z);
    if (nav) {
      dx = nav.x - tank.pos.x;
      dz = nav.z - tank.pos.z;
    }
    if (this.unstick > 0) {
      // 巡逻时顶住障碍物一样要脱困：换个方向绕出去
      this._unstickMove(dx, dz);
    } else {
      const [ix, iz] = this._keepInside(dx, dz);
      this._move(ix, iz, 0.85);
    }

    // 没目标时炮塔朝行进方向，看起来自然一点
    tank.turretYaw += Math.sin(performance.now() * 0.0004 + tank.id) * dt * 0.35;
    tank._applyTurret();
  }

  _engage(dt, dist) {
    const tank = this.tank;
    const t = this.target;
    // 默认按"边走边打"来：移动模式。只有下面那段"停车开火"才切瞄准模式。
    // 放在这里是因为下面有几个提前 return（迷宫寻路 / 脱困 / 隔墙压过去），
    // 不在这里复位的话，那些分支会带着上一次的瞄准模式慢慢挪
    tank.precise = false;
    // 迷宫地形：目标不在同一格，就先沿着走廊往下一格开（直线冲只会顶墙）
    const nav = this._mazeNav(dt, t.pos.x, t.pos.z);
    if (nav) {
      const nx = nav.x - tank.pos.x;
      const nz = nav.z - tank.pos.z;
      if (this.unstick > 0) this._unstickMove(nx, nz);
      else {
        const [ix, iz] = this._keepInside(nx, nz);
        this._move(ix, iz, 1);
      }
      return;
    }
    const dx = t.pos.x - tank.pos.x;
    const dz = t.pos.z - tank.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;

    // 顶在树/石头上了：转个方向蹭出去，别原地一直硬顶
    if (this.unstick > 0) {
      this._unstickMove(ux, uz);
      return;
    }

    let mx;
    let mz;
    // 打侦察兵：直接**碾过去**。
    // 它只有一滴血、又小又快，跟它保持交火距离毫无意义 ——
    // 原来这里套的是打坦克那套（一进 engageMin 就往后倒），结果永远碰不到它，
    // 只能在 30 多米外干耗；而坦克比它快（12.5 vs 8.5），是追得上的。
    // 追的路上照样开炮（_aimAndFire 在后面统一处理），
    // 要是友军正好挡在弹道上、炮不能开，那就更该压过去
    if (t.isScout && CONFIG.ai.ramScouts) {
      const dodgeScout = this._dodgeAllyLine(ux, uz);
      const [ix, iz] = this._keepInside(dodgeScout[0], dodgeScout[1]);
      this._move(ix, iz, 1);
      return;
    }
    // 中间隔着一栋楼（这发炮弹根本打不出去）：别傻站在那儿保持距离。
    // 原来只看距离，于是"隔着一栋楼的两辆车"会永远互相绕圈 —— 谁都打不着谁，
    // 谁也不靠近（玩家反馈：隔了障碍物还硬要保持距离、转来转去）。
    // 打不着就压过去，找个能打的位置（贴墙滑行负责绕开楼）
    if (this.world.terrain.losBlocked) {
      _losFrom.set(tank.pos.x, tank.pos.y + 2.4, tank.pos.z);
      _losTo.set(t.pos.x, t.pos.y + 1.7, t.pos.z);
      if (this.world.terrain.losBlocked(_losFrom, _losTo)) {
        const dodgeLos = this._dodgeAllyLine(ux, uz);
        const [ix, iz] = this._keepInside(dodgeLos[0], dodgeLos[1]);
        this._move(ix, iz, 1);
        return;
      }
    }
    // 看得见、距离也合适 —— **停下来打**。
    // 玩家反馈：AI 攻击时从来没停过，而且一直挂着移动模式（移动中散布 2.6 倍），
    // 所以老是打不准。这里给它一个"停车开火 ↔ 挪一段"的节奏：
    // 停车那一段切瞄准模式（散布小、也走不动），挪动那一段照常跑。
    // 只在**贴到交火距离**才停（engageHold 稍微外一点）：再远就先全速压上去，
    // 不然两边会在中距离上互相干瞪眼、一局拖很久
    const holdBand = !t.isScout && dist <= CONFIG.ai.engageHold * 1.05 && dist >= CONFIG.ai.engageMin * 0.85;
    if (!t.isPlane && holdBand) {
      this.aimHold -= dt;
      if (this.aimHold <= 0) {
        this.aimHoldOn = !this.aimHoldOn;
        this.aimHold = this.aimHoldOn
          ? rand(CONFIG.ai.aimHold[0], CONFIG.ai.aimHold[1])
          : rand(CONFIG.ai.aimMove[0], CONFIG.ai.aimMove[1]);
      }
      if (this.aimHoldOn) {
        tank.precise = true;      // 瞄准模式：散布极小（代价是走不动，反正也停着）
        this.moving = false;      // 站住了就不该再吃"移动中偏差"
        this._move(0, 0, 0);
        return;
      }
      tank.precise = false;
    } else {
      this.aimHoldOn = true;      // 出了这个距离段就重新从"停车"那一段开始
      this.aimHold = rand(CONFIG.ai.aimHold[0], CONFIG.ai.aimHold[1]);
    }
    if (dist > CONFIG.ai.engageMax) {
      mx = ux;
      mz = uz;
    } else if (dist < CONFIG.ai.engageMin) {
      mx = -ux * 0.9;
      mz = -uz * 0.9;
    } else {
      // 侧移躲避，但**同时朝"理想交火距离"收拢**：
      // 比 engageHold 远就往里压，比它近就往外散。
      // 原来这里在中间不管多远都只加一个固定的 +0.25 内偏，结果是
      // 坦克在 32~95 这一大段里来回拐、既不靠近也不退开（玩家反馈"拐来拐去"）
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = rand(1.6, 3.6);
        this.strafeSign *= -1;
      }
      const gap = clamp((dist - CONFIG.ai.engageHold) * 0.04, -0.6, 0.9);
      mx = -uz * this.strafeSign + ux * gap;
      mz = ux * this.strafeSign + uz * gap;
    }

    // 血少的时候不要冲太近
    if (tank.health < tank.maxHealth * 0.6 && dist < CONFIG.ai.engageMin * 1.4) {
      mx = -ux;
      mz = -uz;
    }
    // 最后再让开车道：别顶在友军的炮口正前方（不然人家一开炮就打到自己人）
    const dodge = this._dodgeAllyLine(mx, mz);
    const [ix, iz] = this._keepInside(dodge[0], dodge[1]);
    this._move(ix, iz, 0.95);
  }

  _retreat(dt, dist) {
    const tank = this.tank;
    const t = this.target;
    const dx = tank.pos.x - t.pos.x;
    const dz = tank.pos.z - t.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rand(1.5, 3);
      this.strafeSign *= -1;
    }
    // 顶住障碍物时先转个方向蹭开，不然残血撤退会一直贴着障碍物原地磨
    if (this.unstick > 0) {
      this._unstickMove(dx / len, dz / len);
      return;
    }
    // 撤退方向也要避开地图边界：贴着墙根退会被边界夹死，永远跑不掉
    const [ix, iz] = this._keepInside(dx / len + px * 0.6 * this.strafeSign, dz / len + pz * 0.6 * this.strafeSign);
    this._move(ix, iz, 1);
  }

  _aimAndFire(dt, dist) {
    const tank = this.tank;
    const t = this.target;

    const flight = dist / CONFIG.bullet.speed;
    _aimPoint.copy(t.pos);
    _aimPoint.y += 1.7;
    const targetVel = t.velocity || t.vel;
    if (targetVel) _aimPoint.addScaledVector(targetVel, flight * 0.85);
    // 常驻瞄准偏差：距离越远，偏得越多；打飞机还要再放大一截（对空是全场最难的活）
    // 唯一例外是清场之后的搜剿：那时候必须打得下来，否则这局结束不了
    let planeMul = this.mopUp ? CONFIG.ai.planeMopUpErrorMul : CONFIG.ai.planeAimErrorMul;
    // 夜战：对空偏差再放大一截（本来就难的活，黑灯瞎火更难）。
    // 残局搜剿也放大，但幅度小 —— 不然这局永远收不掉
    if (this.world.night) {
      planeMul *= this.mopUp ? CONFIG.night.mopUpErrorMul : CONFIG.night.planeAimErrorMul;
    }
    const spread = this.target.isPlane ? planeMul : 1;
    _aimPoint.addScaledVector(this.aimOffset, dist * spread);

    tank.aimAtPoint(_aimPoint, dt);

    if (this.reactionLeft > 0) {
      this.reactionLeft -= dt;
      return;
    }
    if (this.burstPause > 0) {
      this.burstPause -= dt;
      return;
    }
    if (tank.aimErrorTo(_aimPoint) > CONFIG.ai.fireAngle) return;

    const len = Math.hypot(t.pos.x - tank.pos.x, t.pos.z - tank.pos.z) || 1;
    // 射线上有自己人就一定收手：绝不故意朝友军开火
    // （误伤还是会发生 —— 炮弹飞出去之后友军自己走进弹道，那才是"不小心打到自己人"）
    if (this._friendlyInLine((t.pos.x - tank.pos.x) / len, (t.pos.z - tank.pos.z) / len, len)) {
      return;
    }

    // 中间隔着楼 / 树篱就别放炮了：打不到，还白暴露自己
    // （树、石头、沙袋不算，见 terrain.losBlocked）
    const terr = this.world.terrain;
    if (terr.losBlocked) {
      _losFrom.set(tank.pos.x, tank.pos.y + 2.4, tank.pos.z);
      _losTo.set(t.pos.x, t.pos.y + 1.7, t.pos.z);
      if (terr.losBlocked(_losFrom, _losTo)) return;
    }

    if (tank.fire()) {
      this.burstLeft--;
      if (this.burstLeft <= 0) {
        this.burstLeft = randInt(CONFIG.tank.aiBurst[0], CONFIG.tank.aiBurst[1]);
        this.burstPause = rand(CONFIG.tank.aiBurstPause[0], CONFIG.tank.aiBurstPause[1]);
      }
    }
  }
}
