// HUD：准星、血条、弹夹、战报、波次横幅、结算面板（没有小地图）

import { CONFIG, BIOMES } from './config.js';

export class HUD {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      ally: document.getElementById('stat-ally'),
      labelAlly: document.getElementById('label-ally'),
      unitAlly: document.getElementById('unit-ally'),
      allyAir: document.getElementById('stat-ally-air'),
      kills: document.getElementById('stat-kills'),
      friendlyKills: document.getElementById('stat-friendly'),
      planes: document.getElementById('stat-planes'),
      feed: document.getElementById('feed'),
      banner: document.getElementById('banner'),
      bannerTitle: document.getElementById('banner-title'),
      bannerSub: document.getElementById('banner-sub'),
      healthFill: document.getElementById('health-fill'),
      healthBar: document.getElementById('health-bar'),
      healthText: document.getElementById('health-text'),
      healthCap: document.getElementById('health-cap'),
      repairHint: document.getElementById('repair-hint'),
      reloadFill: document.getElementById('reload-fill'),
      reloadBar: document.getElementById('reload-bar'),
      reloadLabel: document.getElementById('reload-label'),
      bottomBar: document.getElementById('bottom-bar'),
      planeThrottleBar: document.getElementById('plane-throttle-bar'),
      throttleFill: document.getElementById('throttle-fill'),
      throttleLabel: document.getElementById('throttle-label'),
      planeAmmoBar: document.getElementById('plane-ammo-bar'),
      planeAmmoFill: document.getElementById('plane-ammo-fill'),
      planeAmmoLabel: document.getElementById('plane-ammo-label'),
      planeAlt: document.getElementById('plane-alt'),
      crosshair: document.getElementById('crosshair'),
      hitmarker: document.getElementById('hitmarker'),
      damageFlash: document.getElementById('damage-flash'),
      overlay: document.getElementById('overlay'),
      menuPanel: document.getElementById('menu-panel'),
      overPanel: document.getElementById('over-panel'),
      overTitle: document.getElementById('over-title'),
      overStats: document.getElementById('over-stats'),
      statusLine: document.getElementById('status-line'),
      startBtn: document.getElementById('start-btn'),
      restartBtn: document.getElementById('restart-btn'),
      spectateHint: document.getElementById('spectate-hint'),
      modeBtn: document.getElementById('mode-btn'),
      modeWidget: document.getElementById('mode-widget'),
      rulesOverlay: document.getElementById('rules-overlay'),
      rulesClose: document.getElementById('rules-close'),
      rulesBtns: [document.getElementById('rules-btn'), document.getElementById('rules-btn-2')],
      blackout: document.getElementById('blackout'),
      enterGate: document.getElementById('enter-gate'),
      enterBtn: document.getElementById('enter-btn'),
      // 右下角的测试开关（默认收起来，菜单里按 T 调出来）
      testToggles: document.getElementById('test-toggles'),
      forcePureAir: document.getElementById('force-pure-air'),
      forcePureGround: document.getElementById('force-pure-ground'),
      forcePureTank: document.getElementById('force-pure-tank'),
      forcePureSea: document.getElementById('force-pure-sea'),
      // 自定义地图：右下角那个默认收起来的小条
      mapPicker: document.getElementById('map-picker'),
      mapPickerHead: document.getElementById('map-picker-head'),
      mapPickerLabel: document.getElementById('map-picker-label'),
      mapPickerBody: document.getElementById('map-picker-body'),
    };

    // 开发开关：按 T 把右下角那块调出来 / 收回去（默认藏着 —— 正式玩不需要它）
    window.addEventListener('keydown', (e) => {
      if (e.key !== 't' && e.key !== 'T') return;
      if (this.el.testToggles) this.el.testToggles.classList.toggle('hidden');
    });
    this.bannerTimer = null;
    this.feedItems = [];
    this.damageLevel = 0;
    this.side = 'tank';   // 玩家开什么：tank / plane

    this._bindRules();
    this._bindPicks();
    this._bindMapPicker();
  }

  // 自定义地图（右下角）：默认收成一条小字，点开才能勾地形。
  // 一个都不勾 = 全随机（默认）；勾了就在勾中的那几种里抽
  _bindMapPicker() {
    const head = this.el.mapPickerHead;
    const body = this.el.mapPickerBody;
    this.mapPool = new Set();
    this.mapChips = [];
    if (!head || !body) return;

    const addChip = (id, label) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mp-chip';
      chip.textContent = label;
      chip.addEventListener('click', () => {
        if (id === '') this.mapPool.clear();                 // 「全随机」= 清空
        else if (this.mapPool.has(id)) this.mapPool.delete(id);
        else this.mapPool.add(id);
        this._syncMapPicker();
      });
      body.appendChild(chip);
      this.mapChips.push({ id, chip });
    };
    for (const b of BIOMES) addChip(b.id, b.name);           // 现从 BIOMES 生成，以后加地图不用改 HTML
    addChip('', '全随机');

    head.addEventListener('click', () => {
      if (this.el.mapPicker) this.el.mapPicker.classList.toggle('collapsed');
    });
    this._syncMapPicker();
  }

  _syncMapPicker() {
    for (const { id, chip } of this.mapChips) {
      chip.classList.toggle('on', id === '' ? this.mapPool.size === 0 : this.mapPool.has(id));
    }
    if (this.el.mapPickerLabel) {
      // 收起来时只显示这一行；勾过就把数量带上，免得玩家忘了自己锁过地图
      const n = this.mapPool.size;
      this.el.mapPickerLabel.textContent = n === 0 ? '自定义地图' : `自定义地图 · ${n}`;
    }
  }

  // 本局从哪几种地形里抽（空数组 = 全部，保持原来的全随机）
  get biomePool() {
    return [...this.mapPool];
  }

  // 菜单和结算面板上都有"开坦克 / 开飞机"，两边同步选中状态
  _bindPicks() {
    const groups = [document.getElementById('pick-menu'), document.getElementById('pick-over')];
    for (const g of groups) {
      if (!g) continue;
      for (const btn of g.querySelectorAll('.pick')) {
        btn.addEventListener('click', () => this.setSide(btn.dataset.side));
      }
    }
    this._syncPicks();
  }

  setSide(side) {
    if (side !== 'tank' && side !== 'plane' && side !== 'boat') return;
    this.side = side;
    this._syncPicks();
  }

  _syncPicks() {
    for (const btn of document.querySelectorAll('.side-pick .pick')) {
      btn.classList.toggle('active', btn.dataset.side === this.side);
    }
    const desc = document.getElementById('pick-desc');
    if (desc) {
      // 开飞机不写备注（玩家要求：选边的时候别给飞机加注解）。
      // 留空但保留这个元素，免得切来切去时下面的按钮上下跳
      desc.textContent = this.side === 'plane'
        ? ''
        : this.side === 'boat'
          ? '炮艇：一轮齐射三发（近距离糊脸最狠），舰炮打得准、还能抬头打飞机；代价是皮最薄、转向最笨，一轮打完要空几秒（会换成水图：湖 / 海）。'
          : '坦克：装甲厚、能修车，扛得住几发。';
    }
  }

  // 右下角那几个测试开关。都没勾时返回 false，游戏就照常按 config 里的概率抽
  get forcePureAir() {
    return !!(this.el.forcePureAir && this.el.forcePureAir.checked);
  }

  get forcePureGround() {
    return !!(this.el.forcePureGround && this.el.forcePureGround.checked);
  }

  get forcePureTank() {
    return !!(this.el.forcePureTank && this.el.forcePureTank.checked);
  }

  get forcePureSea() {
    return !!(this.el.forcePureSea && this.el.forcePureSea.checked);
  }

  // 按玩家选的身份切换仪表盘（坦克：装甲 + 弹夹；飞机：油门 + 机炮 + 高度）
  applySide(side) {
    const plane = side === 'plane';
    this.el.healthBar.classList.toggle('hidden', plane);
    this.el.reloadBar.classList.toggle('hidden', plane);
    // 油门那一栏彻底不显示了：那个数值对玩法没有实际影响，白占地方（"油"去掉）
    this.el.planeThrottleBar.classList.add('hidden');
    this.el.planeAmmoBar.classList.toggle('hidden', !plane);
    this.el.planeAlt.classList.toggle('hidden', !plane);
    this.el.modeWidget.classList.toggle('hidden', plane);
    if (plane) this.el.repairHint.classList.add('hidden');
  }

  // 规则面板：默认收起，点「操作与规则」才打开
  _bindRules() {
    const open = () => this.el.rulesOverlay.classList.remove('hidden');
    const close = () => this.el.rulesOverlay.classList.add('hidden');
    for (const btn of this.el.rulesBtns) btn.addEventListener('click', open);
    this.el.rulesClose.addEventListener('click', close);
    // 点面板外面的黑底也能关
    this.el.rulesOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.rulesOverlay) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  onStart(cb) {
    this.el.startBtn.addEventListener('click', () => cb(this.side));
  }

  onRestart(cb) {
    this.el.restartBtn.addEventListener('click', () => cb(this.side));
  }

  onToggleMode(cb) {
    this.el.modeBtn.addEventListener('click', cb);
  }

  // 进场页的「进军！」。只认这一下点击 —— 点别处、按键盘都不算
  onEnter(cb) {
    if (this.el.enterBtn) this.el.enterBtn.addEventListener('click', cb);
  }

  // 移动模式 / 瞄准模式。
  // pending 不为 null 时表示"正在切过去"：按钮上写明目标模式，一秒后才会真正生效
  setMode(precise, pending = null) {
    const key = `${precise}|${pending}`;
    if (key === this._modeKey) return;
    this._modeKey = key;
    this.el.modeBtn.textContent = pending === null
      ? (precise ? '瞄准模式 · F' : '移动模式 · F')
      : `切换到${pending ? '瞄准' : '移动'}模式…`;
    this.el.modeBtn.classList.toggle('switching', pending !== null);
    this.el.modeBtn.classList.toggle('aim', precise);
    this.el.crosshair.classList.toggle('aim', precise);
  }

  showGame() {
    this.el.overlay.classList.add('hidden');
    this.el.hud.classList.remove('hidden');
    // 上一局结算的黑屏可能还挂着计时器，清干净，免得它影响下一局
    if (this.blackoutTimer) {
      clearTimeout(this.blackoutTimer);
      this.blackoutTimer = null;
    }
    if (this.el.blackout) this.el.blackout.classList.add('hidden');
  }

  showMenu() {
    this.el.overlay.classList.remove('hidden');
    this.el.menuPanel.classList.remove('hidden');
    this.el.overPanel.classList.add('hidden');
    this.el.hud.classList.add('hidden');
  }

  // 撤掉进场页（点过「进军！」之后）
  hideEnterGate() {
    if (this.el.enterGate) this.el.enterGate.classList.add('hidden');
  }

  // 结算黑屏：先把整个界面盖成黑的（也挡住点击），过一会儿再露出来。
  // 目的是别让"还在按开火"的手指点到刚出现的「再来一局」。
  blackout(seconds = 1) {
    const el = this.el.blackout;
    if (!el) return;
    el.classList.remove('hidden');
    if (this.blackoutTimer) clearTimeout(this.blackoutTimer);
    this.blackoutTimer = setTimeout(() => {
      el.classList.add('hidden');
      this.blackoutTimer = null;
    }, Math.max(0, seconds) * 1000);
  }

  // win: true=胜 / false=负 / null=平局（两边同一刻都打光了）
  showGameOver(win, stats) {
    this.el.overlay.classList.remove('hidden');
    this.el.menuPanel.classList.add('hidden');
    this.el.overPanel.classList.remove('hidden');
    const draw = win === null || win === undefined;
    this.el.overTitle.textContent = draw ? '平局' : win ? '战斗胜利' : '战斗失败';
    this.el.overTitle.className = draw ? 'draw' : win ? 'win' : 'lose';
    this.el.overStats.innerHTML = `
      <li><span>你击毁的敌军</span><b>${stats.kills}</b></li>
      <li><span>误伤友军</span><b class="warn">${stats.friendlyKills}</b></li>
      <li><span>击落飞机</span><b>${stats.planesDown}</b></li>
      <li><span>我方阵亡</span><b>${stats.allyLost}</b></li>
      <li><span>敌方损失</span><b>${stats.enemyLost}</b></li>
      <li><span>你的阵亡次数</span><b>${stats.playerDeaths}</b></li>
      <li><span>战斗时长</span><b>${stats.duration}</b></li>
    `;
  }

  setCounts(state) {
    // 只显示**我方**兵力。敌方剩多少是情报 —— 这战场没有小地图、看不到别人血量，
    // 数量也一样不该白送。原来还留了两格写「?」，等于占着地方说废话，干脆整块删掉
    this.el.ally.textContent = state.allyAlive;
    this.el.allyAir.textContent = state.allyAir;
    // 你的击毁：顺带标出"我方一共打掉多少"。队友干的活本来完全不露脸，
    // 玩家很容易觉得"全是我一个人打的"（实测队友包了大头）——
    // 把队伍的战果摆出来，这一局才像一场联合作战
    const mine = state.kills;
    const team = mine + (state.allyKills || 0);
    this.el.kills.textContent = team > mine ? `${mine}（我方共 ${team}）` : `${mine}`;
    this.el.friendlyKills.textContent = state.friendlyKills;
    this.el.planes.textContent = state.planesDown;
  }

  // 顶上那排兵力标签：本局有什么就写什么（船 / 坦克 / 飞机）。
  // 混编局里"友军 坦克 / 飞机"会把水里的船也数进去，说不清楚，所以跟着阵容走。
  // 敌方那块已经不显示了 —— 不写"情报不明"这种占位的话
  setForceLabels({ boat, tank, air }) {
    const kinds = [];
    if (boat) kinds.push('炮艇');
    if (tank) kinds.push('坦克');
    if (air) kinds.push('飞机');
    const text = kinds.length ? ` / ${kinds.join(' / ')}` : '';
    if (this.el.labelAlly) this.el.labelAlly.textContent = `友军${text}`;
    // 只有船的时候量词用"艘"，免得"2 辆炮艇"读着别扭
    const unit = boat && !tank ? '艘' : '辆';
    if (this.el.unitAlly) this.el.unitAlly.textContent = unit;
  }

  setPlayer(tank) {
    const ratio = Math.max(0, tank.health / tank.maxHealth);
    this.el.healthFill.style.width = `${ratio * 100}%`;
    this.el.healthFill.style.background = ratio > 0.6 ? '#4ad07a' : ratio > 0.3 ? '#ffc24a' : '#ff4a3d';
    this.el.healthText.textContent = `${Math.ceil(tank.health)}`;

    // 修复上限刻度：白线右边是永久损失的血，怎么修都回不来
    const ceiling = Math.min(tank.maxHealth, Math.max(0, tank.repairCeiling));
    this.el.healthCap.style.left = `${(ceiling / tank.maxHealth) * 100}%`;
    this.el.healthCap.classList.toggle('hidden', ceiling >= tank.maxHealth - 0.5);

    if (tank.repairing) {
      this.el.repairHint.classList.remove('hidden');
      this.el.repairHint.classList.add('repairing');
      this.el.repairHint.textContent = `应急修复中… 还需 ${tank.repairTimer.toFixed(1)}s（别动、别开炮）`;
    } else if (tank.canRepair) {
      this.el.repairHint.classList.remove('hidden');
      this.el.repairHint.classList.remove('repairing');
      // 耗时就写在提示里：修得多就久、修得少就快，心里有数
      this.el.repairHint.textContent =
        `按 R 应急修复：可修回 ${(ceiling - tank.health).toFixed(0)} 点，` +
        `约 ${tank.repairDuration.toFixed(1)} 秒（上限 ${ceiling.toFixed(0)}）`;
    } else {
      this.el.repairHint.classList.add('hidden');
    }

    // 弹夹：显示已经压好的弹；弹链式装填，随时都在补，所以用"装填中"标注。
    // 炮艇是一轮齐射一起打的，用"齐射"两个字更贴切（还要标出"够不够一轮"）
    const mag = tank.magazine;
    const kind = tank.isBoat ? `齐射 ${tank.rounds} / ${mag}` : `弹夹 ${tank.rounds} / ${mag}`;
    this.el.reloadFill.style.width = `${(tank.rounds / mag) * 100}%`;
    // 炮艇：不满一轮齐射是打不出去的，进度条也就别标"就绪"
    const ready = tank.isBoat ? tank.rounds >= (tank.salvo || 1) : tank.rounds > 0;
    this.el.reloadFill.classList.toggle('ready', ready);
    this.el.reloadLabel.textContent = tank.loading ? `${kind} · 装填中` : kind;
  }

  // 飞机仪表：油门 / 本轮余弹 / 离地高度
  setPlayerPlane(plane, groundY = 0) {
    const cfg = CONFIG.playerPlane;
    const t = (plane.throttle - cfg.throttleMin) / (cfg.throttleMax - cfg.throttleMin);
    this.el.throttleFill.style.width = `${Math.max(0, Math.min(1, t)) * 100}%`;
    this.el.throttleLabel.textContent = `油门 ${Math.round(plane.throttle * 100)}%`;

    const burst = Math.max(0, plane.burst);
    this.el.planeAmmoFill.style.width = `${(burst / cfg.burst) * 100}%`;
    this.el.planeAmmoFill.classList.toggle('ready', burst > 0);
    this.el.planeAmmoLabel.textContent = plane.fireCooldown > 0
      ? `机炮冷却 ${plane.fireCooldown.toFixed(1)}s`
      : `机炮 ${burst} / ${cfg.burst}`;

    this.el.planeAlt.textContent = `离地 ${Math.max(0, Math.round(plane.pos.y - groundY))} m`;
  }

  // 阵亡后的头 5 秒：镜头绕着自己的残骸转，先看完再转上帝视角
  setDeathCam() {
    this.el.spectateHint.classList.remove('hidden');
    this.el.spectateHint.textContent = '你被击毁';
    this.el.crosshair.classList.add('hidden');
    this.el.modeWidget.classList.add('hidden');
    this.el.repairHint.classList.add('hidden');
    this.el.bottomBar.classList.add('hidden');
  }

  // 阵亡后转上帝视角（高处俯瞰交战区，鼠标仍可转视角）
  setSpectating() {
    this.el.spectateHint.classList.remove('hidden');
    // 提示挂在屏幕下缘（原来是 58%，正好压在交战区上，挡观战）。
    // 顺带告诉玩家能缩放 —— 空战离得远，不拉近看不清
    this.el.spectateHint.textContent = '你已被击毁 · 上帝视角观战（鼠标 / 方向键转视角，滚轮拉远拉近）';
    this.el.crosshair.classList.add('hidden');
    // 人都没了，模式按钮、仪表和修复提示就别占着屏幕
    this.el.modeWidget.classList.add('hidden');
    this.el.repairHint.classList.add('hidden');
    this.el.bottomBar.classList.add('hidden');
  }

  stopSpectating() {
    this.el.spectateHint.classList.add('hidden');
    this.el.crosshair.classList.remove('hidden');
    this.el.bottomBar.classList.remove('hidden');
    this.applySide(this.side);
  }

  feed(text, cls = '') {
    const div = document.createElement('div');
    div.className = `feed-item ${cls}`;
    div.textContent = text;
    this.el.feed.appendChild(div);
    // 情报和警告要看得清：多留一会儿，字号也更大（见 style.css）
    const important = cls === 'air' || cls === 'danger';
    const item = { el: div, t: 0, hold: important ? 7.5 : 4.8 };
    this.feedItems.push(item);
    if (this.feedItems.length > 6) {
      const old = this.feedItems.shift();
      old.el.remove();
    }
  }

  updateFeed(dt) {
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const f = this.feedItems[i];
      f.t += dt;
      if (f.t > f.hold - 0.8) {
        f.el.classList.add('fade');
      }
      if (f.t > f.hold) {
        f.el.remove();
        this.feedItems.splice(i, 1);
      }
    }
  }

  banner(title, sub, duration = 2.4) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub || '';
    this.el.banner.classList.remove('hidden');
    this.el.banner.classList.add('show');
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      this.el.banner.classList.remove('show');
    }, duration * 1000);
  }

  hitMark(kind = 'hit') {
    const m = this.el.hitmarker;
    m.className = '';
    void m.offsetWidth;
    m.className = `show ${kind}`;
    setTimeout(() => {
      m.className = '';
    }, 220);
  }

  crosshairKick() {
    this.el.crosshair.classList.add('kick');
    setTimeout(() => this.el.crosshair.classList.remove('kick'), 90);
  }

  damage() {
    this.damageLevel = Math.min(1, this.damageLevel + 0.45);
  }

  update(dt) {
    if (this.damageLevel > 0) {
      this.damageLevel = Math.max(0, this.damageLevel - dt * 1.4);
      this.el.damageFlash.style.opacity = String(this.damageLevel * 0.75);
    }
    this.updateFeed(dt);
  }

  setStatus(text) {
    this.el.statusLine.textContent = text;
  }
}
