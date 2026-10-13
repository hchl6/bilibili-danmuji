// B站直播弹幕协议客户端（WebSocket + 心跳 + brotli/zlib 解压）
const WebSocket = require('ws');
const zlib = require('zlib');

// B站弹幕协议操作码：
// 2=客户端心跳(空body) 3=服务端心跳回复 5=消息 7=认证 8=认证回复
const OP = { AUTH: 7, HEARTBEAT: 2, MESSAGE: 5, AUTH_REPLY: 8, HEARTBEAT_REPLY: 3 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

// 打包协议帧：16字节头 + JSON体
function encodePacket(op, body) {
  const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + bodyBuf.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, bodyBuf]);
}

// 拆包（一个 buffer 可能含多个帧）
function decodePackets(buf) {
  const packets = [];
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const total = buf.readUInt32BE(offset);
    const headerLen = buf.readUInt16BE(offset + 4);
    // 帧长校验：非法帧直接丢弃剩余数据，防死循环/错位（B站偶发异常帧）
    if (total < 16 || total > buf.length - offset) break;
    const ver = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    const body = buf.subarray(offset + headerLen, offset + total);
    packets.push({ ver, op, body });
    offset += total;
  }
  return packets;
}

// INTERACT_WORD_V2 的 data.pb 是 Base64 编码的 protobuf（B站已用 V2 取代 V1 明文 JSON）。
// 字段定义（blivemsg 等开源解析器实测确认）：
//   tag 1=uid(uint64) 2=uname(string) 3=uname_color(string) 4=identities(repeated) 5=msg_type(uint64,1进场/2关注/3分享)
//   tag 6=roomid(uint64) 7=timestamp(uint64) 8=score(uint64)
// 手写迷你解码器（无需 protobuf 库）：返回 { fieldNum: value }，varint 高位用乘法避免 32 位移位溢出
function decodeInteractPb(b64) {
  const buf = Buffer.from(b64 || '', 'base64');
  const fields = {};
  let i = 0;
  function readVarint() {
    let val = 0, shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      if (shift < 28) val |= (b & 0x7f) << shift;
      else val += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return val;
  }
  while (i < buf.length) {
    const tag = readVarint();
    const num = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) { fields[num] = readVarint(); }
    else if (wt === 2) { const len = readVarint(); fields[num] = buf.slice(i, i + len).toString('utf8'); i += len; }
    else if (wt === 5) { fields[num] = buf.readUInt32LE(i); i += 4; }
    else if (wt === 1) { i += 8; } // 64-bit 原始块，不需要
    else break; // 异常 wire type，停止解析
  }
  return fields;
}

// 短号/房间号 -> 真实房间号 + 元数据
async function resolveRoom(roomId) {
  const res = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
    headers: { 'User-Agent': UA }
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data) throw new Error(`房间解析失败: ${json.message || '房间不存在'}`);
  return {
    roomId: json.data.room_id,
    title: json.data.title || '',
    uid: json.data.uid || 0,
    liveStatus: json.data.live_status,
    online: json.data.online || 0,         // 人气值（"在线"）
    attention: json.data.attention || 0,   // 关注数
  };
}

// 拉取直播间元数据（在线/关注）
// 注意："看过"和"赞"已由 ws 实时事件维护（WATCHED_CHANGE / LIKE_INFO_V3_*），这里只提供"在线"兜底
// （getRoomPlayInfo 不带 like_info / getRoomBaseInfo 无"看过"字段——都已验证，不重复请求）
async function fetchRoomStats(cookie, roomId) {
  const stats = { online: null, attention: null };
  try {
    const r1 = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
      headers: { 'User-Agent': UA, 'Referer': `https://live.bilibili.com/${roomId}`, ...(cookie ? { Cookie: cookie } : {}) }
    });
    const j1 = await r1.json();
    if (process.env.DM_DEBUG) console.log('[stats-raw] getRoomInfo:', JSON.stringify(j1).slice(0, 400));
    if (j1.code === 0 && j1.data) {
      stats.online = j1.data.online || 0;
      stats.attention = j1.data.attention || 0;
    }
  } catch (e) { /* 抓取失败忽略 */ }
  return stats;
}

// 获取弹幕服务器地址 + token
// 注：新版 getDanmuInfo 有 wbi 风控(-352)，旧版 getConf 稳定可用
// 必须带 cookie 调（否则 B 站 5 分钟后会强制匿名化弹幕发送者，昵称变 X***）
async function getDanmuInfo(roomId, cookie = '') {
  const res = await fetch(`https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`, {
    headers: { 'User-Agent': UA, 'Referer': 'https://live.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) }
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data || !json.data.host_server_list || !json.data.host_server_list.length) {
    throw new Error(`弹幕服务器获取失败: ${json.code} ${json.message || '未知错误'}`);
  }
  const host = json.data.host_server_list[0];
  return { token: json.data.token, host: host.host, port: host.wss_port || 443 };
}

class BiliDanmaku {
  constructor({ roomId, onEvent, onStatus, onError, cookie, onLog }) {
    this.inputRoomId = roomId;
    this.cookie = cookie || '';   // B站登录 Cookie（可选，带登录态能收到主播弹幕/未开播留言）
    this.onEvent = onEvent;       // 统一事件回调
    this.onStatus = onStatus;     // 状态回调
    this.onError = onError;
    this.onLog = onLog || (() => {}); // 诊断日志钩子（server.js 注入 → 写入 diagnose.log）
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.running = false;
    this.roomInfo = null;
    this.authDone = false;   // 本次连接是否已收到 AUTH_REPLY（判定 cookie 失效：登录态连接认证前被断开）
  }

  get connected() { return !!(this.ws && this.ws.readyState === WebSocket.OPEN); }

  // 从 Cookie 提取登录 uid（DedeUserID）—— B 站隐私政策：
  // 游客连接（uid=0）会在 5 分钟后被强制匿名化（发送者昵称变 X***）
  // 带 cookie + 真 uid 认证 → 持续保持登录态，5 分钟内/外都不匿名化
  getUid() {
    if (!this.cookie) return 0;
    const m = this.cookie.match(/DedeUserID=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  async connect() {
    if (this.connected) return;
    this.running = true;
    try {
      // 1. 解析房间
      this.roomInfo = await resolveRoom(this.inputRoomId);
      this.onLog('[连接] 房间解析成功: id=' + this.roomInfo.roomId + ' title=' + (this.roomInfo.title || '') + ' (uid=' + this.getUid() + ')');
      this.onStatus({ state: 'resolving', msg: `房间: ${this.roomInfo.title || this.roomInfo.roomId}` });
      // 2. 拿弹幕服务器（带 cookie 避免 5 分钟后被匿名化）
      const info = await getDanmuInfo(this.roomInfo.roomId, this.cookie);
      const url = `wss://${info.host}:${info.port}/sub`;
      this.onLog('[连接] 弹幕服务器: ' + info.host + ':' + info.port + ' (cookie=' + (this.cookie ? '带' : '不带') + ')');
      // 3. 连接（带 Cookie 走登录身份）
      const headers = { 'User-Agent': UA, 'Origin': 'https://live.bilibili.com' };
      if (this.cookie) headers['Cookie'] = this.cookie;
      this.ws = new WebSocket(url, { headers });
      // 握手被拒时打印状态码（定位带 Cookie 连接失败原因）
      this.ws.on('unexpected-response', (req, res) => {
        this.onLog('[连接] 握手被拒 HTTP ' + res.statusCode);
        this.onError && this.onError(new Error('WebSocket 握手被拒(HTTP ' + res.statusCode + ')'));
      });
      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.authDone = false;   // 新连接重置认证标志
        this.onLog('[连接] WS 已打开，发送认证包 roomid=' + this.roomInfo.roomId + ' uid=' + this.getUid());
        // 认证（uid 用登录 ID，游客为 0）
        this.ws.send(encodePacket(OP.AUTH, {
          uid: this.getUid(), roomid: this.roomInfo.roomId, protover: 3,
          platform: 'web', type: 2, key: info.token
        }));
        this.startHeartbeat();
        this.onStatus({ state: 'connecting', msg: this.getUid() ? `连接中(登录态 uid=${this.getUid()})...` : '连接中(游客)...' });
      });
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', () => this.handleClose());
      this.ws.on('error', (e) => {
        this.onLog('[连接] ws error: ' + e.message);
        this.onError && this.onError(e);
      });
    } catch (e) {
      this.onLog('[连接] 初始化异常: ' + e.message);
      this.onError && this.onError(e);
      this.scheduleReconnect();
    }
  }

  handleMessage(data) {
    try {
      for (const pkt of decodePackets(data)) {
        if (pkt.ver === 2) {
          // zlib 压缩
          const inner = decodePackets(zlib.inflateSync(pkt.body));
          for (const p of inner) this.dispatch(p);
        } else if (pkt.ver === 3) {
          // brotli 压缩
          const inner = decodePackets(zlib.brotliDecompressSync(pkt.body));
          for (const p of inner) this.dispatch(p);
        } else {
          this.dispatch(pkt);
        }
      }
    } catch (e) {
      this.onError && this.onError(new Error('数据解析失败: ' + e.message));
    }
  }

  dispatch(pkt) {
    if (pkt.op === OP.AUTH_REPLY) {
      this.authDone = true;   // 收到认证回复（无论成败）都算"服务器已处理认证"
      const j = JSON.parse(pkt.body.toString());
      if (j.code === 0) {
        this.onLog('[连接] 认证成功，弹幕通道已建立');
        this.onStatus({ state: 'connected', msg: '已连接' });
      } else {
        this.onLog('[连接] 认证失败 code=' + j.code + ' (' + (j.message || '') + ')');
        this.onStatus({ state: 'error', msg: `认证失败(${j.code})` });
      }
      return;
    }
    if (pkt.op === OP.MESSAGE) {
      const j = JSON.parse(pkt.body.toString());
      const ev = this.parseCommand(j);
      // running=false 表示已 close——丢弃旧连接的缓冲弹幕（切换房间/断开后旧 WS 缓冲可能还在吐）
      if (ev && this.running) this.onEvent(ev);
    }
  }

  // 各类 cmd -> 统一事件
  parseCommand(j) {
    const cmd = j.cmd;
    if (!cmd) return null;
    // 弹幕（含带状态码的 DANMU_MSG:xxx）
    if (cmd.startsWith('DANMU_MSG')) {
      const info = j.info;
      // B站 DANMU_MSG info[0] 数组结构（实测）：
      //   [0]=模式, [1]=字号, [2]=?, [3]=颜色(16777215), [4]=发送时间戳(毫秒), ...
      // 注意：info[0][3] 是颜色值（永远 truthy），绝对不能当 sendtime！正确位置是 info[0][4]
      const sendtimeMs = (info[0] && info[0][4]) || 0;
      const sendtime = sendtimeMs ? Math.floor(sendtimeMs / 1000) : 0;
      if (process.env.DM_DEBUG && this.onEvent) {
        // 一次性打印 info 索引结构（避免刷屏，只打第一次）
        if (!this._infoLogged) { this._infoLogged = true; console.log('[debug-info] info.length=' + info.length + ' u2=' + JSON.stringify(info[2]) + ' m3=' + JSON.stringify(info[3])); }
      }
      // "自己人"判定（供服务端"仅朗读粉丝牌/房管"过滤）：
      //   isAdmin: info[2][2] === 1 是房管（协议实测确认）
      //   hasMedal: info[3] 非空数组 = 戴了本直播间粉丝牌；舰长/提督/总督上舰必有牌 → 自动包含，无需单列
      //   注意：旧版"info[3][0][9] 取关注标记"是抄错的协议结构——B站弹幕不含"是否关注主播"字段，已废弃
      const u2 = info[2] || [];
      const isAdmin = u2[2] === 1;
      const hasMedal = Array.isArray(info[3]) && info[3].length > 0;
      return { type: 'danmaku', uid: u2[0], uname: u2[1], text: info[1], time: sendtime, ts: Date.now(), isAdmin, hasMedal };
    }
    // 在线人数实时更新（开播期间 B 站 ws 推送，比 getRoomInfo 准）
    if (cmd === 'ONLINE_RANK_V2' || cmd === 'ONLINE_RANK' || cmd === 'ROOM_REAL_TIME_MESSAGE_UPDATE') {
      const c = (j.data && (j.data.online_count || j.data.count || j.data.online)) || 0;
      return { type: 'online', count: c, ts: Date.now() };
    }
    // 点赞事件：V3_CLICK（单次点赞，本场新增）/ V3_UPDATE（累计点赞数）
    if (cmd === 'LIKE_INFO_V3_CLICK') {
      return { type: 'like_click', count: (j.data && j.data.click_count) || 1, ts: Date.now() };
    }
    if (cmd === 'LIKE_INFO_V3_UPDATE') {
      return { type: 'like_update', count: (j.data && (j.data.total || j.data.like_count || j.data.click_count)) || 0, ts: Date.now() };
    }
    // 看过人数变化（B 站 ws 推送，开播期间有用户进出时触发；data.text 是看过人数字符串）
    if (cmd === 'WATCHED_CHANGE') {
      const n = parseInt((j.data && (j.data.num || j.data.text)) || 0, 10) || 0;
      return { type: 'watched', count: n, ts: Date.now() };
    }
    // 进场 / 关注（V1 明文 JSON，部分老房间/兼容通道仍推）
    if (cmd === 'INTERACT_WORD') {
      const d = j.data;
      const msgType = d.msg_type; // 1进场 2关注 3分享
      return { type: 'enter', uid: d.uid, uname: d.uname, msgType, ts: Date.now() };
    }
    // 进场 / 关注（V2：B站已用它取代 V1，data.pb 是 Base64 编码的 protobuf，需解码拿 uid/uname/msg_type）
    if (cmd === 'INTERACT_WORD_V2') {
      let uid, uname, msgType;
      try {
        const f = decodeInteractPb((j.data && j.data.pb) || '');
        uid = f[1]; uname = f[2]; msgType = f[5]; // tag 1=uid 2=uname 5=msg_type
      } catch (e) {
        this.onLog('[连接] INTERACT_WORD_V2 解码失败: ' + e.message);
      }
      return { type: 'enter', uid, uname, msgType, ts: Date.now() };
    }
    // 舰长进场
    if (cmd === 'WELCOME' || cmd === 'WELCOME_GUARD') {
      return { type: 'welcome', uname: j.data.uname, guardLevel: j.data.guard_level || 3, ts: Date.now() };
    }
    // 特效进场（含大航海）—— copy_writing 里常含 <%昵称%> 包裹的 HTML-like 符号，清洗时【保留昵称文字】剥掉符号
    if (cmd === 'ENTRY_EFFECT') {
      const d = j.data;
      const copy = (d.copy_writing || '').replace(/<%([^%]+)%>/g, '$1').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      // 昵称兜底：优先 user.uname，其次从 copy_writing 的 <%xxx%> 提取（B 站可能只在文案里带昵称）
      const nameMatch = (d.copy_writing || '').match(/<%([^%]+)%>/);
      const uname = (d.user && d.user.uname) || (nameMatch ? nameMatch[1] : '') || '';
      return { type: 'effect_enter', text: copy, uname, ts: Date.now() };
    }
    // 礼物（单次送礼）
    if (cmd === 'SEND_GIFT') {
      const d = j.data;
      return {
        type: 'gift', uid: d.uid, uname: d.uname, giftName: d.giftName,
        num: d.num, price: (d.price || 0) / 1000, // 元（price单位: 1000金瓜子=1元）
        total: (d.total_coin || 0) / 1000, ts: Date.now()
      };
    }
    // 礼物连击（连送：B站推 COMBO_SEND，字段与 SEND_GIFT 不同——combo_num 是累计连击数）
    // 输出同构 gift 事件，num 取连击数，交给上层短窗口合并，避免"1个小心心"刷屏
    if (cmd === 'COMBO_SEND') {
      const d = j.data;
      return {
        type: 'gift', uid: d.uid, uname: d.uname,
        giftName: d.gift_name || d.giftName,
        num: d.combo_num || d.gift_num || d.num || 1,
        price: (d.price || 0) / 1000,
        total: (d.combo_total_coin || d.total_coin || 0) / 1000, ts: Date.now()
      };
    }
    // SC 醒目留言
    if (cmd === 'SUPER_CHAT_MESSAGE') {
      const d = j.data;
      return { type: 'superchat', uname: d.user_info.uname, text: d.message, price: d.price, ts: Date.now() };
    }
    // 大航海（上舰）
    if (cmd === 'GUARD_BUY') {
      const d = j.data;
      const names = { 1: '总督', 2: '提督', 3: '舰长' };
      return { type: 'guard', uname: d.username, guardLevel: d.guard_level, guardName: names[d.guard_level] || '上舰', num: d.num || 1, ts: Date.now() };
    }
    return null;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) this.ws.send(encodePacket(OP.HEARTBEAT, null)); // 心跳 op=2，body 空
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  handleClose() {
    this.stopHeartbeat();
    let code = 'self', reason = '';
    try {
      if (this.ws) { code = this.ws._closeCode || ''; reason = this.ws._closeMessage || ''; }
    } catch (e) { /* 忽略 */ }
    this.onLog('[连接] WS 关闭 code=' + code + ' reason=' + String(reason).slice(0, 80) + ' running=' + this.running);
    // Cookie 失效判定：带登录态(uid>0) + 认证包发出后未收到 AUTH_REPLY 就被异常断开(1006)
    // → B站识别出无效登录态直接断，继续重连也白连；停止重连并提示重新扫码
    if (this.running && !this.authDone && this.getUid() > 0 && code === 1006) {
      this.onLog('[连接] 判定 Cookie 失效（登录态连接认证前被断开），停止重连');
      this.onStatus({ state: 'cookie_invalid', msg: 'Cookie 失效，请重新扫码/复制最新 Cookie' });
      this.running = false;
      return;
    }
    if (this.running) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    // 退避策略：30s→60s→120s→300s 封顶（B站风控时不能重连太急，会越连越断）
    const delays = [30000, 60000, 120000, 300000, 300000];
    const delay = delays[Math.min(this.reconnectAttempts - 1, delays.length - 1)];
    this.onLog('[连接] 断开，' + (delay / 1000) + 's 后重连(第' + this.reconnectAttempts + '次)');
    this.onStatus({ state: 'reconnecting', msg: `连接断开，${delay / 1000}s 后重连(第${this.reconnectAttempts}次)` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.connect();
    }, delay);
  }

  close() {
    this.onLog('[连接] close() 被调用, running=' + this.running);
    this.running = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* 忽略 */ }
      this.ws = null;
    }
  }
}

module.exports = { BiliDanmaku, resolveRoom, getDanmuInfo, encodePacket, fetchRoomStats };
