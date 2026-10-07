// 可见炮弹：发光弹体 + 曳光拖尾，带飞行时间和轻微下坠

import * as THREE from 'three';
import { CONFIG, COLORS, TEAM } from './config.js';
import { pointSegmentDist2 } from './utils.js';

const FORWARD = new THREE.Vector3(0, 0, 1);
const _seg = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _dirNorm = new THREE.Vector3();
const _mid = new THREE.Vector3();

export class BulletManager {
  constructor(world, max = 200) {
    this.world = world;
    this.max = max;
    this.bullets = [];
    this.free = [];

    this.geoCore = new THREE.SphereGeometry(CONFIG.bullet.radius * 1.7, 8, 6);
    // 曳光拉得比较长：出速高了以后，短拖尾会"闪一下就没"，长拖尾才看得出弹道
    this.geoTrail = new THREE.CylinderGeometry(0.16, 0.05, 12, 6, 1, true);
    this.geoTrail.rotateX(Math.PI / 2);
    this.geoTrail.translate(0, 0, -6);
  }

  _create() {
    const group = new THREE.Group();
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
    const core = new THREE.Mesh(this.geoCore, coreMat);
    const trailMat = new THREE.MeshBasicMaterial({
      color: COLORS.tracer,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trail = new THREE.Mesh(this.geoTrail, trailMat);
    group.add(core, trail);
    group.visible = false;
    this.world.scene.add(group);

    const b = {
      group,
      core,
      coreMat,
      trail,
      trailMat,
      active: false,
      pos: new THREE.Vector3(),
      prev: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      damage: 0,
      owner: null,
      team: null,
      kind: 'shell',
      life: 0,
      age: 0,
      puffOnDeath: false,   // 飞到头自己炸一下（"受潮"的子弹），而不是无声消失
    };
    this.bullets.push(b);
    return b;
  }

  // life 传正数就是"这发子弹只活这么久"（受潮的子弹飞不远，到点自己炸）
  spawn({ pos, dir, speed = CONFIG.bullet.speed, damage, owner, team, kind = 'shell', life = 0 }) {
    let b;
    if (this.free.length) b = this.free.pop();
    else if (this.bullets.length < this.max) b = this._create();
    else {
      // 超出上限就复用最老的一发
      b = this.bullets[0];
    }
    b.active = true;
    b.kind = kind;
    b.pos.copy(pos);
    b.prev.copy(pos);
    b.vel.copy(dir).normalize().multiplyScalar(speed);
    b.damage = damage;
    b.owner = owner;
    b.team = team;
    b.life = life > 0 ? life : CONFIG.bullet.life;
    b.puffOnDeath = life > 0;
    b.age = 0;
    b.group.visible = true;
    b.group.position.copy(pos);

    const isAir = kind === 'air';
    let color;
    if (isAir) color = team === TEAM.ALLY ? COLORS.tracerAirAlly : COLORS.tracerAir;
    else color = team === TEAM.ENEMY ? COLORS.tracerEnemy : COLORS.tracer;
    b.trailMat.color.setHex(color);
    b.coreMat.color.setHex(isAir ? 0xfffbe0 : 0xfff2c0);
    return b;
  }

  _recycle(b) {
    b.active = false;
    b.group.visible = false;
    this.free.push(b);
  }

  _impact(b, onGround) {
    _dirNorm.copy(b.vel).normalize();
    this.world.effects.impact(b.pos, _dirNorm, onGround);
    this._recycle(b);
  }

  update(dt) {
    const terrain = this.world.terrain;
    const tanks = this.world.tanks;
    const planes = this.world.planes ? this.world.planes.list : [];

    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (!b.active) continue;

      b.prev.copy(b.pos);
      b.vel.y -= CONFIG.bullet.gravity * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.age += dt;
      b.life -= dt;

      if (b.life <= 0) {
        // 受潮的子弹飞到头会自己炸一下（"自爆"），不是无声消失
        if (b.puffOnDeath) this._impact(b, false);
        else this._recycle(b);
        continue;
      }

      // 姿态：局部 +Z 指向飞行方向
      b.group.position.copy(b.pos);
      _dirNorm.copy(b.vel).normalize();
      b.group.quaternion.setFromUnitVectors(FORWARD, _dirNorm);

      // 彩蛋：朝太阳方向打上去的子弹算"打中太阳"（具体判定在 Game 里）
      if (this.world.sunShot && _dirNorm.y > 0.45) this.world.sunShot(b.pos, _dirNorm);

      // 1) 地面
      const gh = terrain.heightAt(b.pos.x, b.pos.z);
      if (b.pos.y <= gh) {
        b.pos.y = gh;
        this._impact(b, true);
        continue;
      }

      // 2) 掩体（含隧道岩顶：飞机从上面打不进隧道里）
      //    这里是**从上一帧位置到这一帧位置的整条线段**去撞，不是只测落点：
      //    炮弹一帧飞 2.5 米，比城里的断墙还厚，只测落点会直接穿过去。
      //    另外补一个"胶囊"点判定（terrain.pointInWall）—— 车体碰撞走的是胶囊，
      //    和圆链不完全重合，这边也认一下，免得从两者的缝里钻过去
      if (
        terrain.segmentHit(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z) ||
        (terrain.pointInWall && terrain.pointInWall(b.pos.x, b.pos.y, b.pos.z)) ||
        terrain.roofAt(b.pos.x, b.pos.y, b.pos.z)
      ) {
        this._impact(b, false);
        continue;
      }

      // 3) 飞机（判定体积很小，所以很难打中；同样打不到自己）
      let hitPlane = null;
      for (const p of planes) {
        if (!p.alive || p === b.owner) continue;
        const d2 = pointSegmentDist2(
          p.pos.x, p.pos.y, p.pos.z,
          b.prev.x, b.prev.y, b.prev.z,
          b.pos.x, b.pos.y, b.pos.z
        );
        const r = p.radius + CONFIG.bullet.radius;
        if (d2 < r * r) {
          hitPlane = p;
          break;
        }
      }
      if (hitPlane) {
        this._onPlaneHit(b, hitPlane);
        continue;
      }

      // 4) 坦克（不分敌我，打到谁算谁；但自己的炮弹永远打不到自己）
      let hitTank = null;
      for (const t of tanks) {
        if (!t.alive) continue;
        if (t === b.owner) continue;
        const d2 = pointSegmentDist2(
          t.pos.x, t.pos.y + 1.8, t.pos.z,
          b.prev.x, b.prev.y, b.prev.z,
          b.pos.x, b.pos.y, b.pos.z
        );
        const r = t.radius + CONFIG.bullet.radius;
        if (d2 < r * r) {
          hitTank = t;
          break;
        }
      }
      if (hitTank) {
        this._onTankHit(b, hitTank);
        continue;
      }

      // 4.5) 侦察小兵：一滴血，蹭到就倒
      let hitScout = null;
      for (const s of this.world.scouts.list) {
        if (!s.alive) continue;
        const d2 = pointSegmentDist2(
          s.pos.x, s.pos.y + 1.1, s.pos.z,
          b.prev.x, b.prev.y, b.prev.z,
          b.pos.x, b.pos.y, b.pos.z
        );
        if (d2 < s.hitRadius * s.hitRadius) {
          hitScout = s;
          break;
        }
      }
      if (hitScout) {
        this.world.effects.impact(b.pos.clone(), _dirNorm.copy(b.vel).normalize(), false);
        hitScout.damage(1, b.owner);
        this._recycle(b);
        continue;
      }

      // 5) 打到地图外太空就算了
      if (Math.abs(b.pos.x) > 900 || Math.abs(b.pos.z) > 900 || b.pos.y > 400) {
        this._recycle(b);
      }
    }

    this._intercept();
  }

  // 子弹拦截：敌我两发炮弹在空中撞上，只打掉先射出的那发 ——
  // 后射出的那发算"主动拦截"，打掉来袭炮弹之后继续飞。
  // （原来是把两发都炸掉，等于用一发换一发，拦截成功也白打）
  // 同一阵营的炮弹互不干扰，不然一轮连发自己就炸光了
  _intercept() {
    const list = this.bullets;
    const r2 = CONFIG.bullet.interceptRadius * CONFIG.bullet.interceptRadius;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.active) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.active || b.team === a.team) continue;
        // 两边都在高速飞，用"点到对方这一帧的飞行线段"各判一次，避免对穿时漏掉
        const d1 = pointSegmentDist2(
          b.pos.x, b.pos.y, b.pos.z,
          a.prev.x, a.prev.y, a.prev.z,
          a.pos.x, a.pos.y, a.pos.z
        );
        const d2 = pointSegmentDist2(
          a.pos.x, a.pos.y, a.pos.z,
          b.prev.x, b.prev.y, b.prev.z,
          b.pos.x, b.pos.y, b.pos.z
        );
        if (Math.min(d1, d2) > r2) continue;

        // 谁先射出谁死：age 大的那发是"打过来的"，被引爆；
        // age 小的那发是"后开炮主动拦的"，活下来继续飞
        const doomed = a.age >= b.age ? a : b;
        _mid.copy(a.pos).add(b.pos).multiplyScalar(0.5);
        _dirNorm.copy(doomed.vel).normalize();
        this.world.effects.impact(_mid, _dirNorm, false);
        this._recycle(doomed);
        if (doomed === a) break;   // a 没了，换下一发；a 活着就继续拿它比后面的
      }
    }
  }

  _onTankHit(b, tank) {
    _hitPoint.copy(b.pos);
    _dirNorm.copy(b.vel).normalize();
    const friendly = b.owner && b.owner.team === tank.team && b.owner !== tank;
    const destroyed = tank.damage(b.damage, b.owner);
    this.world.effects.impact(_hitPoint, _dirNorm, false);
    this.world.onTankHit(tank, b.owner, friendly, destroyed, b.kind);
    this._recycle(b);
  }

  _onPlaneHit(b, plane) {
    _hitPoint.copy(b.pos);
    _dirNorm.copy(b.vel).normalize();
    // 把弹着点一起传过去：打在机翼上只掉那片翅膀，打在机身上才致命
    const destroyed = plane.damage(b.damage, b.owner, _hitPoint);
    this.world.effects.impact(_hitPoint, _dirNorm, false);
    this.world.onPlaneHit(plane, b.owner, destroyed);
    this._recycle(b);
  }
}
