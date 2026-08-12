const std = @import("std");
const HWND = ?*anyopaque;
const DWORD = u32;
const UINT = u32;
const ULONG_PTR = usize;
const KEYBDINPUT = extern struct {
    wVk: u16,
    wScan: u16,
    dwFlags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
};
const INPUT = extern struct {
    type: DWORD,
    payload: extern union { ki: KEYBDINPUT, padding: [32]u8 },
};
extern "user32" fn GetForegroundWindow() callconv(.winapi) HWND;
extern "user32" fn IsWindow(hwnd: HWND) callconv(.winapi) c_int;
extern "user32" fn SetForegroundWindow(hwnd: HWND) callconv(.winapi) c_int;
extern "user32" fn SetFocus(hwnd: HWND) callconv(.winapi) HWND;
extern "user32" fn SendInput(count: UINT, inputs: [*]INPUT, input_size: c_int) callconv(.winapi) UINT;
const INPUT_KEYBOARD: DWORD = 1;
const KEYEVENTF_KEYUP: DWORD = 0x0002;
const KEYEVENTF_UNICODE: DWORD = 0x0004;
const SOCKET = usize;
const INVALID_SOCKET = ~@as(SOCKET, 0);
const AF_INET: c_int = 2;
const SOCK_STREAM: c_int = 1;
const IPPROTO_TCP: c_int = 6;
const SOCKADDR_IN = extern struct { family: u16, port: u16, address: u32, zero: [8]u8 };
extern "ws2_32" fn WSAStartup(version: u16, data: ?*anyopaque) callconv(.winapi) c_int;
extern "ws2_32" fn WSACleanup() callconv(.winapi) c_int;
extern "ws2_32" fn socket(af: c_int, kind: c_int, protocol: c_int) callconv(.winapi) SOCKET;
extern "ws2_32" fn bind(fd: SOCKET, address: ?*const anyopaque, len: c_int) callconv(.winapi) c_int;
extern "ws2_32" fn listen(fd: SOCKET, backlog: c_int) callconv(.winapi) c_int;
extern "ws2_32" fn accept(fd: SOCKET, address: ?*anyopaque, len: ?*c_int) callconv(.winapi) SOCKET;
extern "ws2_32" fn recv(fd: SOCKET, buffer: [*]u8, len: c_int, flags: c_int) callconv(.winapi) c_int;
extern "ws2_32" fn send(fd: SOCKET, buffer: [*]const u8, len: c_int, flags: c_int) callconv(.winapi) c_int;
extern "ws2_32" fn closesocket(fd: SOCKET) callconv(.winapi) c_int;

fn usage() void {
    std.debug.print("usage: stage-shell-core capture | stage-shell-core inject <hwnd> <utf8-text>\n", .{});
}

fn printForeground() void {
    const hwnd = GetForegroundWindow();
    std.debug.print("{d}\n", .{@intFromPtr(hwnd)});
}

fn inject(hwnd_value: usize, text: []const u8) !void {
    const hwnd: HWND = @ptrFromInt(hwnd_value);
    if (hwnd != null and IsWindow(hwnd) != 0) {
        _ = SetForegroundWindow(hwnd);
        _ = SetFocus(hwnd);
    }

    var iterator = try std.unicode.Utf8View.init(text);
    var codepoints = iterator.iterator();
    while (codepoints.nextCodepoint()) |codepoint| {
        var down: INPUT = std.mem.zeroes(INPUT);
        down.type = INPUT_KEYBOARD;
        down.payload.ki.wVk = 0;
        down.payload.ki.wScan = @truncate(codepoint);
        down.payload.ki.dwFlags = KEYEVENTF_UNICODE;
        var up = down;
        up.payload.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        var inputs = [_]INPUT{ down, up };
        if (SendInput(inputs.len, &inputs, @sizeOf(INPUT)) != inputs.len) return error.SendInputFailed;
    }
}

fn sendResponse(client: SOCKET, status: []const u8, body: []const u8) void {
    var head: [256]u8 = undefined;
    const header = std.fmt.bufPrint(&head, "HTTP/1.1 {s}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {d}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", .{ status, body.len }) catch return;
    _ = send(client, header.ptr, @intCast(header.len), 0);
    _ = send(client, body.ptr, @intCast(body.len), 0);
}

fn queryHwnd(target: []const u8) ?usize {
    const marker = "?hwnd=";
    const start = std.mem.indexOf(u8, target, marker) orelse return null;
    const value = target[start + marker.len ..];
    return std.fmt.parseInt(usize, value, 10) catch null;
}

fn handleRequest(client: SOCKET, request: []const u8) void {
    const line_end = std.mem.indexOf(u8, request, "\r\n") orelse { sendResponse(client, "400 Bad Request", "{\"error\":\"bad request\"}"); return; };
    const first = request[0..line_end];
    const body_at = std.mem.indexOf(u8, request, "\r\n\r\n") orelse request.len;
    const body = if (body_at + 4 <= request.len) request[body_at + 4 ..] else "";
    if (std.mem.eql(u8, first, "GET /v1/core/health HTTP/1.1")) { sendResponse(client, "200 OK", "{\"ok\":true,\"service\":\"stage-shell-core\"}"); return; }
    if (std.mem.eql(u8, first, "GET /v1/core/capture HTTP/1.1")) {
        var response: [96]u8 = undefined;
        const json = std.fmt.bufPrint(&response, "{{\"hwnd\":{d}}}", .{@intFromPtr(GetForegroundWindow())}) catch return;
        sendResponse(client, "200 OK", json); return;
    }
    if (std.mem.startsWith(u8, first, "POST /v1/core/inject?hwnd=")) {
        // The first space is the separator after `POST`, not the end of the
        // request target. Searching from the path start avoids an inverted
        // slice (`first[5..4]`) and a process crash on every injection.
        const path_start = 5;
        const path_end = path_start + (std.mem.indexOfScalar(u8, first[path_start..], ' ') orelse first.len - path_start);
        const target = first[path_start..path_end];
        const hwnd = queryHwnd(target) orelse { sendResponse(client, "400 Bad Request", "{\"error\":\"missing hwnd\"}"); return; };
        inject(hwnd, body) catch |err| { var response: [128]u8 = undefined; const json = std.fmt.bufPrint(&response, "{{\"error\":\"{t}\"}}", .{err}) catch "{\"error\":\"inject failed\"}"; sendResponse(client, "500 Internal Server Error", json); return; };
        sendResponse(client, "200 OK", "{\"ok\":true}"); return;
    }
    sendResponse(client, "404 Not Found", "{\"error\":\"not found\"}");
}

fn serve(port: u16) !void {
    var wsa: [512]u8 = std.mem.zeroes([512]u8);
    if (WSAStartup(0x0202, @ptrCast(&wsa)) != 0) return error.WinsockStartupFailed;
    defer _ = WSACleanup();
    const listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return error.SocketCreateFailed;
    defer _ = closesocket(listener);
    const address = SOCKADDR_IN{ .family = AF_INET, .port = @byteSwap(port), .address = 0x0100007f, .zero = .{0} ** 8 };
    if (bind(listener, @ptrCast(&address), @sizeOf(SOCKADDR_IN)) != 0) return error.BindFailed;
    if (listen(listener, 16) != 0) return error.ListenFailed;
    std.debug.print("READY http://127.0.0.1:{d}\n", .{port});
    while (true) {
        const client = accept(listener, null, null);
        if (client == INVALID_SOCKET) continue;
        var buffer: [65536]u8 = undefined;
        const count = recv(client, &buffer, buffer.len, 0);
        if (count > 0) handleRequest(client, buffer[0..@intCast(count)]);
        // This must happen for every accepted connection. A defer inside this
        // endless loop runs only when the server exits, gradually exhausting
        // the listener backlog and making later text injection look like a
        // random `fetch failed`.
        _ = closesocket(client);
    }
}

pub fn main(init: std.process.Init) !void {
    var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa);
    defer args.deinit();
    _ = args.next();
    const command = args.next() orelse {
        usage();
        return error.InvalidArguments;
    };
    if (std.mem.eql(u8, command, "capture")) return printForeground();
    if (std.mem.eql(u8, command, "serve")) {
        const port_text = args.next() orelse "7803";
        return serve(try std.fmt.parseInt(u16, port_text, 10));
    }
    if (std.mem.eql(u8, command, "inject")) {
        const hwnd_text = args.next() orelse return error.InvalidArguments;
        const text = args.next() orelse return error.InvalidArguments;
        const hwnd = try std.fmt.parseInt(usize, hwnd_text, 10);
        return inject(hwnd, text);
    }
    usage();
    return error.InvalidArguments;
}
