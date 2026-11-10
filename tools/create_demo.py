"""Generate an explicitly synthetic city using only Python's standard library."""
import argparse
import json
import math
from pathlib import Path
import random
import struct
import zlib

STEM = 'demo_city'
RECORD = struct.Struct('<6f4B4B')


def create_demo(output):
    root = Path(output)
    targets = [root / 'models' / (STEM + ext) for ext in ('.splat', '.buildings.json')]
    targets += [root / 'models.json', root / 'previews' / (STEM + '.png')]
    if any(path.exists() for path in targets):
        raise FileExistsError('Demo files already exist. Choose a new --output directory to preserve them.')
    rng = random.Random(218)
    payload = bytearray()
    buildings = []
    palette = [(163, 186, 205), (182, 121, 92), (192, 191, 173), (106, 154, 177)]

    def add(x, y, z, scale, color):
        payload.extend(RECORD.pack(x, y, z, *scale, *color, 255, 255, 128, 128, 128))

    for x in range(-76, 77, 2):
        for y in range(-67, 68, 2):
            road = abs(x) < 6 or abs(y) < 5 or 30 < abs(y) < 39
            add(x, y, 0, (1.25, 1.25, .07), (71, 84, 100) if road else (83, 115, 102))
    for row in range(3):
        for col in range(4):
            cx, cy = (col - 1.5) * 35, (row - 1) * 40
            w, d = rng.randint(16, 23), rng.randint(17, 25)
            floors = rng.randint(3, 9)
            height = round(floors * 3.2, 2)
            base_color = palette[(row + col) % len(palette)]
            x0, x1, y0, y1 = cx-w/2, cx+w/2, cy-d/2, cy+d/2
            ring = [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]
            bid = len(buildings)
            buildings.append({'id': bid, 'ring': ring, 'cx': cx, 'cy': cy, 'base': 0, 'top': height,
                              'height_m': height, 'floors': floors, 'area_m2': w*d, 'perim_m': 2*(w+d),
                              'name': 'Synthetic building %02d' % bid, 'synthetic': True})
            for axis, length, fixed in [('x',w,y0),('x',w,y1),('y',d,x0),('y',d,x1)]:
                steps = math.ceil(length)
                for u in range(steps+1):
                    pos = u * length / steps
                    for zi in range(math.ceil(height)):
                        z = zi + .5
                        window = .65 < (pos % 3.8) < 2.5 and .9 < (z % 3.2) < 2.55
                        color = (41, 78, 101) if window else base_color
                        if axis == 'x': add(x0+pos, fixed, z, (.68,.08,.68), color)
                        else: add(fixed, y0+pos, z, (.08,.68,.68), color)
            for xi in range(math.ceil(w)+1):
                for yi in range(math.ceil(d)+1):
                    add(x0+xi, y0+yi, height, (.7,.7,.08), (102, 125, 147))
    for path in targets: path.parent.mkdir(parents=True, exist_ok=True)
    targets[0].write_bytes(payload)
    sidecar = {'aligned': True, 'coord_system': 'synthetic metric scene', 'synthetic': True, 'buildings': buildings}
    targets[1].write_text(json.dumps(sidecar, ensure_ascii=False, indent=2), encoding='utf-8')
    registry = {'items': [{'file': STEM+'.splat', 'title': 'Demo City · Synthetic',
                           'desc': '程序化合成示例，仅用于体验界面；非实测、非训练成果，无地理或实景证据。',
                           'metrics': '12 栋 · 152×134 m', 'preview': STEM+'.png'}]}
    targets[2].write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding='utf-8')
    width, height = 384, 336
    pixels = bytearray()
    for py in range(height):
        pixels.append(0)
        y = 67 - py / (height-1) * 134
        for px in range(width):
            x = -76 + px / (width-1) * 152
            color = (52,72,81) if abs(x)<6 or abs(y)<5 or 30<abs(y)<39 else (55,91,83)
            for building in buildings:
                a, _, c = building['ring'][:3]
                if a[0] <= x <= c[0] and a[1] <= y <= c[1]: color = palette[building['id'] % len(palette)]; break
            pixels.extend(color)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind+data) & 0xffffffff)
    targets[3].write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', width,height,8,2,0,0,0))
                           + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b''))
    return {'buildings': len(buildings), 'gaussians': len(payload)//32, 'path': str(targets[0])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1]/'data'/'library')
    args = parser.parse_args()
    try:
        print(json.dumps(create_demo(args.output), ensure_ascii=True))
    except FileExistsError as exc:
        parser.exit(1, str(exc)+'\n')
