' launch.vbs -- start the local workbench copy (D:\AAAlingmindu_wb)
' 2026-11-21: port 3083 -> 3093 (3083 is owned by wslrelay.exe / another DSH behind WSL).
' All real work happens in launch-inner.cmd, which also deletes ELECTRON_RUN_AS_NODE.
' 2026-11-22: if port 3093 already answers, do NOT start a second engine (it would
'   spawn another 400MB instance on another port) -- bring the existing window up instead.
Option Explicit
Dim fso, sh, root, cmdFile, alive, http, act
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
cmdFile = root & "\launch-inner.cmd"

alive = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 2000, 2000, 3000, 4000
http.Open "GET", "http://127.0.0.1:3093/", False
http.Send
If Err.Number = 0 Then alive = True
Err.Clear
Set http = Nothing
On Error GoTo 0

If alive Then
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
