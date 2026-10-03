// 瞄准模式的虚线弹道预览：用真实物理预演一遍炮弹轨迹

import * as THREE from 'three';
import { CONFIG } from './config.js';

const MAX_POINTS = 170;
const STEP = 0.012;   // 出速 150m/s，步长必须够小，否则预测落点会差好几米

const _muzzle = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _center = new THREE.Vector3();

export class AimLine {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;

    this.positions = new Float32Array(MAX_POINTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.LineDashedMaterial({
      color: 0xffd479,
      dashSize: 3.2,
      gapSize: 2.4,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.line = new THREE.Line(geo, this.material);
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);

    // 预计落点的小圆圈
    const ringGeo = new THREE.RingGeometry(1.6, 2.3, 22);
    ringGeo.rotateX(-Math.PI / 2);
    this.markerMat = new THREE.MeshBasicMaterial({
      color: 0xffd479,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.marker = new THREE.Mesh(ringGeo, this.markerMat);
    this.marker.visible = false;
    scene.add(this.marker);
  }

  hide() {
    this.line.visible = false;
    this.marker.visible = false;
  }

  update(tank, tanks, show) {
    if (!tank || !tank.alive || !show) {
      this.hide();
      return;
    }

    tank.getMuzzlePos(_muzzle);
    tank.getBarrelDir(_dir);
    _vel.copy(_dir).multiplyScalar(CONFIG.bullet.speed);
    _pos.copy(_muzzle);

    let n = 0;
    let hit = null;
    for (let i = 0; i < MAX_POINTS; i++) {
      _vel.y -= CONFIG.bullet.gravity * STEP;
      _pos.addScaledVector(_vel, STEP);

      this.positions[n * 3] = _pos.x;
      this.positions[n * 3 + 1] = _pos.y;
      this.positions[n * 3 + 2] = _pos.z;
      n++;

      // 打中别人就停
      let hitTank = null;
      for (const t of tanks) {
        if (t === tank || !t.alive) continue;
        _center.set(t.pos.x, t.pos.y + 1.8, t.pos.z);
        if (_pos.distanceTo(_center) < t.radius) {
          hitTank = t;
          break;
        }
      }
      if (hitTank) {
        hit = _pos.clone();
        break;
      }
      if (_pos.y <= this.terrain.heightAt(_pos.x, _pos.z)) {
        hit = _pos.clone();
        break;
      }
    }

    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.line.computeLineDistances();
    this.line.visible = true;

    if (hit) {
      this.marker.position.set(hit.x, this.terrain.heightAt(hit.x, hit.z) + 0.25, hit.z);
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
  }
}
