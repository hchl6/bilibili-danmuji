// Edge TTS 合成：调用 Python 官方 edge-tts 库（自研 WebSocket 实现因微软服务端更新已失效 403，
// 官方库已适配；合成后转码为标准 WAV，Chrome 100% 可解码）→ 输出 WAV Buffer；失败抛错（供上层降级）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
// Python 自动探测（分享适配 2026-09-01）：① DM_PYTHON 环境变量（显式指定，最高优先）
// ② runtime/python（随包分发，接收方机器自动命中——已内置 edge_tts+soundfile，无需对方装环境）
// ③ 系统 python（最后兜底，若装了 edge_tts 也能用）
function findPython() {
  const dm = process.env.DM_PYTHON;
  if (dm) return dm; // 显式指定，直接信任（可能是路径或命令名）
  const bundled = path.join(__dirname, '..', 'runtime', 'python', 'python.exe');
  try { if (fs.existsSync(bundled)) return bundled; } catch (e) {}
  return 'python';
}
const PYTHON = findPython();
const TTS_SCRIPT = path.join(__dirname, '..', 'tts.py');

// 音色表单一数据源（2026-09-18）：voices.json 项目根目录，tts.py / 前端(/api/voices) 三方同源
// 读取失败兜底仅保留晓晓（防 voices.json 被误删后合成全瘫；此时服务端音色校验也只认晓晓）
let VOICES;
try {
  VOICES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voices.json'), 'utf8'));
} catch (e) {
  console.warn('[edge-tts] voices.json 读取失败，兜底仅晓晓:', e.message);
  VOICES = { '晓晓(女·普通话)': 'zh-CN-XiaoxiaoNeural' };
}

/**
 * 合成一段文本为 WAV
 * @param {string} text 文本
 * @param {string} voiceKey 音色键（VOICES 的 key）
 * @param {object} opts { rate: 语速(±50%), pitch: 音调(±50Hz) }
 * @returns {Promise<Buffer>} WAV
 */
function synthesize(text, voiceKey = '晓晓(女·普通话)', opts = {}) {
  return new Promise((resolve, reject) => {
    const rate = `+${Math.round(opts.rate || 0)}%`;
    const pitch = opts.pitch ? `${opts.pitch >= 0 ? '+' : ''}${Math.round(opts.pitch)}Hz` : '+0Hz';
    const child = spawn(PYTHON, [TTS_SCRIPT, text, voiceKey, rate, pitch], { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => err += d.toString());
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('晓晓合成超时(25s)')); }, 25000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !chunks.length) {
        reject(new Error('晓晓合成失败: ' + (err.trim().slice(0, 1500) || '无音频输出')));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('无法启动合成器: ' + e.message)); });
  });
}

module.exports = { synthesize, VOICES };
