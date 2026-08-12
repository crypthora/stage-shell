param(
  [Parameter(Mandatory = $true)][ValidateSet('reserve', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][UInt64]$Hwnd,
  [int]$Width = 300,
  [ValidateSet('left', 'right')][string]$Side = 'right'
)

$source = @'
using System;
using System.Runtime.InteropServices;

public static class OutputsAppBar {
  const int ABM_NEW = 0x0, ABM_REMOVE = 0x1, ABM_QUERYPOS = 0x2, ABM_SETPOS = 0x3;
  const int ABE_LEFT = 0, ABE_RIGHT = 2;
  const int MONITOR_DEFAULTTONEAREST = 2;
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge;
    public RECT rc; public IntPtr lParam;
  }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public static int[] Reserve(ulong rawHwnd, int width, bool right) {
    // The PowerShell helper is otherwise DPI-unaware and Windows virtualizes
    // monitor/appbar coordinates, making the dock reserve far too much space.
    SetProcessDpiAwarenessContext((IntPtr)(-4)); // PER_MONITOR_AWARE_V2
    var data = new APPBARDATA { cbSize = Marshal.SizeOf(typeof(APPBARDATA)), hWnd = (IntPtr)(long)rawHwnd, uEdge = (uint)(right ? ABE_RIGHT : ABE_LEFT) };
    SHAppBarMessage(ABM_NEW, ref data);
    var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
    GetMonitorInfo(MonitorFromWindow(data.hWnd, MONITOR_DEFAULTTONEAREST), ref info);
    data.rc = info.rcMonitor;
    if (right) data.rc.left = data.rc.right - Math.Max(1, width);
    else data.rc.right = data.rc.left + Math.Max(1, width);
    SHAppBarMessage(ABM_QUERYPOS, ref data);
    data.rc.top = info.rcMonitor.top; data.rc.bottom = info.rcMonitor.bottom;
    if (right) data.rc.left = data.rc.right - Math.Max(1, width);
    else data.rc.right = data.rc.left + Math.Max(1, width);
    SHAppBarMessage(ABM_SETPOS, ref data);
    return new [] { data.rc.left, data.rc.top, data.rc.right - data.rc.left, data.rc.bottom - data.rc.top };
  }
  public static void Remove(ulong rawHwnd) {
    var data = new APPBARDATA { cbSize = Marshal.SizeOf(typeof(APPBARDATA)), hWnd = (IntPtr)(long)rawHwnd };
    SHAppBarMessage(ABM_REMOVE, ref data);
  }
}
'@

Add-Type -TypeDefinition $source
if ($Action -eq 'reserve') {
  [OutputsAppBar]::Reserve($Hwnd, $Width, $Side -eq 'right') | ConvertTo-Json -Compress
} else {
  [OutputsAppBar]::Remove($Hwnd)
}
