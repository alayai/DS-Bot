"""Clear held X11 input after the interactive VNC relay has exited."""
import ctypes as c

x = c.CDLL("libX11.so.6")
t = c.CDLL("libXtst.so.6")
x.XOpenDisplay.restype = c.c_void_p
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XQueryKeymap.argtypes = [c.c_void_p, c.c_void_p]
x.XGetPointerMapping.argtypes = [c.c_void_p, c.c_void_p, c.c_int]
x.XQueryPointer.argtypes = [c.c_void_p, c.c_ulong] + [c.c_void_p] * 7
x.XSync.argtypes = [c.c_void_p, c.c_int]
x.XCloseDisplay.argtypes = [c.c_void_p]
t.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
t.XTestFakeButtonEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
d = x.XOpenDisplay(None)
if not d:
    raise RuntimeError("Desktop input cleanup cannot open the display.")
try:
    keys = (c.c_ubyte * 32)()
    x.XQueryKeymap(d, keys)
    for key in range(8, 256):
        if keys[key // 8] & (1 << (key % 8)):
            if not t.XTestFakeKeyEvent(d, key, 0, 0):
                raise RuntimeError("Key release failed.")
    mapping = (c.c_ubyte * 256)()
    count = x.XGetPointerMapping(d, mapping, len(mapping))
    if not 0 < count <= 256:
        raise RuntimeError("Invalid pointer mapping.")
    for button in range(1, count + 1):
        if not t.XTestFakeButtonEvent(d, button, 0, 0):
            raise RuntimeError("Button release failed.")
    x.XSync(d, 0)
    x.XQueryKeymap(d, keys)
    root, child = c.c_ulong(), c.c_ulong()
    rx, ry, wx, wy, mask = (c.c_int() for _ in range(5))
    if not x.XQueryPointer(d, x.XDefaultRootWindow(d), c.byref(root), c.byref(child),
                          c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask)):
        raise RuntimeError("Cannot confirm pointer release.")
    if any(keys) or mask.value & 0x1F00:
        raise RuntimeError("Desktop input is still held.")
finally:
    x.XCloseDisplay(d)
