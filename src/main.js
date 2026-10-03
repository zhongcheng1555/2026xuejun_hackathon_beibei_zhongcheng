// 入口：场景装配、战斗流程、玩家操控与镜头

import * as THREE from 'three';
import { CONFIG, TEAM, BIOMES, LAVA } from './config.js';
import { clamp, makeNoise, rand, randInt, dampAngle, wrapAngle } from './utils.js';
import { rigPosition, aimPointFromCamera, followHull, mouseLook } from './camera.js';
import { Terrain } from './terrain.js';
import { Effects } from './effects.js';
import { BulletManager } from './bullet.js';
import { PlaneManager } from './plane.js';
import { ScoutManager } from './scout.js';
import { Tank } from './tank.js';
import { TankAI } from './ai.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { AimLine } from './aimline.js';
import { TreadMarks } from './tracks.js';
import { GameAudio, MenuMusic } from './audio.js';

const _point = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _look = { yaw: 0, pitch: 0 };
const _godCenter = new THREE.Vector3();
const _sunOffset = new THREE.Vector3(90, 150, 60);

// 现画一张很小的天空渐变图（equirect）当作环境反射源：上蓝下亮，和天空球同色。
// 不引任何外部图片；横竖都只有几十像素，代价可以忽略。
// （横向是均匀的，所以左右接缝天然对得上）
// 导出只是为了能在无头测试里单独跑一遍（它每局开局都会执行，出错就是黑屏）
export function makeSkyEnvTexture(topHex, bottomHex, k) {
  const cv = document.createElement('canvas');
  cv.width = 8;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  const top = new THREE.Color(topHex).multiplyScalar(k);
  const bottom = new THREE.Color(bottomHex).multiplyScalar(k);
  const g = ctx.createLinearGradient(0, 0, 0, cv.height);
  g.addColorStop(0, `#${top.getHexString()}`);
  g.addColorStop(0.55, `#${top.clone().lerp(bottom, 0.5).getHexString()}`);
  g.addColorStop(1, `#${bottom.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cv.width, cv.height);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xc2d2e0, 180, 680);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      window.innerWidth / window.innerHeight,
      0.5,
      1500
    );
    this.camera.position.set(0, 40, -60);

    this.tanks = [];
    this.ais = [];
    this.wrecks = [];
    this.player = null;
    // 雪地履带印（只有开了 tracks 的地形才看得见）
    this.treads = new TreadMarks(this.scene);
    this.night = false;   // 这局是不是夜战
    // 玩家开什么：'tank'（默认）或 'plane'（飞机难得多）
    this.playerSide = 'tank';
    this.playerPlane = null;
    // 纯空战：极低概率抽到的特殊玩法。地面清空、天上 2 对 2，每架飞机 3 次复活。
    // 两边还可能各配一辆"20 秒一炮"的坦克（你开坦克被抽中时，我方那辆就是你）
    this.pureAir = false;
    this.pureAirAllyTank = false;
    this.pureAirEnemyTank = false;
    this.pureGround = false;
    this.edgeWarnTimer = 0;
    this._envCache = new Map();   // 天空环境贴图：按"上/下两段颜色"缓存，不用每局重画
    this.volcanoFx = 0;           // 火山喷发时，火线上炸火的节流计时
    this.repairTick = 0;   // 修复滴答声的间隔计时
    // 观战用的上帝视角
    this.godYaw = 0;
    this.godPitch = 1.02;
    this._godPos = null;
    // 阵亡后的"看自己死"镜头
    this.deathCamTimer = 0;
    this.deathCamYaw = 0;
    this.state = 'menu';
    // AI 之间的"无线电通报"：最近一次交火的位置，用于把双方拉向同一片区域
    this.lastContact = { ally: null, enemy: null };

    this.camYaw = 0;
    this.camPitch = CONFIG.camera.defaultPitch;
    this.lookYaw = 0;      // 相对车头的视角偏移（鼠标控制）
    this.lookPitch = CONFIG.camera.defaultPitch;
    this.followYaw = 0;    // 跟随车头的那一段（带阻尼）
    this.hudTimer = 0;
    this.wreckTimer = 0;
    this.lastScoutMsg = 0;
    this.elapsed = 0;

    this._setupSky();
    this._setupLights();

    // 先随机抽一种地形给菜单当背景，点开始时会再抽一次
    this.terrain = null;
    this.effects = null;
    this.currentBiome = BIOMES[randInt(0, BIOMES.length - 1)];
    this._buildTerrain(this.currentBiome);
    this.effects = new Effects(this.scene, this.terrain);
    this.bullets = new BulletManager(this);
    this.planes = new PlaneManager(this, CONFIG.plane.count);
    this.scouts = new ScoutManager(this, CONFIG.scout.count);
    // 爆炸震伤侦察兵：Effects 只负责喊一声，谁被震到由 ScoutManager 判断
    this.effects.onBlast = (pos, radius) => this.scouts.blast(pos, radius);
    // 音效同样挂在 Effects 的钩子上（Effects 不认识音频，只负责报告"哪里出了什么事"）
    this.audio = new GameAudio();
    this.effects.onMuzzle = (pos) => this.audio.cannon(pos);
    this.effects.onImpact = (pos, onGround) => this.audio.impactSound(pos, onGround);
    this.effects.onExplosion = (pos, scale) => this.audio.explosion(pos, scale);
    // 两首曲子，各管一处：
    //   menu-theme   → 主菜单的开场曲
    //   result-theme → 结算画面（胜或败都用它）
    // 每首都按 flac → mp3 → ogg → wav 顺序试，第一个能加载的就用；
    // 一个都没有就安静进游戏，不报错。
    const themes = (name) => [`./${name}.flac`, `./${name}.mp3`, `./${name}.ogg`, `./${name}.wav`];
    this.music = new MenuMusic(themes('menu-theme'));
    this.resultMusic = new MenuMusic(themes('result-theme'));
    this.aimLine = new AimLine(this.scene, this.terrain);

    this.input = new Input(this.canvas);
    this.hud = new HUD();
    this.hud.onStart((side) => this.start(side));
    this.hud.onRestart((side) => this.start(side));

    // M 键静音（音效是现场合成的，不占界面，所以开关藏在按键里）
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      const muted = this.audio.toggleMute();
      this.music.setMuted(muted);
      this.resultMusic.setMuted(muted);
      this.hud.feed(muted ? '已静音（按 M 恢复）' : '音效已开启', 'friendly');
    });
    this.hud.onToggleMode(() => this.toggleMode());

    // 先试着直接自动播放：站点被允许出声时，音乐一进来就响（进场页照常显示）。
    // 被拦下来也没关系 —— 点「进军！」那一下就是浏览器要的那次用户操作。
    this.music.play();

    // 进场页只认「进军！」这一下点击：点别处、按键盘都不放行。
    // （原来挂的是"第一次任意操作"，于是点哪都能进去、按个键也能进去，体验不对）
    this.hud.onEnter(() => {
      this.music.play();
      this.hud.hideEnterGate();
    });

    this.clock = new THREE.Clock();
    window.addEventListener('resize', () => this._onResize());
    this.hud.showMenu();

    this.animate();
  }

  // ---------- 场景 ----------

  _setupSky() {
    const geo = new THREE.SphereGeometry(900, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x2c6ba8) },
        bottomColor: { value: new THREE.Color(0xd6e2ec) },
        offset: { value: 80 },
        exponent: { value: 0.75 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), exponent)), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _setupLights() {
    this.hemi = new THREE.HemisphereLight(0xdfeaf5, 0x4a5638, 0.75);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.55);
    const sun = this.sun;
    sun.position.copy(_sunOffset);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 420;
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.ambient = new THREE.AmbientLight(0x6a7a8a, 0.35);
    this.scene.add(this.ambient);
  }

  // 按地形类型重建整张地图（每局都会换）
  _buildTerrain(biome) {
    if (this.terrain) this.terrain.dispose();
    this.terrain = new Terrain(this.scene, makeNoise(Math.floor(rand(1, 99999))), biome);
    if (this.effects) this.effects.terrain = this.terrain;
    this._applyBiomeLook(biome);
  }

  _applyBiomeLook(biome) {
    const b = biome;
    this.scene.fog.color.setHex(b.fog.color);
    this.scene.fog.near = b.fog.near;
    this.scene.fog.far = b.fog.far;

    const u = this.sky.material.uniforms;
    u.topColor.value.setHex(b.sky.top);
    u.bottomColor.value.setHex(b.sky.bottom);

    this.sun.color.setHex(b.light.sun);
    this.sun.intensity = b.light.sunIntensity;
    this.hemi.intensity = b.light.hemi;
    this.ambient.intensity = b.light.ambient;

    if (this.night) this._applyNightLook(b);
    // 放最后：环境反射要跟着"最终那套天空颜色"走（夜里就是月夜的颜色）
    this._applySkyEnv();
  }

  // 环境反射：拿当前天空的两段颜色现画一张很小的渐变图（equirect），挂到场景上，
  // 金属件才有东西可反射。强度在 CONFIG.render.envLight，调到 0 就整个关掉。
  // 开着的时候把 ambient 灯压掉一部分 —— 不然环境光叠上去，整体会明显变亮
  _applySkyEnv() {
    const k = CONFIG.render.envLight;
    if (!k || k <= 0) {
      this.scene.environment = null;
      return;
    }
    const u = this.sky.material.uniforms;
    const top = u.topColor.value.getHex();
    const bottom = u.bottomColor.value.getHex();
    const key = `${top}_${bottom}_${k}`;
    let tex = this._envCache.get(key);
    if (!tex) {
      tex = makeSkyEnvTexture(top, bottom, k);
      this._envCache.set(key, tex);
    }
    this.scene.environment = tex;
    this.ambient.intensity *= CONFIG.render.envAmbientComp;
  }

  // 夜战：整体压暗成月夜，雾也更近。
  // 这时候就靠枪口火光、曳光弹和爆炸短暂照亮周围 —— 那些点光源 effects 里本来就有
  _applyNightLook(b) {
    const n = CONFIG.night;
    this.scene.fog.color.setHex(n.fog);
    this.scene.fog.near = b.fog.near * n.fogScale[0];
    this.scene.fog.far = b.fog.far * n.fogScale[1];

    const u = this.sky.material.uniforms;
    u.topColor.value.setHex(n.skyTop);
    u.bottomColor.value.setHex(n.skyBottom);

    this.sun.color.setHex(n.sun);
    this.sun.intensity = b.light.sunIntensity * n.sunMul;
    this.hemi.intensity = b.light.hemi * n.hemiMul;
    this.ambient.intensity = b.light.ambient * n.ambientMul;
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ---------- 战斗流程 ----------

  start(side) {
    this.playerSide = side === 'plane' ? 'plane' : 'tank';
    this.audio.init();   // 浏览器要求音频由用户操作启动，点按钮正好是那次操作
    this.audio.setBattleActive(true);   // 战斗音效开闸
    this.music.stop();   // 开打了：开场曲停掉，把耳朵让给战场
    this.resultMusic.stop();
    this.hud.showGame();
    this.input.requestLock();
    this.startBattle();
  }

  startBattle() {
    for (const t of this.tanks) t.dispose();
    this.tanks = [];
    this.ais = [];
    this.wrecks = [];
    this._godPos = null;
    this.deathCamTimer = 0;
    this.elapsed = 0;
    this.lastContact = { ally: null, enemy: null };
    this.tankNameCounter = 0;   // 每局都从「坦克1」重新编号，不会越打越大

    // 每局重新抽一种地形：地貌、大小、能见度、掩体密度全换
    // 另外有 10% 概率赶上夜战（任何地形都可能入夜）
    this.night = Math.random() < CONFIG.night.chance;
    this.currentBiome = BIOMES[randInt(0, BIOMES.length - 1)];
    this._buildTerrain(this.currentBiome);
    this.treads.reset(this.terrain);

    // 特殊玩法抽签（右下角的测试开关勾上就无视概率直接必出，正式玩不勾）：
    //   开飞机 → 15% 纯空战
    //   开坦克 → 1% 纯空战（你就是"空战里那辆坦克"，地面只有你）
    //            10% 纯陆战（天上一个飞机都没有，地面照旧打）
    //            剩下才是常规局
    // 三个开关都勾时按"纯空战 > 纯陆战"来，不会同时成立
    const forceAir = !!(this.hud.forcePureAir || this.hud.forcePureTank);
    const forceGround = !!this.hud.forcePureGround;
    const forceTank = !!this.hud.forcePureTank;
    const tankIsPlayer = this.playerSide === 'tank';
    let pureGround = false;
    if (forceAir) {
      this.pureAir = true;
    } else if (forceGround && tankIsPlayer) {
      // 纯陆战是"你开坦克"的玩法，开飞机时勾了它也没意义（总不能天上一个飞机都没有
      // 还让你开飞机），所以这里只对开坦克生效
      this.pureAir = false;
      pureGround = true;
    } else if (tankIsPlayer) {
      const r = Math.random();
      this.pureAir = r < CONFIG.mode.pureAirChanceTank;
      pureGround = !this.pureAir && r < CONFIG.mode.pureAirChanceTank + CONFIG.mode.pureGroundChance;
    } else {
      this.pureAir = Math.random() < CONFIG.mode.pureAirChance;
    }
    this.pureGround = pureGround;
    // 地面那辆坦克：每局先抽一次"这局地面有没有坦克"。抽中的话再决定是
    // "两边都有"还是"只有随机某一方" —— 出坦克不等于两边都有。
    // （你开坦克被抽中时，我方那辆就是你；敌方再单独抽一次）
    let allyTank = tankIsPlayer;
    let enemyTank = false;
    if (this.pureAir) {
      if (tankIsPlayer) {
        enemyTank = forceTank || Math.random() < CONFIG.mode.pureAirTankChance;
      } else if (forceTank || Math.random() < CONFIG.mode.pureAirTankChance) {
        const both = Math.random() < CONFIG.mode.pureAirTankBothChance;
        allyTank = both || Math.random() < 0.5;
        enemyTank = both || !allyTank;
      }
    }
    this.pureAirAllyTank = this.pureAir && allyTank;
    this.pureAirEnemyTank = this.pureAir && enemyTank;

    if (this.pureAir) {
      this.planes.configure(CONFIG.mode.pureAirPerSide, CONFIG.mode.pureAirPerSide, true);
    } else if (this.pureGround) {
      this.planes.configure(0, 0, false);         // 纯陆战：两边空军都不上场
    } else {
      this.planes.configure(null, null, false);   // 常规局：飞机全上，打一架少一架
    }
    this.planes.reset();
    // 纯空战和纯陆战都不派侦察兵 —— 主打一个"盲战"：
    // 没有侦察兵替你摸底，敌人在哪得自己找（常规局照常派）
    this.scouts.setCount(this.pureAir || this.pureGround ? 0 : CONFIG.scout.count);
    this.scouts.reset();
    this.aimLine.terrain = this.terrain;

    this.stats = {
      kills: 0,
      friendlyKills: 0,
      planesDown: 0,
      allyLost: 0,
      enemyLost: 0,
      playerDeaths: 0,
    };

    // 兜底：万一没有可开的本方飞机，就退回坦克
    if (this.playerSide === 'plane' && !this.planes.list.some((p) => !p.retired && p.alive && p.team === TEAM.ALLY)) {
      this.playerSide = 'tank';
      this.pureAir = false;
      this.pureAirAllyTank = false;
      this.pureAirEnemyTank = false;
      this.pureGround = false;
    }
    this.hud.setSide(this.playerSide);
    this.hud.applySide(this.playerSide);

    // 规模：纯空战里地面最多就是那两辆（一边一辆，你开坦克的话我方那辆是你）；
    // 常规局照旧 —— 玩家开坦克时占一辆，开飞机时地面全是 AI
    if (this.pureAir) {
      this.allyTotal = this.pureAirAllyTank ? 1 : 0;
      this.enemyTotal = this.pureAirEnemyTank ? 1 : 0;
    } else {
      const aiAlly = randInt(CONFIG.battle.allyMin, CONFIG.battle.allyMax);
      this.allyTotal = this.playerSide === 'tank' ? aiAlly + 1 : aiAlly;
      this.enemyTotal = clamp(
        this.allyTotal + randInt(-CONFIG.battle.teamDiff, CONFIG.battle.teamDiff),
        4,
        40
      );
    }

    this.player = null;
    this.playerPlane = null;
    this.edgeWarnTimer = 0;
    if (this.pureAir && this.playerSide === 'tank') {
      // 你就是"空战里那辆坦克"：地面只有你一辆，天上两边各 2 架 AI 飞机在打。
      // 你比天上的飞机硬得多（能修车），代价是那 20 秒一炮
      const playerSpawn = this._findSpawn(TEAM.ALLY, 30);
      this.player = this._spawnTank(TEAM.ALLY, playerSpawn, 0, true);
      this._slowFireTank(this.player);
      this.lookYaw = 0;
      this.lookPitch = CONFIG.camera.defaultPitch;
      this.followYaw = this.player.yaw;
      this.camYaw = this.followYaw;
      this.camPitch = this.lookPitch;
    } else if (this.pureAir) {
      // 玩家接手一架我方飞机，两边按"车道"对着摆好
      this.playerPlane = this.planes.takeForPlayer(TEAM.ALLY);
      this.player = this.playerPlane;
      this._startAirDuel();
    } else if (this.playerSide === 'tank') {
      const playerSpawn = this._findSpawn(TEAM.ALLY, 30);
      this.player = this._spawnTank(TEAM.ALLY, playerSpawn, 0, true);
      this.lookYaw = 0;
      this.lookPitch = CONFIG.camera.defaultPitch;
      this.followYaw = this.player.yaw;
      this.camYaw = this.followYaw;
      this.camPitch = this.lookPitch;
      for (let i = 0; i < this.allyTotal - 1; i++) {
        const p = this._findSpawn(TEAM.ALLY, 22);
        this._spawnTank(TEAM.ALLY, p, rand(-0.5, 0.5), false);
      }
    } else {
      for (let i = 0; i < this.allyTotal; i++) {
        const p = this._findSpawn(TEAM.ALLY, 22);
        this._spawnTank(TEAM.ALLY, p, rand(-0.5, 0.5), false);
      }
      // 玩家接手一架我方飞机：放到我方半场，机头朝敌方（+z）
      this.playerPlane = this.planes.takeForPlayer(TEAM.ALLY);
      this.player = this.playerPlane;
      const half = this.terrain.playable;
      this.player.pos.set(rand(-half * 0.45, half * 0.45), CONFIG.plane.airHoldAlt + 6, -half * 0.55);
      this.player.vel.set(0, 0, 1).multiplyScalar(CONFIG.plane.speed);
      this.player._orient(0);
      this.lookYaw = 0;
      this.lookPitch = 0;
      this.camYaw = 0;
      this.camPitch = 0;
    }

    // 地面部队：纯空战里两边各最多一辆（你开坦克的话，我方那辆已经是你了，这儿不再放）
    if (this.pureAir) {
      if (this.pureAirAllyTank && !tankIsPlayer) {
        const p = this._findSpawn(TEAM.ALLY, 22);
        this._slowFireTank(this._spawnTank(TEAM.ALLY, p, rand(-0.5, 0.5), false));
      }
      if (this.pureAirEnemyTank) {
        const p = this._findSpawn(TEAM.ENEMY, 22);
        this._slowFireTank(this._spawnTank(TEAM.ENEMY, p, Math.PI + rand(-0.5, 0.5), false));
      }
    } else {
      for (let i = 0; i < this.enemyTotal; i++) {
        const p = this._findSpawn(TEAM.ENEMY, 22);
        this._spawnTank(TEAM.ENEMY, p, Math.PI + rand(-0.5, 0.5), false);
      }
    }
    this.updateCamera(1);

    this.state = 'playing';
    this.updateCounts();
    this.hud.stopSpectating();
    if (this.playerSide === 'tank') {
      this.hud.setPlayer(this.player);
      this.hud.setMode(this.player.precise);
    }
    if (this.pureAir) {
      // 那辆坦克归谁：你自己开的就是你，AI 开的说清楚是哪一边
      const tankBits = [];
      if (tankIsPlayer) tankBits.push(`你就是那辆坦克（${CONFIG.mode.pureAirTankReload} 秒一炮）`);
      else if (this.pureAirAllyTank) tankBits.push('我方 1 辆坦克');
      if (this.pureAirEnemyTank) tankBits.push('敌方 1 辆坦克');
      this.hud.banner(
        '纯空战',
        `地形：${this.currentBiome.name} · 空中 ${CONFIG.mode.pureAirPerSide} 对 ${CONFIG.mode.pureAirPerSide} · 每架 ${CONFIG.mode.planeLives} 次复活` +
          (tankBits.length ? ' · ' + tankBits.join(' · ') : '') +
          (this.night ? ' · 夜战' : ''),
        3
      );
    } else if (this.pureGround) {
      this.hud.banner(
        '纯陆战',
        `地形：${this.currentBiome.name} · 天上一个飞机都没有 · 我方 ${this.allyTotal} 辆 · 敌方 ${this.enemyTotal} 辆` +
          (this.night ? ' · 夜战' : ''),
        3
      );
    } else {
      this.hud.banner(
        '战斗开始',
        `地形：${this.currentBiome.name} · 我方 ${this.allyTotal} 辆 · 敌方 ${this.enemyTotal} 辆 · 空中 ${CONFIG.plane.count} 架` +
          (this.playerSide === 'plane' ? ' · 你驾驶飞机' : '') +
          (this.night ? ' · 夜战' : ''),
        3
      );
    }
    this._feedTerrainTip();
  }

  // 纯空战开局：两边各摆成一排"车道"，而且我方占偶数道、敌方占奇数道 ——
  // 任意两架对面飞机的横向间隔至少有一个车道宽，对着飞过去也是擦肩而过，
  // 不会一出生就迎面顶上（以前两边都摆在正中，开局两秒就撞了）
  _startAirDuel() {
    const active = this.planes.list.filter((p) => !p.retired && p.alive);
    const lane = new Map();
    let ally = 0;
    let foe = 0;
    for (const p of active) lane.set(p, p.team === TEAM.ALLY ? ally++ * 2 : foe++ * 2 + 1);
    const spacing = this.terrain.playable * 0.22;
    const mid = (active.length - 1) / 2;
    for (const p of active) {
      this._placeDuelPlane(p, p.team === TEAM.ALLY ? -1 : 1, (lane.get(p) - mid) * spacing);
    }
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.camYaw = 0;
    this.camPitch = 0;
    this._engageAirDuel();
  }

  // 有人重新升空：只把这架摆到一条空车道，不动别人 ——
  // 玩家可能还在天上飞着，把他一起拽回出生点太打断了
  _respawnAirDuel(plane) {
    const side = plane.team === TEAM.ALLY ? -1 : 1;
    this._placeDuelPlane(plane, side, this._pickDuelLane(side, plane));
    this._engageAirDuel();
  }

  // 挑一条离场上所有人最远的横向车道（刚升空的飞机用）
  _pickDuelLane(side, self) {
    const half = this.terrain.playable;
    const z = side * half * 0.35;
    let bestX = 0;
    let bestGap = -1;
    for (let i = -2; i <= 2; i++) {
      const x = i * half * 0.22;
      let gap = Infinity;
      for (const p of this.planes.list) {
        if (p === self || p.retired || !p.alive) continue;
        gap = Math.min(gap, Math.hypot(p.pos.x - x, p.pos.z - z));
      }
      if (gap > bestGap) {
        bestGap = gap;
        bestX = x;
      }
    }
    return bestX;
  }

  // side = -1：摆在我方半场、朝 +z（敌方）；side = +1：反之
  _placeDuelPlane(plane, side, x) {
    plane.pos.set(x, CONFIG.plane.airHoldAlt + 6, side * this.terrain.playable * 0.35);
    plane.vel.set(0, 0, -side).multiplyScalar(CONFIG.plane.speed);
    plane._orient(0);
    plane.controlFire = false;
    plane.controlThrottle = 0;
  }

  // 让每架 AI 飞机咬上离自己最近的对面飞机（玩家那架不用管，杆在他自己手里）
  _engageAirDuel() {
    for (const p of this.planes.list) {
      if (p.retired || !p.alive || p.isPlayer) continue;
      const foe = this._nearestFoePlane(p);
      if (foe) p.engageAir(foe);
    }
  }

  // 离这架飞机最近的一架对面飞机（纯空战每边好几架，得挑最近的咬）
  _nearestFoePlane(plane) {
    const foeTeam = plane.team === TEAM.ALLY ? TEAM.ENEMY : TEAM.ALLY;
    let best = null;
    let bd = Infinity;
    for (const p of this.planes.list) {
      if (p.retired || !p.alive || p.team !== foeTeam) continue;
      const d = plane.pos.distanceTo(p.pos);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  // 火山喷发：打满 2:30 还没分出胜负，火山就喷了 ——
  // 火焰从火山口往外一圈圈爬，坦克的活动范围越挤越小，3:00 吞掉整个战场。
  // 伤害和减速都走 terrain 里那套（hazardAt / speedFactorAt），所以 AI 会像
  // 躲岩浆一样主动往外躲，玩家看到的就是"火在追着人跑"，不用额外写 AI
  _updateVolcano(dt) {
    const t = this.terrain;
    if (!t.volcano) return;
    const v = CONFIG.volcano;
    if (!t.fireActive) {
      if (this.elapsed < v.eruptAt) return;
      t.startEruption();
      // 真的喷出来：火山口当场炸开一大团，之后每隔一阵往外翻一次 ——
      // 不是一个"提示你火山喷发了"的文字，是屏幕上真的在炸。
      // 注意是**贴地铺开**（岩浆流），不是往天上炸到飞机高度 ——
      // 飞机在 40~60m 上飞，火团只到地面附近几米，喷不到它
      const cy = t.heightAt(t.volcano.x, t.volcano.z);
      this.volcanoErupt = 0.45;
      for (let k = 0; k < 6; k++) {
        _point.set(t.volcano.x + rand(-14, 14), cy + rand(0.5, 5), t.volcano.z + rand(-14, 14));
        this.effects.explosion(_point.clone(), 2.4);
      }
      this.audio.explosion(new THREE.Vector3(t.volcano.x, 0, t.volcano.z), 1.6);
      this.hud.banner('火山喷发', '岩浆正从火山口往外漫 —— 往外跑，别被圈住', 3);
      this.hud.feed('火山喷发了！岩浆流一直在往外推，3 分半吞掉整个战场', 'danger');
      this.volcanoFx = v.fxEvery;
      return;
    }
    t.updateFire(dt);
    // 火山口本体一直在翻：岩浆往外冒、带一点烟、还有低声的闷响（全是贴地的）
    this.volcanoErupt -= dt;
    if (this.volcanoErupt <= 0) {
      this.volcanoErupt = 0.55;
      const vy = t.heightAt(t.volcano.x, t.volcano.z);
      for (let k = 0; k < 2; k++) {
        _point.set(t.volcano.x + rand(-12, 12), vy + rand(0.5, 4), t.volcano.z + rand(-12, 12));
        this.effects.explosion(_point.clone(), 1.8);
      }
      this.effects.wreckSmoke(_point.set(t.volcano.x, vy + 6, t.volcano.z));
      this.audio.explosion(new THREE.Vector3(t.volcano.x, 0, t.volcano.z), 0.7);
    }
    // 火线上时不时炸一团：光靠地面变色不够"烧起来"的感觉
    this.volcanoFx -= dt;
    if (this.volcanoFx <= 0) {
      this.volcanoFx = v.fxEvery;
      for (let k = 0; k < 3; k++) {
        const a = rand(0, Math.PI * 2);
        const r = t.fireRadius * rand(0.88, 1.02);
        const x = clamp(t.volcano.x + Math.cos(a) * r, -t.half + 6, t.half - 6);
        const z = clamp(t.volcano.z + Math.sin(a) * r, -t.half + 6, t.half - 6);
        this.effects.explosion(new THREE.Vector3(x, t.heightAt(x, z) + 1.5, z), 1);
      }
    }
  }

  // 开局那条地形提示。要按"水带到底是什么"来说：以前只判断有没有水带，
  // 一律说成"小溪、涉水减速"，于是在火山（岩浆河）和雪原（冰面）上说的都是错的。
  _feedTerrainTip() {
    const st = this.terrain.stream;
    if (!st) this.hud.feed('注意上下坡：上坡慢、下坡快', 'friendly');
    else if (st.kind === 'lava') this.hud.feed('地形里有岩浆河：踩上去又烧血又减速，尽量绕开', 'danger');
    else if (st.kind === 'ice') this.hud.feed('地形里有结冰的小河：冰面能正常开过去，不减速', 'air');
    else this.hud.feed('地形里有小溪，涉水会明显减速', 'air');
  }

  _findSpawn(team, minDist) {
    const half = this.terrain.playable;
    const sign = team === TEAM.ENEMY ? 1 : -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const x = rand(-half * 0.95, half * 0.95);
      const z = sign * rand(half * 0.05, half * 0.9);
      if (this.terrain.slopeAt(x, z) > 0.32) continue;
      let ok = true;
      for (const c of this.terrain.colliders) {
        if (Math.hypot(c.x - x, c.z - z) < c.r + 5) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const t of this.tanks) {
        if (t.alive && Math.hypot(t.pos.x - x, t.pos.z - z) < minDist) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      return new THREE.Vector3(x, this.terrain.heightAt(x, z), z);
    }
    return this.terrain.randomSpawnPoint(null, 0);
  }

  _spawnTank(team, position, yaw, isPlayer) {
    const name = isPlayer ? '你' : `坦克${++this.tankNameCounter}`;
    const tank = new Tank(this, { team, position, yaw, isPlayer, name });
    this.tanks.push(tank);
    if (!isPlayer) {
      const ai = new TankAI(tank, this);
      tank.ai = ai;
      this.ais.push(ai);
    }
    return tank;
  }

  // 纯空战里那辆坦克 20 秒才能打一炮：弹夹压成 1 发、装填拉长。
  // AI 那辆和你自己开的那辆都压 —— 不压的话它对着天上的飞机太强了
  _slowFireTank(tank) {
    tank.magazine = 1;
    tank.rounds = 1;
    tank.loadTime = CONFIG.mode.pureAirTankReload;
  }

  // ---------- 战斗回调 ----------

  onTankHit(tank, owner, friendly, destroyed, kind) {
    if (owner === this.player && !destroyed) {
      this.hud.hitMark(friendly ? 'friendly' : 'hit');
    }
    if (tank === this.player) this.hud.damage();
    // 打中装甲：坦克炮弹是金属"当"，飞机机炮是轻一点的脆响
    this.audio.armorHit(tank.pos, kind !== 'air');
  }

  onTankDestroyed(tank, killer) {
    tank.corpseTimer = CONFIG.tank.corpseTime;   // 黑壳冒烟 5 秒后消失
    this.wrecks.push(tank);
    const killerName = killer ? killer.name : null;

    if (tank === this.player) {
      this.stats.playerDeaths++;
      this.hud.feed(killer === LAVA ? '你被岩浆烧毁了，战斗仍在继续' : '你被击毁了，战斗仍在继续', 'danger');
      this._startDeathCam();
    } else if (tank.team === TEAM.ALLY) {
      this.stats.allyLost++;
      if (killer === LAVA) {
        this.hud.feed(`友军 ${tank.name} 陷进岩浆烧毁了`, 'danger');
      } else if (killer === this.player) {
        this.stats.friendlyKills++;
        this.hud.feed(`误伤！你击毁了友军 ${tank.name}`, 'friendly');
        this.hud.hitMark('friendly');
      } else if (killer && killer.isPlane) {
        if (killer.team === TEAM.ALLY) {
          this.hud.feed(`我方空军误伤，${tank.name} 被自家扫射击毁`, 'friendly');
        } else {
          this.hud.feed(`友军 ${tank.name} 被敌方空军扫射击毁`, 'air');
        }
      } else if (killer && killer.team === TEAM.ALLY) {
        this.hud.feed(`友军 ${killerName} 误伤，${tank.name} 被自家炮弹打爆`, 'friendly');
      } else {
        this.hud.feed(`友军 ${tank.name} 阵亡`, 'danger');
      }
    } else {
      this.stats.enemyLost++;
      if (killer === LAVA) {
        this.hud.feed(`敌方 ${tank.name} 陷进岩浆烧毁了`, 'kill');
      } else if (killer === this.player) {
        this.stats.kills++;
        this.hud.feed(`你击毁了敌方 ${tank.name}`, 'kill');
        this.hud.hitMark('kill');
      } else if (killer && killer.isPlane) {
        if (killer.team === TEAM.ENEMY) {
          this.hud.feed(`敌方空军误伤，${tank.name} 被自家扫射击毁`, 'friendly');
        } else {
          this.hud.feed(`我方空军扫射击毁了敌方 ${tank.name}`, 'kill');
        }
      } else if (killer && killer.team === TEAM.ALLY) {
        this.hud.feed(`友军 ${killerName} 击毁了敌方 ${tank.name}`, 'kill');
      } else if (killer && killer.team === TEAM.ENEMY) {
        this.hud.feed(`敌方自相残杀：${killerName} 打爆了 ${tank.name}`, 'friendly');
      } else {
        this.hud.feed(`敌方 ${tank.name} 被击毁`, '');
      }
    }
    this.updateCounts();
    this._checkBattleEnd();
  }

  onPlaneHit(plane, owner, destroyed) {
    if (destroyed) return;
    if (owner === this.player) this.hud.hitMark('plane');
    if (plane === this.player) this.hud.damage();
    // 飞机被弹是轻一点的脆响
    this.audio.armorHit(plane.pos, false);
  }

  // 坠落的飞机砸中坦克：不扣血，只是短时间跑不动（只有砸到自己才提示）
  onWreckHit(tank, plane) {
    if (tank !== this.player) return;
    this.hud.feed('被坠落的飞机砸中，短时间开不快', 'danger');
  }

  // 飞机掉了一片机翼：说清楚是哪一侧、怎么掉的（撞地 / 撞障碍 / 挨弹 / 对撞）
  onPlaneWingLost(plane, side, cause) {
    const who = plane === this.player ? '你的飞机' : plane.name;
    const why = cause === 'ground' ? '机翼蹭到地面'
      : cause === 'obstacle' ? '机翼撞上障碍物'
        : cause === 'crash' ? '和对方撞在一起'
          : '机翼被打断';
    if (plane === this.player) {
      this.hud.feed(`${why}，${side === 'left' ? '左' : '右'}翼没了 —— 赶紧找地方落`, 'danger');
    } else {
      this.hud.feed(`${who} ${why}，掉了一侧机翼`, 'kill');
    }
    this.audio.armorHit(plane.pos, false);
  }

  // 飞机平稳落到地上：不炸，趴在地上慢慢烧，烧的过程中还能开炮
  onPlaneLanded(plane) {
    if (plane === this.player) {
      this.hud.feed('平稳落地了 —— 机身开始着火，还能开炮，烧完就没了', 'danger');
    } else {
      this.hud.feed(`${plane.name} 迫降在地面上，正在烧`, 'kill');
    }
    this.audio.smallPuff(plane.pos);
  }

  onPlaneDestroyed(plane, killer, cause = 'shot') {
    const isAlly = plane.team === TEAM.ALLY;

    // 玩家自己开的飞机
    if (plane === this.player) {
      this.stats.playerDeaths++;
      const why =
        cause === 'edge' ? '你飞出了场地边界，撞毁'
          : cause === 'crash' ? '你和别的飞机撞在一起，同归于尽'
            : '你的飞机被击落';
      if (this.pureAir && plane.lives > 0) {
        // 纯空战 + 还有复活机会：不播坠机回放、也不进观战 —— 黑屏一秒直接回天上。
        // 黑屏同时也挡住"还在按开火"的那根手指，不会误触到结算面板
        this.hud.blackout(1);
        this.hud.feed(`${why}，马上重新升空（还剩 ${plane.lives} 次复活机会）`, 'danger');
      } else {
        // 最后一条命也打完了（哪怕队友还在天上打）：得照常播坠机回放 + 进观战，
        // 不然镜头会永远冻在坠机那一帧 —— 你之前遇到的"打死了也不看上帝视角"就是这个
        this.hud.feed(this.pureAir ? `${why}，这是最后一条命了` : `${why}，战斗仍在继续`, 'danger');
        this._startDeathCam();
      }
      this.updateCounts();
      this._checkBattleEnd();
      return;
    }

    // 空中相撞会一次报两架，这里只报一次
    if (cause === 'crash') {
      if (killer && plane.id < killer.id) {
        this.hud.feed(`空中相撞！${plane.name} 与 ${killer.name} 同归于尽`, 'air');
      }
      this.updateCounts();
      this._checkBattleEnd();
      return;
    }
    if (cause === 'edge') {
      this.hud.feed(`${plane.name} 撞上场地边界，坠毁`, isAlly ? 'danger' : 'air');
      this.updateCounts();
      this._checkBattleEnd();
      return;
    }

    if (killer === this.player) {
      if (isAlly) {
        this.stats.friendlyKills++;
        this.hud.feed(`误伤！你击落了自家飞机 ${plane.name}`, 'friendly');
        this.hud.hitMark('friendly');
      } else {
        this.stats.planesDown++;
        // 只走战报 + 命中标记，和击毁坦克保持一致
        // （原来飞机额外弹一个"击落！"横幅，打坦克却没有 —— 同样是击毁，不该两套待遇）
        this.hud.feed(`你击落了敌机 ${plane.name}！`, 'air');
        this.hud.hitMark('plane');
      }
    } else if (killer && killer.isPlane) {
      this.hud.feed(`${killer.name} 击落了 ${plane.name}`, 'air');
    } else if (isAlly) {
      this.hud.feed(`我方飞机 ${plane.name} 被击落`, 'danger');
    } else {
      this.hud.feed(`敌方飞机 ${plane.name} 被击落`, 'air');
    }
    // 击落飞机同样要结算胜负！
    // 漏掉这一句的话，"最后剩下的那架是敌机"时永远等不到胜负 ——
    // 你死了在旁边看、或者最后一下是队友打的，就会一直卡在那儿不结算
    this.updateCounts();
    this._checkBattleEnd();
  }

  // 纯空战：飞机残骸消失后隔几秒又飞回来（PlaneManager 到点了会喊这一声）
  onPlaneRespawn(plane) {
    this.updateCounts();
    if (this.pureAir) this._respawnAirDuel(plane);
    if (plane === this.player) {
      // 玩家这架：视角回正到机头朝敌的方向，交还操控
      this.lookYaw = 0;
      this.lookPitch = 0;
      this.camYaw = 0;
      this.camPitch = 0;
      // 黑屏那一秒鼠标还在动，攒下来的位移要清掉，不然刚回来视线会猛甩一下
      this.input.mouseDX = 0;
      this.input.mouseDY = 0;
      this.input.firePressed = false;
      this.input.fireHeld = false;
      this.deathCamTimer = 0;
      this.updateCamera(1);   // 镜头直接怼到新位置，别从坠机点慢慢飘过来
      this.hud.stopSpectating();
      this.hud.feed(`飞机已重新升空！还剩 ${plane.lives} 次复活机会`, 'air');
      this.input.requestLock();
      return;
    }
    this.hud.feed(`${plane.name} 重新升空（还剩 ${plane.lives} 次复活）`, plane.team === TEAM.ALLY ? 'air' : 'danger');
  }

  // 侦察兵的情报：我方侦察兵报敌情（air），敌方侦察兵盯上你是警告（danger）
  onScoutReport(text, kind = 'air') {
    this.hud.feed(text, kind);
    if (kind === 'air') this.hud.hitMark('scout');
  }

  onScoutKilled(scout, killer, cause = 'shot') {
    const verb = cause === 'crush' ? '压扁' : '打死';
    this.audio.smallPuff(scout.pos);
    if (killer === this.player) {
      if (scout.team === TEAM.ALLY) {
        this.stats.friendlyKills++;
        this.hud.feed(`误伤！你${verb}了自家的侦察兵`, 'friendly');
        this.hud.hitMark('friendly');
      } else {
        this.hud.feed(`你${verb}了敌方侦察兵`, 'kill');
        this.hud.hitMark('scout');
      }
      return;
    }
    // 我方侦察兵阵亡：炮弹乱飞的时候会连着倒，所以限流，别把战报刷满
    if (scout.team === TEAM.ALLY && this._scoutMsgReady()) {
      const text =
        cause === 'crush' ? '我方侦察兵被坦克压扁了'
          : cause === 'blast' ? '我方侦察兵被炮火震倒'
            : '我方侦察兵阵亡';
      this.hud.feed(text, 'danger');
    }
  }

  _scoutMsgReady() {
    const now = performance.now();
    if (now - this.lastScoutMsg < 4000) return false;
    this.lastScoutMsg = now;
    return true;
  }

  _startSpectate() {
    this.input.releaseLock();
    // 切成上帝视角：从高空俯瞰，自动飘向交战区
    this.godYaw = rand(0, Math.PI * 2);
    this.godPitch = 1.02;
    this._godPos = null;
    this.hud.setSpectating();
  }

  _checkBattleEnd() {
    if (this.state !== 'playing') return;
    const tanksAlive = (team) => this.tanks.some((t) => t.alive && t.team === team);
    // 胜利条件：对方的坦克和飞机都要打光。
    // 纯空战里被打下来的飞机会重新升空，所以"还没用完复活机会"的也算在场 ——
    // 不这么算的话，第一架被打下来的瞬间就会误判成胜负已分
    const airAlive = (team) =>
      this.planes.list.some((p) => !p.retired && p.team === team && (p.alive || p.lives > 0));
    const enemyOut = !tanksAlive(TEAM.ENEMY) && !airAlive(TEAM.ENEMY);
    const allyOut = !tanksAlive(TEAM.ALLY) && !airAlive(TEAM.ALLY);
    // 两边在同一帧一起被打光（最后两架撞在一起、互射同归于尽）就算平局 ——
    // 先判敌方的话等于白送玩家一个"胜利"，对 AI 那一边不公平
    if (enemyOut && allyOut) this._endBattle(null);
    else if (enemyOut) this._endBattle(true);
    else if (allyOut) this._endBattle(false);
  }

  // win: true=胜 / false=负 / null=平局
  _endBattle(win) {
    this.state = 'over';
    this.audio.setBattleActive(false);   // 结算页：战斗音效全停（引擎底噪也一起掐掉），只留音乐
    this.music.stop();
    this.resultMusic.play();   // 打完了：换结算曲（胜或败都用它）
    // 先黑屏一秒再露出结算面板：这时候玩家往往还在按开火，
    // 不给个缓冲的话一松手就点到刚出现的「再来一局」了
    this.hud.blackout(1);
    this.input.releaseLock();
    const mins = Math.floor(this.elapsed / 60);
    const secs = Math.floor(this.elapsed % 60);
    this.hud.showGameOver(win, {
      ...this.stats,
      duration: `${mins} 分 ${String(secs).padStart(2, '0')} 秒`,
    });
    const allyTanks = this.tanks.filter((t) => t.alive && t.team === TEAM.ALLY).length;
    const enemyTanks = this.tanks.filter((t) => t.alive && t.team === TEAM.ENEMY).length;
    const draw = win === null || win === undefined;
    this.hud.setStatus(
      draw
        ? '双方在同一刻全部打光 —— 平局，谁也没占到最后那一下便宜'
        : win
          ? `我方剩余 ${allyTanks} 辆 · 敌方坦克和飞机全部清空`
          : `我方坦克和飞机全部损失 · 敌方剩余 ${enemyTanks} 辆`
    );
  }

  // 飞机从镜头附近掠过时来一声"呼"（每架飞机各自冷却，免得刷屏）
  _audioPlanePass(dt) {
    for (const p of this.planes.list) {
      if (!p.alive) {
        p.audioCd = 0;
        continue;
      }
      p.audioCd -= dt;
      if (p.audioCd > 0) continue;
      if (p.pos.distanceTo(this.camera.position) < 60) {
        p.audioCd = 5;
        this.audio.planePass(p.pos);
      }
    }
  }

  updateCounts() {
    this.hud.setCounts({
      allyAlive: this.tanks.filter((t) => t.alive && t.team === TEAM.ALLY).length,
      enemyAlive: this.tanks.filter((t) => t.alive && t.team === TEAM.ENEMY).length,
      allyAir: this.planes.list.filter((p) => p.alive && p.team === TEAM.ALLY).length,
      enemyAir: this.planes.list.filter((p) => p.alive && p.team === TEAM.ENEMY).length,
      kills: this.stats.kills,
      friendlyKills: this.stats.friendlyKills,
      planesDown: this.stats.planesDown,
    });
  }

  // ---------- 玩家 ----------

  // 准星指着哪：从相机往屏幕正中打射线（逻辑在 camera.js 里，可以单独测试）
  // skipTank 必须传玩家自己，否则准星会锁在自己车上
  computeAimPoint() {
    return aimPointFromCamera(
      this.camera.position,
      this.camera.quaternion,
      this.tanks,
      this.planes.list,
      this.terrain,
      _point,
      this.player
    );
  }

  // 移动模式 ⇄ 瞄准模式（F 键或点 HUD 按钮）；飞机没有这套，直接忽略
  toggleMode() {
    const p = this.player;
    if (!p || !p.alive || p.isPlane) return;
    p.precise = !p.precise;
    this.hud.setMode(p.precise);
    this.hud.feed(
      p.precise ? '瞄准模式：车速三成、散布极小，虚线是炮弹实际弹道' : '移动模式：跑得快，但炮弹散布明显更大',
      p.precise ? 'air' : 'friendly'
    );
  }

  updatePlayer(dt) {
    if (this.playerSide === 'plane') {
      this.updatePlayerPlane(dt);
      return;
    }
    const p = this.player;
    if (!p || !p.alive) return;

    if (this.input.consumeModeToggle()) this.toggleMode();

    // R：应急修复（10 秒，只能修回累计伤害的一半，期间不能动不能开炮）
    if (this.input.consumeRepair()) {
      if (p.startRepair()) {
        // 耗时是按实际要修的血量算的，所以这里报的数也是这一次的真实时长
        this.hud.feed(`开始应急修复：${p.repairTimer.toFixed(1)} 秒内别动、别开炮`, 'air');
      } else if (p.repairing) {
        this.hud.feed('正在修复中…', 'friendly');
      } else {
        this.hud.feed(`没有可修的部分了（上限 ${p.repairCeiling.toFixed(0)} 血，另一半是永久损失）`, 'danger');
      }
    }
    // 修复中的滴答声：给个"还在修"的听觉反馈
    this.repairTick -= dt;
    if (p.repairing && this.repairTick <= 0) {
      this.repairTick = 0.6;
      this.audio.repairTick(p.pos);
    }

    // 坦克开法：W/S 前进后退，A/D 原地转车体（停下来也能原地掉头）
    p.controlForward = this.input.forward;
    p.controlTurn = this.input.turn;

    const aim = this.computeAimPoint();
    p.aimAtPoint(aim, dt);

    const pressed = this.input.consumeFire();
    if (pressed || this.input.fireHeld) {
      if (p.fire()) this.hud.crosshairKick();
    }
  }

  get playerIsPlane() {
    return !!(this.player && this.player.isPlane);
  }

  // 开飞机：鼠标/方向键定机头方向（准星指哪，机头就朝哪转），W/S 推油门，左键开炮
  updatePlayerPlane(dt) {
    const pl = this.playerPlane;
    if (!pl || !pl.alive) return;
    const cfg = CONFIG.camera.plane;

    const md = this.input.takeMouseDelta();
    const turn = this.input.camTurn + this.input.turn;   // Q/E、方向键、A/D 都能转向
    if (md.x !== 0 || turn !== 0) {
      this.lookYaw = wrapAngle(this.lookYaw - md.x * cfg.sensitivity - turn * 1.5 * dt);
    }
    if (md.y !== 0 || this.input.camPitchAdjust !== 0) {
      this.lookPitch = clamp(
        this.lookPitch - md.y * cfg.sensitivity + this.input.camPitchAdjust * 0.9 * dt,
        cfg.pitchMin,
        cfg.pitchMax
      );
    }

    const cp = Math.cos(this.lookPitch);
    pl.aimDir.set(Math.sin(this.lookYaw) * cp, Math.sin(this.lookPitch), Math.cos(this.lookYaw) * cp).normalize();
    pl.controlThrottle = this.input.forward;
    const pressed = this.input.consumeFire();
    pl.controlFire = pressed || this.input.fireHeld;
    if (pressed) this.hud.crosshairKick();

    // 坦克那两套按键在飞机上用不到，吃掉免得留到下一局误触发
    this.input.consumeModeToggle();
    this.input.consumeRepair();

    // 快撞边界了给个警告（AI 会自动回头，玩家不会）
    const limit = this.terrain.playable * 1.15;
    this.edgeWarnTimer -= dt;
    if (Math.max(Math.abs(pl.pos.x), Math.abs(pl.pos.z)) > limit * 0.72 && this.edgeWarnTimer <= 0) {
      this.edgeWarnTimer = 2.2;
      this.hud.feed('接近场地边界！再往外飞会撞毁', 'danger');
    }
  }

  updateCamera(dt) {
    // 纯空战里"开飞机"阵亡时，只要还有复活机会就不切观战：黑屏盖着，镜头原地等着，
    // 复活帧再直接怼到追尾视角（见 onPlaneRespawn）。
    // 两个前提都得带上：① 你开的是飞机（开那辆坦克死了没有复活这回事）
    // ② 复活机会还没用完（用完了队友可能还在打，那就必须照常进观战，
    //    否则镜头会永远冻在坠机那一帧）
    if (this.pureAir && this.playerIsPlane && !this.player.alive && this.player.lives > 0) return;
    // 阵亡后先看 5 秒自己的残骸，然后才切上帝视角
    if (this.player && !this.player.alive) {
      if (this.deathCamTimer > 0) {
        this.updateDeathCamera(dt);
        return;
      }
      this.updateGodCamera(dt);
      return;
    }
    if (this.playerIsPlane) {
      this.updatePlaneCamera(dt);
      return;
    }
    const focus = this.player;
    if (!focus) return;

    const md = this.input.takeMouseDelta();
    // 键盘也能瞄准：Q/E 或左右方向键转视角，上下方向键调高低
    const camTurn = this.input.camTurn;
    const camPitchAdjust = this.input.camPitchAdjust;
    if (camTurn !== 0) this.lookYaw -= camTurn * 1.9 * dt;
    if (camPitchAdjust !== 0) {
      this.lookPitch = clamp(
        this.lookPitch + camPitchAdjust * 1.2 * dt,
        CONFIG.camera.pitchMin,
        CONFIG.camera.pitchMax
      );
    }
    if (camTurn !== 0 || camPitchAdjust !== 0) this.input.lastLookTime = performance.now();

    {
      // 镜头跟随分两段：
      //  · 车体转向用阻尼跟随 —— 打完方向键镜头柔和地荡过去，不是被硬拽
      //  · 鼠标偏移即时生效   —— 瞄准不拖泥带水
      // 两者分开，所以"跟得柔"和"瞄得准"不冲突；全部静止时也不会自己漂
      this.followYaw = followHull(this.followYaw, this.player.yaw, dt);
      mouseLook(this.lookYaw, this.lookPitch, md.x, md.y, _look);
      this.lookYaw = _look.yaw;
      this.lookPitch = _look.pitch;

      // 开车时视点自己回正到车尾后方：否则视线要是甩到车头前方，
      // 按 W 反而是朝自己开过来，看起来就像"W/S 反了"
      const p = this.player;
      const driving = p.controlForward !== 0 || p.controlTurn !== 0;
      if (driving && performance.now() - this.input.lastLookTime > 400) {
        this.lookYaw = dampAngle(this.lookYaw, 0, 2.4, dt);
      }

      this.camYaw = this.followYaw + this.lookYaw;
      this.camPitch = this.lookPitch;
    }

    rigPosition(this.camYaw, this.camPitch, focus.pos, this.terrain, _camPos, _lookDir);

    if (dt > 0.4) this.camera.position.copy(_camPos);
    else this.camera.position.lerp(_camPos, 1 - Math.exp(-18 * dt));

    _point.copy(this.camera.position).addScaledVector(_lookDir, CONFIG.camera.lookAhead);
    this.camera.lookAt(_point);

    this._syncSky();
  }

  // 开飞机时的追尾镜头：视线方向就是机头要去的方向
  updatePlaneCamera(dt) {
    const cfg = CONFIG.camera.plane;
    this.camYaw = this.lookYaw;
    this.camPitch = this.lookPitch;

    rigPosition(this.camYaw, this.camPitch, this.player.pos, this.terrain, _camPos, _lookDir, cfg);
    if (dt > 0.4) this.camera.position.copy(_camPos);
    else this.camera.position.lerp(_camPos, 1 - Math.exp(-16 * dt));

    _point.copy(this.camera.position).addScaledVector(_lookDir, cfg.lookAhead);
    this.camera.lookAt(_point);

    this._syncSky();
  }

  // 阵亡瞬间：先放 5 秒"自己的坠毁画面"，让玩家看完再转上帝视角
  _startDeathCam() {
    this.input.releaseLock();
    this.deathCamTimer = CONFIG.tank.corpseTime;
    this.deathCamYaw = rand(0, Math.PI * 2);
    this.hud.setDeathCam();
  }

  updateDeathCamera(dt) {
    this.deathCamTimer -= dt;
    const p = this.player.pos;
    // 飞机被击落时残骸还在往下掉，镜头跟着它一起落，别只盯着地面
    const base = Math.max(this.terrain.heightAt(p.x, p.z), p.y);

    // 绕着残骸慢慢转一圈，镜头略微下沉，看得清机/车身上的黑烟
    this.deathCamYaw += dt * 0.4;
    const r = 15;
    _camPos.set(
      p.x + Math.sin(this.deathCamYaw) * r,
      base + 7.4,
      p.z + Math.cos(this.deathCamYaw) * r
    );
    this.camera.position.lerp(_camPos, 1 - Math.exp(-6 * dt));

    _point.set(p.x, base + 1.6, p.z);
    this.camera.lookAt(_point);

    this._syncSky();

    if (this.deathCamTimer <= 0) this._startSpectate();
  }

  // 上帝视角：高空俯瞰整片战场，自动飘到打得最凶的两辆车上方
  updateGodCamera(dt) {
    const g = CONFIG.camera.god;
    const center = this._actionCenter(_godCenter);

    const md = this.input.takeMouseDelta();
    if (md.x !== 0 || md.y !== 0) {
      this.godYaw -= md.x * CONFIG.camera.sensitivity * 0.7;
      this.godPitch = clamp(
        this.godPitch - md.y * CONFIG.camera.sensitivity * 0.7,
        g.pitchMin,
        g.pitchMax
      );
      this.input.lastLookTime = performance.now();
    }
    if (this.input.camTurn !== 0) {
      this.godYaw -= this.input.camTurn * 1.2 * dt;
      this.input.lastLookTime = performance.now();
    }
    if (this.input.camPitchAdjust !== 0) {
      this.godPitch = clamp(
        this.godPitch + this.input.camPitchAdjust * 0.9 * dt,
        g.pitchMin,
        g.pitchMax
      );
      this.input.lastLookTime = performance.now();
    }
    // 手一停就自己慢慢绕着转，像航拍
    if (performance.now() - this.input.lastLookTime > 600) this.godYaw += dt * g.orbit;

    // 交战区位置平滑跟过去，别一帧瞬移
    if (!this._godPos) this._godPos = center.clone();
    else this._godPos.lerp(center, 1 - Math.exp(-g.follow * dt));

    const cx = this._godPos.x;
    const cz = this._godPos.z;
    const base = this.terrain.heightAt(cx, cz);
    const horizon = g.height / Math.max(0.25, Math.tan(this.godPitch));
    _camPos.set(
      cx + Math.sin(this.godYaw) * horizon,
      base + g.height,
      cz + Math.cos(this.godYaw) * horizon
    );
    const camGround = this.terrain.heightAt(_camPos.x, _camPos.z) + 26;
    if (_camPos.y < camGround) _camPos.y = camGround;

    if (dt > 0.4) this.camera.position.copy(_camPos);
    else this.camera.position.lerp(_camPos, 1 - Math.exp(-9 * dt));

    _point.set(cx, base + 4, cz);
    this.camera.lookAt(_point);

    this._syncSky();
  }

  // 战场上最热闹的地方：离得最近的一对敌我坦克的中点
  _actionCenter(out) {
    let bestA = null;
    let bestB = null;
    let bd = Infinity;
    for (const a of this.tanks) {
      if (!a.alive) continue;
      for (const b of this.tanks) {
        if (!b.alive || b.team === a.team) continue;
        const d = a.pos.distanceToSquared(b.pos);
        if (d < bd) {
          bd = d;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA && bestB) {
      return out.copy(bestA.pos).add(bestB.pos).multiplyScalar(0.5);
    }
    // 没有交战的（都躲起来了）就看向所有存活坦克的重心
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      sx += t.pos.x;
      sz += t.pos.z;
      n++;
    }
    return n ? out.set(sx / n, 0, sz / n) : out.set(0, 0, 0);
  }

  _syncSky() {
    this.sky.position.copy(this.camera.position);
    this.sun.position.copy(this.camera.position).add(_sunOffset);
    this.sun.target.position.copy(this.camera.position);
    this.sun.target.updateMatrixWorld();
  }

  updateWrecks(dt) {
    // 残骸（坦克）：烧成黑壳 → 冒黑烟 → 5 秒后自己消失
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.corpseTimer -= dt;
      if (w.corpseTimer <= 0) {
        if (w.object) w.object.visible = false;
        this.wrecks.splice(i, 1);
      }
    }

    this.wreckTimer -= dt;
    if (this.wreckTimer > 0) return;
    this.wreckTimer = 0.3;
    // 一圈黑烟：数量做上限，免得残骸多了冒烟把帧数吃掉
    const n = Math.min(this.wrecks.length, 6);
    for (let i = 0; i < n; i++) this.effects.wreckSmoke(this.wrecks[i].pos);
  }

  // ---------- 主循环 ----------

  // 菜单状态下镜头绕着战场慢慢转，先让人看一眼随机地形
  updateMenuCamera(dt) {
    this.camYaw += dt * 0.07;
    const r = 165;
    this.camera.position.set(Math.sin(this.camYaw) * r, 78, Math.cos(this.camYaw) * r);
    this.camera.lookAt(0, 12, 0);
    this.sky.position.copy(this.camera.position);
    this.sun.position.copy(this.camera.position).add(_sunOffset);
    this.sun.target.position.copy(this.camera.position);
    this.sun.target.updateMatrixWorld();
  }

  update(dt) {
    if (this.state === 'menu') {
      this.updateMenuCamera(dt);
      return;
    }
    // 结算之后整个战场冻住：不再推进坦克/飞机/子弹，也就不会再有爆炸、
    // 命中、坠机的声音漏到结算页面上。（你之前提过"游戏都结束了飞机还在坠机"）
    if (this.state === 'over') return;

    this.elapsed += dt;
    this._updateVolcano(dt);
    for (const key in this.lastContact) {
      const c = this.lastContact[key];
      if (c) c.age += dt;
    }
    this.effects.update(dt);
    this.updatePlayer(dt);
    this.aimLine.update(
      this.playerIsPlane ? null : this.player,
      this.tanks,
      !!this.player && this.player.alive && this.player.precise
    );
    for (const t of this.tanks) t.update(dt);
    for (const ai of this.ais) ai.update(dt);
    this.scouts.update(dt);
    this.planes.update(dt);
    this.bullets.update(dt);

    // 兜底：每帧都判一次胜负，不依赖"谁打死了谁"的回调。
    // 之前只在阵亡回调里判，结果某个分支漏了调用（击落飞机的正常分支），
    // 就出现"你死了在旁边看、或者最后一下是队友打的，永远不结算"。
    // 两个 some() 而已，开销可以忽略。
    this._checkBattleEnd();
    if (this.state !== 'playing') return;   // 刚好这帧打完了，别再往下跑观战逻辑

    this.updateWrecks(dt);
    this.updateCamera(dt);
    // 岩浆发光 / 履带印淡出这类跟地形绑定的小动画
    this.terrain.update(dt, this.player ? this.player.pos : this.camera.position);
    this.treads.update(dt);

    // 音频：镜头位置/朝向每帧同步一次（用来算左右声道），引擎底噪跟着速度走
    this.audio.setCamera(this.camera);
    const pl = this.player;
    const spd = pl && pl.alive && pl.velocity ? pl.velocity.length() / 12.5 : 0;
    this.audio.engine(pl && pl.alive ? spd : 0, this.playerIsPlane);
    this._audioPlanePass(dt);

    this.hud.update(dt);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.18;
      this.updateCounts();
      if (this.player && this.player.alive) {
        if (this.playerIsPlane) {
          this.hud.setPlayerPlane(this.player, this.terrain.heightAt(this.player.pos.x, this.player.pos.z));
        } else {
          this.hud.setPlayer(this.player);
        }
      }
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.game = new Game();
});
