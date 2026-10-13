// ============================================================
//  弹幕姬 · 透明弹幕窗（Electron 壳）
//  版本 v3.4 · overlay/main.js（透明窗：拖动/缩放/锁定/悬停解锁）
//  职责：透明无边框置顶窗口 + 加载 danmaku.html + 拖动/锁定/退出
//  配置集中：以后加文字大小/颜色/文本类改 CONFIG.danmaku 即可
// ============================================================

const { app, BrowserWindow, globalShortcut, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// 修复 GPU 进程「沙箱」崩溃（render-process-gone exitCode -2147483645，Win11 已知坑 issue#51761）：
// 这是 GPU 进程沙箱崩溃，不是硬件加速问题，需禁用 GPU 沙箱 + 兜底禁用整个沙箱。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('enable-transparent-visuals');

const CONFIG = {
  window: { width: 900, height: 480, x: undefined, y: undefined },
  danmaku: {
    mode: 'fly',      // fly=飘屏 / list=列表
    fontSize: 32,
    speed: 10,
    max: 20,
  },
  defaultPort: 3000,
};

const ROOT = path.join(__dirname, '..');

// ===== 日志（写到 save/overlay.log，方便排查）=====
const LOGFILE = path.join(ROOT, 'save', 'overlay.log');
function log(msg) {
  try { fs.appendFileSync(LOGFILE, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}
log('=== overlay 启动 === argv=' + JSON.stringify(process.argv));

process.on('uncaughtException', (err) => log('uncaughtException: ' + (err && err.stack || err)));
process.on('unhandledRejection', (r) => log('unhandledRejection: ' + r));

let win = null;
let locked = false;

const gotLock = app.requestSingleInstanceLock();
log('requestSingleInstanceLock = ' + gotLock);
if (!gotLock) {
  log('已有实例在跑，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => { log('second-instance'); if (win) win.focus(); });
}

function readPort() {
  try {
    const n = parseInt(fs.readFileSync(path.join(ROOT, 'save', 'port.txt'), 'utf8').trim(), 10);
    if (n > 0) { log('readPort = ' + n); return n; }
  } catch (e) { log('readPort 失败: ' + e.message); }
  log('readPort 用默认 ' + CONFIG.defaultPort);
  return CONFIG.defaultPort;
}

function buildUrl() {
  const q = new URLSearchParams(CONFIG.danmaku).toString();
  const url = 'http://127.0.0.1:' + readPort() + '/danmaku.html?' + q;
  log('buildUrl = ' + url);
  return url;
}

// 同步锁定态到渲染层 body[data-overlay-locked]：未锁定(=false)时显示白色定位边框+锁按钮，锁定(=true)时隐藏
function setBodyAttr() {
  if (!win) return;
  win.webContents.executeJavaScript(
    "document.body.setAttribute('data-overlay-locked','" + (locked ? 'true' : 'false') + "')"
  ).catch(() => {});
}
function setLocked(v) {
  locked = v;
  log('setLocked = ' + v);
  if (v) endInteract(); // 锁定瞬间若有未结束的拖拽，立即终止
  if (win) {
    if (v) { setIgnore(true); startHoverPolling(); }
    else { stopHoverPolling(); }
  }
  setBodyAttr();
}

// 渲染层锁按钮 → 主进程：切换锁定（preload.js 通过 ipcRenderer.send('toggle-lock') 触发）
ipcMain.on('toggle-lock', () => setLocked(!locked));

// ===== 手动拖动/缩放（主进程轮询绝对坐标）=====
// 之前用渲染层 e.screenX 算增量，在多显示器不同 DPI 缩放下会失真（4K+Aorus 副屏场景），
// 导致「中间拖动却变大」。现改为：mousedown 只发一次 interact-start（带模式），
// 主进程记下起始光标绝对坐标 + 窗口 bounds，用定时器轮询 screen.getCursorScreenPoint()，
// 按「绝对差值」直接 setBounds，绕开渲染层坐标。
let interact = null;   // { mode, startX, startY, startBounds, timer }
const MIN_W = 200, MIN_H = 80;

function startInteract(mode) {
  if (!win || locked || interact) return;
  const p = screen.getCursorScreenPoint();
  interact = {
    mode: mode,
    startX: p.x,
    startY: p.y,
    startBounds: win.getBounds(),
    timer: null,
  };
  interact.timer = setInterval(tickInteract, 16);
}

function tickInteract() {
  if (!interact || !win) return;
  const p = screen.getCursorScreenPoint();
  const dx = p.x - interact.startX;
  const dy = p.y - interact.startY;
  const b = interact.startBounds;
  if (interact.mode === 'move') {
    win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
  } else {
    const dir = interact.mode;
    let nx = b.x, ny = b.y, nw = b.width, nh = b.height;
    if (dir.indexOf('e') >= 0) nw = b.width + dx;
    if (dir.indexOf('s') >= 0) nh = b.height + dy;
    if (dir.indexOf('w') >= 0) { nw = b.width - dx; nx = b.x + dx; }
    if (dir.indexOf('n') >= 0) { nh = b.height - dy; ny = b.y + dy; }
    if (nw < MIN_W) { if (dir.indexOf('w') >= 0) nx -= (MIN_W - nw); nw = MIN_W; }
    if (nh < MIN_H) { if (dir.indexOf('n') >= 0) ny -= (MIN_H - nh); nh = MIN_H; }
    win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: Math.round(nw), height: Math.round(nh) });
  }
}

function endInteract() {
  if (interact && interact.timer) clearInterval(interact.timer);
  interact = null;
}

ipcMain.on('interact-start', (e, mode) => startInteract(String(mode || 'move')));
ipcMain.on('interact-end', () => endInteract());

// ===== 锁定态悬停解锁按钮（主进程轮询光标，绕开鼠标穿透导致渲染层收不到 hover）=====
// 锁定时 setIgnoreMouseEvents(true) 让整窗鼠标穿透（点穿到 OBS/桌面），渲染层收不到 mouseenter/mousemove，
// 因此用主进程定时轮询光标位置：光标进入窗口 → 显示顶部居中 🔓 按钮；光标落在按钮矩形上 → 临时关闭穿透让按钮可点；
// 移出窗口/按钮 → 恢复穿透并隐藏按钮。
let hoverTimer = null;
let unlockVisible = false;
let ignoreMouse = false;
const UNLOCK_BTN = { w: 44, h: 44, top: 4 }; // 顶部居中 44x44 命中区（略大于按钮本体，更好点）

function setIgnore(v) {
  if (!win || ignoreMouse === v) return;
  ignoreMouse = v;
  win.setIgnoreMouseEvents(v, { forward: true });
}

function setUnlockVisible(v) {
  if (v === unlockVisible) return;
  unlockVisible = v;
  if (!win) return;
  win.webContents.executeJavaScript(
    "document.body.setAttribute('data-unlock-hover','" + (v ? 'true' : 'false') + "')"
  ).catch(() => {});
}

function checkHover() {
  if (!win || !locked) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  if (!inside) {
    setUnlockVisible(false);
    setIgnore(true);
    return;
  }
  setUnlockVisible(true);
  const bx = b.x + (b.width - UNLOCK_BTN.w) / 2;
  const by = b.y + UNLOCK_BTN.top;
  const overBtn = p.x >= bx && p.x <= bx + UNLOCK_BTN.w && p.y >= by && p.y <= by + UNLOCK_BTN.h;
  if (overBtn) setIgnore(false);  // 悬停按钮上 → 临时可点击
  else setIgnore(true);           // 窗口内但不在按钮上 → 保持穿透
}

function startHoverPolling() {
  if (hoverTimer) return;
  hoverTimer = setInterval(checkHover, 100);
}
function stopHoverPolling() {
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  setUnlockVisible(false);
  setIgnore(false);
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: locked ? '🔓 解锁（恢复拖动）' : '🔒 锁定（鼠标穿透）', click: () => setLocked(!locked) },
    { type: 'separator' },
    { label: '退出弹幕窗', click: () => app.quit() },
  ]);
}

function createWindow() {
  log('createWindow 开始');
  win = new BrowserWindow({
    width: CONFIG.window.width,
    height: CONFIG.window.height,
    x: CONFIG.window.x,
    y: CONFIG.window.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minWidth: 200,
    minHeight: 80,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '..', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  log('BrowserWindow 创建完成');

  // 任务栏图标：未打包 Electron 默认显示 electron.exe 图标，用 setAppDetails 指定图标路径（与 setAppUserModelId 的 appId 一致）
  try {
    win.setAppDetails({ appId: 'bilibili-danmuji-overlay', appIconPath: path.join(__dirname, '..', 'icon.ico') });
  } catch (e) { log('setAppDetails 失败: ' + e.message); }

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);

  const url = buildUrl();
  win.loadURL(url);

  win.webContents.on('did-finish-load', () => {
    log('did-finish-load 页面加载成功');
    // 拖动/缩放已改为「主进程轮询绝对坐标」：danmaku.html 里 #__dragzone 监听 pointerdown
    // 只发 interact-start（带模式），主进程定时器轮询 screen.getCursorScreenPoint() 驱动。
    // 不再用 -webkit-app-region:drag（它会整片劫持鼠标，导致锁按钮点不动 + 右键弹系统菜单），
    // 也不用渲染层 e.screenX 增量（多显示器 DPI 下失真，中间拖动会变大）。
    // 这里只初始化锁定态属性（data-overlay-locked=false → 显示白框 + 锁按钮）
    win.webContents.executeJavaScript(
      "document.body.setAttribute('data-overlay-locked','false')"
    ).catch((e) => log('初始化锁定态失败: ' + e.message));
  });
  win.webContents.on('did-fail-load', (e, code, desc) => log('did-fail-load: code=' + code + ' desc=' + desc));
  win.webContents.on('render-process-gone', (e, details) => log('render-process-gone: ' + JSON.stringify(details)));

  win.webContents.on('context-menu', (ev) => {
    ev.preventDefault();
    buildMenu().popup({ window: win });
  });

  win.on('close', () => log('window close 事件'));
  win.on('closed', () => {
    log('window closed');
    endInteract();
    stopHoverPolling();
    win = null;
  });
}

app.whenReady().then(() => {
  log('app ready');
  app.setAppUserModelId('bilibili-danmuji-overlay'); // 固定 AppUserModelID：Windows 按此 ID 缓存任务栏图标，改 ID 才能刷新图标
  createWindow();
  globalShortcut.register('Ctrl+Shift+L', () => setLocked(!locked));
  globalShortcut.register('Ctrl+Shift+Q', () => app.quit());
  // 监听控制面板的「关闭透明窗」请求：server 写 save/overlay-close.flag，本进程轮询到即退出
  // （用标志文件而非 IPC/杀进程，server 重启也不怕，且退出路径统一走 app.quit 干净收尾）
  const CLOSE_FLAG = path.join(ROOT, 'save', 'overlay-close.flag');
  setInterval(() => {
    try {
      if (fs.existsSync(CLOSE_FLAG)) {
        fs.unlinkSync(CLOSE_FLAG);
        log('收到控制面板关闭指令，退出透明窗');
        app.quit();
      }
    } catch (e) {}
  }, 500);
  log('快捷键注册完成');
});

app.on('window-all-closed', () => { log('window-all-closed 触发'); app.quit(); });
app.on('will-quit', () => { log('will-quit'); globalShortcut.unregisterAll(); });
