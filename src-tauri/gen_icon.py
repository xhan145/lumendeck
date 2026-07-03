"""Generate a 1024x1024 LumenDeck app-icon source PNG (pure stdlib).

Draws the brand mark: a Midnight field with two overlapping rounded "cards"
(Ion Cyan + Voltage Violet) and a soft glow. Output feeds `tauri icon`.
"""
import struct
import zlib

W = H = 1024

MIDNIGHT = (7, 20, 38)
CYAN = (52, 214, 244)
VIOLET = (124, 58, 237)
MINT = (69, 230, 166)
PAPER = (251, 252, 254)

px = bytearray(W * H * 3)


def put(x, y, rgb, a=1.0):
    if x < 0 or y < 0 or x >= W or y >= H:
        return
    i = (y * W + x) * 3
    for k in range(3):
        px[i + k] = max(0, min(255, int(px[i + k] * (1 - a) + rgb[k] * a)))


# Background: vertical gradient midnight -> slightly lighter
for y in range(H):
    t = y / H
    base = (int(7 + 10 * t), int(20 + 18 * t), int(38 + 28 * t))
    for x in range(W):
        i = (y * W + x) * 3
        px[i], px[i + 1], px[i + 2] = base


def rounded_rect(cx, cy, w, h, r, rgb, a=1.0, angle=0.0):
    import math
    ca, sa = math.cos(angle), math.sin(angle)
    hw, hh = w / 2, h / 2
    for y in range(int(cy - hh - abs(hw * sa) - 4), int(cy + hh + abs(hw * sa) + 4)):
        for x in range(int(cx - hw - abs(hh * sa) - 4), int(cx + hw + abs(hh * sa) + 4)):
            dx = (x - cx) * ca + (y - cy) * sa
            dy = -(x - cx) * sa + (y - cy) * ca
            ax, ay = abs(dx), abs(dy)
            if ax <= hw - r and ay <= hh:
                put(x, y, rgb, a)
            elif ay <= hh - r and ax <= hw:
                put(x, y, rgb, a)
            else:
                ddx = ax - (hw - r)
                ddy = ay - (hh - r)
                if ddx * ddx + ddy * ddy <= r * r:
                    put(x, y, rgb, a)


# Soft glow behind the mark
import math
for y in range(H):
    for x in range(W):
        d = math.hypot(x - 512, y - 512)
        if d < 430:
            a = (1 - d / 430) * 0.16
            put(x, y, CYAN if (x + y) % 2 == 0 else VIOLET, a)

# Back card (violet), rotated
rounded_rect(470, 540, 360, 470, 60, VIOLET, 0.92, angle=math.radians(-12))
# Front card (cyan)
rounded_rect(560, 500, 360, 470, 60, CYAN, 0.96, angle=math.radians(6))
# Inner "lens" on front card
rounded_rect(560, 500, 150, 150, 75, MIDNIGHT, 0.9, angle=0)
for y in range(H):
    for x in range(W):
        if math.hypot(x - 560, y - 500) < 70:
            a = max(0, 1 - math.hypot(x - 560, y - 500) / 70) * 0.85
            put(x, y, MINT, a)


def write_png(path):
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        raw.extend(px[y * W * 3:(y + 1) * W * 3])
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    write_png("icon-source.png")
    print("wrote icon-source.png")
