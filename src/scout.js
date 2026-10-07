// 探察小兵：1 滴血、两人一色，主要作用是替双方跑图侦察并给玩家报情报

import * as THREE from 'three';
import { CONFIG, COLORS, TEAM } from './config.js';
import { clamp, rand, randInt, wrapAngle } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();

// 相对车头 8 个方位，索引 = round(相对角 / 45°)
const SECTORS = ['正前方', '左前方', '左侧', '左后方', '正后方', '右后方', '右侧', '右前方'];

export class Scout {
  constructor(world, team, position) {
    this.world = world;
    this.team = team;
    this.isScout = true;
    this.alive = true;
    this.radius = 1.4;        // 绕障碍用
    this.hitRadius = 0.75;    // 吃子弹的判定，比人稍大一点
    this.health = 1;          // 一滴血
    this.speed = CONFIG.scout.speed;

    this.yaw = rand(0, Math.PI * 2);
    this.pos = new THREE.Vector3().copy(position);
    this.pos.y = world.terrain.heightAt(this.pos.x, this.pos.z);
    this.target = new THREE.Vector3();
    this.repathTimer = 0;
    this.reportTimer = rand(2, 8);
    this.bob = rand(0, 6);
    this.wander = new THREE.Vector3();

    this.object = new THREE.Group();
    this._build();
    world.scene.add(this.object);
    this._pickWander();
  }

  _build() {
    const coat = this.team === TEAM.ALLY ? COLORS.scoutAlly : COLORS.scoutEnemy;
    const coatMat = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.92, metalness: 0 });   // 布料：全哑光
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc9a07a, roughness: 0.78, metalness: 0 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.72, metalness: 0.18 });   // 装具：一点皮革/金属味

    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.4), darkMat);
    legs.position.y = 0.43;
    legs.castShadow = true;

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.8, 0.5), coatMat);
    body.position.y = 1.25;
    body.castShadow = true;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), skinMat);
    head.position.y = 1.85;

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), coatMat);
    helmet.position.y = 1.87;

    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 0.2), darkMat);
    pack.position.set(0, 1.28, -0.32);

    this.object.add(legs, body, head, helmet, pack);
    this.legs = legs;
  }

  _pickWander() {
    const half = this.world.terrain.playable * 0.92;
    // 往敌方半场跑，才能撞见敌人
    const enemySide = this.team === TEAM.ENEMY ? -1 : 1;
    const z = rand(-half, half) * 0.5 + enemySide * half * 0.45 * rand(0.3, 1);
    this.wander.set(rand(-half, half), 0, clamp(z, -half, half));
    this.repathTimer = rand(6, 13);
  }

  distTo(x, z) {
    return Math.hypot(this.pos.x - x, this.pos.z - z);
  }

  damage(amount, source) {
    if (!this.alive) return false;
    this._die('shot', source);
    return true;
  }

  // 一滴血，怎么死都是直接倒：中弹 / 被爆炸震倒 / 被坦克压扁 / 被坠落的飞机砸到
  _die(cause, source) {
    this.alive = false;
    this.object.visible = false;
    if (cause === 'shot') {
      this.world.effects.impact(this.pos.clone().setY(this.pos.y + 1), UP, false);
    } else {
      this.world.effects.scoutDown(this.pos);
    }
    this.world.onScoutKilled(this, source, cause);
  }
}

export class ScoutManager {
  constructor(world, count = CONFIG.scout.count) {
    this.world = world;
    this.list = [];
    this.reportCooldown = 0;
    this.warnCooldown = 0;   // 被敌方侦察兵盯上的提醒，别刷太勤
    this.allyCount = Math.ceil(count / 2);
    this.total = count;
    this._spawnAll();
  }

  _spawnAll() {
    for (const s of this.list) this.world.scene.remove(s.object);
    this.list.length = 0;
    for (let i = 0; i < this.total; i++) {
      const team = i < this.allyCount ? TEAM.ALLY : TEAM.ENEMY;
      this.list.push(new Scout(this.world, team, this.world.terrain.randomSpawnPoint(null, 0)));
    }
  }

  // 改这一局的侦察兵总数（纯空战里是 0 个 —— 他们是地面部队）
  setCount(count) {
    this.total = Math.max(0, count | 0);
    this.allyCount = Math.ceil(this.total / 2);
  }

  reset() {
    this.reportCooldown = 0;
    this.warnCooldown = 0;
    // 每边的"补充名额"每局重置：名额用完，倒下的侦察兵就真的没了
    this.rebirths = { [TEAM.ALLY]: 0, [TEAM.ENEMY]: 0 };
    this._spawnAll();
  }

  // 复活：保持两边人数。但有**每边每局的名额上限**（CONFIG.scout.respawnBudget）——
  // 原来是无限制补充，所以玩家感觉"侦察兵打都打不完"
  _respawn(dt) {
    for (const s of this.list) {
      if (s.alive) {
        s.respawnAt = undefined;
        continue;
      }
      if (s.respawnAt === undefined) {
        const used = this.rebirths ? (this.rebirths[s.team] || 0) : 0;
        // 名额用完了（-1 表示"不再计时"）：这一条就一直躺着
        s.respawnAt = used >= CONFIG.scout.respawnBudget ? -1 : CONFIG.scout.respawn;
      }
      if (s.respawnAt < 0) continue;
      s.respawnAt -= dt;
      if (s.respawnAt <= 0) {
        const p = this.world.terrain.randomSpawnPoint(null, 0);
        const born = new Scout(this.world, s.team, p);
        born.reportTimer = rand(3, 9);
        const idx = this.list.indexOf(s);
        this.world.scene.remove(s.object);
        this.list[idx] = born;
        if (this.rebirths) this.rebirths[s.team] = (this.rebirths[s.team] || 0) + 1;
      }
    }
  }

  update(dt) {
    this._respawn(dt);
    this.reportCooldown = Math.max(0, this.reportCooldown - dt);
    this.warnCooldown = Math.max(0, this.warnCooldown - dt);
    this._crushCheck();
    for (const s of this.list) {
      if (!s.alive) continue;
      this._move(s, dt);
      s.reportTimer -= dt;
      if (s.reportTimer <= 0) this._tryReport(s);
    }
  }

  // 炮弹/爆炸在附近，侦察兵会被震倒（Effects 里的爆炸都会调到这里）
  blast(pos, radius, source = null) {
    for (const s of this.list) {
      if (!s.alive) continue;
      if (pos.y - s.pos.y > 5) continue;                 // 高空炸的不算（比如天上把飞机打下来）
      if (s.distTo(pos.x, pos.z) > radius) continue;
      s._die('blast', source);
    }
  }

  // 坦克从身上碾过去就压扁了
  _crushCheck() {
    for (const s of this.list) {
      if (!s.alive) continue;
      for (const t of this.world.tanks) {
        if (!t.alive) continue;
        if (s.distTo(t.pos.x, t.pos.z) < t.radius + s.radius * 0.45) {
          s._die('crush', t);
          break;
        }
      }
    }
  }

  _move(s, dt) {
    const terrain = this.world.terrain;
    // 踩进岩浆 / 火山火里：侦察兵是步兵，直接烧没。
    // 原来他们对岩浆完全免疫，站在岩浆里照样活蹦乱跳（玩家反馈"不烫"）
    if (terrain.hazardAt(s.pos.x, s.pos.z) > 0) {
      s._die('burn');
      return;
    }
    // 附近有敌方坦克就躲开
    let flee = null;
    let fleeDist = CONFIG.scout.fleeRange;
    for (const t of this.world.tanks) {
      if (!t.alive || t.team === s.team) continue;
      const d = s.distTo(t.pos.x, t.pos.z);
      if (d < fleeDist) {
        fleeDist = d;
        flee = t;
      }
    }

    // 自家的坦克也要让：不是逃跑，是别自己往人家履带底下钻
    // （我方侦察兵不会自找压扁：看见友军坦克贴过来就侧身闪开）
    let avoid = null;
    let avoidDist = CONFIG.scout.crushAvoid;
    for (const t of this.world.tanks) {
      if (!t.alive || t.team !== s.team) continue;
      const d = s.distTo(t.pos.x, t.pos.z);
      if (d < avoidDist) {
        avoidDist = d;
        avoid = t;
      }
    }

    s.repathTimer -= dt;
    let tx = s.wander.x;
    let tz = s.wander.z;
    // 河 / 岩浆：人不是两栖车，主动绕开 ——
    // 原来侦察兵会一头走进河里，脚陷到河床下面（看着就是穿模），
    // 走到岩浆边缘也照走不误。这里只要靠近就往外推。
    const water = terrain.stream && terrain.streamDistance(s.pos.x, s.pos.z) < terrain.stream.width * 1.3;
    if (water) {
      const cx = terrain.streamCenterX(s.pos.z);
      tx = s.pos.x + (s.pos.x >= cx ? 1 : -1) * 26;
      tz = s.pos.z + rand(-6, 6);
    } else if (flee) {
      tx = s.pos.x - (flee.pos.x - s.pos.x);
      tz = s.pos.z - (flee.pos.z - s.pos.z);
    } else if (avoid) {
      // 友军坦克快压过来了：侧身闪开
      // 关键是"垂直于坦克行进方向"让路，而不是一味往后跑 —— 人跑不过坦克，
      // 只有横着让出车辙才躲得掉
      const tvx = avoid.velocity ? avoid.velocity.x : 0;
      const tvz = avoid.velocity ? avoid.velocity.z : 0;
      const tl = Math.hypot(tvx, tvz);
      const ax = s.pos.x - avoid.pos.x;
      const az = s.pos.z - avoid.pos.z;
      if (tl > 1.5) {
        let px = -tvz / tl;
        let pz = tvx / tl;
        if (px * ax + pz * az < 0) {   // 朝自己已经在的那一侧让，少走冤枉路
          px = -px;
          pz = -pz;
        }
        tx = s.pos.x + px * 20;
        tz = s.pos.z + pz * 20;
      } else {
        // 坦克基本没动（停着）：直接离它远点
        const al = Math.hypot(ax, az) || 1;
        tx = s.pos.x + (ax / al) * 16;
        tz = s.pos.z + (az / al) * 16;
      }
    } else if (s.repathTimer <= 0 || s.distTo(s.wander.x, s.wander.z) < 12) {
      s._pickWander();
      tx = s.wander.x;
      tz = s.wander.z;
    }

    const dx = tx - s.pos.x;
    const dz = tz - s.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const wantYaw = Math.atan2(dx, dz);
    s.yaw += clamp(wrapAngle(wantYaw - s.yaw), -4 * dt, 4 * dt);

    const spd = s.speed * ((flee || avoid) ? 1.25 : 0.8);
    s.pos.x += (dx / len) * spd * dt;
    s.pos.z += (dz / len) * spd * dt;
    terrain.resolveCircle(s.pos, s.radius);
    s.pos.y = terrain.heightAt(s.pos.x, s.pos.z);

    s.object.position.copy(s.pos);
    terrain.normalAt(s.pos.x, s.pos.z, _n);
    s.object.quaternion.setFromUnitVectors(UP, _n);
    s.object.rotateY(s.yaw);
    // 走路上下颠一点，远处也看得出是人不是桩子
    s.bob += dt * 9;
    s.object.position.y += Math.abs(Math.sin(s.bob)) * 0.08;
    s.legs.rotation.x = Math.sin(s.bob) * 0.5;
  }

  // 侦察兵看到敌人就通报：给玩家报情报，同时刷新本方的无线电情报
  // （AI 没有小地图，只能靠 lastContact 知道"那边在打"，所以侦察兵对两边都有用）
  _tryReport(s) {
    s.reportTimer = rand(CONFIG.scout.reportInterval[0], CONFIG.scout.reportInterval[1]);

    const foeTeam = s.team === TEAM.ALLY ? TEAM.ENEMY : TEAM.ALLY;
    const seen = this.world.tanks.filter(
      (t) => t.alive && t.team === foeTeam && s.distTo(t.pos.x, t.pos.z) < CONFIG.scout.spotRange
    );
    if (!seen.length) return;

    // 通报给本方的 AI：把这批敌人的位置记成"最近交火点"，队友巡逻会往那边赶
    if (this.world.lastContact) {
      let cx = 0;
      let cz = 0;
      for (const t of seen) {
        cx += t.pos.x;
        cz += t.pos.z;
      }
      this.world.lastContact[s.team] = { x: cx / seen.length, z: cz / seen.length, age: 0 };
    }

    // 敌方侦察兵：它也在给敌方 AI 报你的位置，得让你知道
    if (s.team !== TEAM.ALLY) {
      const player = this.world.player;
      if (
        player &&
        player.alive &&
        s.distTo(player.pos.x, player.pos.z) < CONFIG.scout.spotRange &&
        this.warnCooldown <= 0
      ) {
        this.warnCooldown = CONFIG.scout.warnCooldown;
        this.world.onScoutReport(
          `敌方侦察兵在${relativeSector(playerHeading(player), player.pos, s.pos)}发现了你，敌方部队正在向你靠拢`,
          'danger'
        );
      }
      return;   // 敌方的情报不给你看
    }

    if (this.reportCooldown > 0) return;   // 我方情报限流，免得刷屏
    const player = this.world.player;
    if (!player || !player.alive) return;

    // 按离玩家最近的那股敌人报
    seen.sort((a, b) => a.pos.distanceTo(player.pos) - b.pos.distanceTo(player.pos));
    const near = seen[0];
    const dist = Math.round(near.pos.distanceTo(player.pos) / 10) * 10;
    const dir = relativeSector(playerHeading(player), player.pos, near.pos);

    let text;
    if (seen.length >= 4) {
      text = `侦察兵报告：${dir}敌人太多（${seen.length} 辆，约 ${dist} 米），建议从侧边绕过去偷袭`;
    } else if (seen.length >= 2) {
      text = `侦察兵报告：${dir}发现 ${seen.length} 辆敌车（约 ${dist} 米）`;
    } else {
      text = `侦察兵报告：${dir}只有 1 辆落单的敌车（约 ${dist} 米）`;
    }
    this.reportCooldown = CONFIG.scout.reportCooldown;
    this.world.onScoutReport(text);
  }
}

// 玩家的朝向：坦克用车体 yaw，飞机用航向（飞机没有 yaw 这个属性，直接用会算成 NaN）
function playerHeading(p) {
  return p.isPlane ? Math.atan2(p.vel.x, p.vel.z) : p.yaw;
}

// 目标在玩家车头的哪个方位
function relativeSector(playerYaw, from, to) {
  const abs = Math.atan2(to.x - from.x, to.z - from.z);
  const rel = wrapAngle(abs - playerYaw);
  const idx = Math.round(rel / (Math.PI / 4));
  return SECTORS[((idx % 8) + 8) % 8];
}

export { randInt };
