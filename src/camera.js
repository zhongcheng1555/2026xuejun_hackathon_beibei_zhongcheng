// 第三人称相机吊臂 + 准星射线
// 单独抽成模块是为了能脱离浏览器跑测试（这是"鼠标不动开一炮会飞哪"的关键路径）

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, dampAngle, wrapAngle } from './utils.js';

const _ray = new THREE.Vector3();
const _probe = new THREE.Vector3();

/**
 * 镜头跟随的第一段：跟着车头转，但带阻尼。
 * 阻尼让原地掉头时画面是"荡"过去的，而不是被硬拽。
 */
export function followHull(followYaw, playerYaw, dt) {
  return dampAngle(followYaw, playerYaw, CONFIG.camera.followLambda, dt);
}

/**
 * 镜头跟随的第二段：鼠标偏移，即时生效（不经过阻尼，所以瞄准不拖）。
 * 结果写进 out {yaw, pitch}
 */
export function mouseLook(lookYaw, lookPitch, dx, dy, out) {
  out.yaw = wrapAngle(lookYaw - dx * CONFIG.camera.sensitivity);
  out.pitch = clamp(
    lookPitch - dy * CONFIG.camera.sensitivity,
    CONFIG.camera.pitchMin,
    CONFIG.camera.pitchMax
  );
  return out;
}

// 射线与球求交，返回最近的正向距离
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ex = cx - ox;
  const ey = cy - oy;
  const ez = cz - oz;
  const t = ex * dx + ey * dy + ez * dz;
  if (t < 0) return -1;
  const d2 = ex * ex + ey * ey + ez * ez - t * t;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const th = Math.sqrt(r2 - d2);
  const t0 = t - th;
  return t0 > 0 ? t0 : t + th;
}

/**
 * 算出相机该待在哪、该朝哪看。
 * camYaw / camPitch：视线方向（世界坐标）；focusPos：坦克/飞机位置
 * cfg：镜头参数（默认坦克那套，开飞机时传 CONFIG.camera.plane）
 * 返回 outPos（相机位置）和 outDir（视线单位向量）
 */
export function rigPosition(camYaw, camPitch, focusPos, terrain, outPos, outDir, cfg = CONFIG.camera) {
  const cp = Math.cos(camPitch);
  const dirX = Math.sin(camYaw) * cp;
  const dirY = Math.sin(camPitch);
  const dirZ = Math.cos(camYaw) * cp;

  const fx = focusPos.x;
  const fy = focusPos.y + cfg.focusHeight;
  const fz = focusPos.z;

  outPos.set(
    fx - dirX * cfg.distance,
    fy - dirY * cfg.distance + cfg.heightBonus,
    fz - dirZ * cfg.distance
  );

  // 别让相机钻到地里
  const minY = terrain.heightAt(outPos.x, outPos.z) + 2.6;
  if (outPos.y < minY) outPos.y = minY;

  // 别让相机钻进墙里 / 楼里 / 树篱里。
  // 迷宫那张图通道只有 20 米宽、树篱 9.5 米高，镜头挂在车后 21 米，
  // 只要一转视角就会卡进树篱内部 —— 屏幕上就是一片绿，看着像"自己跑到墙里去了"。
  // 做法：从焦点往相机位置探一遍，撞到大障碍就把相机沿这条线拉近。
  if (terrain.blockFraction) {
    const k = terrain.blockFraction({ x: fx, y: fy, z: fz }, outPos);
    if (k < 1) {
      const kk = Math.max(0.22, k);   // 别贴到车脸上
      // 只把相机水平地拉近，高度保持住。
      // 要是连高度一起按比例收缩，镜头就会被拽低到树篱/楼的高度范围里，
      // 反而从"在外面"变成"在里面"（这个坑我踩过一次）。
      outPos.set(
        fx + (outPos.x - fx) * kk,
        fy + (outPos.y - fy) * kk + cfg.heightBonus * (1 - kk),
        fz + (outPos.z - fz) * kk
      );
      // 极端情况（紧贴着大楼）拉近了还是在墙里：干脆退成车顶俯视。
      // 车所在的位置一定是空的（出生/行驶都被碰撞约束过），正上方必然也空。
      const c = terrain.hitCollider ? terrain.hitCollider(outPos.x, outPos.y, outPos.z) : null;
      if (c && c.kind === 'building') outPos.set(fx, fy + 13, fz);
    }
  }

  // 隧道里：镜头必须压在岩顶下面。不压的话抬头那一档镜头会穿到岩顶上方，
  // 屏幕上就只剩一片石头（山谷的隧道才有这种情况）。
  //
  // 但**只有"被看的对象本身也在隧道里（在岩顶下沿以下）"时才压**。
  // 这条判据之前漏了，结果飞机镜头也走同一个函数：飞机在 50m 高、
  // 镜头拖在它后面，只要镜头位置正好落在某段隧道上方，就会被从 50m
  // 一把压到 21m（岩顶下沿）—— 画面突然贴到地面，看着像"变成坦克了"，
  // 飞过隧道口又弹回去。山谷的隧道盖住约 17% 地面，所以会时不时抽一下，
  // 而且飞得越高掉得越狠
  if (terrain.roofBottomAt) {
    const rb = terrain.roofBottomAt(outPos.x, outPos.z);
    if (rb !== null && focusPos.y < rb && outPos.y > rb - 0.6) outPos.y = rb - 0.6;
  }

  // 相机永远看向前方的一点，这样准星方向就是玩家的视线方向
  const tx = fx + dirX * cfg.lookAhead;
  const ty = fy + dirY * cfg.lookAhead;
  const tz = fz + dirZ * cfg.lookAhead;
  outDir.set(tx - outPos.x, ty - outPos.y, tz - outPos.z).normalize();
  return outPos;
}

/**
 * 从相机往屏幕正中打一条射线，得到准星真正指着的世界坐标。
 * 会先看有没有打中坦克/飞机，再和地面比远近。
 *
 * 关键：必须排除玩家自己的坦克。相机在车后 20 米，射线第一个就会碰到自己，
 * 那样准星会被"锁"在自己车上，炮塔会朝后上方抬——炮弹飞天上去。
 */
export function aimPointFromCamera(cameraPos, cameraQuat, tanks, planes, terrain, out, skipTank = null) {
  _ray.set(0, 0, -1).applyQuaternion(cameraQuat).normalize();

  // 至少要越过自己车身这么远，才算"前方"的目标
  const minDist = skipTank ? cameraPos.distanceTo(skipTank.pos) * 0.98 : 0;
  let best = 620;

  for (const t of tanks) {
    if (!t.alive || t === skipTank) continue;
    const hit = raySphere(
      cameraPos.x, cameraPos.y, cameraPos.z, _ray.x, _ray.y, _ray.z,
      t.pos.x, t.pos.y + 1.8, t.pos.z, t.radius
    );
    if (hit > minDist && hit < best) best = hit;
  }
  for (const p of planes) {
    if (!p.alive || p === skipTank) continue;
    const hit = raySphere(
      cameraPos.x, cameraPos.y, cameraPos.z, _ray.x, _ray.y, _ray.z,
      p.pos.x, p.pos.y, p.pos.z, p.radius
    );
    if (hit > minDist && hit < best) best = hit;
  }

  // 地面：先 3 米一步粗扫，再回头 0.25 米一步细扫，避免准星落点偏差好几米
  let dist = best;
  let coarse = -1;
  for (let d = 4; d < best; d += 3) {
    _probe.copy(cameraPos).addScaledVector(_ray, d);
    if (_probe.y <= terrain.heightAt(_probe.x, _probe.z)) {
      coarse = d;
      break;
    }
  }
  if (coarse >= 0) {
    dist = coarse;
    for (let d = Math.max(4, coarse - 3); d <= coarse; d += 0.25) {
      _probe.copy(cameraPos).addScaledVector(_ray, d);
      if (_probe.y <= terrain.heightAt(_probe.x, _probe.z)) {
        dist = d;
        break;
      }
    }
  }
  return out.copy(cameraPos).addScaledVector(_ray, dist);
}
