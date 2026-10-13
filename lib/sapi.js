// 系统内置 TTS（SAPI）—— 离线兜底引擎，声音直接在本机扬声器播放
// 零依赖，Windows 自带，音质一般但永远有声音
const { spawn } = require('child_process');

let queue = [];
let speaking = false;
let speakTimer = null;
let currentChild = null; // 当前正在播的 PowerShell 子进程（purge 时 kill 打断）

function speakNext() {
  if (speaking || !queue.length) return;
  speaking = true;
  const item = queue.shift();
  const safe = String(item.text).replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.Speech; ` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.Rate = ${item.rate}; ` +          // SAPI 语速 -10~10（由前端 ±50% 映射：/5）
    `$s.Volume = ${item.volume}; ` +     // SAPI 音量 0~100（与前端音量同刻度，直通）
    `try { $s.Speak('${safe}') } catch {}`;
  const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
  currentChild = child; // 记录当前子进程，purge 时 kill 打断
  let finished = false; // 防双触发：exit 和超时熔断都回调 done 时只生效一次
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(speakTimer);
    speaking = false;
    if (currentChild === child) currentChild = null;
    setTimeout(speakNext, 50);
  };
  // 超时熔断：PowerShell 卡住 10 秒强制跳过，防队列死锁
  speakTimer = setTimeout(done, 10000);
  child.on('exit', () => { clearTimeout(speakTimer); done(); });
  child.on('error', done);
}

// 排队播报一段文本；opts.rate 前端语速 ±50 → SAPI -10~10，opts.volume 前端音量 0~100 直通
function speak(text, opts = {}) {
  if (!text) return;
  const rate = Math.max(-10, Math.min(10, Math.round((opts.rate || 0) / 5)));
  const volume = Math.max(0, Math.min(100, Math.round(opts.volume == null ? 100 : opts.volume)));
  queue.push({ text, rate, volume });
  speakNext();
}

// 立即清空队列并打断正在播的（断开=全停用）：SAPI 是独立队列，必须显式清，否则断开后继续念已入队文本
function purge() {
  queue.length = 0;
  if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
  if (currentChild) {
    try { currentChild.kill(); } catch (e) { /* 忽略 */ }
    currentChild = null;
  }
  speaking = false;
}

module.exports = { speak, purge };
