// BOSS 坦克：一局里低概率出现（敌我两边都可能刷），纯空战 / 纯海战不出。
//
// 还是一辆坦克，只是"哪儿都强一档"：
//   更大、装甲更厚、炮更大（单发 26）、比普通坦克轻微快一点、
//   移动模式瞄准误差很小、进瞄准模式**零误差**（等于自动瞄准）、炮弹带一点点跟踪。
//
// 直接继承 Tank：开炮、装填、受伤、被砸、AI 驾驶、结算这一整套原样复用，
// 只覆盖 ① 数值 ② 模型（大一圈 + 几块装甲）③ 炮口更靠前（炮管更长）

import * as THREE from 'three';
import { CONFIG, COLORS, TEAM } from './config.js';
import { Tank } from './tank.js';
import { rand } from './utils.js';

export class Boss extends Tank {
  constructor(world, opts = {}) {
    super(world, opts);
    this.isBoss = true;
    this.name = opts.name || `BOSS${this.id}`;

    this.maxHealth = CONFIG.boss.health;
    this.health = this.maxHealth;
    this.radius = CONFIG.boss.radius;
    this.speed = CONFIG.boss.speed;
    this.turnSpeed = CONFIG.boss.turnSpeed;
    this.magazine = CONFIG.boss.magazine;
    this.rounds = this.magazine;
    this.loadTime = rand(CONFIG.boss.loadPerShell[0], CONFIG.boss.loadPerShell[1]);
    this.shellDamage = CONFIG.boss.shellDamage;
    this.shellSpeed = CONFIG.boss.shellSpeed;
    this.shellHoming = CONFIG.boss.homing;
    // 移动模式误差压到三成；瞄准模式零误差（"自动瞄准"就是这个）
    this.aimErrorMul = CONFIG.boss.aimErrorMove;
    this.aimErrorMulPrecise = 0;
  }

  // ---------- 模型：一辆大一圈的重装坦克 ----------

  _buildModel() {
    const isEnemy = this.team === TEAM.ENEMY;
    const bodyColor = this.isPlayer ? COLORS.player : isEnemy ? COLORS.enemy : COLORS.ally;
    const turretColor = this.isPlayer ? COLORS.playerTurret : isEnemy ? COLORS.enemyTurret : COLORS.allyTurret;

    this.bodyMaterials = [];
    const mkMat = (color, metal = 0.3, rough = 0.6, emissive = 0x000000) => {
      const m = new THREE.MeshStandardMaterial({
        color, metalness: metal, roughness: rough,
        emissive, emissiveIntensity: emissive ? 0.9 : 0,
      });
      this.bodyMaterials.push(m);
      return m;
    };

    const trackMat = mkMat(COLORS.track, 0.45, 0.42);
    // 履带：比普通坦克更宽更厚
    const trackGeo = new THREE.BoxGeometry(1.75, 2.0, 10.0);
    for (const sx of [-2.5, 2.5]) {
      const track = new THREE.Mesh(trackGeo, trackMat);
      track.position.set(sx, 1.0, 0);
      track.castShadow = true;
      this.object.add(track);
    }

    // 车体：又高又厚
    const hull = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.3, 8.8), mkMat(bodyColor, 0.3, 0.6));
    hull.position.y = 2.05;
    hull.castShadow = true;
    this.object.add(hull);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.8, 6.4), mkMat(bodyColor, 0.34, 0.52));
    deck.position.set(0, 3.35, -0.3);
    deck.castShadow = true;
    this.object.add(deck);

    // 前装甲（推土铲样的大块，正面一眼认得出）
    const plow = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.6, 1.3), mkMat(bodyColor, 0.42, 0.44));
    plow.position.set(0, 2.1, 4.7);
    plow.castShadow = true;
    this.object.add(plow);

    // 两侧附加裙甲
    for (const sx of [-3.15, 3.15]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 7.4), mkMat(COLORS.wreck, 0.5, 0.5));
      skirt.position.set(sx, 2.4, 0);
      skirt.castShadow = true;
      this.object.add(skirt);
    }
    // 车头一左一右两根撞角
    for (const sx of [-1.5, 1.5]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.0, 6), mkMat(0x2b2b30, 0.6, 0.35));
      horn.rotation.x = Math.PI / 2;
      horn.position.set(sx, 3.0, 5.6);
      horn.castShadow = true;
      this.object.add(horn);
    }
    // 一条会发光的缝：夜战里也能一眼认出这是什么
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(4.9, 0.16, 0.16),
      mkMat(0xffffff, 0, 1, isEnemy ? 0xff4a3d : 0x6fe3ff)
    );
    glow.position.set(0, 3.8, 2.9);
    this.object.add(glow);

    // 炮塔（更大）+ 更长的炮管
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.y = 3.9;
    this.object.add(this.turretGroup);

    const turret = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.4, 1.7, 10), mkMat(turretColor, 0.42, 0.44));
    turret.position.y = 0.85;
    turret.castShadow = true;
    this.turretGroup.add(turret);
    // 车长塔
    const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 0.8, 8), mkMat(turretColor, 0.45, 0.42));
    cupola.position.set(0, 2.0, -0.7);
    cupola.castShadow = true;
    this.turretGroup.add(cupola);

    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.y = 1.0;
    this.turretGroup.add(this.barrelPivot);

    const barrelLen = 7.2;
    const barrelGeo = new THREE.CylinderGeometry(0.34, 0.42, barrelLen, 10);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, barrelLen / 2 + 0.9);
    this.barrel = new THREE.Mesh(barrelGeo, mkMat(COLORS.barrel, 0.6, 0.22));
    this.barrel.position.z = 0.9;
    this.barrel.castShadow = true;
    this.barrelPivot.add(this.barrel);

    this.barrelMaxDist = barrelLen + 1.8;   // 9.0：比普通坦克（7.4）伸得更远
    this.barrelDist = this.barrelMaxDist;
    this.barrelBaseY = 4.9;                 // 炮塔枢轴离地多高（炮管避障用）

    this.muzzleDummy = new THREE.Object3D();
    this.muzzleDummy.position.set(0, 0, this.barrelMaxDist);
    this.barrelPivot.add(this.muzzleDummy);

    this.wreckMat = new THREE.MeshStandardMaterial({ color: COLORS.wreck, metalness: 0.35, roughness: 0.9 });
  }
}
