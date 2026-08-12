param(
  [Parameter(Mandatory = $true)][int]$Width,
  [ValidateSet('left', 'right')][string]$Side = 'right',
  [Parameter(Mandatory = $true)][string]$ReadyFile
)

# This is deliberately a separate HWND from Chromium.  Registering Electron's
# BrowserWindow itself as an AppBar lets Shell/DWM reposition a live Chromium
# surface and is the source of the intermittent blank Dock.
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class StageShellAppBarHost : Form {
  const int ABM_NEW = 0x0, ABM_REMOVE = 0x1, ABM_QUERYPOS = 0x2, ABM_SETPOS = 0x3;
  const int ABE_LEFT = 0, ABE_RIGHT = 2, MONITOR_DEFAULTTONEAREST = 2;
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint message, ref APPBARDATA data);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  readonly int width; readonly bool right; readonly string readyFile; bool registered;
  public StageShellAppBarHost(int width, bool right, string readyFile) {
    this.width = Math.Max(1, width); this.right = right; this.readyFile = readyFile;
    ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None; Opacity = 0; Width = 1; Height = 1;
  }
  protected override void OnShown(EventArgs e) { base.OnShown(e); Reserve(); Hide(); }
  void Reserve() {
    SetProcessDpiAwarenessContext((IntPtr)(-4));
    var data = new APPBARDATA { cbSize = Marshal.SizeOf(typeof(APPBARDATA)), hWnd = Handle, uEdge = (uint)(right ? ABE_RIGHT : ABE_LEFT) };
    SHAppBarMessage(ABM_NEW, ref data); registered = true;
    var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
    GetMonitorInfo(MonitorFromWindow(Handle, MONITOR_DEFAULTTONEAREST), ref info);
    data.rc = info.rcMonitor;
    if (right) data.rc.left = data.rc.right - width; else data.rc.right = data.rc.left + width;
    SHAppBarMessage(ABM_QUERYPOS, ref data);
    data.rc.top = info.rcMonitor.top; data.rc.bottom = info.rcMonitor.bottom;
    if (right) data.rc.left = data.rc.right - width; else data.rc.right = data.rc.left + width;
    SHAppBarMessage(ABM_SETPOS, ref data);
    File.WriteAllText(readyFile, String.Format("{{\"hwnd\":\"{0}\",\"left\":{1},\"top\":{2},\"width\":{3},\"height\":{4}}}", Handle.ToInt64(), data.rc.left, data.rc.top, data.rc.right-data.rc.left, data.rc.bottom-data.rc.top));
  }
  protected override void Dispose(bool disposing) {
    if (registered) { var data = new APPBARDATA { cbSize = Marshal.SizeOf(typeof(APPBARDATA)), hWnd = Handle }; SHAppBarMessage(ABM_REMOVE, ref data); registered = false; }
    base.Dispose(disposing);
  }
}
'@

Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition $source
$form = [StageShellAppBarHost]::new($Width, $Side -eq 'right', $ReadyFile)
[System.Windows.Forms.Application]::Run($form)
