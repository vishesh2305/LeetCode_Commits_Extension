#!/usr/bin/env python3
"""Generate the extension icons (stdlib only, no Pillow).

Motif: LeetCode-orange rounded square with a white git-branch graph —
two nodes on a trunk plus a branch node, i.e. "solutions, committed".
"""
import math
import struct
import zlib
from pathlib import Path

BG_A = (255, 161, 22)   # LeetCode orange
BG_B = (255, 122, 24)
FG = (255, 255, 255)
SS = 4                  # supersampling factor


def rounded_rect(x, y, w, h, r):
    def inside(px, py):
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
            return x <= px <= x + w and y <= py <= y + h
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def disc(cx, cy, r):
    return lambda px, py: (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def ring(cx, cy, r, t):
    def inside(px, py):
        d = math.hypot(px - cx, py - cy)
        return r - t <= d <= r
    return inside


def segment(x1, y1, x2, y2, t):
    def inside(px, py):
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        u = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
        return math.hypot(px - (x1 + u * dx), py - (y1 + u * dy)) <= t / 2
    return inside


def arc(cx, cy, r, t, a0, a1):
    def inside(px, py):
        d = math.hypot(px - cx, py - cy)
        if not (r - t / 2 <= d <= r + t / 2):
            return False
        a = math.degrees(math.atan2(py - cy, px - cx)) % 360
        return a0 <= a <= a1 if a0 <= a1 else (a >= a0 or a <= a1)
    return inside


def render(size):
    S = size * SS
    u = S / 100.0  # work in a 0..100 design space

    bg = rounded_rect(0, 0, S, S, 22 * u)

    trunk_x = 36 * u
    branch_x = 66 * u
    top_y, mid_y, bot_y = 24 * u, 50 * u, 76 * u
    stroke = 7.5 * u
    node_r = 9.5 * u
    node_t = 6.5 * u

    strokes = [
        segment(trunk_x, top_y, trunk_x, bot_y, stroke),
        arc(trunk_x + 15 * u, mid_y, 15 * u, stroke, 180, 360),
    ]
    nodes = [
        (trunk_x, top_y), (trunk_x, bot_y), (branch_x, mid_y),
    ]

    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            r_acc = g_acc = b_acc = a_acc = 0
            for sy in range(SS):
                for sx in range(SS):
                    fx = px * SS + sx + 0.5
                    fy = py * SS + sy + 0.5
                    if not bg(fx, fy):
                        continue
                    # vertical gradient across the tile
                    t = fy / S
                    br = int(BG_A[0] + (BG_B[0] - BG_A[0]) * t)
                    bgc = int(BG_A[1] + (BG_B[1] - BG_A[1]) * t)
                    bb = int(BG_A[2] + (BG_B[2] - BG_A[2]) * t)

                    fg_hit = any(s(fx, fy) for s in strokes)
                    if not fg_hit:
                        for cx, cy in nodes:
                            if ring(cx, cy, node_r, node_t)(fx, fy):
                                fg_hit = True
                                break
                    if fg_hit:
                        br, bgc, bb = FG
                    r_acc += br; g_acc += bgc; b_acc += bb; a_acc += 255
            n = SS * SS
            row.append((
                r_acc // n if a_acc else 0,
                g_acc // n if a_acc else 0,
                b_acc // n if a_acc else 0,
                a_acc // n,
            ))
        rows.append(row)
    return rows


def write_png(path, rows):
    h = len(rows); w = len(rows[0])
    raw = b''.join(b'\x00' + bytes(v for px in row for v in px) for row in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    Path(path).write_bytes(png)


if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'icons'
    out.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(out / f'icon{size}.png', render(size))
        print(f'wrote icons/icon{size}.png')
