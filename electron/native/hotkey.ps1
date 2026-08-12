param(
  [string]$Api = 'http://127.0.0.1:7798'
)

# Intentionally a separate PowerShell/.NET process. A keyboard-hook failure
# must only terminate this helper; Windows then automatically removes its hook
# and Electron's microphone capture keeps running.
Add-Type -ReferencedAssemblies 'System.Net.Http.dll' -TypeDefinition @'
using System;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace OutputsHotkey {
  public static class Program {
    const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;
    const int WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    const int VK_CAPITAL = 0x14, VK_RETURN = 0x0D;
    static IntPtr hook = IntPtr.Zero;
    static HookProc callback = Hook;
    static volatile bool held;
    static int holdEpoch;
    static volatile bool editing;
    static string api = "";
    static readonly HttpClient client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT {
      public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo;
    }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hmod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern sbyte GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

    static void Notify(string suffix) { Task.Run(async () => { try { await client.PostAsync(api + suffix, null); } catch {} }); }
    static async Task WatchOverlay() { while (true) { try { editing = (await client.GetStringAsync(api + "/v1/voice/state")).Contains("\"mode\":\"editing\""); } catch { editing = false; } await Task.Delay(80); } }
    static async Task ConfirmCapsRelease(int epoch) {
      // Some CapsLock drivers emit synthetic keyup between repeat keydowns.
      // Check physical state after the hook returns; only a sustained up state
      // ends the utterance.
      await Task.Delay(35);
      if (epoch == holdEpoch && held && (GetAsyncKeyState(VK_CAPITAL) & 0x8000) == 0) {
        held = false; Notify("/v1/voice/record/stop");
      }
    }
    static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam) {
      if (code >= 0) {
        var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        int msg = wParam.ToInt32();
        if (data.vkCode == VK_RETURN && msg == WM_KEYDOWN && editing) { Notify("/v1/voice/commit"); return (IntPtr)1; }
        if (data.vkCode == VK_CAPITAL) {
          if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
            if (!held) { held = true; System.Threading.Interlocked.Increment(ref holdEpoch); Notify("/v1/voice/record/start"); }
            return (IntPtr)1;
          }
          if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && held) {
            int epoch = holdEpoch; Task.Run(new Func<Task>(() => ConfirmCapsRelease(epoch))); return (IntPtr)1;
          }
        }
      }
      return CallNextHookEx(hook, code, wParam, lParam);
    }
    public static void Run(string endpoint) {
      api = endpoint.TrimEnd('/');
      Task.Run(new Func<Task>(WatchOverlay));
      hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(null), 0);
      if (hook == IntPtr.Zero) Environment.Exit(2);
      try { MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); } }
      finally { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); client.Dispose(); }
    }
  }
}
'@

[OutputsHotkey.Program]::Run($Api)
