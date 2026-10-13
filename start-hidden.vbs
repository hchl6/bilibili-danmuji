' start-hidden.vbs - Launch Bilibili Danmaku Bot hidden (no console window)
' Green edition: use bundled node from runtime/ (absolute paths, no cwd dependency)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
nodeExe = dir & "\runtime\node\node.exe"
cmd = "cmd /c cd /d " & q & dir & q & " && " & q & nodeExe & q & " server.js > log.txt 2> log-err.txt"
sh.Run cmd, 0, False
