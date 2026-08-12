param(
  [Parameter(Mandatory = $true)][UInt64]$Hwnd,
  [Parameter(Mandatory = $true)][int]$Left,
  [Parameter(Mandatory = $true)][int]$Top,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height
)

$source = @'
using System;
using System.Runtime.InteropServices;
public static class OutputsNativePosition {
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  const uint SWP_NOACTIVATE=0x0010, SWP_NOOWNERZORDER=0x0200, SWP_NOZORDER=0x0004, SWP_ASYNCWINDOWPOS=0x4000;
  public static void Move(ulong raw, int x, int y, int w, int h) {
    SetProcessDpiAwarenessContext((IntPtr)(-4));
    if (!SetWindowPos((IntPtr)(long)raw, IntPtr.Zero, x, y, w, h, SWP_NOACTIVATE|SWP_NOOWNERZORDER|SWP_NOZORDER|SWP_ASYNCWINDOWPOS)) throw new System.ComponentModel.Win32Exception();
  }
}
'@
Add-Type -TypeDefinition $source
[OutputsNativePosition]::Move($Hwnd, $Left, $Top, $Width, $Height)
