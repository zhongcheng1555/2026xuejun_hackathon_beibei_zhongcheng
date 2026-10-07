// 所有可调数值集中在这里，改一个数字就能改手感

export const CONFIG = {
  // 战场边界：四周环形山壁
  map: {
    wallHeight: 46,   // 环形山壁高度
    wallStart: 0.8,   // 从 80% 半径处开始抬升成山
    backdrop: 6000,   // 地图外远景平地的边长（铺到雾里，别让世界在地平线断掉）
    backdropLevel: 0.86, // 远景平地的高度 = 山壁高度 × 这个系数
  },

  terrain: {
    cell: 4.2,        // 每个地形网格边长（米），地图越大格子自动放粗
    minSeg: 90,
    maxSeg: 170,
    uphillSlow: 2.6,  // 上坡减速系数（坡度 × 这个数）
    speedMin: 0.45,   // 最慢（陡上坡）
    speedMax: 1.55,   // 最快（下坡）
    waterSpeed: 0.45, // 水里减速
  },

  tank: {
    health: 100,
    radius: 3.4,
    // 移动速度 / 车体转向：**玩家和 AI 共用这一个数**。
    // 以前是分开的两份（玩家 15 / AI 12.5，转向 1.8 / 1.6），等于玩家快 19% ——
    // 再加上 AI 每帧还要乘"意图强度"和"转向对齐度"，机动性是全面吃亏。
    // 只留一份就不用担心哪天又飘开；取值是两边原来的中间值
    speed: 14,           // 最高速度（米/秒）
    turnSpeed: 1.7,      // 车体转向（弧度/秒），玩家能原地掉头、AI 边走边转
    reverseSpeed: 0.6,   // 倒车速度比例
    // 切"移动 ⇄ 瞄准"模式要多久才生效：按下之后先留在原模式这么久，
    // 期间照样能开炮、能跑 —— 免得一秒内来回点两下白嫖两种模式的优点
    modeSwitchTime: 1,
    turretSpeed: 2.3,    // 炮塔转向
    turretPitchSpeed: 1.5,
    // 炮塔俯仰的上下限（玩家和 AI **共用**这一条线）。
    // 0.6 rad ≈ 34°：两个人都够不到"接近正上方"。
    // 这里削的是 **AI** —— 以前 AI 能算到 1.15 rad（66°），它在天上打飞机太准，
    // 而玩家被镜头卡在 34° 左右，等于白挨打。
    // 教训：这种"两边不对等"要削 AI，**不是**把玩家也顶到 66°
    // （把玩家顶上去 = 玩家对空无敌，之前干过一次，被骂回来了）
    turretPitchMin: -0.6,
    turretPitchMax: 0.6,
    // 应急修复：只能修回累计伤害的一半，另一半永久损失。
    // 耗时跟着"实际要修多少血"走 —— 原来是固定 10 秒，
    // 只能修 1 点血的时候也要罚站 10 秒，特别尴尬。
    // 按这个速度算，修满 50 点正好 10 秒，和以前的手感对得上
    repairSpeed: 5,          // 每秒最多修回多少血（耗时 = 要修的血量 ÷ 这个速度）
    repairMinTime: 1.2,      // 再少也要修这么久（瞬间修好会看不出来修过）
    repairRatio: 0.5,        // 最多修回累计伤害的几成
    // 两栖：坦克能下水（大湖 / 河道），但水里很难受 ——
    // 跑得慢（见 terrain.waterSpeed）、不能修车、炮塔转得迟钝
    waterTurretMul: 0.45,    // 水里炮塔转向只剩这么多
    waterDraft: 0.9,         // 浮在水面下这么深（车底没入水里的部分）
    // 能涉水的最大水深：比这浅的岸边浅滩可以开进去，
    // 比这深才算"深水墙"（坦克浮起来、再往里顶就顶不动了）。
    // 注意坦克**不浮在水面**：它踩的是湖边的淤泥（玩家反馈），
    // 所以这个深度同时决定"水会不会没到车顶"——0.9 米刚好淹到履带上方
    wadeDepth: 1.35,
    wadeMaxFrac: 0.06,       // 最多允许往水里多趟"湖半径的百分之几"：
                             // 湖底是起伏的，光看水深的话，某些方向能一路趟到湖心
    corpseTime: 5,           // 阵亡后：烧成黑壳 + 冒黑烟，5 秒自己消失（玩家这 5 秒看自己的残骸）
    magazine: 10,        // 弹夹容量：能连发 10 发
    shotInterval: 0.18,  // 连发间隔（秒）
    loadPerShell: 0.5,   // 弹链式装填：每装一颗的时间。打完立刻开始装下一颗，不用等打空
    aiLoadPerShell: [0.55, 0.85],
    // AI 不扫射：一轮点射几发，然后停一下（玩家不受此限制）
    aiBurst: [3, 4],
    aiBurstPause: [2.2, 3.4],
  },

  // 音效：全部现场合成（Web Audio），不需要任何音频素材文件
  audio: {
    volume: 0.5,          // 总音量（按 M 静音）
    maxDist: 240,         // 超出这个距离的声音不生成（省算力）
    engineVolume: 0.22,   // 引擎底噪音量
    engineBaseHz: 190,    // 引擎底噪的滤波频率（飞机自动翻倍变尖）
  },

  // 夜战：每局 10% 概率入夜，任何地形都可能赶上。
  // 入夜后整体压暗，这时候枪口火光、曳光弹和爆炸会短暂照亮周围，格外醒目
  night: {
    chance: 0.1,
    fog: 0x121a26,
    skyTop: 0x06090f,
    skyBottom: 0x1b2634,
    sun: 0xa8c0e0,      // 月光：冷白
    fogScale: [0.5, 0.45],  // 雾更近更浓（夜里看不远）
    // 夜里的亮度：玩家反馈"晚上太暗了"。压得太狠的话，
    // 涂装、地形起伏、远处敌车全看不清，只剩枪口火光 —— 那就不是"夜战"是"瞎打"了。
    // 所以整体往上提了一档：夜里仍然明显比白天暗、看得近，但该看见的能看见
    sunMul: 0.3,
    hemiMul: 0.5,
    ambientMul: 0.75,
    // 夜里的岩浆要比白天更亮：它是光源，不是被照的东西。
    // 不抬的话，夜里岩浆比白天还暗（玩家反馈"晚上的火山岩浆也很暗"）
    lavaGlowMul: 2.1,        // 岩浆河的自发光倍率
    lavaLightMul: 1.9,       // 岩浆河 / 火山口的点光源倍率

    // 夜战对"坦克打飞机"的影响：夜里就是看不清天上的东西。
    // 注意这是**削弱 AI**，不是加强玩家 —— 白天 AI 的防空已经把飞机逼得很紧，
    // 夜里再一样狠，等于开飞机就是送死。
    antiairRangeMul: 0.45,   // 防空交战距离缩到这个比例（210m -> 95m）
    planeAimErrorMul: 2.6,   // 打飞机的常驻偏差再放大这么多（本来就难，夜里更难）
    mopUpErrorMul: 1.5,      // 残局搜剿时的放大（比常态小，不然这局永远收不掉）
    blindEvery: [1.6, 4.0],  // 能看见持续多久，之后转入"跟丢"
    blindFor: [0.8, 2.2],    // 跟丢持续多久（这几秒里它完全不看天上）
  },

  // 海战（第三种载具：炮艇）。只能在水里跑，一上岸就被"海岸线"挡回去。
  //
  // 定位：**炮舰，不是一个"水里的坦克"**。三样载具各有各的活法：
  //   坦克：单发点射、弹夹 10 发、能持续输出，装甲最厚 —— 阵地战
  //   飞机：最快、能打天也能打地，但只有一滴血 —— 一击脱离
  //   炮艇：**一轮齐射糊脸**（3 发扇形同时出膛）+ 舰炮远距离更准 + 能抬头打飞机
  //         代价是皮最薄、转向最笨、齐射之后有一段长空窗（打空就只能绕圈跑）
  boat: {
    // 血量：原来 70 太脆了 —— 敌方一轮齐射就是 54，实战里交火后 5~7 秒就沉。
    // 现在是「比坦克略脆」，而不是纸糊的：95 扛得住两轮齐射
    health: 95,
    radius: 3.4,
    // 航速最快（坦克 14）、船头转向最笨（坦克 1.7）—— 直线谁也追不上，
    // 但礁岛之间被人绕到屁股后面就转不回来
    speed: 18.5,
    turnSpeed: 1.45,
    // **齐射**：一次扳机打出 salvo 发，呈固定扇形铺开。
    // 坦克是一发一发精确点射，炮艇是一撮同时出膛：近距离糊脸、打移动目标容错高，
    // 代价是这几发共用一次装填
    salvo: 3,
    salvoSpread: 0.05,      // 扇形半角（弧度）≈ 2.9°：30 米外三发横向散开约 3 米
    // 弹夹 = **两轮**齐射：打完一轮还能接着补一轮，不至于放完就干瞪眼
    magazine: 6,
    loadPerShell: 1.2,      // 每颗压弹时间：补满一轮齐射约 3.6 秒
    aiLoadPerShell: [1.35, 1.8],
    // 舰炮：初速更高、弹道更平，而且**AI 的瞄准误差按距离放大时只有坦克的四成**
    // —— 远处那几炮比坦克准得多，这是"舰炮"和"坦克炮"的区别
    shellSpeed: 215,
    // 单发 14：一轮齐射 42。原来是 18（一轮 54）——
    // 三发几乎在同一个瞬间砸下来，太致命了，交火两三秒就沉
    shellDamage: 14,
    aimErrorMul: 0.65,
    // 炮塔仰角比坦克大（坦克 0.6 rad ≈ 34°）：能抬头打低空飞机。
    // 船本来就是防空平台，所有炮艇都会抬头，不用抽签
    turretPitchMax: 0.95,
    // 炮艇**没有瞄准模式**：它本来就比飞机准、单发也更重，再给一个"停车慢瞄"就过强了。
    // 它永远是常速，F 键对它无效（玩家要求）
    noAimMode: true,
    // 修复：炮艇是"边开边修" —— 移动不打断修复，速度降到瞄准模式那一档，只是不能开炮。
    // 坦克是"停下、罚站、修完再打"，炮艇是"拖着破船跑，一边补"
    repairMoveMul: 0.35,
    perTeam: 2,             // 湖上混编战里每边几条船（玩家开的那条算我方一条）
    seaPerTeam: 6,          // 海图每边几条船 —— 那么大一片水，两条船根本碰不上
    draft: 0.9,             // 吃水：船体沉到水面下多少
    keepIn: 0.94,           // 船最多跑到"真实水线的这个比例处"（免得开上岸）
    spawnFrac: 0.7,         // 出生点摆在"真实水线的几成处"（越靠里越稳在水里）
    // 混编：湖是唯一"陆水都能打"的图，所以混编都发生在湖上（海是纯炮艇图）
    lakeMixTankChance: 0.4,   // 湖战里额外出现坦克的概率（两边各 1 辆）
    lakeMixPlaneChance: 0.4,  // 湖战里额外出现飞机的概率（两边各 2 架）
    lakeMixTanks: 1,          // 混编坦克时每边几辆
    lakeMixPlanes: 2,         // 混编飞机时每边几架
    landMixBoatChance: 0.5,   // 坦克/飞机模式抽到「湖」图时，额外刷炮艇的概率（两边各 1 艘）
  },

  // 彩蛋：子弹顺着太阳的方向打上去 = 把太阳打碎 —— 太阳先裂开飞散、再渐隐，
  // 整个天慢慢黑成深夜（这一局不再亮回来）。
  // 注意：**别写进规则/README**，让玩家自己撞出来
  sunBreak: {
    hitRad: 0.075,     // 子弹方向与太阳方向的夹角小于这个就算打中（弧度，约 4.3°）
    fadeTime: 1.8,     // 太阳本体渐隐用多久
    nightTime: 3.4,    // 从白天过渡到深夜用多久
    shards: 24,        // 碎成几块
  },

  // 特殊玩法：纯空战。
  // 抽中后地面清空、天上 2 对 2，每架飞机 3 次复活机会。
  // 开飞机才会碰到，开坦克时的机会小得多；右下角有测试开关可以强制它必出。
  // 平时（没抽中）这些数字完全不参与，节奏还是老样子
  mode: {
    pureAirChance: 0.15,      // 你「开飞机」时抽中纯空战的概率
    // 你「开坦克」时抽中的概率。抽中的话你就是"空战里那辆坦克"：
    // 地面只有你一辆，天上两边各 2 架 AI 飞机在打
    pureAirChanceTank: 0.01,
    // 纯陆战：只有"你开坦克"时才可能抽到。天上一个飞机都没有（两边空军都不上场），
    // 地面照旧打 —— 就是最原始的那种坦克大战。侦察兵照常派
    pureGroundChance: 0.10,
    pureAirPerSide: 2,        // 纯空战里每边几架飞机（2 = 2 对 2。
                              // 飞机池按 plane.count 分：5 架 = 我方 3 / 敌方 2，所以最多 2 对 2）
    // 地面那辆坦克：每局抽一次"这一局地面有没有坦克"（至少一边有）。
    // 抽中的话再决定是"两边都有"还是"只有随机某一方" —— 不是必然两边都有
    pureAirTankChance: 0.10,  // 这局地面出现坦克的概率
    pureAirTankBothChance: 0.5, // 出现坦克的局里，"两边都有"占几成（剩下的是随机某一方）
    // 纯空战里那辆坦克（AI 的那辆，和你自己开的那辆都一样）每 20 秒才能打一炮：
    // 弹夹压成 1 发、装填拉长。不压的话它对着天上的飞机太强了
    pureAirTankReload: 20,
    planeLives: 3,            // 每架飞机 3 次复活机会，用完再被打下来就彻底出局
    respawnDelay: 6,          // 被击落到重新升空隔几秒（残骸 5 秒后消失，正好接上）
    // 玩家那架不等残骸落地：纯空战里一死就黑屏（黑屏 1 秒，见 main.js），
    // 所以要比黑屏更早一点把人放回天上，换机那一下正好被黑屏盖住
    playerRespawnDelay: 0.7,
  },

  // 雪地履带印：坦克压过之后留在地上的痕迹（只有开了 tracks 的地形才有）
  // 用环形缓冲 + InstancedMesh，压几万条也只有 1 个 draw call
  tracks: {
    max: 600,          // 上限（超过就从最旧的开始覆盖）
    gap: 3.0,          // 每开多少米压一道
    life: 26,          // 多少秒后被雪盖回去
    width: 0.85,       // 单条履带的宽度
    length: 3.4,       // 单道印子的长度
    spread: 1.15,      // 左右两条履带离车体中线的距离
    color: 0x93a6ba,   // 压实的雪：比周围暗一点、偏冷
  },

  bullet: {
    speed: 150,          // 出速（够快才打得到飞机；曳光被拉长所以依然看得清）
    gravity: 2.6,        // 轻微下坠，炮弹有真实飞行时间
    life: 7,
    radius: 0.42,
    damage: 16,          // 单发伤害：7 发打爆一辆，一个弹夹刚好够打掉一辆多
    spread: 0.012,       // 基础散布（永远保留，任何模式都不可能绝对精准）
    interceptRadius: 1.15, // 子弹对撞：两发敌我炮弹近了就互相引爆（拦截）
  },

  // 玩家两种模式：移动模式跑得快但打不准，瞄准模式走得慢但很准
  player: {
    aimSpeed: 0.35,      // 瞄准模式车速倍率
  },

  // BOSS 坦克（一局里低概率出现，敌我两边都可能刷）：
  // 更大、更厚、炮更大、比普通坦克稍快；移动模式误差很小，进瞄准模式零误差，
  // 炮弹还带一点点跟踪。纯空战 / 纯海战里不出
  boss: {
    chance: 0.07,          // 每局出现（某一方刷一台）的概率
    health: 260,           // 普通车 100
    radius: 5.2,           // 普通车 3.4
    speed: 15,             // 比普通坦克（14）轻微快一点
    turnSpeed: 1.5,
    magazine: 3,           // 炮更大所以一夹更少
    loadPerShell: [2.4, 3.2],
    shellDamage: 26,       // 单发 26（普通 16）
    shellSpeed: 165,
    homing: 1.6,           // 轻微跟踪的强度（越大转得越快；躲还是躲得开）
    homingRange: 95,       // 只在这个距离内跟（出了射程就直飞）
    aimErrorMove: 0.3,     // 移动模式的瞄准误差倍率（普通车是 1）
    // 随从：BOSS 出现时，如果"对手"的坦克+飞机+炮艇 ≥ escortMinFoe，
    // 它随机带 1~2 个随从（类型也是随机：坦克/飞机/船，海图才可能有船）
    escortMinFoe: 8,
    escortMax: 2,
  },

  // 开炮瞬间的散布倍率（再乘上 CONFIG.bullet.spread = 0.012）。
  // **玩家和 AI 共用这一套** —— 以前两边各写一份（玩家 0.22 / 1.7，AI 0.9 / 2.6），
  // 玩家的炮弹比 AI 准得多。既然要公平就统一，取原来偏大的那一份（AI 的）。
  // 注意这只是"开炮那一下的散布"；AI 另外还有一个常驻瞄准偏差（CONFIG.ai.aimError）
  spread: {
    aim: 0.9,            // 瞄准模式：0.9 × 0.012 ≈ 0.011 rad
    move: 2.6,           // 移动模式：2.6 × 0.012 ≈ 0.031 rad
  },

  // 环境反射（材质的关键一环）：拿天空的两段颜色现画一张很小的渐变图，
  // 挂在场景的 environment 上，金属件才有东西可反射 —— 没有它的话，
  // 材质里的 metalness 只会让表面发灰发黑（金属只反射环境光）
  render: {
    envLight: 0.5,       // 这张环境图的亮度系数；调到 0 就整个关掉（回到纯灯光照明）
    envAmbientComp: 0.6, // 开了环境光之后，把 ambient 灯压到这个比例，免得整体变太亮
  },

  // 火山喷发：火山熔岩这张图的专属收尾。
  // 打满 2:30 还没分出胜负，火山就喷 —— 火焰从火山口往外一圈圈蔓延，
  // 坦克的活动范围被越挤越小，到 3:00 吞掉整个战场，剩下的坦克很快就烧没了。
  // 不走"往天上喷柱淹没飞机"那套：火焰只在地面上爬，天上的飞机不受影响
  volcano: {
    r: 72,            // 火山底半径（米）
    rim: 52,          // 火山口边缘比周围地面高多少
    crater: 22,       // 火山口半径
    craterDepth: 22,  // 火山口往下凹多少（要够深才看得出是个碗）
    lag: 8,           // 火焰从火山口外这么多米开始（别一上来就点着火山口里）
    eruptAt: 90,      // 打满 1 分半就开喷（更早，火山这张图的特殊节奏来得更快）
    fullAt: 210,      // 到 3 分半才铺满整个战场 —— 喷得早、爬得慢，中间一直是拉锯
    fxEvery: 0.35,    // 火线上每隔这么久炸一团火（视觉）
    slowMul: 0.55,    // 火里的速度倍率（跑不动，但还能挪）
  },

  // 规模：玩家 + 随机 4~9 辆 AI 队友；敌方总数和友方一样或 ±1
  // 双方都是固定编制，阵亡不补，一方全灭即结束
  battle: {
    allyMin: 4,
    allyMax: 9,
    teamDiff: 1,
    spectateOnDeath: true,
  },

  ai: {
    viewRange: 200,
    engageMin: 32,
    engageMax: 95,
    engageHold: 52,          // 想保持的交火距离：比这远就往里压，比这近就往外散
    aimError: 0.055,         // 常驻瞄准偏差（弧度，按距离换算成米）
    aimErrorMoving: 0.045,   // 移动中额外偏差
    fireAngle: 0.07,         // 转到这个角度内才开火
    // 交火时的"停车开火 ↔ 挪一段"节奏（秒）。
    // 停车那一段切瞄准模式、原地不动 —— 移动中散布是瞄准时的 2.6 倍，
    // AI 原来从来不站住，所以远距离老是打不准
    aimHold: [0.9, 2.2],     // 站住打多久
    aimMove: [0.8, 1.8],     // 然后挪多久
    // 每辆车"想保持的交火距离"在 engageHold 附近浮动（乘数）：
    // 有的车偏爱贴上去打，有的就爱在远一点的地方对射 —— 不是所有车一个脾气。
    // 0.78~1.42 倍就是 40~74 米
    engagePrefMul: [0.78, 1.42],
    reaction: [0.8, 2.1],    // 发现目标后的反应延迟
    // 队友被打了就去帮他扛：附近有队友最近挨过打，就优先换成"正打他的那个敌人"。
    // 玩家反馈"我方的行动应该能带动队友" —— 一个队友在挨打/后退，
    // 附近的队友该去切断那个追兵的注意力，而不是各打各的
    helpAllyRange: 110,      // 这个范围内挨打的队友才管（太远的不去）
    planeAimErrorMul: 2.2,   // AI 打飞机时瞄准误差放大倍数（对空最难，别让坦克把飞机当靶子打）
    planeMopUpErrorMul: 1.0, // 敌方地面清空后的搜剿：恢复正常准头，否则残局收不掉
    mopUpRange: 520,         // 搜剿阶段的视野（放开一点，好让坦克能咬住天上的飞机）
    lateGameViewRange: 480,  // 残局（敌方地面只剩 1~2 辆）的搜索范围，免得幸存者在超大地图上互相找不到
    // 敌方侦察兵：最低优先级目标。只在"手头真的没别的事"时才去清，
    // 毕竟侦察兵会一直补人，不值得为它漏掉真敌人
    scoutHuntRange: 150,
    // 打侦察兵时直接碾过去（压扁）而不是保持交火距离。
    // 侦察兵一滴血、又小又快，坦克比它快（12.5 vs 8.5）追得上；
    // 原来套的是打坦克那套（进 engageMin 就往后倒），永远碰不到它
    ramScouts: true,
    // 战斗时不站到友军的炮口正前方。开炮前收手（_friendlyInLine）只能挡住
    // "我瞄的时候你正好在弹道上"，挡不住"我自己开车怼进别人的弹道里" ——
    // 炮弹飞出去之后友军再让开就晚了。所以走位上也要主动让开车道
    allyLineGap: 13,         // 横向离友军弹道多近就算"挡着了"（米）
    allyLinePush: 1.1,       // 让开的力度（贴到弹道上时会翻倍，见 _dodgeAllyLine）
    allyLineBehind: 20,      // 目标背后这一小段里站着自己人也算挡着（炮弹打偏会飞过去）
    maxRetreat: 9,           // 残血撤退最多持续几秒；甩不掉追兵就回头打，避免"同速无限长跑"
    // 什么时候允许停下来修车。
    // 原来卡的是"最近敌人必须远在 viewRange*0.6 = 120m 之外才敢动手"，
    // 实战里几乎永远不满足 —— 所以坦克看着就像从来不修车。
    // 现在两条：① 这一带没敌人就能修；② 自己人明显多、敌人又没贴脸，就缩在队友后面修
    repairSafeRange: 90,     // 判断"这一带安不安全"的范围
    repairMateRatio: 2,      // 自己人至少是敌人的几倍，才敢在敌人眼皮底下修
    repairFoeDist: 45,       // 最近的敌人比这还近就别修了（会被贴脸打死）
    stuckTime: 1.6,
  },

  plane: {
    count: 5,
    speed: 40,
    altitude: [40, 60],   // 飞低一点，地面上抬头就能看见，不用靠影子认
    diveChance: 0.05,     // 每秒决定俯冲的概率
    diveDuration: 3.5,
    pullUpDuration: 2.6,
    pullUpAlt: 18,        // 俯冲最低拉到离地多高（有高障碍物的图会自动抬高，见 plane.diveFloor）
    pullUpClear: 16,      // 有隧道岩顶的图，最低高度要在岩顶之上再留这么多（改平还会下沉十几米）
    gunDamage: 26,
    gunInterval: 0.14,
    // ---- 撞地 / 撞障碍 / 被弹：机翼是能单独掉的 ----
    // 飞机的"血"还是只有 1 滴，但分部位了：打在机身/机头 = 当场完；
    // 打在机翼上 = 那片机翼掉（飞机还活着，但开始失去平衡）
    wingZone: 3.4,        // 撞点/弹着点在机身坐标系里横向偏出这么多米，就算"打在我机翼上"
    wingDropCtrl: 0.45,   // 掉机翼后操控权只剩这么多
    wingBankRate: 0.8,    // 掉机翼后每秒多滚多少（弧度，越滚越厉害 = 逐渐失控）
    wingSinkRate: 1.8,    // 掉机翼后每秒往下沉多少（米/秒，逐渐加快）
    bodyClear: 1.3,       // 机身中心离地低于这个就算碰到地了
    wingCrash: 6.5,       // 两机中心近到这个距离就算"撞上了"（翼展半边，翼尖擦到就算）
    softLandVy: 7.5,      // 下沉速度低于这个值算"平稳落地"：不炸，趴地上慢慢烧
    burnTime: 14,         // 平稳落地后烧多久才烧完（以前 7 秒太急，断翼的来不及反打）
    burst: [2, 5],        // 一次俯冲最多搂 5 发，不能像扫射一样没完没了
    // 趴在地上烧的那架（残骸炮台）打完一轮也要歇 —— 以前这里没写停顿，
    // 它一轮打完立刻把弹数补满，等于无限机枪，比在天上还猛，太不公平
    groundBurstPause: [1.5, 2.5],
    hitSigma: 0.175,      // 瞄准误差 1σ≈10°，单次俯冲命中率约 4%
    health: 1,            // 飞机只有一滴血：打中一发就掉，难在打中而不在打疼
    corpseTime: 5,        // 被击落：烧成黑壳往下坠，落地继续冒烟，5 秒后消失
    radius: 3.0,
    minTargetDist: 26,
    // 空中缠斗：只在高空平飞时发生，俯冲中绝不参与（横向对穿，难度最高）
    dogfightChance: 0.025,   // 巡航时每秒去找对手的概率
    airRange: 460,          // 多近才缠上
    airAltBand: 26,         // 高度差超过这个就不纠缠
    airMinAlt: 34,          // 低于这个高度不打空战（那是俯冲的地盘）
    airHoldAlt: 52,         // 打空战时保持的高度
    airDuration: [9, 16],   // 一次缠斗持续多久
    // 友机之间会自动拉开，别挤成一团（两架贴上就是同归于尽）
    sepRange: 34,     // 进到这个距离内就开始互相避开
    // 让开自己人的弹道：友机看到自家人（含玩家）朝这边打，会横着让开。
    // 只躲"同阵营"的炮弹 —— 敌方不会躲你的弹，不然你就打不着人了
    dodgeRange: 150,  // 在这个距离内评估
    dodgeTime: 1.8,   // 预测未来 1.8 秒内的最近距离
    dodgeMiss: 16,    // 最近距离小于这个值才算"会打到我"
    dodgeHold: 0.9,   // 让开的动作持续多久
    dodgeCd: 1.6,     // 两次让开之间的冷却
    dodgeRate: 2.2,   // 让开时的转向速率（比巡航猛得多，不然来不及横移出弹道）
    airHitSigma: 0.30,      // 对空射击误差：比打地面大得多，所以很难打中
    // 防空：一部分坦克在地面打得正热闹时也会抬头打低空的飞机。
    // 没有这一条的话，飞机在地面战期间是"零风险刷分机"——敌坦克只盯地面目标，
    // 实测玩家开飞机平均 25 秒就把整场清完了（开坦克要 83 秒）。
    // 比例给得不高，所以地面战不会被带偏；而且对空命中率依旧很低（约一成）。
    antiairChance: 0.35,    // 有多少比例的坦克是"会抬头的"
    antiairRange: 210,      // 抬头打飞机的距离
    antiairAlt: 85,         // 只打这个高度以下的（飞得高就不管了，想安全就爬升）
    edgeWarn: 0.8,          // 飞到场地半径的这个比例时，AI 就专心往回拐（免得自己撞墙）
    crashRadius: 0.6,       // 两机相撞判定：距离小于 (双方半径和 × 这个系数) 就撞毁
    // 坠机砸坦克：被击落的飞机不是白白掉下去，而是朝最近的坦克扎过去。
    // 砸中不致命，只是把坦克震得短时间跑不动 —— 所以挨砸是"烦"而不是"死"
    wreckDiveAccel: 14,     // 坠落时朝坦克的水平引导（米/秒²），让它真的能"攻击"而不是纯靠运气
    wreckDiveMax: 45,       // 水平速度上限，别越追越快
    wreckHitRadius: 6,      // 砸中/烧到的判定余量：稍微沾边一点就算（不是只有正中心）
    wreckSlowHeight: 8,     // 要掉到离地这么近才算"砸到"，还在高空不算
    wreckSlowTime: 5,       // 被砸中后跑不动多久（秒）
    wreckSlowMul: 0.4,      // 这段时间的速度倍率（只剩四成，等于砍掉六成）
    wreckDamage: 45,        // 被坠落的飞机砸中：一次掉这么多血（坦克满血才 100）
    // 断翼之后的坠机：先想清楚"该摔哪儿"，再想"还能拉几个垫背的"
    wreckAvoidMate: 45,     // 附近有自己人就往外偏（绝不故意砸在队友头上）
    fallAirRange: 170,      // 坠落途中还能朝天上的敌机开炮的范围
    // AI 飞行员的"手抖"：概率极低 —— 压力机头扎向地面，或者直直飞出边界。
    // 之前 AI 飞机永远不会摔（边界保护 + 俯冲下限），玩家反馈"空军也该有很少的意外"。
    // 玩家的飞机不参与（杆在自己手里）
    pilotErrorChance: 0.0004,   // 每个 AI 飞行员每秒手抖的概率
    pilotErrorTime: [1.2, 2.6], // 手抖持续多久（这段时间压着机头，不管边界/不改平）
    // 平稳落地、又泡在水里的飞机：炮管进水，子弹"受潮"——
    // 方向乱飘得厉害，而且飞一小会儿就自己炸掉（飞不远）。陆地上趴着烧的不受影响
    wetSpreadMul: 8,        // 偏差按这个倍率放大
    wetSpreadMax: 0.3,      // 但不超过这么多弧度（约 17°）
    wetBulletLife: 0.25,    // 只活这么久（×200m/s ≈ 50m 就自爆）
  },

  // 玩家开飞机时的操控手感（比坦克难：一发就掉、飞得快、还得盯着边界）
  playerPlane: {
    // W/S 抬头低头（原来 W/S 是推油门，玩家反馈说想要用它控制上下）。
    // 油门改成自动固定在巡航速度，HUD 上那根油门条本来也已经不显示了
    pitchKeyRate: 1.0,      // 按住 W/S 时机头抬低的速度（弧度/秒）
    throttleMin: 0.55,      // 油门下限（相对飞机巡航速度）
    throttleMax: 1.45,      // 油门上限
    throttleRate: 1.1,      // 油门推杆速度（每秒）
    turnRate: 1.15,         // 机头转向速率（弧度/秒），比 AI 灵活一点
    // 机炮：一轮 4 发、打完冷却 1.2 秒 → 持续火力约 33 dps，和坦克主炮（约 32 dps）持平。
    // 之前是 26 伤害 + 一轮 5 发 + 0.9 秒冷却（约 84 dps），一架飞机 17 秒能清完全场，太强了。
    // 注意：打飞机不受影响 —— 飞机只有一滴血，打中就行，所以它依然是全场最好的"飞机杀手"，
    // 削的只是它对地面的压制力（现在扫射坦克要持续咬住十秒左右，得真的冒险低空盘旋）。
    gunDamage: 15,
    burst: 4,
    burstPause: 1.2,
    gunInterval: 0.15,
    gunSigma: 0.02,         // 玩家机炮散布（弧度）。不用 AI 那套 10°，否则根本没法瞄
  },

  camera: {
    distance: 21,
    focusHeight: 4.6,   // 镜头看向坦克上方多高
    heightBonus: 6,     // 镜头额外抬高：视角更高才看得清地面和障碍（之前贴地看，地平线一片糊）
    fov: 62,
    lookAhead: 10,
    sensitivity: 0.0026,
    defaultPitch: 0.05,  // 默认视线：配合抬高的机位，实际是微微俯视，准星落在车前约 60~70 米
    followLambda: 9,      // 镜头跟随车体转向的阻尼速度（越大跟得越紧，越小越柔）
    pitchMin: -0.45,     // 最低（往下看脚下）
    // 最高（抬头看飞机）。这个值不是"视线角度"，而是镜头的输入角度：
    // 吊臂一抬头就会被地面卡住（离地 2.6m），加上视线目标点只有车前 10m，
    // 实际传给炮塔的仰角会被压得很低 —— 给 1.0 时炮管只能抬到 34°。
    // 曾经为了"让玩家也够得着飞机"把它提到过 1.5（炮管顶到 66°），
    // 那是错的方向：该做的是把 AI 削到和玩家一样（见 tank.turretPitchMax），
    // 而不是把玩家也变成对空无敌。已经退回 1.0
    pitchMax: 1.0,

    // 玩家开飞机时的追尾镜头（比坦克拉得远、视角略高，才看得清航向和边界）
    plane: {
      distance: 27,
      focusHeight: 0,
      heightBonus: 2.5,
      lookAhead: 30,
      pitchMin: -0.9,        // 能往下看 51°：俯冲扫射要这个角度才瞄得到地面
      pitchMax: 0.8,
      sensitivity: 0.0023,
      followLambda: 7,
    },

    // 阵亡后的观战：上帝视角（高空俯瞰，自动飘到最激烈的交战区上方）
    god: {
      height: 190,       // 离地高度（米）
      pitchMin: 0.55,    // 视角与地面的夹角下限（越小越接近平视）
      pitchMax: 1.4,     // 接近正上方
      orbit: 0.05,       // 手不动时自己慢慢绕的速度（弧度/秒）
      follow: 2.2,       // 跟随交战区的阻尼
      zoomMin: 0.35,     // 滚轮拉近的下限（压到 0.35 就是贴着看）
      zoomMax: 2.4,      // 滚轮拉远的上限（空战拉远一点才看得全）
    },
  },

  effects: {
    maxImpacts: 60,
    maxCraters: 70,
  },

  // 探察小兵：1 滴血，满地图跑，替我方向玩家通报敌情
  scout: {
    count: 6,             // 总数（两边各一半）。原来 12，玩家反馈"满地都是、还打不完"
    speed: 8.5,
    respawn: 12,          // 倒下之后隔多久补一个
    respawnBudget: 3,     // **每边每局**最多补充几个。用完就不再补了（原来是无限制，所以永远打不完）
    spotRange: 120,       // 能看到多远的敌车
    fleeRange: 42,        // 撞见敌车就往反方向跑
    crushAvoid: 14,       // 离自家坦克这么近就侧身让开（别自己钻到履带底下被压扁）
    reportInterval: [9, 18],   // 单个侦察兵的通报间隔
    reportCooldown: 5,         // 全局通报间隔，免得刷屏
    // 我方的情报也报：侦察兵不只盯敌人，也看自己人 ——
    // "我方 N 辆扎堆，可以凑过去一起打" / "我方有一辆落单被围攻，需要支援"
    friendCooldown: 20,        // 我方情报的间隔（跟敌方那条分开限流）
    groupRange: 62,            // 自家车互相离这么近算"扎堆"
    groupMin: 3,               // 至少这么多辆才算一股
    swarmRange: 78,            // 判定"被围攻"时看多近的敌车
    swarmMin: 2,               // 至少这么多辆敌车围着才算被围攻
    mateRange: 70,             // 这个范围内没有自家车，就算"落单"
    warnCooldown: 16,          // "你被敌方侦察兵发现了"最短间隔
    blastRadius: 5,            // 爆炸震倒侦察兵的范围（炮弹落点、坦克/飞机爆炸都会震死人）
  },
};

export const COLORS = {
  player: 0x35c0e8,
  ally: 0x2f6fd0,
  enemy: 0xd8402f,
  playerTurret: 0x2aa2c9,
  allyTurret: 0x24539c,
  enemyTurret: 0xb02a1c,
  track: 0x2b2f33,
  barrel: 0x9aa3ab,
  wreck: 0x1c1d1f,
  plane: 0x6d757d,
  planeAlly: 0x3f86d8,   // 我方飞机：蓝
  planeEnemy: 0xc9412c,  // 敌方飞机：红
  planeDark: 0x2f353c,
  tracer: 0xffc24a,
  tracerEnemy: 0xff5a3c,
  tracerAir: 0xffb066,       // 敌机扫射：橙色
  tracerAirAlly: 0xa9dcff,   // 友机扫射：淡蓝
  scoutAlly: 0x4fb8e8,       // 我方侦察兵军装：亮蓝
  scoutEnemy: 0xe8752c,      // 敌方侦察兵军装：橙红
};

export const TEAM = {
  ALLY: 'ally',
  ENEMY: 'enemy',
  AIR: 'air',
};

// 被岩浆烧毁时用的"凶手"标记（只是个占位，让 HUD 能说清楚死因）
export const LAVA = { name: '岩浆', isHazard: true };

// 地形类型：每局随机抽一个，不只是换个排布，连地貌、尺寸、能见度都换
export const BIOMES = [
  {
    id: 'forest',
    name: '森林',
    size: 480,
    heightScale: 15,
    noiseScale: 0.006,
    ridge: 3.0,
    trees: 300, rocks: 105, bushes: 200, sandbags: 60,
    ground: { base: 0x4a6b34, second: 0x6f7b3c, rock: 0x6b6259, high: 0x8a8a86 },
    parts: { leaf: 0x2f5a2a, trunk: 0x4a3524, rock: 0x7a726a, bush: 0x3d6b2e, sandbag: 0x8a7c58 },
    sky: { top: 0x2c6ba8, bottom: 0xd6e2ec },
    fog: { color: 0xc2d2e0, near: 180, far: 660 },
    light: { sun: 0xfff0d8, sunIntensity: 1.55, hemi: 0.75, ambient: 0.35 },
    stream: { chance: 0.55, width: 10, depth: 1.5 },
  },
  {
    id: 'desert',
    name: '沙漠',
    size: 900,
    heightScale: 13,
    noiseScale: 0.0038,
    ridge: 2.0,
    trees: 0, rocks: 70, bushes: 25, sandbags: 0,
    ground: { base: 0xd8bf8a, second: 0xe8d6ad, rock: 0xc0a273, high: 0xe2d0a8 },
    parts: { leaf: 0x6d7a3c, trunk: 0x8a6a42, rock: 0xc7ac80, bush: 0x9aa05c, sandbag: 0xb9a173 },
    sky: { top: 0x4f93cd, bottom: 0xf2e6cc },
    fog: { color: 0xe4d5b0, near: 340, far: 1300 },
    light: { sun: 0xfff4dc, sunIntensity: 1.75, hemi: 0.85, ambient: 0.45 },
    stream: { chance: 0.2, width: 8, depth: 1.2 },
  },
  {
    id: 'grass',
    name: '草原',
    size: 580,
    heightScale: 14,
    noiseScale: 0.0048,
    ridge: 2.6,
    trees: 70, rocks: 45, bushes: 150, sandbags: 90,
    ground: { base: 0x5f8a3e, second: 0x8aa04c, rock: 0x7a7268, high: 0x9aa08c },
    parts: { leaf: 0x3f6f2c, trunk: 0x55402a, rock: 0x837a70, bush: 0x4d7a34, sandbag: 0x8a7c58 },
    sky: { top: 0x2f74b4, bottom: 0xdceaf2 },
    fog: { color: 0xcfe0e8, near: 260, far: 980 },
    light: { sun: 0xfff2dc, sunIntensity: 1.6, hemi: 0.8, ambient: 0.38 },
    stream: { chance: 0.65, width: 12, depth: 1.8 },
  },
  {
    id: 'hills',
    name: '丘陵',
    size: 400,
    heightScale: 34,
    noiseScale: 0.0095,
    ridge: 7.0,
    trees: 150, rocks: 110, bushes: 80, sandbags: 40,
    ground: { base: 0x53713a, second: 0x6d7b46, rock: 0x6f665c, high: 0x8f8d84 },
    parts: { leaf: 0x2f5a2a, trunk: 0x4a3524, rock: 0x776e64, bush: 0x3d6b2e, sandbag: 0x8a7c58 },
    sky: { top: 0x2a68a4, bottom: 0xcfdde8 },
    fog: { color: 0xc6d6de, near: 190, far: 640 },
    light: { sun: 0xffeed4, sunIntensity: 1.5, hemi: 0.78, ambient: 0.36 },
    stream: { chance: 0.35, width: 9, depth: 1.6 },
  },
  {
    id: 'snow',
    name: '雪原',
    size: 620,
    heightScale: 16,
    noiseScale: 0.0052,
    ridge: 3.4,
    trees: 230, rocks: 90, bushes: 55, sandbags: 70,
    // 高反照率的雪：底色很亮，所以坦克在上面对比强烈、特别显眼
    ground: { base: 0xe6edf5, second: 0xcdd9e6, rock: 0x8b95a2, high: 0xf4f8fc },
    parts: { leaf: 0x1e3d2a, trunk: 0x3a2a1c, rock: 0x99a3ae, bush: 0x2c4d33, sandbag: 0xb6c2cc,
      snowCap: 0xf2f6fa },   // 雪松：树冠上压一层雪（只有雪原写这个键，别的图不长雪）
    sky: { top: 0x5b88bb, bottom: 0xe8f0f7 },
    fog: { color: 0xe0eaf4, near: 230, far: 820 },
    light: { sun: 0xf4f8ff, sunIntensity: 1.4, hemi: 0.92, ambient: 0.52 },
    stream: { chance: 0.7, width: 13, depth: 1.1, kind: 'ice', color: 0xbcd8e8 },  // 结冰的小河：淡蓝冰面，能正常开过去
    tracks: true,   // 履带压出的印子会留在地上（能靠痕迹反推敌人走向）
  },
  {
    id: 'volcano',
    name: '火山熔岩',
    size: 460,
    heightScale: 22,
    noiseScale: 0.0075,
    ridge: 5.5,
    trees: 0, rocks: 160, bushes: 0, sandbags: 40,   // 没有植被，只有黑玄武岩巨石
    ground: { base: 0x33302d, second: 0x453e39, rock: 0x1f1d1b, high: 0x574c44 },
    parts: { leaf: 0x5a2f1c, trunk: 0x2a2320, rock: 0x3c3532, bush: 0x4a3a2a, sandbag: 0x4a423c },
    sky: { top: 0x43414c, bottom: 0x9a7259 },
    fog: { color: 0x6e5b52, near: 150, far: 580 },
    light: { sun: 0xffc890, sunIntensity: 1.2, hemi: 0.6, ambient: 0.34 },
    // 岩浆河：发光、会烧血、走得很慢。span 0.6 —— 只铺地图中间一段，
    // 两头留出干地，不然一条河把战场劈成两半，两队永远碰不到面
    stream: {
      chance: 0.95, width: 12, depth: 2.4, span: 0.6,
      kind: 'lava', color: 0xe0500f, glow: true,
      damage: 9, speedMul: 0.7,
    },
  },
  {
    id: 'city',
    name: '城市废墟',
    size: 520,
    heightScale: 7,        // 城区地面比较平
    noiseScale: 0.006,
    ridge: 1.2,
    // 城市不用"随机撒掩体"，走街区布局：6×6 个街区 + 街道，见 terrain.js 的 _buildCity
    city: true,
    cityBlocks: 6,
    trees: 0, rocks: 0, bushes: 0, sandbags: 0,
    ground: { base: 0x6f6c66, second: 0x7d7a74, rock: 0x5b5854, high: 0x8f8c86 },
    parts: {
      leaf: 0x4a5a3a, trunk: 0x4a3f34, rock: 0x87847f, bush: 0x55603f, sandbag: 0x9a927e,
      concrete: 0x8a8782,                              // 混凝土（塌楼、断墙）
      container: [0x2f6ea8, 0xa8452f, 0xb99a3a, 0x3f7a5a],  // 集装箱：蓝 / 红 / 黄 / 墨绿
    },
    sky: { top: 0x4a7ba8, bottom: 0xd2d8dd },
    fog: { color: 0xc0c5ca, near: 170, far: 620 },
    light: { sun: 0xffeeda, sunIntensity: 1.45, hemi: 0.72, ambient: 0.4 },
    stream: { chance: 0.15, width: 9, depth: 1.4 },
  },
  {
    id: 'garden',
    name: '花园',
    size: 460,
    heightScale: 4,        // 花园地面很平整
    noiseScale: 0.007,
    ridge: 0.6,
    // 迷宫：大块绿色植物墙体围成格子，通道在中间。见 terrain.js 的 _buildMaze
    maze: true,
    mazeBlocks: 8,         // 8×8 格
    mazeCorridor: 20,      // 通道宽度（米）
    mazeHeight: 9.5,       // 树篱高度（比坦克高得多，会挡住视线）
    mazeOpen: 0.12,        // 额外打通的比例：不去做纯死胡同，留点回路，免得坦克被堵死在尽头
    trees: 0, rocks: 0, bushes: 0, sandbags: 0,
    ground: { base: 0x5d8a44, second: 0x6f9a52, rock: 0x8a8478, high: 0x7fa85e },
    parts: {
      leaf: 0x2f6b34, trunk: 0x4a3f34, rock: 0x8a8478, bush: 0x3f7a3c, sandbag: 0x9a927e,
      hedge: 0x2c6331,      // 树篱主体：深绿
      hedgeTop: 0x4f9a44,   // 树篱顶上一团团的新叶：亮绿
      hedgeLump: 0x3d8038,
    },
    sky: { top: 0x3f86c4, bottom: 0xdfeef8 },
    fog: { color: 0xd6e8f2, near: 150, far: 520 },
    light: { sun: 0xfff4e0, sunIntensity: 1.55, hemi: 0.85, ambient: 0.45 },
    stream: { chance: 0, width: 10, depth: 1.2 },   // 迷宫不铺河，免得把走廊淹了
  },
  {
    id: 'valley',
    name: '山谷',
    // 沙漠一样大（900）—— 这就是你要的"很大"
    size: 900,
    heightScale: 7,        // 谷底比较平，起伏主要靠岩壁
    noiseScale: 0.004,
    ridge: 1.4,
    // 山谷 = "路上有墙"的地图，和花园共用同一套骨架（terrain.js 的 _buildMaze），
    // 区别只在三处：① 墙换成 24m 高的岩壁（坦克绝对爬不上去）
    //              ② 地图放大到沙漠那么大、走廊收窄
    //              ③ 墙打得更稀疏（mazeOpen 高）+ 若干节点直接开成空地（mazePlazas），
    //                 所以走起来是"窄走廊 + 一个个岔路口"，不是花园那种死胡同迷宫
    maze: true,
    mazeBlocks: 16,        // 16×16 个节点 → 格子约 42m
    mazeCorridor: 15,      // 走廊只有 15m 宽：坦克贴着岩壁走，很窄
    mazeHeight: 24,        // 岩壁 24m 高 —— 爬不上去
    mazeOpen: 0.15,        // 额外打通的墙：留出回路，几乎不走死胡同
    mazePlazas: 0.15,      // 15% 的节点开成空地（十字路口）
    // 转角打通：把墙角的墙也拿掉，这样斜向能直接穿过去 —— 这才是你要的"节点 8 个方向"。
    // 只开四面墙是 4 向；不开转角的话全图只有 1% 的节点能走满 8 向，开到 30% 大约是 17%
    mazeCorners: 0.3,
    // 每个节点都必须有一条斜的通道：概率挖墙角总有漏的节点，这里再兜一遍
    mazeDiagonalAll: true,
    // 隧道：节点（路口）露天，节点之间的通道盖一层岩顶 ——
    // 头顶有石头，飞机从上面打不进来（除非它自己俯冲钻进隧道口）；
    // 隧道里的坦克也打不出去，只有走到路口那段才露头
    tunnels: true,
    trees: 0, rocks: 0, bushes: 0, sandbags: 0,   // 除了岩壁没有任何障碍物
    ground: { base: 0xa8764e, second: 0xc08f63, rock: 0x8a6244, high: 0xd8ab7c },
    parts: {
      leaf: 0x6d7a3c, trunk: 0x8a6a42, rock: 0x9a7150, bush: 0x8a8a52, sandbag: 0xb9a173,
      hedge: 0x9a6f4c,      // 岩壁主体：暖褐色砂岩
      hedgeTop: 0xc79a6b,   // 岩壁顶上受光的那层亮岩
      wallRough: 0.88,      // 岩壁比树篱光一点（砂岩有岩面反光）
      wallMetal: 0.05,
    },
    sky: { top: 0x3f7fb5, bottom: 0xf0d8b8 },
    fog: { color: 0xe0c8a8, near: 320, far: 1200 },
    light: { sun: 0xfff0d8, sunIntensity: 1.7, hemi: 0.85, ambient: 0.42 },
    stream: { chance: 0, width: 10, depth: 1.2 },   // 不铺河：别把走廊淹了
  },
  {
    id: 'lake',
    name: '湖',
    size: 780,
    heightScale: 11,
    noiseScale: 0.004,
    ridge: 2.0,
    trees: 110, rocks: 45, bushes: 130, sandbags: 60,
    ground: { base: 0x6f8a52, second: 0x8aa066, rock: 0x7f7a6e, high: 0x9aa08c },
    parts: { leaf: 0x3f6f2c, trunk: 0x55402a, rock: 0x837a70, bush: 0x4d7a34, sandbag: 0x8a7c58,
      // 水生植物：荷叶 / 芦苇 / 海草
      lily: 0x4f8f3c, reed: 0x7f9a4a, weed: 0x2f6b4a },
    sky: { top: 0x2f74b4, bottom: 0xdceaf2 },
    fog: { color: 0xcfe0e8, near: 300, far: 1150 },
    light: { sun: 0xfff2dc, sunIntensity: 1.6, hemi: 0.82, ambient: 0.4 },
    stream: { chance: 0, width: 10, depth: 1.2 },   // 不铺河：这片水本身就是主角
    // 湖：两片大椭圆交叠，把战场从中间横着切开 —— 左右各留一条 ~78m 的岸上通道，
    // 坦克只能绕着走（深水是硬障碍，开不进去）。
    // 这里是**混编战场**：可以纯陆战、纯湖战，也可以船和坦克/飞机一起上
    lake: {
      chance: 1, count: 2, spots: [[-0.10, 0], [0.10, 0]],
      // 水盆要够深：太浅的话连湖心看着都像一片浅水（玩家反馈）
      rx: 0.24, rz: 0.21, depth: 22,
      color: 0x24618f, speedMul: 0.38,
      waveAmp: 0.45,      // 浪高：湖面比海面稳
      waveScale: 0.09,    // 波长：2π/0.09 ≈ 70 米的小波纹
    },
  },
  {
    id: 'ocean',
    name: '海',
    // 真正的海：比沙漠（900）大三倍上下 —— 一眼望不到边的那种开阔
    size: 2600,
    heightScale: 9,
    noiseScale: 0.0035,
    ridge: 1.4,
    // 海面上没有树 / 灌木这些陆生掩体，掩护全靠礁岛
    trees: 0, rocks: 0, bushes: 0, sandbags: 0,
    // 礁岛：从海底鼓起来的几座圆包，顶露出水面。船绕着走（登记成碰撞体），
    // 飞机飞得高，直接从上面过。半径和"露出水面多高"都按地图尺寸给
    islands: { count: 9, r: [0.032, 0.06], above: [7, 16], minGap: 0.06 },
    // 地图这么大，出生点不能再按湖图的比例摆 —— 两军会隔着上千米。收到两成左右
    boatSpawnFrac: 0.2,
    // 视野倍率：图大三倍，AI 的搜索半径也要跟着放大，不然两军永远碰不上
    viewMul: 2.6,
    ground: { base: 0x9c8a68, second: 0xb09a74, rock: 0x7f7a6e, high: 0xc4ad86 },
    parts: { leaf: 0x3f6f2c, trunk: 0x55402a, rock: 0x837a70, bush: 0x4d7a34, sandbag: 0x8a7c58,
      lily: 0x4f8f3c, reed: 0x7f9a4a, weed: 0x2f6b4a },
    sky: { top: 0x2a6cb0, bottom: 0xd2e8f4 },
    fog: { color: 0xc6dcea, near: 900, far: 2600 },
    light: { sun: 0xfff2dc, sunIntensity: 1.7, hemi: 0.9, ambient: 0.45 },
    stream: { chance: 0, width: 10, depth: 1.2 },
    // 真正的海：一片几乎占满战场的大水，只散着几座礁岛。
    // 只有炮艇能在这儿跑 —— 这里不出坦克、不出飞机（坦克掉进来就废了）
    lake: {
      chance: 1, count: 1, spots: [[0, 0]],
      // 0.72：水面几乎铺满整张图，四周只留一圈远远的岸（雾里几乎看不见），
      // 这样才有"一眼望不到边"的海，而不是地图中间一个大湖
      rx: 0.72, rz: 0.72, depth: 38,
      color: 0x1f5f8c, speedMul: 0.36,
      waveAmp: 2.2,       // 浪高：海面有真正的涌浪（低模，两条正弦叠一下）
      waveScale: 0.025,   // 波长：2π/0.025 ≈ 250 米的大涌浪 —— 又长又慢，一眼看得出在起伏
    },
  },
];

