' launch.vbs -- start the local workbench copy (D:\AAAlingmindu_wb)
' 2026-11-21: port 3083 -> 3093 (3083 is owned by wslrelay.exe / another DSH behind WSL).
' All real work happens in launch-inner.cmd, which also deletes ELECTRON_RUN_AS_NODE.
' 2026-11-22: if port 3093 already answers, do NOT start a second engine (it would
'   spawn another 400MB instance on another port) -- bring the existing window up instead.
' 2026-11-25: engine is now KEPT ALIVE after the shell quits (DSH_KEEP_ENGINE), so
'   "3093 answers" no longer means "a window exists". Check the shell's own CDP port
'   (9224/9223, passed by launch-inner.cmd) too -- otherwise we'd only try to activate a
'   window that isn't there and nothing would start.
Option Explicit
Dim fso, sh, root, cmdFile, engineAlive, shellAlive, http, act, http2
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
cmdFile = root & "\launch-inner.cmd"

engineAlive = False
shellAlive = False

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 2000, 2000, 3000, 4000
http.Open "GET", "http://127.0.0.1:3093/", False
http.Send
If Err.Number = 0 Then engineAlive = True
Err.Clear
Set http = Nothing

Dim ports, pi
ports = Array(9224, 9223)
For pi = 0 To UBound(ports)
  Set http2 = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http2.setTimeouts 1500, 1500, 2000, 2500
  http2.Open "GET", "http://127.0.0.1:" & ports(pi) & "/json/version", False
  http2.Send
  If Err.Number = 0 Then shellAlive = True
  Err.Clear
  Set http2 = Nothing
  If shellAlive Then Exit For
Next
On Error GoTo 0

If engineAlive And shellAlive Then
  act = root & "\activate-window.ps1"
  If fso.FileExists(act) Then
    sh.CurrentDirectory = root
    sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & act & """", 0, False
  End If
ElseIf fso.FileExists(cmdFile) Then
  sh.CurrentDirectory = root
  sh.Run """" & cmdFile & """", 1, False
Else
  MsgBox "missing launch-inner.cmd next to this file:" & vbCrLf & root, 48, "workbench"
End If
