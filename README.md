# B站语音弹幕姬 (bilibili-danmuji)

B站直播间的弹幕实时显示 + 语音播报工具。弹幕、进场、关注、礼物、SC、上舰等事件都能用 TTS 语音念出来，支持桌面透明弹幕小窗，适合配合 OBS 推流上屏。

## 功能特性

- 语音播报：弹幕 / 进场 / 关注 / 礼物 / SC / 上舰 全事件覆盖
- 双语音引擎：微软 Edge TTS（晓晓等音色）+ Windows 系统内置音（SAPI）兜底
- 弹幕循环变色 / 随机色，字号、字体、颜色可调
- 桌面透明弹幕小窗（Electron），可置顶 / 穿透 / 拖动，OBS 浏览器源上屏
- 事件过滤：空弹幕 / 纯 emoji / 仅粉丝牌房管 / 仅关注
- 尾字、语速、音调、音量、队列容量等全可配置
- Cookie 扫码登录（存浏览器 localStorage，不落盘）

## 环境要求

- Windows（语音播放依赖 winsound 系统音频）
- Node.js 18+
- Python 3.10+（Edge TTS 合成，需安装 `edge-tts`）

## 快速开始

1. 安装依赖：`npm install`
2. 安装 Edge TTS：`pip install edge-tts`
3. 双击 `start.bat`，浏览器会自动打开 `http://localhost:3000`
4. 填写房间号 + 扫码登录，连接成功后即开始播报
5. 停止：双击 `停止弹幕姬.bat`，或关闭页面后约 7 秒自动退出

## 完整安装包

想要免安装、解压即用（含 Electron 透明窗 + Python 运行时 + 图标 + 启动器 exe）的完整包，请到 [Releases](../../releases) 下载 zip。

## 重要声明

- 语音合成依赖微软 Edge Read Aloud 非公开接口，微软可能随时调整导致失效；线上音色不可用时会自动降级为系统内置音。
- 本项目仅供学习交流，请勿用于违反 B站用户协议或法律法规的用途。

## License

[MIT](LICENSE)
