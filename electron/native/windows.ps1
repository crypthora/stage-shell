param(
  [ValidateSet('list', 'focus', 'close')]
  [string]$Action = 'list',
  [UInt64]$Hwnd = 0,
  [UInt64]$Exclude = 0
)

$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -ReferencedAssemblies 'System.Drawing.dll' -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
public static class StageShellWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtr", SetLastError=true)] public static extern IntPtr GetClassLongPtr(IntPtr h, int index);
  const uint WM_GETICON=0x007F, SMTO_ABORTIFHUNG=0x0002;
  static string IconData(IntPtr h) {
    IntPtr icon=IntPtr.Zero, ignored;
    foreach (var kind in new int[] { 1, 2, 0 }) { SendMessageTimeout(h, WM_GETICON, (IntPtr)kind, IntPtr.Zero, SMTO_ABORTIFHUNG, 120, out ignored); if (ignored != IntPtr.Zero) { icon=ignored; break; } }
    if (icon==IntPtr.Zero) { icon=GetClassLongPtr(h,-14); if(icon==IntPtr.Zero) icon=GetClassLongPtr(h,-34); }
    if (icon==IntPtr.Zero) return null;
    try { using(var source=Icon.FromHandle(icon)) using(var bitmap=new Bitmap(source.ToBitmap(), new Size(64,64))) using(var stream=new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); return Convert.ToBase64String(stream.ToArray()); } } catch { return null; }
  }
  public static List<object> List(ulong exclude) {
    var result = new List<object>();
    EnumWindows((h,l) => {
      if ((ulong)h.ToInt64() == exclude || !IsWindowVisible(h)) return true;
      var title = new StringBuilder(512); GetWindowText(h,title,title.Capacity);
      if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h,out pid);
      try { var p=System.Diagnostics.Process.GetProcessById((int)pid); if (p.ProcessName=="explorer" || p.ProcessName=="ApplicationFrameHost" || p.ProcessName=="stage-shell" || title.ToString().StartsWith("Developer Tools")) return true; result.Add(new { hwnd=(ulong)h.ToInt64(), title=title.ToString(), process=p.ProcessName, icon=IconData(h) }); } catch {}
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
