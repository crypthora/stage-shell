param(
  [ValidateSet('list', 'focus', 'close')]
  [string]$Action = 'list',
  [UInt64]$Hwnd = 0,
  [UInt64]$Exclude = 0
)

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class StageShellWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<object> List(ulong exclude) {
    var result = new List<object>();
    EnumWindows((h,l) => {
      if ((ulong)h.ToInt64() == exclude || !IsWindowVisible(h)) return true;
      var title = new StringBuilder(512); GetWindowText(h,title,title.Capacity);
      if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h,out pid);
      try { var p=System.Diagnostics.Process.GetProcessById((int)pid); if (p.ProcessName=="explorer" || p.ProcessName=="ApplicationFrameHost" || p.ProcessName=="stage-shell" || title.ToString().StartsWith("Developer Tools")) return true; result.Add(new { hwnd=(ulong)h.ToInt64(), title=title.ToString(), process=p.ProcessName }); } catch {}
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

if ($Action -eq 'list') { [StageShellWindows]::List($Exclude) | ConvertTo-Json -Compress; exit }
$ptr = [IntPtr][Int64]$Hwnd
if ($Action -eq 'focus') { [StageShellWindows]::ShowWindow($ptr, 9) | Out-Null; [StageShellWindows]::SetForegroundWindow($ptr) | ConvertTo-Json -Compress; exit }
if ($Action -eq 'close') { [StageShellWindows]::PostMessage($ptr, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | ConvertTo-Json -Compress }
