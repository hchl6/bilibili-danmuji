# 晓晓语音合成脚本：edge-tts 官方库合成 → 解码 → 输出标准 WAV（Chrome 必解）
# 用法: python tts.py "文本" [音色] [语速+0%] [音调+0Hz] > out.wav
import sys, asyncio, io, json, os
import edge_tts, soundfile as sf

# 音色表单一数据源：voices.json（与本脚本同目录，lib/edge-tts.js / 前端 /api/voices 三方同源）
# 读取失败兜底仅晓晓，防 voices.json 缺失时合成全瘫
def _load_voices():
    try:
        try:
            base = os.path.dirname(os.path.abspath(__file__))
        except NameError:
            base = os.getcwd()  # exec/内嵌环境无 __file__ 时退到工作目录
        p = os.path.join(base, 'voices.json')
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'晓晓(女·普通话)': 'zh-CN-XiaoxiaoNeural'}

VOICE_MAP = _load_voices()

async def main():
    text = sys.argv[1]
    voice_key = sys.argv[2] if len(sys.argv) > 2 else '晓晓(女·普通话)'
    rate = sys.argv[3] if len(sys.argv) > 3 else '+0%'
    pitch = sys.argv[4] if len(sys.argv) > 4 else '+0Hz'
    voice = VOICE_MAP.get(voice_key, voice_key)
    audio = b''
    # 429 限流重试：微软 v2 端点(api.msedgeservices.com)限流比 v1 狠，弹幕连发易触发 429。
    # 命中 429 退避重试(0.8s/1.6s)；其他错误(403 等)不重试，直接抛给上层降级 SAPI。
    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            audio = b''
            async for chunk in communicate.stream():
                if chunk['type'] == 'audio':
                    audio += chunk['data']
            break  # 合成成功，跳出重试
        except Exception as e:
            if '429' in str(e) and attempt < 2:
                await asyncio.sleep(0.8 * (attempt + 1))
                continue
            raise  # 其他错误（或最后一次 429），保留原 traceback 直接传播
    if not audio:
        print('NO_AUDIO', file=sys.stderr)
        sys.exit(1)
    # 解码 mp3 → PCM → 标准 WAV
    data, sr = sf.read(io.BytesIO(audio), dtype='float32')
    buf = io.BytesIO()
    sf.write(buf, data, sr, format='WAV')
    sys.stdout.buffer.write(buf.getvalue())
    sys.stderr.write(f'OK {len(buf.getvalue())}B sr={sr}\n')

asyncio.run(main())
