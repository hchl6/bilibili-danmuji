// B站语音弹幕姬 — 主服务
// 职责：HTTP 提供控制面板 + WebSocket 推送音频 + 弹幕协议 + 过滤/限频 + Edge TTS 合成队列
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { BiliDanmaku, resolveRoom, getDanmuInfo, encodePacket, fetchRoomStats } = require('./lib/bilibili');
const edge = require('./lib/edge-tts');
const sapi = require('./lib/sapi');

const PORT = process.env.PORT || 3000;
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

// ---------------- B站扫码登录 ----------------
let buvidCookie = '';
let qrCookieJar = '';   // 生成接口的 Set-Cookie 需回传轮询（保持会话完整）

async function ensureBuvid() {
  if (buvidCookie) return buvidCookie;
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': BILI_UA } });
    const j = await r.json();
    if (j.code === 0 && j.data) buvidCookie = `buvid3=${j.data.b_3}; buvid4=${j.data.b_4}`;
  } catch (e) { /* 忽略 */ }
  return buvidCookie;
}

// 合并 cookie（Set-Cookie 追加/覆盖）
function mergeCookies(base, setCookies) {
  if (!setCookies || !setCookies.length) return base;
  const map = new Map();
  (base || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) map.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });
  setCookies.forEach(sc => {
    const i = sc.indexOf('=');
    if (i > 0) map.set(sc.slice(0, i).trim(), sc.slice(i + 1, sc.indexOf(';') > 0 ? sc.indexOf(';') : undefined).trim());
  });
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function biliQrcodeGenerate() {
  const buvid = await ensureBuvid();
  const headers = {
    'User-Agent': BILI_UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
  };
  if (buvid) headers['Cookie'] = buvid;
  const res = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers });
  // 保存 Set-Cookie 到会话
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookies.length) qrCookieJar = mergeCookies(qrCookieJar || buvid, setCookies);
  const j = await res.json();
  if (j.code !== 0 || !j.data) throw new Error('获取二维码失败: ' + (j.message || j.code));
  return { url: j.data.url, key: j.data.qrcode_key };
}

async function biliQrcodePoll(key) {
  await ensureBuvid();
  const headers = {
    'User-Agent': BILI_UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
  };
  if (qrCookieJar) headers['Cookie'] = qrCookieJar;
  const res = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}&source=main-fe-header`, { headers });
  const j = await res.json();
  log('扫码poll:', JSON.stringify(j).slice(0, 160));
  // B站状态码在 data.code（外层 code 恒为 0）：86101 未扫码 / 86090 已扫未确认 / 86038 过期 / 0 成功
  const status = (j.data && typeof j.data.code === 'number') ? j.data.code : j.code;
  if (status === 0 && j.data && j.data.url) {
    // 方式1：从 url query 提取 Cookie
    let parts = [];
    try {
      const u = new URL(j.data.url);
      for (const [k, v] of u.searchParams) {
        if (/^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid|buvid3|buvid4)$/.test(k)) parts.push(`${k}=${v}`);
      }
    } catch (e) { /* 忽略 */ }
    // 方式2：crossDomain/ticket 形式——直接请求拿 Set-Cookie（不跟随重定向）
    if (!parts.length && j.data.url.startsWith('http')) {
      try {
        const r2 = await fetch(j.data.url, {
          headers: { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' },
          redirect: 'manual',
        });
        const sc = typeof r2.headers.getSetCookie === 'function' ? r2.headers.getSetCookie() : [];
        const map = new Map();
        sc.forEach(c => {
          const i = c.indexOf('=');
          if (i > 0) map.set(c.slice(0, i).trim(), c.slice(i + 1, c.indexOf(';') > 0 ? c.indexOf(';') : undefined).trim());
        });
        for (const [k, v] of map) {
          if (/^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid)$/.test(k)) parts.push(`${k}=${v}`);
        }
      } catch (e) { log('crossDomain获取cookie失败:', e.message); }
    }
    qrCookieJar = '';
    return { code: 0, cookie: parts.join('; '), got: parts.length };
  }
  return { code: status, message: (j.data && j.data.message) || j.message || '扫码状态' };
}

// ---------------- 设置（前端可改） ----------------
const state = {
  cfg: {
    readDanmaku: true,    // 朗读弹幕
    readEnter: true,      // 朗读进场
    onlyGuardEnter: false,// 只念大航海进房
    readUsername: true,   // 读用户名（xx说：）
    readGift: false,      // 朗读礼物
    readSC: false,        // 朗读醒目留言
    readGuard: true,      // 朗读大航海
    priorityGift: true,   // 打赏插队：礼物/SC/大航海插到普通弹幕前优先念（付费互动不被刷屏淹没；默认开）
    tailWord: '喵',        // 自定义尾词：弹幕朗读末尾自动追加（例："你好"→"你好喵"），默认"喵"
    giftThreshold: 0.1,   // 礼物金额阈值(元)
    scThreshold: 0,       // SC金额阈值(元)
    blockWords: [],          // 屏蔽词列表（数组，每项独立匹配——"广告"和"芜湖"是两个词分别屏蔽）
    voice: '晓晓(女·普通话)',
    // 分事件音色（可选）：'' = 跟随上面 voice；设置后该类事件用专属音色（仅晓晓引擎生效，SAPI 无音色概念）
    voiceDanmaku: '',     // 弹幕音色
    voiceEnter: '',       // 进场/关注音色
    voiceGift: '',        // 礼物音色
    voiceSC: '',          // 醒目留言音色
    voiceGuard: '',       // 大航海音色
    rate: 0,              // 语速 ±50%
    pitch: 0,             // 音调 ±50Hz
    engine: 'edge',       // 朗读引擎：edge=微软晓晓(音质好)，sapi=系统内置(秒响稳定)
    dedupWindowMs: 30000, // 防刷屏窗口（毫秒，0=不防刷屏；默认 30 秒——同一用户 N 秒内重复弹幕只读一次）
    queueCapacity: 5,     // 合成队列容量（满后新弹幕挤掉最旧的，默认 5）
    maxTextLength: 30,    // 弹幕最长字数（与前端默认一致；B站直播弹幕上限30字）
    enterNameMax: 20,     // 进场昵称可听长度（1-20，B站昵称上限20字；V2协议实测给完整昵称，默认 20）
    volume: 50,           // 播报音量 0-100（默认 50）
    filterEmptyDanmaku: true,   // 过滤空弹幕（纯空白跳过）
    filterEmojiDanmaku: false,  // 过滤只有表情的弹幕（[大哭] 或 emoji 占满）
    readFollowOnly: false,      // 仅朗读粉丝牌/房管（开关开启：没戴本直播间粉丝牌又不是房管的弹幕跳过。舰长上舰必有牌自动包含。默认关）
    readFollowing: false,       // 仅朗读关注（开关开启：先确认发弹幕者关注了你才念。判定=粉丝列表快照+关注事件叠加，有延迟。默认关）
    firstRunDone: false,        // 首次启动自检是否已完成（前端首开自动体检后 POST 置 true 写回 config.json）
    danmakuMode: 'list',        // 弹幕小窗显示模式：list=列表（底部堆叠）/ fly=飘屏（横向滚动）——通过 cfg 广播同步给透明窗/OBS
    danmakuFontSize: 32,        // 弹幕小窗字号 px（12-96）——同步透明窗/OBS
    danmakuColor: '#ffffff',    // 弹幕文字颜色（固定色；danmakuRandomColor 开时忽略）
    danmakuRandomColor: false,  // 随机颜色弹幕：每条弹幕随机一个颜色（覆盖固定色）
    danmakuFont: 'Microsoft YaHei',  // 弹幕字体（宋体/黑体/微软雅黑等系统字体）
  },
  client: null,       // 浏览器连接
  browserGone: false, // 浏览器页面是否已关闭（关闭期间静默播报）
  danmaku: null,      // B站弹幕连接
  synthQueue: [],     // 合成队列
  synthesizing: false,
  lastSynthEnd: 0,    // 上次晓晓合成完成时间戳（连发时最小间隔节流，防 v2 端点 429）
  enterBuffer: [],    // 进场合并缓冲
  enterTimer: null,
  giftBuffer: new Map(), // 礼物连击合并缓冲 key=uid|giftName → {uname,giftName,num,total,timer}（3秒窗口防连击刷屏）
  lastCookie: '',     // 暂存登录 Cookie（仅 DM_DEBUG 调试接口用）
  myUid: 0,           // 主播自身 uid（从连接 Cookie 的 DedeUserID 提取，"仅朗读关注"粉丝列表查询用）
  fanCache: { ids: null, ts: 0 },  // 粉丝列表快照 ids=Set(uid)（"仅朗读关注"用，120s TTL 惰性刷新）
  fanRecent: new Map(),            // 关注事件叠加 uid→ts（兜底"刚关注还没进下一轮快照"的窗口，刷新成功即清空）
  roomStatsTimer: null, // 房间元数据 30 秒刷新定时器
  likeCounter: 0,     // 本场新增点赞计数（ws LIKE_INFO_V3_CLICK 累计）
  sessionId: 0,       // 会话代数：每次 stopAll/换房间 +1，异步放行（仅朗读关注）落地前比对，防旧会话事件在新会话出声
};

// ---------------- 配置文件持久化（不存敏感字段，分享排除此文件 → 朋友用默认） ----------------
const CONFIG_PATH = path.join(__dirname, 'save', 'config.json');
const SENSITIVE_FIELDS = ['blockWords', 'cookie', 'roomId']; // 不写入 config.json（用户隐私，分享隔离）
let saveCfgTimer = null;
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    Object.keys(data).forEach(k => {
      if (SENSITIVE_FIELDS.includes(k)) return; // 跳过敏感字段
      if (k in state.cfg) state.cfg[k] = data[k];
    });
    if (process.env.DM_DEBUG) log('配置已从 config.json 加载');
  } catch (e) {
    log('config.json 加载失败:', e.message);
  }
  sanitizeVoiceConfig(); // 音色兜底：config.json 可能残留已删除/不存在的音色（如旧"晓辰/晓梦"），拉回合法值
}
// 音色兜底（单一数据源 voices.json）：全局 voice 必须是合法音色，非法恢复首个（晓晓）；
// 分事件音色必须是 ''(跟随默认) 或合法音色，非法拉回 ''。防历史假音色（晓辰/晓梦）残留导致合成失败落 SAPI。
function sanitizeVoiceConfig() {
  const validVoices = Object.keys(edge.VOICES);
  if (typeof state.cfg.voice !== 'string' || !validVoices.includes(state.cfg.voice)) {
    state.cfg.voice = validVoices[0] || '晓晓(女·普通话)';
  }
  ['voiceDanmaku', 'voiceEnter', 'voiceGift', 'voiceSC', 'voiceGuard'].forEach(k => {
    if (typeof state.cfg[k] !== 'string' || (state.cfg[k] && !validVoices.includes(state.cfg[k]))) state.cfg[k] = '';
  });
}
function saveConfig() {
  try {
    const cfgToSave = {};
    Object.keys(state.cfg).forEach(k => {
      if (SENSITIVE_FIELDS.includes(k)) return; // 敏感字段不写
      cfgToSave[k] = state.cfg[k];
    });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgToSave, null, 2));
  } catch (e) {
    log('config.json 保存失败:', e.message);
  }
}
function saveConfigDebounced() {
  // 拖动滑块/输入框会高频触发，防抖 800ms 避免频繁写文件
  if (saveCfgTimer) clearTimeout(saveCfgTimer);
  saveCfgTimer = setTimeout(saveConfig, 800);
}

// ---------------- 事件日志（save/events.log，3 天滚动） ----------------
// 只保留 3 天内的弹幕事件：超过 3 天再打开弹幕姬（服务启动）时自动清空
function checkEventsLog() {
  try {
    if (!fs.existsSync(EVENTS_LOG)) return;
    const stat = fs.statSync(EVENTS_LOG);
    const days = (Date.now() - stat.mtimeMs) / 86400000;
    if (days > 3) {
      fs.writeFileSync(EVENTS_LOG, '');
      if (process.env.DM_DEBUG) log('事件日志超过 3 天未使用，已清空');
    }
  } catch (e) { /* 忽略 */ }
}
let eventWriteCount = 0; // 运行中轮转计数：每 500 次写检查一次体积（防连续直播几天撑爆 2MB）
function appendEventLog(line) {
  try {
    fs.appendFileSync(EVENTS_LOG, line + '\n');
  } catch (e) { /* 写入失败忽略 */ }
  if (++eventWriteCount % 500 === 0) rotateEventsLog();
}
// 事件日志体积轮转：超 2MB 归档为 events.old.log（保留最近一份。
// 与"3 天未用清空"互补：3 天清空管"放着不用"，体积轮转管"连续直播用得狠"）
function rotateEventsLog() {
  try {
    if (fs.existsSync(EVENTS_LOG) && fs.statSync(EVENTS_LOG).size > 2 * 1024 * 1024) {
      fs.renameSync(EVENTS_LOG, path.join(SAVE_DIR, 'events.old.log'));
      log('事件日志超 2MB，已归档为 events.old.log');
    }
  } catch (e) { /* 忽略 */ }
}

// 屏蔽词：数组遍历每项独立匹配（"广告"/"芜湖"是两个词分别屏蔽）
function isBlocked(text) {
  const words = state.cfg.blockWords;
  if (!Array.isArray(words) || !words.length) return false;
  return words.some(w => w && text.includes(w));
}

// 判断弹幕是否"只有表情"：B站 [xxx] 表情 + Unicode emoji 占满整条（空格忽略）
function isOnlyEmoji(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  const cleaned = s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  if (!cleaned) return true; // 去掉 [表情] 后为空 → 纯表情
  const noEmoji = cleaned.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\u200d\ufe0f]/g, '');
  return noEmoji.length === 0; // 去掉 emoji 后为空 → 纯 emoji
}

// ---------------- 合成队列（串行，防打爆 Edge） ----------------
function sendClient(obj) {
  // 广播给所有客户端（控制面板 + 弹幕小窗等），弹幕事件/状态两者都要收；本地 localhost，量级无压力
  const msg = JSON.stringify(obj);
  let sent = false;
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); sent = true; } catch (e) { log('sendClient 发送失败:', e.message.slice(0, 50)); }
    }
  }
  return sent;
}

// 控制台排障日志 → 同时写入 save/diagnose.log（无条件落盘，不依赖 DM_DEBUG）
// 诊断日志定位：朋友电脑出问题 → 前端「导出日志」按钮 → 下载 txt 发回 → 据此判断
let logWriteCount = 0; // 运行中轮转计数：每 2000 次写检查一次文件大小（防连续播报几天撑爆 512KB）
function log(...args) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + args.map(String).join(' ');
  console.log(ts, ...args);
  try { fs.appendFileSync(path.join(SAVE_DIR, 'diagnose.log'), line + '\n'); } catch (e) { /* 写盘失败忽略 */ }
  // 低频轮转检查（每 2000 次写约几 KB 检查一次，statSync 开销可忽略）
  if (++logWriteCount % 2000 === 0) rotateDiagnoseLog();
}
// 诊断日志轮转：超过 512KB 时归档为 diagnose.old.log（保留最近一次）
function rotateDiagnoseLog() {
  try {
    const f = path.join(SAVE_DIR, 'diagnose.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) {
      fs.renameSync(f, path.join(SAVE_DIR, 'diagnose.old.log'));
    }
  } catch (e) { /* 忽略 */ }
}
// 启动时输出环境诊断块（OS/Node/Python/端口/关键文件/配置摘要）——快速定位环境问题
function logEnvironment() {
  const probe = p => fs.existsSync(p) ? 'OK' : '缺失';
  log('═══════ 环境诊断 ═══════');
  log('时间:', new Date().toLocaleString('zh-CN', { hour12: false }));
  log('系统:', process.platform, process.arch, '(' + os.release() + ')');
  log('Node:', process.version);
  log('项目路径:', __dirname);
  log('监听端口:', actualPort);
  log('Python:', findPython(), '| player.py:', probe(PLAYER_PY), '| tts.py:', probe(path.join(__dirname, 'tts.py')));
  log('runtime/python:', probe(path.join(__dirname, 'runtime', 'python', 'python.exe')));
  log('node_modules/ws:', probe(path.join(__dirname, 'node_modules', 'ws')));
  try {
    const c = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, 'config.json'), 'utf8'));
    const safe = { ...c };
    if (safe.cookie) safe.cookie = '(已设置 ' + String(safe.cookie).length + ' 字符)';
    if (Array.isArray(safe.blockWords)) safe.blockWords = safe.blockWords.length + ' 条';
    log('配置摘要:', JSON.stringify(safe));
  } catch (e) { log('配置读取失败:', e.message); }
  log('═══════════════════════');
}

// ---------------- 系统播放器（晓晓WAV直出，绕开浏览器自动播放策略，免点击出声） ----------------
const PLAYER_PY = path.join(__dirname, 'player.py');
// 所有运行时数据统一收进 save/ 文件夹（tmp 临时音频 + config.json 配置 + events.log 事件日志）——分享/卸载时整体排除
const SAVE_DIR = path.join(__dirname, 'save');
const TMP_DIR = path.join(SAVE_DIR, 'tmp');
const EVENTS_LOG = path.join(SAVE_DIR, 'events.log');
let player = null;

// 查找 Python 解释器（绿色版优先，依次探测）：
// 1. 环境变量 DM_PYTHON 显式指定（最高优先）
// 2. 绿色版：本项目 runtime/python/python.exe（打包便携运行时）
// 3. 系统 PATH 的 python / py（本机已装时直接用）
// 4. 兜底：旧版硬编码路径
function findPython() {
  if (process.env.DM_PYTHON) return process.env.DM_PYTHON;
  const bundled = path.join(__dirname, 'runtime', 'python', 'python.exe');
  if (fs.existsSync(bundled)) return bundled;
  try {
    const { spawnSync } = require('child_process');
    for (const cmd of ['python', 'py']) {
      const r = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { windowsHide: true, timeout: 3000 });
      if (r.status === 0 && r.stdout) return r.stdout.toString().trim();
    }
  } catch (e) { /* 忽略 */ }
  return 'python'; // 极端兜底：以上全缺时让 spawn 报错信息直白（正常包必带 runtime/python，走不到这里）
}

function initPlayer() {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
  const py = findPython();
  log('播放器 Python:', py); // 启动时输出路径（排查"播放进程不可用"关键）
  try {
    player = spawn(py, ['-u', PLAYER_PY], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log('播放进程启动失败:', e.message); // 去掉 DM_DEBUG 门控——播放失败必须可见
    player = null;
    return;
  }
  player.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s === 'DONE') sendClient({ type: 'speakEnd' });
  });
  player.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) log('[player]', s.slice(0, 200)); // 去掉 DM_DEBUG 门控
  });
  player.on('exit', code => {
    log('播放进程退出 code=' + code + ', 5秒后重启'); // 去掉 DM_DEBUG 门控
    player = null;
    setTimeout(initPlayer, 5000);
  });
  player.on('error', e => {
    log('播放进程错误:', e.message); // 去掉 DM_DEBUG 门控
    player = null;
  });
  log('系统播放器已就绪'); // 去掉 DM_DEBUG 门控
}

function playWavFile(file) {
  if (!player || !player.stdin || !player.stdin.writable) return false;
  try { player.stdin.write(file + '\n'); return true; } catch (e) { return false; }
}

// 16bit PCM 音量缩放（factor 0-1）。factor>=1 原样返回，不复制
function scaleWav(buf, factor) {
  if (factor >= 1 || !buf || buf.length <= 44) return buf;
  const out = Buffer.from(buf);
  for (let i = 44; i + 1 < out.length; i += 2) {
    let s = out.readInt16LE(i);
    s = Math.max(-32768, Math.min(32767, Math.round(s * factor)));
    out.writeInt16LE(s, i);
  }
  return out;
}

function pushSpeech(text, kind, uname) {
  if (!text) return;
  // 浏览器页面已关闭/断开 → 静默（不出声、不入队）。断开=全停（关连接+清队列+PURGE）
  // （系统直出架构下声音不依赖浏览器，必须显式抑制，否则"网页关了还在说话"）
  if (state.browserGone) {
    if (process.env.DM_DEBUG) log('[pushSpeech] 浏览器已关，静默:', kind, String(text).slice(0, 20));
    return;
  }
  if (process.env.DM_DEBUG) log('[pushSpeech]', kind, '|', String(text).slice(0, 20), '| 队列:', state.synthQueue.length, '| 容量:', state.cfg.queueCapacity, '| 合成中:', state.synthesizing);
  // 字数超限 → 跳过不朗读（防超长弹幕卡死晓晓/刷屏）
  // 注意：kind='test' 测试语音跳过字数检查——用户把弹幕字数限制设小（如5）时点"测试"必须出声，否则误以为坏了
  if (kind !== 'test' && text.length > state.cfg.maxTextLength) {
    if (process.env.DM_DEBUG) log('[pushSpeech] 字数超限跳过:', text.length, '/', state.cfg.maxTextLength, '|', String(text).slice(0, 20));
    return;
  }
  // 打赏插队（可开关）：礼物/SC/大航海 = 高优先级，插到普通弹幕/进场前面（付费互动不被刷屏淹没；不打断正在合成的）
  const priority = state.cfg.priorityGift && (kind === 'gift' || kind === 'sc' || kind === 'guard') ? 1 : 0;
  // 队列容量上限：满了优先挤掉"最旧的普通项"（高优先级尽量保住；队列全是高优时才挤最旧的高优）
  while (state.synthQueue.length >= state.cfg.queueCapacity) {
    const lowIdx = state.synthQueue.findIndex(q => !q.priority);
    state.synthQueue.splice(lowIdx >= 0 ? lowIdx : 0, 1);
  }
  if (priority) {
    // 插到第一个普通项之前（同级高优保持先来后到，排在已有高优之后）
    const firstLow = state.synthQueue.findIndex(q => !q.priority);
    if (firstLow >= 0) state.synthQueue.splice(firstLow, 0, { text, kind, uname, priority });
    else state.synthQueue.push({ text, kind, uname, priority });
    if (process.env.DM_DEBUG) log('[pushSpeech] 打赏插队:', kind, '|', String(text).slice(0, 20), '| 队列:', state.synthQueue.length);
  } else {
    state.synthQueue.push({ text, kind, uname, priority });
  }
  sendClient({ type: 'queue', count: state.synthQueue.length }); // 推队列长度给前端显示
  pumpSynth();
}

async function pumpSynth() {
  if (state.synthesizing) return;
  if (!state.synthQueue.length) return;
  state.synthesizing = true;
  const item = state.synthQueue.shift();
  // 引擎 = 系统内置(SAPI)：直接本地播，秒响稳定，不碰晓晓
  if (state.cfg.engine === 'sapi') {
    log('[TTS] SAPI引擎 直接本地播:', item.text.slice(0, 20));
    sapi.speak(item.text, { rate: state.cfg.rate, volume: state.cfg.volume });
    sendClient({ type: 'sapi', text: item.text, engine: 'sapi' });
    state.synthesizing = false;
    sendClient({ type: 'queue', count: state.synthQueue.length }); // 队列变化同步前端
    setImmediate(pumpSynth);
    return;
  }
  // 引擎 = 微软晓晓（默认）：晓晓合成 → 系统直出播放（不经浏览器，免点击解锁、刷新不掉线）
  // 最小合成间隔节流：v2 端点限流狠，连发时拉开请求间隔防 429；正常弹幕间隔大不等待、不增加延迟
  const SYNTH_MIN_INTERVAL = 400; // ms，晓晓两次请求最小间隔
  const synthWait = SYNTH_MIN_INTERVAL - (Date.now() - state.lastSynthEnd);
  if (synthWait > 0) {
    state.synthesizing = false; // 释放标志，等间隔到了再 pump（不阻塞队列）
    setTimeout(pumpSynth, synthWait);
    return;
  }
  const t0 = Date.now();
  try {
    // 分事件音色：该类事件配了专属音色（voiceDanmaku/voiceEnter/...）就用专属，否则跟随全局 voice
    const evVoiceKey = { danmaku: 'voiceDanmaku', enter: 'voiceEnter', gift: 'voiceGift', sc: 'voiceSC', guard: 'voiceGuard' }[item.kind];
    const itemVoice = (evVoiceKey && state.cfg[evVoiceKey]) || state.cfg.voice;
    const wav = await edge.synthesize(item.text, itemVoice, { rate: state.cfg.rate, pitch: state.cfg.pitch });
    const cost = Date.now() - t0;
    if (!wav || wav.length < 200) throw new Error('音频数据异常(过小)');
    log('[TTS] 晓晓合成完成:', item.text.slice(0, 20), cost + 'ms');
    // 浏览器已关 → 丢弃合成结果（不写文件不播放不发消息，wav 还在内存中无需清理）
    if (state.browserGone) {
      log('浏览器已关,合成结果丢弃:', item.text.slice(0, 20));
      return;
    }
    const vol = Math.max(0, Math.min(100, state.cfg.volume ?? 100)) / 100;
    // 前端状态先行（显示"正在念"），播放实际走系统扬声器
    sendClient({ type: 'speaking', text: item.text, kind: item.kind, uname: item.uname });
    if (vol <= 0) {
      log('音量0,跳过播放:', item.text.slice(0, 20));
      sendClient({ type: 'speakEnd' });
    } else {
      const final = vol < 1 ? scaleWav(wav, vol) : wav;
      const file = path.join(TMP_DIR, `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`);
      fs.writeFileSync(file, final);
      if (playWavFile(file)) {
        log('晓晓合成OK→系统播放:', item.text.slice(0, 20), (final.length / 1024).toFixed(0) + 'KB', vol * 100 + '%');
      } else {
        log('播放进程不可用,本地SAPI兜底念:', item.text.slice(0, 20));
        setTimeout(() => { try { fs.unlinkSync(file); } catch (e) { /* 忽略 */ } }, 1000);
        sapi.speak(item.text, { rate: state.cfg.rate, volume: state.cfg.volume });
        sendClient({ type: 'sapi', text: item.text, engine: 'sapi' });
      }
    }
  } catch (e) {
    log('[TTS] 晓晓合成失败(' + (Date.now() - t0) + 'ms),启用本地SAPI兜底:', e.message);
    sapi.speak(item.text, { rate: state.cfg.rate, volume: state.cfg.volume });
    sendClient({ type: 'sapi', text: item.text, engine: 'sapi' });
  } finally {
    state.lastSynthEnd = Date.now(); // 记录晓晓请求完成时间（连发节流基准，无论成败都记）
    state.synthesizing = false;
    sendClient({ type: 'queue', count: state.synthQueue.length }); // 推队列长度给前端
    setImmediate(pumpSynth);
  }
}

// ---------------- 进场合并限频（2秒窗口，防报菜名） ----------------
// 昵称超长截断：只朗读限制数的昵称（少爷要求不带省略号，如"李二狗"限制2→"李二"；TTS 实测不吞字，
// 截断纯为防止超长昵称拖慢单句朗读。当初"晓晓吞字"是受进场协议截断现象误导的错误结论，已废弃）
// 长度由前端"进场限制"配置（1-20，B站昵称上限20字；V2 协议实测 uname 给完整昵称，不再有7字截断，默认 20）
function truncateName(name) {
  const n = state.cfg.enterNameMax ?? 20;
  return (typeof name === 'string' && name.length > n) ? name.slice(0, n) : name;
}
function flushEnter() {
  state.enterTimer = null;
  if (!state.enterBuffer.length) return;
  const events = state.enterBuffer.splice(0);
  const names = [...new Set(events.map(e => truncateName(e.uname)))];
  let text;
  if (names.length >= 3) text = `${names.slice(0, 3).join('、')}等${names.length}人进入了直播间`;
  else if (names.length === 2) text = `${names[0]}和${names[1]}进入了直播间`;
  else text = `${names[0]}进入了直播间`; // 关注事件不经过这里（bufferEnter 已独立即时播报）
  pushSpeech(text, 'enter', names[0]);
}

function bufferEnter(ev) {
  if (!state.cfg.readEnter) return;
  if (state.cfg.onlyGuardEnter) return; // 只念大航海时普通进场全过滤
  // 关注事件独立即时播报（不跟进场 2 秒合并——感谢要趁热，且避免多人合并时被念成"进入直播间"）
  if (ev.msgType === 2) {
    if (state.cfg.readFollowing) fanAddRecent(ev.uid); // 关注事件叠加："仅朗读关注"下刚关注的用户立即能念
    pushSpeech(`感谢${truncateName(ev.uname)}关注了直播间`, 'enter', ev.uname);
    return;
  }
  state.enterBuffer.push(ev);
  if (!state.enterTimer) state.enterTimer = setTimeout(flushEnter, 2000);
}
// 清进场合并缓冲：stopAll（断开）和 connectRoom（换房间）共用，防旧会话/旧房间的进场定时器在新会话落地
function clearEnterBuffer() {
  if (state.enterTimer) { clearTimeout(state.enterTimer); state.enterTimer = null; }
  state.enterBuffer.length = 0;
}

// 礼物连击合并：同一用户同一礼物在 3 秒窗口内累计数量，窗口结束只念一次（防"1个小心心"刷屏）
function bufferGift(ev) {
  const key = `${ev.uid || ev.uname}|${ev.giftName}`;
  const cur = state.giftBuffer.get(key);
  if (cur) {
    cur.num += (ev.num || 1);
    cur.total += (ev.total || 0);
    clearTimeout(cur.timer);
  } else {
    state.giftBuffer.set(key, { uname: ev.uname, giftName: ev.giftName, num: ev.num || 1, total: ev.total || 0, timer: null });
  }
  const entry = state.giftBuffer.get(key);
  entry.timer = setTimeout(() => flushGift(key), 3000);
}
function flushGift(key) {
  const entry = state.giftBuffer.get(key);
  if (!entry) return;
  state.giftBuffer.delete(key);
  pushSpeech(`感谢${entry.uname}送出了${entry.num}个${entry.giftName}`, 'gift', entry.uname);
}

// ---------------- "仅朗读关注"：粉丝判定 ----------------
// 判定"发弹幕者是否关注了主播"没有单点关系接口可用（x/relation?fid= 返回的是"主播→观众"方向，反的——
// attribute 永远是"查询者(cookie持有者)对目标"的视角）。正确数据源 = 主播自己的粉丝列表 x/relation/fans。
// 策略（不逐条现查，避免每条弹幕都请求）：
//   1. 粉丝列表快照：惰性拉取 + TTL 刷新（有弹幕且快照过期才刷新，无人发弹幕不刷）。
//      TTL 越大 → 粉丝列表接口请求越少、越稳，但"取关后停止朗读"越慢。
//      当前 120s 保守档（少爷拍板：灵敏度非刚需，只有测试才反复取关，接口稳定优先）。
//   2. 关注事件叠加：收到 INTERACT_WORD_V2 msgType=2（"xxx关注了主播"）→ uid 临时入 fanRecent，
//      兜住"刚关注还没进下一轮快照"的窗口；快照刷新成功后清空（新快照已是全量真相）。
//      fanRecent 判定只认 FAN_TTL_MS 内的标记——即使快照刷新失败也不会让取关者被无限放行。
// 局限：粉丝数 > 快照上限(400) 时尾段粉丝可能漏判；cookie 过期/游客连接 → 查询失败一律不念（宁可少念）；
//       "取关→停止朗读"最坏延迟一个 TTL，取关后立刻发弹幕可能仍被旧快照放行一次（快照机制固有）
const FAN_TTL_MS = 120000;  // 粉丝列表快照有效期（毫秒，保守档：取关生效最迟 ~120s）
const FAN_MAX_PAGES = 8;    // 最多翻页（50人/页 → 上限400人）
let fanRefreshing = null;   // 进行中的刷新 Promise（串行防弹幕洪峰重复请求）
let fanGateChain = Promise.resolve(); // 弹幕放行判定队列（保序 + 复用同一刷新）
let lastFanSnapLog = 0;     // 快照成功打点限频（5分钟一条，诊断日志不刷屏）
function fanAddRecent(uid) {
  if (!uid) return;
  if (state.fanRecent.size >= 500) { // 防无限增长：清掉超 FAN_TTL_MS 的旧标记
    const now = Date.now();
    for (const [k, t] of state.fanRecent) if (now - t > FAN_TTL_MS) state.fanRecent.delete(k);
  }
  state.fanRecent.set(uid, Date.now());
}
async function fetchFanList(myUid) {
  // 翻页拉取粉丝列表 → Set(uid)；失败抛错由调用方降级（沿用旧快照）
  const ids = new Set();
  for (let pn = 1; pn <= FAN_MAX_PAGES; pn++) {
    const r = await fetch(`https://api.bilibili.com/x/relation/fans?vmid=${myUid}&pn=${pn}&ps=50`, {
      headers: {
        'User-Agent': BILI_UA,
        'Referer': `https://space.bilibili.com/${myUid}/fans`,
        'Accept': 'application/json, text/plain, */*',
        ...(state.lastCookie ? { 'Cookie': state.lastCookie } : {}),
      },
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error('fans接口 code=' + j.code + ' ' + (j.message || ''));
    const list = (j.data && j.data.list) || [];
    list.forEach(u => { if (u && u.mid) ids.add(u.mid); });
    if (list.length < 50) break; // 翻到底了
  }
  return ids;
}
function ensureFanFresh() {
  // 快照新鲜直接返回；过期/缺失才刷新。并发调用共享同一 Promise（防重入）
  const now = Date.now();
  if (state.fanCache.ids && now - state.fanCache.ts < FAN_TTL_MS) return Promise.resolve();
  if (!fanRefreshing) {
    const myUid = state.myUid;
    fanRefreshing = (async () => {
      try {
        if (!myUid || !state.lastCookie) throw new Error('无主播身份/Cookie，请先登录连接');
        const ids = await fetchFanList(myUid);
        state.fanCache = { ids, ts: Date.now() };
        state.fanRecent.clear(); // 新快照=全量真相，清掉叠加窗口（刚关注者已含在列表则无影响）
        // 成功打点限频 5 分钟一条（诊断日志能直接看到"关注判定链路活着"，又不刷屏）
        if (Date.now() - lastFanSnapLog > 300000) {
          lastFanSnapLog = Date.now();
          log('[关注过滤] 粉丝快照刷新: ' + ids.size + ' 人 (TTL=' + FAN_TTL_MS + 'ms)');
        }
      } catch (e) {
        state.fanCache.ts = Date.now(); // 防失败后每条弹幕疯狂重试（等一个 TTL 后才再试）
        log('[关注过滤] 粉丝列表刷新失败(沿用旧快照):', e.message);
      } finally {
        fanRefreshing = null;
      }
    })();
  }
  return fanRefreshing;
}
// 单条弹幕判定：确认发送者 uid 在粉丝列表 或 一个 TTL 内刚关注过 → true 放行
function gateFollowing(ev) {
  return ensureFanFresh().then(() => {
    if (!state.myUid || !state.lastCookie) return false; // 无主播身份 → 不念
    const ids = state.fanCache.ids;
    if (ids && ids.has(ev.uid)) return true; // 在粉丝列表快照里
    // 关注事件叠加兜底：只认 FAN_TTL_MS 内的标记——取关后即使快照刷新失败，
    // 残留标记超一个 TTL 即失效，不会导致取关者被无限放行（原实现 2h 残留是隐藏 bug）
    const recentTs = state.fanRecent.get(ev.uid);
    if (recentTs && Date.now() - recentTs < FAN_TTL_MS) return true;
    return false;
  });
}

// ---------------- 事件 -> 朗读文本 ----------------
// B 站对 uid=0 匿名推送用户的昵称截断格式：X***（首字+多个星号）—— 少爷要求直接过滤
// 正常用户昵称极少带星号，且"首字+多星号"的模式只在 B 站匿名截断中出现
function isPrivateUname(name) {
  return typeof name === 'string' && /^[^\s*]\*+$/.test(name);
}
// 清洗 B 站特殊昵称/文案格式（<%xxx%> 会把 < % > 符号都念出来）—— 保留纯文字
// 处理：1) <%xxx%> 包裹 → xxx  2) <...> 任何 HTML 标签剥掉  3) 残留孤立 < > % 剥掉
function cleanName(name) {
  if (typeof name !== 'string') return name;
  return name
    .replace(/<%([^%]+)%>/g, '$1')   // <%花吹_花落%> → 花吹_花落
    .replace(/<[^>]*>/g, '')          // <font> <svg> 等 HTML 标签全部剥掉
    .replace(/[<>%]/g, '')            // 残留孤立符号
    .trim();
}
function handleEvent(ev) {
  if (process.env.DM_DEBUG) log('事件:', ev.type, '|', ev.uname, '|', ev.text || ev.giftName || '');
  // 统一清洗昵称和文案（<%xxx%> → xxx），避免朗读把符号念出来
  if (ev.uname) ev.uname = cleanName(ev.uname);
  if (ev.text) ev.text = cleanName(ev.text);
  // 隐私昵称（X*** 格式）→ 不推 event 消息也不朗读，避免 B 站匿名版污染事件日志和双通道重复
  if (ev.uname && isPrivateUname(ev.uname)) {
    if (process.env.DM_DEBUG) log('[handleEvent] 隐私昵称过滤:', ev.uname, '|', (ev.text || '').slice(0, 20));
    return;
  }
  // 浏览器已关：不推 event 消息（避免静默事件进事件日志误导用户），但内部朗读判定仍走（pushSpeech 会再次拦）
  const pushEvent = () => {
    if (state.browserGone) {
      if (process.env.DM_DEBUG) log('[handleEvent] 浏览器已关,事件不入事件日志:', ev.type, (ev.text || ev.uname || '').slice(0, 20));
    } else {
      sendClient({ type: 'event', ev }); // 嵌套传递，避免 ev.type 覆盖外层 type
      // 事件日志落盘（save/events.log，3 天滚动）
      try {
        const detail = ev.type === 'danmaku' ? `${ev.uname}：${ev.text}`
          : ev.type === 'gift' ? `${ev.uname} 送出 ${ev.num} 个 ${ev.giftName}`
          : ev.type === 'superchat' ? `${ev.uname} 醒目留言：${ev.text}`
          : ev.type === 'enter' ? (ev.msgType === 2 ? `${ev.uname} 感谢关注直播间` : `${ev.uname} 进场`)
          : ev.type === 'effect_enter' ? `${ev.uname} 特效进场`
          : ev.type === 'welcome' || ev.type === 'guard' ? `${ev.uname} 大航海`
          : `${ev.uname || ev.text || ''}`;
        appendEventLog(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${ev.type}] ${detail}`);
      } catch (e) { /* 日志组装失败忽略 */ }
    }
  };
  // 弹幕特殊：先过 shouldSpeak 再决定是否显示事件（被拦截的弹幕不进事件日志，避免"发一个显示俩个"）
  if (ev.type === 'danmaku') {
    if (!state.cfg.readDanmaku) { if (process.env.DM_DEBUG) log('[danmaku] 被 readDanmaku 开关拦截'); return; }
    // 过滤空弹幕（开关开启时：纯空白/空文本跳过）
    if (state.cfg.filterEmptyDanmaku && !String(ev.text || '').trim()) {
      if (process.env.DM_DEBUG) log('[danmaku] 被空弹幕过滤');
      return;
    }
    // 过滤只有表情的弹幕（开关开启时：[大哭][流汗] 或纯 emoji 占满跳过）
    if (state.cfg.filterEmojiDanmaku && isOnlyEmoji(ev.text)) {
      if (process.env.DM_DEBUG) log('[danmaku] 被表情弹幕过滤:', String(ev.text).slice(0, 20));
      return;
    }
    // 仅朗读粉丝牌/房管（开关开启：没戴本直播间粉丝牌(hasMedal)又不是房管(isAdmin)的弹幕跳过。
    // 舰长/提督/总督上舰必有粉丝牌 → hasMedal=true 自动包含；不依赖 B站弹幕里不存在的"关注"字段）
    if (state.cfg.readFollowOnly && !(ev.isAdmin || ev.hasMedal)) {
      log('[danmaku] 被"仅朗读粉丝牌/房管"拦截:', ev.text);
      return;
    }
    if (isBlocked(ev.text)) { log('[danmaku] 被屏蔽词拦截:', ev.text); return; }
    // 字数限制：只算弹幕文本（不含"xxx说："昵称前缀），超长弹幕跳过不念
    if (ev.text.length > state.cfg.maxTextLength) {
      log('[danmaku] 字数超限跳过:', ev.text.length, '/', state.cfg.maxTextLength, '|', ev.text.slice(0, 20));
      return;
    }
    const skip = shouldSpeak(ev.text, ev.uname, ev.uid, ev.time);
    if (skip === 'dedup') {
      // 双通道去重（协议层自动，B站把同一条弹幕从 WS 和 gethistory 各推一次）——静默不显示不打扰
      if (process.env.DM_DEBUG) log('[danmaku] 双通道去重拦截(静默):', ev.text);
      return;
    }
    if (skip === 'antispam') {
      // 防刷屏窗口拦截（用户设置生效）→ 通知前端显示（让拦截可见）
      sendClient({ type: 'suppressed', reason: '防刷屏', text: ev.text, uname: ev.uname });
      log('[danmaku] 被防刷屏拦截:', ev.text);
      return;
    }
    // 通过过滤：显示事件 + 朗读（抽成函数，供"仅朗读关注"异步判定放行后复用同一路径）
    const finishDanmaku = () => {
      pushEvent();
      if (process.env.DM_DEBUG) log('[danmaku] 通过过滤，进入朗读:', ev.text);
      pushSpeech(state.cfg.readUsername ? `${ev.uname}说：${ev.text}${state.cfg.tailWord || ''}` : ev.text + (state.cfg.tailWord || ''), 'danmaku', ev.uname);
    };
    // 仅朗读关注（开启时：弹幕先进判定队列，确认发送者关注了你才放行朗读——首条会触发粉丝列表拉取，有延迟）
    if (state.cfg.readFollowing) {
      const sid = state.sessionId; // 捕获当前会话代数：判定在飞期间断开/换房间（代数+1）→ 落地直接丢弃，防旧会话弹幕在新会话出声
      fanGateChain = fanGateChain.then(() => gateFollowing(ev)).then(ok => {
        if (sid !== state.sessionId) { if (process.env.DM_DEBUG) log('[danmaku] 会话已切换，丢弃在飞判定:', ev.text); return; }
        if (ok) finishDanmaku();
        else log('[danmaku] 被"仅朗读关注"拦截:', ev.text);
      }).catch(e => log('[danmaku] 关注判定异常(拦截):', e.message));
      return;
    }
    finishDanmaku();
    return;
  }
  // 非弹幕事件：直接显示（实时数据事件 online/like_*/watched 不入事件日志——不是事件是状态）
  if (!['online', 'like_click', 'like_update', 'watched'].includes(ev.type)) pushEvent();
  switch (ev.type) {
    case 'enter':
      bufferEnter(ev);
      break;
    case 'online':
      // 在线人数实时更新（B 站 ws 推送，开播时准；不打断、不读、不入事件日志）
      sendClient({ type: 'onlineUpdate', count: ev.count });
      break;
    case 'like_click':
      // 本场新增点赞数（从连接开始累计，B 站 ws 推 V3_CLICK）
      state.likeCounter = (state.likeCounter || 0) + ev.count;
      sendClient({ type: 'likeUpdate', count: state.likeCounter });
      break;
    case 'like_update':
      // 累计点赞数（B 站 ws 推 V3_UPDATE，带总数）
      sendClient({ type: 'likeUpdate', count: ev.count, total: true });
      break;
    case 'watched':
      // 看过人数变化（B 站 ws 推 WATCHED_CHANGE，data.text 是看过人数字符串）
      sendClient({ type: 'viewUpdate', count: ev.count });
      break;
    case 'welcome':
    case 'guard': {
      if (!state.cfg.readGuard) return;
      const gn = ev.guardName || (ev.guardLevel === 1 ? '总督' : ev.guardLevel === 2 ? '提督' : '舰长');
      pushSpeech(`欢迎${ev.uname}上${gn}！`, 'guard', ev.uname);
      break;
    }
    case 'effect_enter':
      // 特效进场并入普通进场合并（统一"xxx进入了直播间"格式 + 2秒合并限频防报菜名）
      // 之前直接读 B 站 copy_writing（"xxx 来了"）——格式不统一且高频刷屏
      bufferEnter(ev);
      break;
    case 'gift': {
      if (!state.cfg.readGift) return;
      if (ev.total < (state.cfg.giftThreshold || 0)) return;
      bufferGift(ev); // 连击合并：同一用户同一礼物 3 秒窗口累计，只念一次
      break;
    }
    case 'superchat': {
      if (!state.cfg.readSC) return;
      if (ev.price < (state.cfg.scThreshold || 0)) return;
      pushSpeech(`${ev.uname}留言：${ev.text}`, 'sc', ev.uname);
      break;
    }
  }
}

// ---------------- 连接/断开 ----------------
async function connectRoom(roomId, cookie) {
  // 已有同房间连接时直接复用（防止前端自动重连杀掉保留中的 B站连接）
  if (state.danmaku && state.danmaku.inputRoomId === roomId) {
    log('已有同房间连接，复用不重建');
    await startHistoryPoll(roomId);
    sendClient({ type: 'status', state: 'connected', msg: '已连接(B站连接复用)' });
    return;
  }
  // 先校验房间号再动旧连接（原来先关旧连接后校验——清空房间号点连接会误杀现有连接）
  if (!roomId) { sendClient({ type: 'error', msg: '请输入房间号' }); return; }
  // 切换房间：先停旧轮询、再关旧连接（顺序很重要——防止旧轮询在窗口期继续朗读旧房间弹幕）
  if (state.danmaku) { log('[来源] connectRoom 关闭旧连接'); stopHistoryPoll(); state.danmaku.close(); state.danmaku = null; }
  // 清旧房间元数据定时器（防泄漏：不清理的话旧 timer 引用被新赋值覆盖，会永远清不掉并继续推旧房间数据）
  if (state.roomStatsTimer) { clearInterval(state.roomStatsTimer); state.roomStatsTimer = null; }
  // 换房间 = 新会话：清旧房间进场合并缓冲 + 会话代数 +1（在飞的"仅朗读关注"判定落地后丢弃，防旧房间弹幕念进新房间）
  clearEnterBuffer();
  state.sessionId++;
  sendClient({ type: 'status', state: 'connecting', msg: '正在连接...' });
  // 登录 Cookie 自动补全 buvid 指纹（B站弹幕服务器要求 Cookie 含 buvid）
  let fullCookie = cookie || '';
  if (fullCookie) {
    const buvid = await ensureBuvid();
    if (buvid && !fullCookie.includes('buvid3=')) fullCookie = fullCookie + '; ' + buvid;
    // 打印 Cookie 字段名（不泄露值）用于排障
    const names = fullCookie.split(';').map(p => p.split('=')[0].trim()).filter(Boolean);
    log('连接Cookie字段:', names.join(','));
    state.lastCookie = fullCookie; // 暂存供认证调试
    state.myUid = parseInt((fullCookie.match(/DedeUserID=(\d+)/) || [])[1] || '0', 10); // 主播自身uid（"仅朗读关注"查粉丝列表用）
    state.fanCache = { ids: null, ts: 0 }; state.fanRecent.clear(); // 新连接身份变化 → 粉丝快照作废重取
  } else {
    // 切游客/清空 Cookie：清掉旧身份（否则"仅朗读关注"会用旧账号粉丝列表判定，全错）
    state.lastCookie = '';
    state.myUid = 0;
    state.fanCache = { ids: null, ts: 0 };
    state.fanRecent.clear();
  }
  state.danmaku = new BiliDanmaku({
    roomId,
    cookie: fullCookie,
    onLog: (m) => log('[bili]', m),
    onEvent: handleEvent,
    onStatus: (s) => {
      log('状态:', s.state, s.msg || '');
      sendClient({ type: 'status', ...s });
    },
    onError: (e) => {
      log('错误:', e.message);
      sendClient({ type: 'error', msg: e.message });
    },
  });
  state.danmaku.connect();
  // 启动 gethistory 补漏轮询（WebSocket 收不全时靠它补全弹幕）
  await startHistoryPoll(roomId);
  // 拉取并定时刷新直播间元数据（在线/看过/赞）
  await refreshRoomStats(fullCookie, roomId);
  state.roomStatsTimer = setInterval(() => refreshRoomStats(fullCookie, roomId), 30000);
}
async function refreshRoomStats(cookie, roomId) {
  const stats = await fetchRoomStats(cookie, roomId);
  if (process.env.DM_DEBUG) log('房间元数据:', JSON.stringify(stats));
  sendClient({ type: 'roomStats', stats });
}

// 【断开=全停】统一清理：清合成队列 + SAPI 内部队列 purge + PURGE 打断播放 + 关 B站连接 + 停轮询 + 清游标/去重/礼物缓冲。
// 两处断开入口（disconnectRoom 主动断开 / ws close 浏览器断开）共用，防改一处漏一处（历史教训：SAPI 清理被两处同时漏了）
function stopAll(reason) {
  const dropped = state.synthQueue.length;
  state.synthQueue = [];
  state.sessionId++; // 会话代数 +1：在飞的"仅朗读关注"异步判定落地后比对，旧会话事件直接丢弃
  sapi.purge(); // SAPI 引擎内部队列也清（否则断开后"系统内置"引擎继续念已入队文本）
  if (player && player.stdin && player.stdin.writable) {
    try { player.stdin.write('__PURGE__\n'); } catch (e) { /* 忽略 */ }
  }
  if (state.danmaku) { log('[来源] ' + reason + ' 关闭连接'); state.danmaku.close(); state.danmaku = null; }
  stopHistoryPoll();
  historyLastTs = '';
  recentByTime.clear(); // 断开即清空去重状态——重新连接后全新开始（防旧房间去重污染新房间）
  recentByUser.clear();
  // 清礼物连击合并缓冲（清掉所有 pending 的 setTimeout，防断开后 3 秒还 flush 播报）
  for (const [, g] of state.giftBuffer) clearTimeout(g.timer);
  state.giftBuffer.clear();
  // 清进场合并缓冲（礼物缓冲的兄弟，之前漏了——防"断开→2秒内快速重连"把上一会话进场念出来）
  clearEnterBuffer();
  state.likeCounter = 0; // 本场点赞计数随会话结束归零（防跨会话/换房间累计）
  if (state.roomStatsTimer) { clearInterval(state.roomStatsTimer); state.roomStatsTimer = null; }
  log(reason + ' 已全停（队列:' + dropped + '条 + PURGE + 关连接 + 清游标）');
}

function disconnectRoom() {
  state.browserGone = true; // 断开 = 静默（防止断开后到 ws.close 前的窗口期新弹幕被播）
  stopAll('disconnectRoom');
  sendClient({ type: 'status', state: 'disconnected', msg: '已断开' });
}

// ---------------- gethistory 弹幕补漏（B站对未开播/小直播间 WebSocket 推送不全，历史接口 100% 完整） ----------------
let historyTimer = null;
let historyLastTs = '';   // 游标：已处理到的最新 timeline（防止旧弹幕重复念）
let historyPolling = false; // 防重入

const recentByTime = new Map(); // text|sendtime -> 时间戳（3秒窗口防 WS+gethistory 双通道，**永远启用**）
const recentByUser = new Map(); // text|uid -> 时间戳（dedupWindowMs 窗口防同用户刷屏）
// 定期清理过期去重记录（防 Map 无限增长内存泄漏）——每 5 分钟清一次。
// 【修复】清理基准必须按各自窗口分：recentByTime 是 3 秒双通道窗口；recentByUser 是防刷屏窗口
// （dedupWindowMs 默认 30 秒、最大 999 秒）。若统一按 10 秒清，防刷屏窗口 >10 秒的记录会被提前删除 → 防刷屏失效
setInterval(() => {
  const timeCut = Date.now() - 4000; // 双通道：3 秒窗口 + 1 秒余量
  for (const [k, t] of recentByTime) if (t < timeCut) recentByTime.delete(k);
  const userCut = Date.now() - Math.max(3000, state.cfg.dedupWindowMs || 0) - 1000; // 防刷屏窗口 + 1 秒余量
  for (const [k, t] of recentByUser) if (t < userCut) recentByUser.delete(k);
}, 300000).unref();

// 返回：'dedup'=双通道去重（协议层自动，静默不显示）、'antispam'=防刷屏（用户设置，显示🚫）、null=通过
function shouldSpeak(text, uname, uid, time) {
  const now = Date.now();
  // 通道1：双通道去重（基于 B 站 sendtime——同一条弹幕 WS 和 gethistory 绝对一致）
  // 这一层不受防刷屏开关影响，**永远拦截双通道重复**（这是 B 站协议造成的固有问题，跟用户意愿无关）
  if (time) {
    const tKey = text + '|' + time;
    const lastT = recentByTime.get(tKey);
    if (lastT && now - lastT < 3000) return 'dedup'; // 3秒内同 text+同 sendtime = 同一条弹幕被双推
    recentByTime.set(tKey, now);
  }
  // 通道2：防刷屏（受 dedupWindowMs 控制，0=关）
  // 即使没传 time（兜底用 Date.now），仅当 uid 有效时启用
  if (uid) {
    const uKey = text + '|' + uid;
    const lastU = recentByUser.get(uKey);
    const window = state.cfg.dedupWindowMs || 0;
    if (window > 0 && lastU && now - lastU < window) return 'antispam'; // 窗口内同用户同内容不重念
    if (window > 0) recentByUser.set(uKey, now);
  }
  return null;
}

// 拉取 gethistory 弹幕列表（公共：pollHistory 轮询 + startHistoryPoll 建游标共用，避免两处重复 fetch 逻辑）
async function fetchHistory(roomId) {
  const r = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${roomId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Referer': `https://live.bilibili.com/${roomId}` }
  });
  const j = await r.json();
  if (j.code !== 0 || !j.data) return [];
  const all = [...(j.data.room || []), ...(j.data.admin || [])];
  all.sort((a, b) => (a.timeline || '').localeCompare(b.timeline || ''));
  return all;
}

async function pollHistory(roomId) {
  if (historyPolling) return;
  historyPolling = true;
  try {
    const all = await fetchHistory(roomId);
    // 房间校验：fetch 期间用户可能已断开/切换房间——丢弃旧房间的 in-flight 结果，避免"断开后还读断开前弹幕"
    const currentRoom = state.danmaku ? state.danmaku.inputRoomId : null;
    if (currentRoom !== roomId) {
      log('[pollHistory] 房间已变化(' + roomId + '→' + (currentRoom || '无') + ')，丢弃结果');
      return;
    }
    if (!all.length) return;
    // 游标去重：只处理比已处理到的时间更新的弹幕（避免最近10条滚动窗口里旧弹幕反复念）
    const newMsgs = all.filter(m => m && m.text && (!m.timeline || m.timeline > historyLastTs));
    if (!newMsgs.length) return;
    historyLastTs = newMsgs[newMsgs.length - 1].timeline || historyLastTs;
    // 注意：这里不再调 shouldSpeak——handleEvent 里统一去重（否则 double-check 会把刚 set 的 key 立刻拦截）
    for (const m of newMsgs) {
      // 把 B 站 timeline 字符串 "2026-08-28 16:43:06" 解析为秒级时间戳，与 WS 路径的 sendtime 对齐做跨通道去重
      const time = m.timeline ? Math.floor(new Date(m.timeline.replace(/-/g, '/')).getTime() / 1000) : 0;
      handleEvent({ type: 'danmaku', uid: m.uid, uname: m.nickname || '观众', text: m.text, time, ts: Date.now() });
    }
  } catch (e) { /* 轮询失败忽略，下轮再试 */ } finally {
    historyPolling = false;
  }
}

async function startHistoryPoll(roomId) {
  stopHistoryPoll();
  historyLastTs = '';
  // 独立建游标（不依赖 historyPolling 锁——旧房间 poll in-flight 时，若走 pollHistory 建游标会被挡，
  // 游标建失败 → 定时器首轮读到"打开前的旧弹幕"。独立 fetch 直接取最新 timeline 建游标，稳）
  try {
    const all = await fetchHistory(roomId);
    if (all.length) {
      const maxTs = all[all.length - 1].timeline || ''; // fetchHistory 已按 timeline 排序，最后一条最新
      historyLastTs = maxTs;
      if (process.env.DM_DEBUG) log('历史游标建立:', maxTs);
    }
  } catch (e) { /* 建游标失败忽略，定时器首轮会重新建 */ }
  historyTimer = setInterval(() => pollHistory(roomId), 1500); // 1.5 秒轮询，延迟≈2秒
  pollHistory(roomId); // 启动后立即拉一次（从游标之后的新弹幕开始读）
}

function stopHistoryPoll() {
  if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
}

// ---------------- HTTP 静态服务 ----------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONTS_DIR = path.join(PUBLIC_DIR, 'fonts'); // 用户自定义弹幕字体（.ttf/.otf）存放目录
try { fs.mkdirSync(FONTS_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 音色表（单一数据源 voices.json，经 lib/edge-tts.js 加载）：前端启动时拉取校正内嵌兜底表
  if (urlPath === '/api/voices') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(Object.keys(edge.VOICES)));
    return;
  }

  // 自定义弹幕字体列表：扫描 public/fonts/ 下的 .ttf/.otf，返回 [{file,family}]（family=文件名去扩展名）
  if (urlPath === '/api/fonts') {
    try {
      const list = [];
      if (fs.existsSync(FONTS_DIR)) {
        for (const f of fs.readdirSync(FONTS_DIR)) {
          if (/\.(ttf|otf)$/i.test(f)) list.push({ file: f, family: f.replace(/\.(ttf|otf)$/i, '') });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(list));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // 上传自定义字体：前端 FileReader 读 base64 后 POST {name:'xxx.ttf', data:'base64...'}，写入 public/fonts/
  if (urlPath === '/api/upload-font' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    let responded = false;
    const sendErr = (code, msg) => {
      if (responded) return;
      responded = true;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg }));
    };
    req.on('data', c => {
      size += c.length;
      if (size > 40 * 1024 * 1024) { // 单字体上限约 30MB（base64 膨胀后 ~40MB）
        sendErr(413, '字体文件过大（上限约 30MB）');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (responded) return;
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const name = String(obj.name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
        if (!name || !/\.(ttf|otf)$/i.test(name)) return sendErr(400, '仅支持 .ttf / .otf 字体文件');
        if (!obj.data) return sendErr(400, '未收到字体数据');
        const buf = Buffer.from(obj.data, 'base64');
        if (!buf.length) return sendErr(400, '字体数据为空');
        fs.mkdirSync(FONTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(FONTS_DIR, name), buf);
        log('上传自定义字体: ' + name + ' (' + Math.round(buf.length / 1024) + 'KB)');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file: name, family: name.replace(/\.(ttf|otf)$/i, '') }));
        sendClient({ type: 'fonts-updated' }); // 通知已打开的透明窗/OBS 重新加载 @font-face，新字体无需重开即生效
      } catch (e) {
        sendErr(400, '上传失败: ' + e.message);
      }
    });
    return;
  }

  // 系统已装字体：读 Windows 注册表（HKLM/HKCU Fonts），清理出可用 font-family 名（中英文名都保留）
  // 前端据此动态填充「系统字体」下拉，用户双击安装的字体能自动出现（失败/超时返回空数组，前端保留固定 7 个兜底）
  if (urlPath === '/api/system-fonts') {
    const psScript = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts');" +
      "$r=@();foreach($x in $k){$p=Get-ItemProperty -Path $x -ErrorAction SilentlyContinue;" +
      "if($p){$p.PSObject.Properties|Where-Object{$_.Name -notmatch '^PS'}|ForEach-Object{$r+=$_.Name}}};" +
      "$r|Sort-Object -Unique";
    let child;
    try { child = spawn('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true }); }
    catch (e) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('[]'); return; }
    let out = '';
    let done = false;
    const finish = (arr) => { if (done) return; done = true; res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(arr)); };
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} finish([]); }, 8000);
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => {
      clearTimeout(t);
      const seen = new Set();
      const fonts = [];
      out.split(/\r?\n/).forEach(line => {
        let name = line.trim();
        if (!name) return;
        name = name.replace(/\([^)]*\)/g, '').trim();          // 去 (TrueType)/(OpenType) 等后缀
        if (name.indexOf('&') >= 0) name = name.split('&')[0].trim(); // 取本地化名（中文）
        if (!name || name.length < 2) return;
        if (seen.has(name)) return;
        seen.add(name);
        fonts.push(name);
      });
      finish(fonts);
    });
    child.on('error', () => { clearTimeout(t); finish([]); });
    return;
  }

  // 一键健康体检：逐项检测运行环境，返回 JSON（前端渲染成清单 + 修复建议）——分享给朋友后"没声音"可自助排查
  if (urlPath === '/api/selfcheck') {
    const items = [];
    const add = (name, status, detail, advice) => items.push({ name, status, detail, advice: advice || '' });
    // 跑一段 PowerShell 取输出（8 秒熔断，失败不阻塞整体体检）
    const runPs = (script) => new Promise(resolve => {
      let child;
      try { child = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true }); }
      catch (e) { return resolve(''); }
      let out = '';
      const done = () => resolve(out.trim());
      const t = setTimeout(() => { try { child.kill(); } catch (e) {} done(); }, 8000);
      child.stdout.on('data', d => out += d.toString());
      child.on('close', () => { clearTimeout(t); done(); });
      child.on('error', () => { clearTimeout(t); done(); });
    });

    // 1) 播放进程（player.py）——它不在，必然无声
    if (player && player.stdin && player.stdin.writable && !player.killed) {
      add('播放进程', 'ok', 'player.py 播放器运行中');
    } else {
      add('播放进程', 'fail', '播放器进程未运行', '重启弹幕姬即可；若反复出现，检查杀毒软件是否拦截了项目内的 python.exe');
    }

    if (process.platform === 'win32') {
      // 2) 音频输出设备（"没声音"的头号嫌疑）：设备健康数 + 默认设备漂移提示
      const a = await runPs('$d = @(Get-CimInstance Win32_SoundDevice); "$($d.Count)|$((@($d | Where-Object { $_.Status -eq \'OK\' })).Count)"');
      if (!a) {
        add('音频输出设备', 'warn', '检测超时或 PowerShell 不可用', '手动确认：右下角喇叭图标 → 输出设备是否选对、是否静音');
      } else {
        const [total, ok] = a.split('|').map(n => parseInt(n, 10) || 0);
        if (ok > 0) add('音频输出设备', 'ok', '检测到 ' + ok + ' 个状态正常的音频设备', '弹幕姬声音走「系统默认输出」设备；若没声，右键右下角喇叭→声音设置，把默认输出切到你想听的喇叭/耳机（笔记本尤其注意别选成 HDMI/显示器）');
        else if (total > 0) add('音频输出设备', 'warn', '检测到 ' + total + ' 个音频设备但状态异常', '设备管理器 → 声音、视频和游戏控制器，检查驱动是否异常');
        else add('音频输出设备', 'fail', '未检测到任何音频输出设备', '检查音箱/耳机接口与电源、声卡驱动；笔记本确认音频设备未被禁用');
      }
      // 3) 系统内置语音（SAPI 兜底引擎用；走注册表，不依赖 Add-Type）
      const n = parseInt(await runPs('(Get-ChildItem "HKLM:\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens" -ErrorAction SilentlyContinue).Count'), 10);
      if (n > 0) add('系统内置语音', 'ok', '已安装 ' + n + ' 个系统语音');
      else add('系统内置语音', 'warn', '未检测到系统语音', '切"系统内置"引擎时会无声；建议保持"晓晓在线"引擎');
    }

    // 4) 晓晓在线合成通路（真实调一次微软 TTS，一次体检约 1-3 秒）
    if (state.cfg.engine === 'edge') {
      const t0 = Date.now();
      try {
        const wav = await edge.synthesize('弹幕姬体检', state.cfg.voice, { rate: 0, pitch: 0 });
        if (wav && wav.length > 1000) add('晓晓在线合成', 'ok', '合成正常（' + Math.round(wav.length / 1024) + 'KB，' + (Date.now() - t0) + 'ms）');
        else add('晓晓在线合成', 'fail', '合成返回空音频', '检查网络后重试；持续失败可临时切"系统内置"引擎');
      } catch (e) {
        add('晓晓在线合成', 'fail', '合成失败：' + String(e.message).slice(0, 60), '确认能访问微软语音服务（网络/代理/防火墙）；或临时切"系统内置"引擎');
      }
    } else {
      add('晓晓在线合成', 'ok', '当前用系统内置引擎，跳过在线检测');
    }

    // 5) B站接口连通
    try {
      const ctl = new AbortController();
      const tid = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=1', { signal: ctl.signal });
      clearTimeout(tid);
      if (r.ok) add('B站接口连通', 'ok', '接口访问正常');
      else add('B站接口连通', 'warn', '返回 HTTP ' + r.status, '可能被网络环境限制，弹幕可能收不到');
    } catch (e) {
      add('B站接口连通', 'fail', '无法访问 B站接口', '检查本机网络；不通则弹幕连接无法建立');
    }

    // 6) 播报音量（最常见的"手滑"）
    if ((state.cfg.volume || 0) <= 0) add('播报音量', 'fail', '当前音量为 0（必然无声）', '把「音量」滑块调回 50 以上');
    else add('播报音量', 'ok', '当前音量 ' + state.cfg.volume + '%');

    // 7) 登录 Cookie（影响弹幕昵称是否被匿名化）
    if (state.lastCookie) add('登录 Cookie', 'ok', '已填写 Cookie');
    else add('登录 Cookie', 'warn', '未填 Cookie（游客模式）', '游客连接约 5 分钟后，弹幕昵称会变成 X***；填 Cookie 可避免');

    // 8) 日志目录可写（播报不依赖，但出问题时要能留证据）
    try { fs.accessSync(SAVE_DIR, fs.constants.W_OK); add('日志目录', 'ok', 'save/ 目录可写'); }
    catch (e) { add('日志目录', 'fail', 'save/ 目录不可写', '检查文件夹权限，或杀毒软件是否锁定了该目录'); }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ time: new Date().toLocaleString('zh-CN', { hour12: false }), items }));
    return;
  }
  // 首次启动自检标记：前端首开自动跑体检前查一次；跑完 POST 置 true 写回 config.json
  if (urlPath === '/api/firstrun') {
    if (req.method === 'POST') {
      state.cfg.firstRunDone = true;
      saveConfig();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ done: !!state.cfg.firstRunDone }));
    return;
  }
  // 打开透明弹幕窗（Electron 壳）：spawn electron.exe 加载 overlay 目录；main.js 有单实例锁，重复点击只会聚焦已有窗口
  if (urlPath === '/api/open-overlay') {
    try {
      const electronExe = path.join(__dirname, 'runtime', 'electron', 'electron.exe');
      const overlayDir = path.join(__dirname, 'overlay');
      const closeFlag = path.join(SAVE_DIR, 'overlay-close.flag');
      try { fs.unlinkSync(closeFlag); } catch (e) { /* 无残留标志忽略 */ } // 清掉上次关闭残留，避免刚启动就被误关
      if (fs.existsSync(electronExe)) {
        spawn(electronExe, [overlayDir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        log('已通过接口启动透明弹幕窗');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, msg: '透明弹幕窗已启动' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, msg: '未找到 Electron 运行时（runtime/electron 缺失）' }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, msg: '启动失败: ' + e.message }));
    }
    return;
  }
  // 关闭透明弹幕窗：写标志文件 save/overlay-close.flag，overlay/main.js 轮询到即退出（不直接杀进程，走干净退出）
  if (urlPath === '/api/close-overlay') {
    try {
      fs.writeFileSync(path.join(SAVE_DIR, 'overlay-close.flag'), 'close');
      log('已发送关闭透明弹幕窗指令');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, msg: '透明弹幕窗关闭指令已发送' }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, msg: '发送失败: ' + e.message }));
    }
    return;
  }
  // 导出诊断日志：朋友电脑出问题 → 前端点「导出日志」→ 下载 txt 发回 → 据此定位
  if (urlPath === '/api/diagnose') {
    try {
      const parts = [];
      parts.push('B站语音弹幕姬 诊断日志');
      parts.push('导出时间: ' + new Date().toLocaleString('zh-CN', { hour12: false }));
      parts.push('='.repeat(50));
      // 环境信息
      parts.push('[环境]');
      parts.push('系统: ' + process.platform + ' ' + process.arch + ' (' + os.release() + ')');
      parts.push('Node: ' + process.version);
      parts.push('项目路径: ' + __dirname);
      parts.push('端口: ' + actualPort);
      parts.push('Python: ' + findPython());
      parts.push('='.repeat(50));
      // 诊断日志全文（截断到最近 2000 行）
      parts.push('[diagnose.log 最近日志]');
      try {
        const lines = fs.readFileSync(path.join(SAVE_DIR, 'diagnose.log'), 'utf8').split('\n');
        parts.push(lines.slice(-2000).join('\n'));
      } catch (e) { parts.push('(diagnose.log 不存在或读取失败: ' + e.message + ')'); }
      parts.push('='.repeat(50));
      // 事件日志尾部
      parts.push('[events.log 最近事件]');
      try {
        const lines = fs.readFileSync(EVENTS_LOG, 'utf8').split('\n');
        parts.push(lines.slice(-300).join('\n'));
      } catch (e) { parts.push('(events.log 不存在或读取失败)'); }
      const body = parts.join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="danmuji-diagnose.txt"'
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('导出失败: ' + e.message);
    }
    return;
  }
  // 扫码登录接口
  if (urlPath === '/api/qrcode') {
    try {
      const { url, key } = await biliQrcodeGenerate();
      const image = await QRCode.toDataURL(url, { width: 260, margin: 1 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key, image }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (urlPath === '/api/qrcode/poll') {
    const key = new URL(req.url, 'http://localhost').searchParams.get('key');
    if (!key) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺 key' })); return; }
    try {
      const r = await biliQrcodePoll(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // 取暂存 Cookie（本机排障用，仅 DM_DEBUG 模式开启——防 Cookie 泄露到局域网/公网）
  if (process.env.DM_DEBUG && urlPath === '/api/debug/getcookie') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cookie: state.lastCookie || '' }));
    return;
  }
  // 实时监听调试：用暂存 Cookie 连指定房间，打印收到的事件（仅 DM_DEBUG 模式）
  if (process.env.DM_DEBUG && urlPath === '/api/debug/listen') {
    try {
      const cookie = state.lastCookie || '';
      const q = new URL(req.url, 'http://localhost');
      const roomId = q.searchParams.get('room') || '';
      const seconds = parseInt(q.searchParams.get('seconds') || '45', 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ listening: true, room: roomId, seconds, cookie: !!cookie }));
      log('开始监听[' + roomId + '] ' + seconds + 's, cookie=' + !!cookie);
      const dm = new BiliDanmaku({
        roomId,
        cookie,
        onEvent: ev => log('📣 监听事件:', ev.type, '|', ev.uname, '|', ev.text || ev.giftName || ''),
        onStatus: s => log('监听状态:', s.state, s.msg || ''),
        onError: e => log('监听错误:', e.message),
      });
      dm.connect();
      setTimeout(() => { dm.close(); log('监听结束[' + roomId + ']'); }, seconds * 1000);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 对照事件测试：用 lastCookie 连活跃直播间看能否收到弹幕（仅 DM_DEBUG 模式）
  if (process.env.DM_DEBUG && urlPath === '/api/debug/events') {
    try {
      const cookie = state.lastCookie || '';
      const testRoomId = new URL(req.url, 'http://localhost').searchParams.get('room') || '21144080';
      const room = await resolveRoom(testRoomId);
      const info = await getDanmuInfo(room.roomId);
      const url = `wss://${info.host}:${info.port}/sub`;
      let events = 0, bins = 0;
      const result = await new Promise(resolve => {
        const ws = new WebSocket(url, {
          headers: { 'User-Agent': BILI_UA, 'Origin': 'https://live.bilibili.com', ...(cookie ? { Cookie: cookie } : {}) }
        });
        ws.on('open', () => ws.send(encodePacket(7, { uid: 0, roomid: room.roomId, protover: 3, platform: 'web', type: 2, key: info.token })));
        ws.on('message', (data, isBinary) => {
          if (isBinary) { bins++; return; }
          const t = data.toString();
          if (t.includes('DANMU_MSG') || t.includes('INTERACT_WORD') || t.includes('SEND_GIFT')) events++;
        });
        ws.on('close', () => resolve({ events, bins, closed: true }));
        setTimeout(() => resolve({ events, bins, closed: false }), 15000);
      });
      log('对照测试(uid=0' + (cookie ? '+Cookie' : '游客') + ') 房间' + testRoomId + ':', JSON.stringify(result));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 认证组合调试（仅 DM_DEBUG 模式）
  if (process.env.DM_DEBUG && urlPath === '/api/debug/authtest') {
    try {
      const cookie = state.lastCookie || '';
      if (!cookie) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '无Cookie，请先连接一次' })); return; }
      const roomId = new URL(req.url, 'http://localhost').searchParams.get('room') || '';
      const room = await resolveRoom(roomId);
      const info = await getDanmuInfo(room.roomId, cookie);
      const url = `wss://${info.host}:${info.port}/sub`;
      const uid = parseInt((cookie.match(/DedeUserID=(\d+)/) || [])[1] || '0', 10);
      const combos = [
        { label: 'uid真实+web/type2', body: { uid, roomid: room.roomId, protover: 3, platform: 'web', type: 2, key: info.token } },
        { label: 'uid真实+android/type3', body: { uid, roomid: room.roomId, protover: 3, platform: 'android', type: 3, key: info.token } },
        { label: 'uid0+web/type2', body: { uid: 0, roomid: room.roomId, protover: 3, platform: 'web', type: 2, key: info.token } },
        { label: 'uid0+android/type3', body: { uid: 0, roomid: room.roomId, protover: 3, platform: 'android', type: 3, key: info.token } },
        { label: 'uid0+web/type2/proto2', body: { uid: 0, roomid: room.roomId, protover: 2, platform: 'web', type: 2, key: info.token } },
      ];
      const results = [];
      for (const c of combos) {
        const r = await new Promise(resolve => {
          const ws = new WebSocket(url, { headers: { 'User-Agent': BILI_UA, 'Origin': 'https://live.bilibili.com', 'Cookie': cookie } });
          let done = false, msgs = 0, events = 0;
          const finish = (ok, msg) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve({ ok, msg, msgs, events }); } };
          ws.on('open', () => ws.send(encodePacket(7, c.body)));
          ws.on('message', (data, isBinary) => {
            if (!isBinary) {
              msgs++;
              const t = data.toString();
              if (t.includes('DANMU_MSG') || t.includes('INTERACT_WORD') || t.includes('SEND_GIFT') || t.includes('NOTICE_MSG')) events++;
              const m = t.match(/"code":(\d+)/);
              if (t.includes('"code"')) {
                const code = m ? parseInt(m[1]) : -1;
                if (code === 0 && t.includes('AUTH')) finish(true, '认证OK');
              }
            }
          });
          ws.on('close', () => finish(false, 'closed'));
          ws.on('error', (e) => finish(false, 'error:' + e.message));
          setTimeout(() => finish(msgs > 0 || events > 0, '5s(存活)'), 5000);
        });
        results.push({ combo: c.label, ...r });
        log('认证测试[' + roomId + ']:', c.label, '->', r.ok ? '✅' : '❌', 'msgs=' + r.msgs, 'events=' + r.events, r.msg);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml', '.json': 'application/json',
      '.ttf': 'font/ttf', '.otf': 'font/otf',
    };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------- WebSocket（浏览器控制面板） ----------------
const wss = new WebSocket.Server({ server });
// 端口自动换口配套：EADDRINUSE 时 ws 库会把 http server 的 error 转发到 wss 上，
// 无人处理会当场崩进程（"Unhandled 'error' event on WebSocketServer instance"）。
// 真正的换口重试由底部 startListen 的 server.once('error') 负责，这里只兜底防崩。
wss.on('error', () => { /* 转发错误兜底，见上注释 */ });
// 【叉掉页面=彻底关闭】浏览器全部断开后 7 秒内无新连接（刷新/重开页面会重连并取消）→ 杀播放器 + 服务退出（释放 3000 端口）
let shutdownTimer = null;

wss.on('connection', (ws) => {
  state.client = ws;
  state.browserGone = false; // 页面回来了 → 恢复播报
  // 有页面重连 → 取消"叉掉页面自动关闭"倒计时（刷新/重开页面时 7 秒内必连上）
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; log('页面重连，取消自动关闭'); }
  log('浏览器新连接 (uid=' + (ws._upgradeReq?.headers?.['sec-websocket-key']?.slice(0, 8) || '?') + ')'); // 入口日志：每次新连接都有，便于排查重连
  sendClient({ type: 'cfg', cfg: state.cfg });
  if (state.danmaku) {
    sendClient({ type: 'status', state: 'connected', msg: '已连接(B站连接保留)' });
  } else {
    sendClient({ type: 'status', state: 'idle', msg: '未连接' });
  }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    switch (msg.type) {
      case 'connect': connectRoom(String(msg.roomId || '').trim(), String(msg.cookie || '').trim()); break;
      case 'disconnect': disconnectRoom(); break;
      case 'config':
        Object.assign(state.cfg, msg.cfg || {});
        // 防刷屏窗口兜底：非法值恢复默认 0（不防刷屏）
        const dw = state.cfg.dedupWindowMs;
        if (typeof dw !== 'number' || isNaN(dw) || dw < 0 || dw > 999000) state.cfg.dedupWindowMs = 0;
        // 音量兜底：非法值恢复 50
        const v = state.cfg.volume;
        if (typeof v !== 'number' || isNaN(v) || v < 0 || v > 100) state.cfg.volume = 50;
        // 屏蔽词兜底：非数组恢复 []（空列表=不屏蔽）
        if (!Array.isArray(state.cfg.blockWords)) state.cfg.blockWords = [];
        // 尾词兜底：非字符串/超长恢复 '喵'
        if (typeof state.cfg.tailWord !== 'string' || state.cfg.tailWord.length > 10) state.cfg.tailWord = '喵';
        // 弹幕小窗模式兜底：非 list/fly 恢复 list
        if (state.cfg.danmakuMode !== 'list' && state.cfg.danmakuMode !== 'fly') state.cfg.danmakuMode = 'list';
        // 弹幕小窗外观兜底
        const dfs = state.cfg.danmakuFontSize;
        if (typeof dfs !== 'number' || isNaN(dfs) || dfs < 12 || dfs > 96) state.cfg.danmakuFontSize = 32;
        if (typeof state.cfg.danmakuColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(state.cfg.danmakuColor)) state.cfg.danmakuColor = '#ffffff';
        if (typeof state.cfg.danmakuRandomColor !== 'boolean') state.cfg.danmakuRandomColor = false;
        if (typeof state.cfg.danmakuFont !== 'string' || !state.cfg.danmakuFont.trim()) state.cfg.danmakuFont = 'Microsoft YaHei';
        // 队列容量兜底：1-999 整数；非法恢复 5
        const qc = state.cfg.queueCapacity;
        if (typeof qc !== 'number' || isNaN(qc) || qc < 1 || qc > 999) state.cfg.queueCapacity = 5;
        // 最长字数兜底：1-30 整数；非法恢复 30（与前端默认一致）
        const mtl = state.cfg.maxTextLength;
        if (typeof mtl !== 'number' || isNaN(mtl) || mtl < 1 || mtl > 30) state.cfg.maxTextLength = 30;
        // 进场昵称长度兜底：1-20 整数；非法恢复 20
        const enm = state.cfg.enterNameMax;
        if (typeof enm !== 'number' || isNaN(enm) || enm < 1 || enm > 20) state.cfg.enterNameMax = 20;
        // 过滤规则开关兜底：非布尔恢复默认（空弹幕 on / 表情 off / 仅关注 on）
        if (typeof state.cfg.filterEmptyDanmaku !== 'boolean') state.cfg.filterEmptyDanmaku = true;
        if (typeof state.cfg.filterEmojiDanmaku !== 'boolean') state.cfg.filterEmojiDanmaku = false;
        if (typeof state.cfg.readFollowOnly !== 'boolean') state.cfg.readFollowOnly = false;
        if (typeof state.cfg.readFollowing !== 'boolean') state.cfg.readFollowing = false;
        if (typeof state.cfg.priorityGift !== 'boolean') state.cfg.priorityGift = true; // 打赏插队默认开
        // 音色兜底（全局 + 分事件统一）：非法/不存在的音色名拉回合法值，防历史假音色残留导致合成失败落 SAPI
        sanitizeVoiceConfig();
        sendClient({ type: 'cfg', cfg: state.cfg });
        saveConfigDebounced(); // 防抖写 config.json（拖动滑块高频时只写一次）
        break;
      case 'test':
        pushSpeech('你好，这是测试语音，哔哩哔哩弹幕姬工作正常', 'test');
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });
  ws.on('close', () => {
    if (state.client === ws) {
      state.client = null;
      // 关掉的是"当前推送对象"但还有别的标签页 → 让存活标签页接管消息推送（否则那页收不到状态/事件更新）
      for (const c of wss.clients) { if (c !== ws && c.readyState === WebSocket.OPEN) { state.client = c; break; } }
    }
    // 多标签页保护（真正的）：还有别的标签页连着 → 只记日志，不断 B站连接、不清队列
    // （之前 stopAll 在这个检查之前执行——注释说"多标签页保护"其实只保住了进程不退出，B站连接照样被掐）
    let otherLive = false;
    for (const c of wss.clients) { if (c !== ws && c.readyState === WebSocket.OPEN) { otherLive = true; break; } }
    if (otherLive) { log('浏览器断开（仍有其它标签页连着，保持运行）'); return; }
    state.browserGone = true;
    // 【断开即全停】最后一个标签页断开/刷新/关页 = 打断一切（不再保留 B站连接：重连已改 setInterval 不被节流，保留不再需要）
    stopAll('浏览器断开');
    // 【叉掉页面=彻底关闭】全部断开后 7 秒内无新连接（刷新/重开页面会重连并取消）→ 杀播放器 + 服务退出（释放端口）
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      log('浏览器关闭超 7 秒未重连，弹幕姬彻底关闭（下次使用请双击 start.bat）');
      try { if (player && player.kill) player.kill(); } catch (e) { /* 忽略 */ }
      try { if (player && player.stdin) player.stdin.end(); } catch (e) { /* 忽略 */ }
      process.exit(0);
    }, 7000);
  });
});

// ---------------- 启动 ----------------
// 端口占用自动规避：默认端口被占（常见于上次没关干净/别的程序占用）→ 依次 +1 试 10 个口，
// 实际端口写入 save/port.txt（start.bat 读它决定浏览器打开哪个页面，换口后仍能自动开对）
let actualPort = parseInt(PORT, 10) || 3000;
function startListen(port, retriesLeft) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && retriesLeft > 0) {
      // 关键：listen(port, cb) 内部是 once('listening', cb)，EADDRINUSE 失败不会自动移除这个成功回调——
      // 不清掉的话换口成功时新旧回调都触发，启动流程（initPlayer 等）会跑两遍（实测踩坑）
      server.removeAllListeners('listening');
      console.log('[启动] 端口 ' + port + ' 被占用，自动尝试 ' + (port + 1) + ' ...');
      startListen(port + 1, retriesLeft - 1);
      return;
    }
    console.error('[启动] 服务启动失败: ' + e.message);
    process.exit(1);
  });
  server.listen(port, () => {
    actualPort = port;
    loadConfig(); // 启动时加载 config.json（不存在则用 state.cfg 默认值）
    checkEventsLog(); // 事件日志超 3 天未用 → 清空（打开弹幕姬时执行）
    try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
    rotateDiagnoseLog(); // 诊断日志超 512KB 先归档（保留上一份 diagnose.old.log）
    rotateEventsLog();   // 事件日志超 2MB 先归档（保留上一份 events.old.log）
    try { fs.writeFileSync(path.join(SAVE_DIR, 'port.txt'), String(actualPort)); } catch (e) { /* 忽略 */ }
    if (actualPort !== (parseInt(PORT, 10) || 3000)) log('注意：默认端口被占用，本次自动换到端口 ' + actualPort);
    logEnvironment(); // 输出环境诊断块
    initPlayer(); // 启动系统播放器（晓晓WAV直出，免浏览器）
    console.log('==============================================');
    console.log('  B站语音弹幕姬 已启动');
    console.log(`  浏览器打开:  http://localhost:${actualPort}`);
    console.log('  关闭服务:   Ctrl+C');
    console.log('  runtime: node/' + process.version + ' · channel: dm-2609-7A3F');
    console.log('==============================================');
  });
}
// 启动前清掉旧 port.txt（防 start.bat 读到上次的旧端口开错页面；监听成功后会立刻重写）
try { fs.unlinkSync(path.join(SAVE_DIR, 'port.txt')); } catch (e) { /* 忽略 */ }
startListen(actualPort, 10);
