// Bili Danmu Bot - exe 启动器（绿色版门把手，2026-09-18 v2）
// v2 变更：启动链从「exe → wscript → vbs → cmd → node」缩为「exe → cmd → node」
//   原因：实测 wscript 调 vbs 静默无执行（log.txt 未被覆盖），四层链任一环节被拦都静默死亡
//   新增 log-launcher.txt 启动日志 + 失败弹窗，不再静默死亡
// 行为：双击 → 防双开(端口已听则只开浏览器) → cmd 隐藏起 node(日志落 log.txt/log-err.txt)
//       → 每 500ms 重读 port.txt+试连(最多15s) → 开浏览器 → exe 退出(自身不留后台)
// 编译（项目根目录执行）：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /platform:anycpu /r:System.Windows.Forms.dll /win32icon:icon.ico "/out:Bili Danmu Bot.exe" launcher\DanmujiLauncher.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

static class DanmujiLauncher
{
    static string LogPath = "";

    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        LogPath = Path.Combine(dir, "log-launcher.txt");
        Log("=== launcher start, dir=" + dir);

        int port = ReadPort(dir);

        // 防双开：服务已在跑 → 直接开页面，不重复启动
        if (IsPortOpen(port))
        {
            Log("port " + port + " already listening -> open browser only");
            OpenBrowser(port);
            return;
        }

        string nodeExe = Path.Combine(dir, "runtime", "node", "node.exe");
        if (!File.Exists(nodeExe))
        {
            Fail("runtime\\node\\node.exe not found");
            return;
        }

        // exe → cmd → node：cmd /c 做日志重定向(> 覆盖，与 vbs 时代行为一致)并常驻持有文件句柄
        // CreateNoWindow 隐藏控制台（exe 本身 winexe 无窗口，cmd 也不再新建）
        string args = "/c cd /d \"" + dir + "\" && \"" + nodeExe + "\" server.js > log.txt 2> log-err.txt";
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = args,
                WorkingDirectory = dir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            });
            Log("spawned cmd -> node");
        }
        catch (Exception ex)
        {
            Fail("spawn failed: " + ex.Message);
            return;
        }

        // 等服务就绪：每 500ms 重读 port.txt（端口自动规避可能改口）+ 试连，最多 15 秒
        for (int i = 0; i < 30; i++)
        {
            Thread.Sleep(500);
            port = ReadPort(dir);
            if (IsPortOpen(port))
            {
                Log("port " + port + " ready after " + (i + 1) + " polls -> open browser");
                OpenBrowser(port);
                return;
            }
        }

        Log("TIMEOUT 15s: node never listened");
        MessageBox.Show("启动超时：服务 15 秒内未就绪。\n请把项目目录里的 log-launcher.txt 和 log-err.txt 发给作者排查。",
            "Bili Danmu Bot", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        OpenBrowser(port); // 仍兜底开一次（慢机器随后就绪可刷新）
    }

    static void Log(string msg)
    {
        try { File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + msg + "\r\n"); } catch { }
    }

    static void Fail(string msg)
    {
        Log("FAIL: " + msg);
        MessageBox.Show("启动失败：" + msg + "\n详见项目目录 log-launcher.txt", "Bili Danmu Bot", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    // 读取 server.js 写入的实际端口（save/port.txt），缺省 3000
    static int ReadPort(string dir)
    {
        try
        {
            string p = Path.Combine(dir, "save", "port.txt");
            if (File.Exists(p))
            {
                int v;
                if (int.TryParse(File.ReadAllText(p).Trim(), out v) && v > 0 && v < 65536)
                    return v;
            }
        }
        catch { }
        return 3000;
    }

    static bool IsPortOpen(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = ar.AsyncWaitHandle.WaitOne(500);
                if (ok) c.EndConnect(ar);
                return ok;
            }
        }
        catch { return false; }
    }

    static void OpenBrowser(int port)
    {
        try { Process.Start("http://localhost:" + port); } catch { }
    }
}
