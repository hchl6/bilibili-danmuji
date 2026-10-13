// 透明窗 preload：把主进程能力以最小接口暴露给渲染层（contextIsolation 下安全桥）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  // 渲染层锁按钮点击 → 通知主进程切换锁定（穿透）
  toggleLock: () => ipcRenderer.send('toggle-lock'),
  // 拖动/缩放开始：mousedown 只发一次（mode 为 move 或 n/s/e/w 方向组合，主进程轮询绝对坐标驱动）
  interactStart: (mode) => ipcRenderer.send('interact-start', mode),
  // 拖动/缩放结束：通知主进程停轮询
  interactEnd: () => ipcRenderer.send('interact-end'),
});
