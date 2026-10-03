// 雪地履带印
//
// 坦克开过去在地上留下两道压痕，过一会儿被雪盖回去（颜色淡回雪色）。
// 玩法上的用处：没有小地图，但你能靠地上的痕迹反推"刚才有谁往哪边去了"。
//
// 实现：一块 InstancedMesh + 环形缓冲。压多少条都只有 1 个 draw call，
// 超出上限就从最旧的一条开始覆盖，所以永远不增长、不吃内存。

import * as THREE from 'three';
import { CONFIG } from './config.js';

export class TreadMarks {
  constructor(scene) {
    this.enabled = false;
    this.snow = new THREE.Color(0xffffff);
    this.mark = new THREE.Color(CONFIG.tracks.color);
    this.colors = new Float32Array(CONFIG.tracks.max * 2 * 3);
    this.head = 0;       // 环形缓冲写到哪里了
    this.filled = 0;     // 已经写了多少条（用来控制 mesh.count）
    this.slot = 0;       // 当前正在写的那一条的时间戳（按 2 条履带一组）

    const geo = new THREE.PlaneGeometry(CONFIG.tracks.width, CONFIG.tracks.length);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, CONFIG.tracks.max * 2);
    this.mesh.name = 'treads';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    // 每条印子的出生时间，用来算淡出
    this.birth = new Float32Array(CONFIG.tracks.max * 2);
    this.kStore = new Float32Array(CONFIG.tracks.max * 2).fill(-1);  // 上一帧的"新旧程度"，用来跳过没变化的
    this._t = 0;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._pos = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
  }

  // 每局开始：换了地形就重来，并按当地地面颜色决定"淡出到哪个色"
  reset(terrain) {
    this.enabled = !!terrain.biome.tracks;
    this.terrain = terrain;
    this.head = 0;
    this.filled = 0;
    this.mesh.count = 0;
    this.snow.setHex(terrain.biome.ground.base);
    this._t = 0;
  }

  // 坦克开过：踩一脚。pos 是车体位置，yaw 是车头朝向
  add(pos, yaw) {
    if (!this.enabled) return;
    const cfg = CONFIG.tracks;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const y = this.terrain.heightAt(pos.x, pos.z) + 0.13;

    for (let side = -1; side <= 1; side += 2) {
      this._pos.set(pos.x + rx * cfg.spread * side, y, pos.z + rz * cfg.spread * side);
      this._q.setFromAxisAngle(this._up, yaw);
      this._m4.compose(this._pos, this._q, this._one);
      this.mesh.setMatrixAt(this.head, this._m4);
      this.birth[this.head] = this._t;
      this._writeColor(this.head, 1);
      this.kStore[this.head] = 1;
      this.head = (this.head + 1) % (cfg.max * 2);
      this.filled = Math.min(this.filled + 1, cfg.max * 2);
    }
    this.mesh.count = this.filled;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // k = 1 全新（最深的印），k = 0 已经被雪盖回去（和雪同色，看不出来）
  _writeColor(i, k) {
    this._c.copy(this.mark).lerp(this.snow, 1 - k);
    this.colors[i * 3] = this._c.r;
    this.colors[i * 3 + 1] = this._c.g;
    this.colors[i * 3 + 2] = this._c.b;
    if (!this.mesh.instanceColor) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
  }

  update(dt) {
    if (!this.enabled || !this.mesh.count) return;
    this._t += dt;
    const life = CONFIG.tracks.life;
    let dirty = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const k = Math.max(0, 1 - (this._t - this.birth[i]) / life);
      // 已经淡到位的就别再算了（每帧只更新还在变的那些）
      if (Math.abs(k - this.kStore[i]) < 0.008) continue;
      this.kStore[i] = k;
      this._writeColor(i, k);
      dirty = true;
    }
    if (dirty) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}
