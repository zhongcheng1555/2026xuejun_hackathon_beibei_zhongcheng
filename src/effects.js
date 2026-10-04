// 爆炸、弹着、弹坑、炮口火光等特效（全部走对象池，避免频繁创建销毁）

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { rand } from './utils.js';

export class Effects {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.active = [];
    this.pools = new Map();
    this.lights = [];
    this.lightIndex = 0;
    // 爆炸震伤的钩子，由 Game 接到 ScoutManager 上（Effects 不认识侦察兵）
    this.onBlast = null;
    // 音效钩子，同样由 Game 接上（Effects 不认识音频）
    this.onMuzzle = null;
    this.onImpact = null;
    this.onExplosion = null;

    this.geoSphere = new THREE.SphereGeometry(1, 10, 8);
    this.geoRing = new THREE.RingGeometry(0.55, 1, 24);
    this.geoRing.rotateX(-Math.PI / 2);
    this.geoCrater = new THREE.CircleGeometry(1, 16);
    this.geoCrater.rotateX(-Math.PI / 2);

    this.craters = [];
    this.craterIndex = 0;

    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffb066, 0, 60, 2);
      light.visible = false;
      scene.add(light);
      this.lights.push(light);
    }
  }

  _take(poolKey, geometry, additive) {
    let arr = this.pools.get(poolKey);
    if (!arr) {
      arr = [];
      this.pools.set(poolKey, arr);
    }
    if (arr.length) {
      const mesh = arr.pop();
      mesh.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      mesh.visible = true;
      return mesh;
    }
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  _recycle(e) {
    e.mesh.visible = false;
    const key = e.poolKey;
    this.pools.get(key).push(e.mesh);
  }

  _spawn(opts) {
    const e = {
      mesh: opts.mesh,
      poolKey: opts.poolKey,
      t: 0,
      dur: opts.dur,
      scale0: opts.scale0,
      scale1: opts.scale1,
      opacity: opts.opacity,
      fadePow: opts.fadePow ?? 1.6,
      vel: opts.vel || null,
      grav: opts.grav || 0,
      spin: opts.spin || 0,
      yaw: opts.yaw || 0,
      fixedScale: opts.fixedScale || false,
    };
    opts.mesh.position.copy(opts.pos);
    opts.mesh.rotation.set(opts.rotX || 0, opts.rotY || 0, opts.rotZ || 0);
    opts.mesh.scale.setScalar(opts.scale0);
    opts.mesh.material.color.setHex(opts.color);
    opts.mesh.material.opacity = opts.opacity;
    this.active.push(e);
    return e;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.t += dt;
      const k = e.t / e.dur;
      if (k >= 1) {
        this._recycle(e);
        this.active.splice(i, 1);
        continue;
      }
      if (e.vel) {
        e.mesh.position.addScaledVector(e.vel, dt);
        e.vel.y += e.grav * dt;
      }
      if (e.spin) e.mesh.rotation.z += e.spin * dt;
      const s = e.scale0 + (e.scale1 - e.scale0) * k;
      e.mesh.scale.setScalar(s);
      e.mesh.material.opacity = e.opacity * Math.pow(1 - k, e.fadePow);
    }
    for (const light of this.lights) {
      if (!light.visible) continue;
      light.intensity *= Math.max(0, 1 - dt * 6);
      if (light.intensity < 0.05) {
        light.intensity = 0;
        light.visible = false;
      }
    }
  }

  _flashLight(pos, intensity, distance) {
    const light = this.lights[this.lightIndex];
    this.lightIndex = (this.lightIndex + 1) % this.lights.length;
    light.position.copy(pos);
    light.color.setHex(0xffb066);
    light.intensity = intensity;
    light.distance = distance;
    light.visible = true;
  }

  // 炮口火光
  muzzleFlash(pos, dir) {
    const mesh = this._take('flash', this.geoSphere, true);
    this._spawn({
      mesh, poolKey: 'flash', pos, color: 0xffd479, dur: 0.09,
      scale0: 0.5, scale1: 2.6, opacity: 0.95, fadePow: 1.2,
    });
    const smoke = this._take('smoke', this.geoSphere, false);
    this._spawn({
      mesh: smoke, poolKey: 'smoke', pos, color: 0xbdb6a8, dur: 0.5,
      scale0: 0.6, scale1: 3.2, opacity: 0.32,
      vel: new THREE.Vector3(dir.x * 2, 0.6, dir.z * 2), grav: 0.6,
    });
    // 开炮的一瞬间照亮周围。白天几乎看不出来，夜战里这是唯一的光源
    this._flashLight(pos, 7, 34);
    if (this.onMuzzle) this.onMuzzle(pos);
  }

  // 弹着点：火花 + 扬尘（打在地上还会留弹坑）
  impact(pos, dir, onGround) {
    const spark = this._take('flash', this.geoSphere, true);
    this._spawn({
      mesh: spark, poolKey: 'flash', pos, color: 0xffe0a0, dur: 0.22,
      scale0: 0.35, scale1: 1.9, opacity: 1,
    });
    const dust = this._take('smoke', this.geoSphere, false);
    this._spawn({
      mesh: dust, poolKey: 'smoke', pos, color: onGround ? 0xa08f6e : 0x9a9a9a, dur: 0.7,
      scale0: 0.7, scale1: 3.6, opacity: onGround ? 0.5 : 0.35,
      vel: new THREE.Vector3(0, 1.4, 0), grav: -1.2,
    });
    if (onGround && !this.terrain.isWater(pos.x, pos.z)) this.crater(pos);
    else if (!onGround) this._flashLight(pos, 4, 24);

    // 炮弹在附近炸开会把侦察兵震倒（onBlast 由 Game 接到 ScoutManager 上）
    if (this.onBlast) this.onBlast(pos, CONFIG.scout.blastRadius * 0.7);
    if (this.onImpact) this.onImpact(pos, onGround);
  }

  // 落水：一圈白水花 + 一团水汽。落水和落地要分开 ——
  // 水里炸出一团火、还抠个土坑就太出戏了
  splash(pos, scale = 1) {
    const flash = this._take('flash', this.geoSphere, true);
    this._spawn({
      mesh: flash, poolKey: 'flash',
      pos: new THREE.Vector3(pos.x, pos.y + 0.5, pos.z),
      color: 0xdff2ff, dur: 0.35,
      scale0: 0.6 * scale, scale1: 4.6 * scale, opacity: 0.85,
    });
    for (let i = 0; i < 4; i++) {
      const puff = this._take('smoke', this.geoSphere, false);
      this._spawn({
        mesh: puff, poolKey: 'smoke',
        pos: new THREE.Vector3(pos.x + rand(-1.6, 1.6), pos.y + 0.3, pos.z + rand(-1.6, 1.6)),
        color: 0xd6ebf5, dur: rand(0.5, 0.95),
        scale0: 0.5 * scale, scale1: rand(2.4, 3.8) * scale, opacity: 0.5,
        vel: new THREE.Vector3(rand(-2.2, 2.2), rand(2.4, 4.4), rand(-2.2, 2.2)), grav: -3.4,
      });
    }
  }

  // 侦察兵倒下：一小团尘土。单独做是为了不触发上面的爆炸震伤，否则会自己炸死自己
  scoutDown(pos) {
    const dust = this._take('smoke', this.geoSphere, false);
    this._spawn({
      mesh: dust, poolKey: 'smoke',
      pos: new THREE.Vector3(pos.x, pos.y + 0.7, pos.z),
      color: 0x8d8577, dur: 0.55,
      scale0: 0.45, scale1: 2.0, opacity: 0.42,
      vel: new THREE.Vector3(rand(-0.6, 0.6), 1.1, rand(-0.6, 0.6)), grav: 1.6,
    });
  }

  crater(pos) {
    let mesh = this.craters[this.craterIndex];
    if (!mesh) {
      mesh = this._take('crater', this.geoCrater, false);
      mesh.material.opacity = 1;
      this.craters[this.craterIndex] = mesh;
    }
    this.craterIndex = (this.craterIndex + 1) % CONFIG.effects.maxCraters;
    const s = rand(1.4, 2.6);
    const y = this.terrain.heightAt(pos.x, pos.z) + 0.12;
    mesh.position.set(pos.x, y, pos.z);
    mesh.rotation.set(0, rand(0, Math.PI * 2), 0);
    mesh.scale.set(s, s, s);
    mesh.material.color.setHex(0x3a2f26);
    mesh.material.opacity = 0.62;
    mesh.visible = true;
  }

  explosion(pos, scale = 1) {
    const fire = this._take('flash', this.geoSphere, true);
    this._spawn({
      mesh: fire, poolKey: 'flash', pos, color: 0xffa53c, dur: 0.55,
      scale0: 1.4 * scale, scale1: 9.5 * scale, opacity: 1, fadePow: 1.3,
    });
    const core = this._take('flash', this.geoSphere, true);
    this._spawn({
      mesh: core, poolKey: 'flash', pos, color: 0xfff2b0, dur: 0.3,
      scale0: 1.0 * scale, scale1: 5.0 * scale, opacity: 1,
    });
    const ring = this._take('ring', this.geoRing, true);
    const groundY = this.terrain.heightAt(pos.x, pos.z) + 0.3;
    this._spawn({
      mesh: ring, poolKey: 'ring', pos: new THREE.Vector3(pos.x, groundY, pos.z),
      color: 0xffd9a0, dur: 0.7, scale0: 1.5 * scale, scale1: 17 * scale, opacity: 0.85,
    });
    for (let i = 0; i < 6; i++) {
      const smoke = this._take('smoke', this.geoSphere, false);
      this._spawn({
        mesh: smoke, poolKey: 'smoke',
        pos: new THREE.Vector3(pos.x + rand(-2, 2), pos.y + rand(-0.5, 2.5), pos.z + rand(-2, 2)),
        color: 0x4a453f, dur: rand(1.1, 1.9),
        scale0: 1.6 * scale, scale1: rand(7, 12) * scale, opacity: 0.55,
        vel: new THREE.Vector3(rand(-2, 2), rand(1.5, 4), rand(-2, 2)), grav: 0.4,
      });
    }
    for (let i = 0; i < 5; i++) {
      const debris = this._take('spark', this.geoSphere, true);
      this._spawn({
        mesh: debris, poolKey: 'spark',
        pos: pos.clone(), color: 0xffc46a, dur: rand(0.5, 1.0),
        scale0: 0.35, scale1: 0.05, opacity: 1,
        vel: new THREE.Vector3(rand(-14, 14), rand(6, 18), rand(-14, 14)), grav: -22,
      });
    }
    this.crater(pos);
    this._flashLight(pos, 24 * scale, 90);

    // 大爆炸也会把附近的侦察兵震倒（坦克爆、飞机砸地都用这个）
    if (this.onBlast) this.onBlast(pos, CONFIG.scout.blastRadius * scale);
    if (this.onExplosion) this.onExplosion(pos, scale);
  }

  // 残骸冒烟
  wreckSmoke(pos) {
    const smoke = this._take('smoke', this.geoSphere, false);
    this._spawn({
      mesh: smoke, poolKey: 'smoke',
      pos: new THREE.Vector3(pos.x + rand(-0.8, 0.8), pos.y + 2.6, pos.z + rand(-0.8, 0.8)),
      color: 0x37342f, dur: rand(1.6, 2.6),
      scale0: 1.0, scale1: 4.5, opacity: 0.42,
      vel: new THREE.Vector3(rand(-0.5, 0.5), 3.2, rand(-0.5, 0.5)), grav: 0.3,
    });
  }
}
