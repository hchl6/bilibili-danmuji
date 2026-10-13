# -*- coding: utf-8 -*-
# 常驻系统播放进程（v3）：异步播放 + 工作线程 + 队列 + 可打断 sleep
# - 播放用 SND_ASYNC（不阻塞主线程）→ stdin 始终可读 → __PURGE__ 能【立即】打断正在播的
# - worker 线程串行播放（同一时刻只播一个，防混音），播完输出 DONE + 删文件
# - __PURGE__：SND_PURGE 立即停声音 + purge_event 唤醒 worker（立刻删文件/播下一条）+ 清空等待队列
import sys
import os
import struct
import time
import threading
import queue
import winsound

task_queue = queue.Queue()
purge_event = threading.Event()   # PURGE 时 set，worker 的 sleep 循环检测后立即醒来
# PURGE 后的丢弃窗口（秒）：在这段时间内从 stdin 读到的任务全部丢弃
# ——关键修复：高频场景下断开时 node 端已写入多个 wav 路径到 stdin OS 缓冲，__PURGE__ 打断当前 + 清内存队列后，
# 主循环继续读 stdin 仍会读到残留任务（OS 管道无法清空），用丢弃窗口挡掉
DISCARD_WINDOW = 5.0
discard_until = 0.0  # time.time() 比较，0=不过滤


def wav_duration(path):
    """从 WAV 头估算播放时长（秒），用于等待播放结束"""
    try:
        with open(path, 'rb') as f:
            data = f.read(44)
        if data[:4] != b'RIFF':
            return 1.0
        rate = struct.unpack('<I', data[24:28])[0]
        channels = struct.unpack('<H', data[22:24])[0]
        bits = struct.unpack('<H', data[34:36])[0]
        if rate == 0:
            return 1.0
        size = os.path.getsize(path) - 44
        return size / (rate * channels * (bits // 8))
    except Exception:
        return 1.0


def worker():
    while True:
        path = task_queue.get()
        if path is None:
            break
        purge_event.clear()
        try:
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
            # 可打断 sleep：分小段等待，PURGE 触发后立即醒（不拖到下一条）
            dur = wav_duration(path)
            elapsed = 0.0
            while elapsed < dur and not purge_event.is_set():
                time.sleep(0.05)
                elapsed += 0.05
        except Exception as e:
            sys.stderr.write('PLAY_ERR: %s\n' % e)
            sys.stderr.flush()
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        print('DONE', flush=True)


def main():
    global discard_until  # main 内赋值会把它当局部变量，必须声明 global，否则主循环读取时报 UnboundLocalError 崩溃
    threading.Thread(target=worker, args=(), daemon=True).start()
    for line in sys.stdin:
        cmd = line.strip()
        if not cmd:
            continue
        if cmd == '__PURGE__':
            # 立即打断：停声音 + 唤醒 worker（立刻删文件/处理下一条）+ 清空等待队列 + 开启丢弃窗口
            try:
                winsound.PlaySound(None, winsound.SND_PURGE)
            except Exception:
                pass
            purge_event.set()
            while True:
                try:
                    p = task_queue.get_nowait()
                    if os.path.isfile(p):
                        try:
                            os.remove(p)
                        except OSError:
                            pass
                except queue.Empty:
                    break
            discard_until = time.time() + DISCARD_WINDOW
            continue
        if time.time() < discard_until:
            # 丢弃窗口内：直接删文件不播（防 stdin 缓冲残留）
            if os.path.isfile(cmd):
                try:
                    os.remove(cmd)
                except OSError:
                    pass
            continue
        if os.path.isfile(cmd):
            task_queue.put(cmd)


if __name__ == '__main__':
    main()
