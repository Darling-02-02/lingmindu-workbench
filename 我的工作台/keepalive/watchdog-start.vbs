' Workbench keepalive launcher (ASCII only).
' Starts keepalive\watchdog.ps1 in a hidden window. Safe to run repeatedly:
' the watchdog holds a lock file, so a second copy exits immediately.
Option Explicit

Dim sh, root, ps1
root = "D:\AAAlingmindu_wb"
ps1 = root & "\keepalive\watchdog.ps1"

If Not CreateObject("Scripting.FileSystemObject").FileExists(ps1) Then
  WScript.Quit 1
End If

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
