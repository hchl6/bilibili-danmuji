' Launch transparent danmaku overlay (Electron)
' Uses WScript.Shell.Run (same reliable channel as start-hidden.vbs)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
electronExe = dir & "\runtime\electron\electron.exe"
appDir = dir & "\overlay"
sh.Run q & electronExe & q & " " & q & appDir & q, 0, False
