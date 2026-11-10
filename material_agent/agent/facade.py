"""街景立面校正：四角单应变换 + 自动找四边形（best-effort）。

用法:
  python facade.py --image street.jpg --points "x1,y1 x2,y2 x3,y3 x4,y4" --out facade.png
  python facade.py --image street.jpg --auto --out facade.png
  python facade.py --image street.jpg --auto --debug  # 保存检测到的角点图

供 p0_run.py 调用: rectify_facade(img, points)
"""
import argparse
import json
import os

import cv2
import numpy as np


def read_image(path):
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f'cannot read image: {path}')
    return img


def write_image(path, img):
    ext = os.path.splitext(path)[1] or '.png'
    ok, buf = cv2.imencode(ext, img)
    if not ok:
        raise RuntimeError(f'cannot encode image: {path}')
    buf.tofile(path)


def order_points(pts):
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).reshape(-1)
    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = pts[np.argmin(s)]   # top-left
    ordered[2] = pts[np.argmax(s)]   # bottom-right
    ordered[1] = pts[np.argmin(d)]   # top-right
    ordered[3] = pts[np.argmax(d)]   # bottom-left
    return ordered


def rectify_facade(img, points, out_w=None, out_h=None, margin=0.0):
    """points: 4x2 in image coords (TL,TR,BR,BL 顺序不限). 返回 (warped, H)."""
    src = order_points(points)
    if margin:
        cx, cy = src.mean(axis=0)
        src = (src - [cx, cy]) * (1.0 + margin) + [cx, cy]
    w = out_w or int(max(np.linalg.norm(src[0] - src[1]), np.linalg.norm(src[3] - src[2])))
    h = out_h or int(max(np.linalg.norm(src[0] - src[3]), np.linalg.norm(src[1] - src[2])))
    if w < 8 or h < 8:
        raise ValueError(f'facade too small: {w}x{h}')
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(img, H, (w, h), flags=cv2.INTER_CUBIC)
    return warped, H



def crop_norm(img, bb, pad=0.03):
    """按归一化 bbox 裁图，返回 (crop, offset_x, offset_y)。"""
    h, w = img.shape[:2]
    x0 = int(max(0, (bb[0] - pad) * w))
    y0 = int(max(0, (bb[1] - pad) * h))
    x1 = int(min(w, (bb[2] + pad) * w))
    y1 = int(min(h, (bb[3] + pad) * h))
    if x1 - x0 < 40 or y1 - y0 < 40:
        return None, 0, 0
    return img[y0:y1, x0:x1], x0, y0


def auto_quad(img, min_area_ratio=0.04):
    """在街景图里找最像立面的四边形（边缘 + 轮廓近似），失败返回 None。"""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 60, 160)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best, best_area = None, 0.0
    for c in contours:
        area = cv2.contourArea(c)
        if area < w * h * min_area_ratio:
            continue
        peri = cv2.arcLength(c, True)
        for eps in (0.02, 0.03, 0.05):
            approx = cv2.approxPolyDP(c, eps * peri, True)
            if len(approx) != 4:
                continue
            quad = approx.reshape(4, 2)
            if not cv2.isContourConvex(quad):
                continue
            q = order_points(quad)
            # 长宽比与矩形度粗筛
            wa = np.linalg.norm(q[0] - q[1])
            ha = np.linalg.norm(q[0] - q[3])
            if ha < 20 or wa < 20:
                continue
            ratio = max(wa, ha) / max(1.0, min(wa, ha))
            if ratio < 0.3:
                continue
            if area > best_area:
                best, best_area = q, area
            break
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--points', default=None, help='"x,y x,y x,y x,y"')
    ap.add_argument('--points-json', default=None, help='JSON 文件，[[x,y],...]')
    ap.add_argument('--auto', action='store_true')
    ap.add_argument('--width', type=int, default=None)
    ap.add_argument('--height', type=int, default=None)
    ap.add_argument('--margin', type=float, default=0.0)
    ap.add_argument('--debug', action='store_true')
    a = ap.parse_args()

    img = read_image(a.image)
    pts = None
    if a.points_json:
        pts = json.load(open(a.points_json, encoding='utf-8'))
    elif a.points:
        pts = [[float(v) for v in p.split(',')] for p in a.points.split()]
    elif a.auto:
        pts = auto_quad(img)
        if pts is None:
            raise SystemExit('auto quad not found; pass --points instead')
    else:
        raise SystemExit('need --points / --points-json / --auto')

    warped, H = rectify_facade(img, pts, a.width, a.height, a.margin)
    write_image(a.out, warped)
    print('OK', a.out, warped.shape[1], 'x', warped.shape[0])
    print('H', json.dumps(np.round(H, 6).tolist()))

    if a.debug:
        dbg = img.copy()
        q = order_points(pts).astype(int)
        cv2.polylines(dbg, [q], True, (0, 0, 255), 4)
        for i, p in enumerate(q):
            cv2.circle(dbg, tuple(p), 8, (0, 255, 0), -1)
            cv2.putText(dbg, str(i), tuple(p + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 0), 2)
        base, ext = os.path.splitext(a.out)
        write_image(base + '_debug' + (ext or '.png'), dbg)


if __name__ == '__main__':
    main()
