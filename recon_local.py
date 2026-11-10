#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Twin Studio local reconstruction: ortho image (+ optional DSM GeoTIFF) -> Gaussian splat scene.

On-premise fallback for the remote citytwin 3DGS pipeline (when configured), used when that host
is unreachable. It does NOT run SfM or photometric 3DGS optimisation. It builds a geometry-true
Gaussian scene directly from the DSM:
  * roof / ground surfels on a regular grid, oriented by the DSM normal, coloured by the ortho image;
  * facade surfels extruded at building height jumps (colour estimated from roof edge + ground);
  * building footprints from nDSM = DSM - DTM (grey opening), vegetation removed with ExG.
Output: <stem>.splat (antimatter15 layout, 32 B/gaussian, z-up, metres, centred on the tile),
        <stem>.meta.json (title/metrics/buildings/georeference), <stem>.png preview.
"""
import argparse
import json
import math
import os
import sys
import time
import traceback
import warnings

import numpy as np

SPLAT_DTYPE = np.dtype([("p", "<f4", (3,)), ("s", "<f4", (3,)), ("c", "u1", (4,)), ("r", "u1", (4,))])
assert SPLAT_DTYPE.itemsize == 32


# ------------------------------------------------------------------------------------------ status
class Status:
    def __init__(self, path):
        self.path = path
        self.t0 = time.time()
        self.state = {"status": "running", "stage": "init", "progress": 0, "msg": "", "started": self.t0,
                      "engine": "local-dsm-splat"}

    def update(self, **kw):
        self.state.update(kw)
        self.state["elapsed"] = round(time.time() - self.t0, 1)
        if self.path:
            os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f, ensure_ascii=False)
            for _ in range(20):
                try:
                    os.replace(tmp, self.path)
                    break
                except PermissionError:
                    time.sleep(0.05)
        print("[%6.1fs] %-9s %3s%% %s" % (self.state["elapsed"], self.state.get("stage"),
                                          self.state.get("progress"), self.state.get("msg")), flush=True)


# ------------------------------------------------------------------------------------------ raster io
def read_raster(path):
    """Return (array[bands, H, W], info). GeoTIFF via rasterio; plain images via OpenCV."""
    rio_err = None
    try:
        import rasterio
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with rasterio.open(path) as ds:
                arr = ds.read()
                crs = ds.crs
                tr = ds.transform
                return arr, {
                    "driver": ds.driver,
                    "crs": crs.to_string() if crs else None,
                    "geographic": bool(crs is not None and crs.is_geographic),
                    "transform": tr,
                    "georef": bool(crs is not None) and not tr.is_identity,
                    "res": (abs(tr.a), abs(tr.e)),
                    "nodata": ds.nodata,
                }
    except Exception as e:  # not a raster rasterio understands -> try OpenCV
        rio_err = e
    import cv2
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("无法读取栅格文件 %s（rasterio: %s）" % (path, rio_err))
    if img.ndim == 2:
        arr = img[None]
    else:
        if img.shape[2] >= 3:
            img = img[:, :, [2, 1, 0] + list(range(3, img.shape[2]))]
        arr = np.transpose(img, (2, 0, 1))
    return arr, {"driver": "opencv", "crs": None, "geographic": False, "transform": None,
                 "georef": False, "res": None, "nodata": None}


def to_rgb8(arr):
    a = arr[:3] if arr.shape[0] >= 3 else np.repeat(arr[:1], 3, axis=0)
    if a.dtype == np.uint8:
        out = a
    else:
        a = a.astype(np.float32)
        out = np.empty(a.shape, np.uint8)
        for i in range(3):
            b = a[i]
            fin = np.isfinite(b)
            lo, hi = (np.percentile(b[fin], [1, 99]) if fin.any() else (0.0, 1.0))
            out[i] = np.clip((b - lo) / max(float(hi - lo), 1e-6) * 255.0, 0, 255).astype(np.uint8)
    return np.ascontiguousarray(np.transpose(out, (1, 2, 0)))


def fill_nan(d):
    bad = ~np.isfinite(d)
    if not bad.any():
        return d, 0.0
    if bad.all():
        raise ValueError("DSM 中没有有效高程值。")
    from scipy import ndimage
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return d[tuple(idx)], float(bad.mean())


def load_dsm(path, oinfo, shape):
    import cv2
    arr, info = read_raster(path)
    d = arr[0].astype(np.float32)
    bad = ~np.isfinite(d)
    if info["nodata"] is not None and np.isfinite(info["nodata"]):
        bad |= d == np.float32(info["nodata"])
    bad |= (d < -1000) | (d > 9000)
    d[bad] = np.nan
    H, W = shape
    if oinfo["georef"] and info["georef"] and oinfo["crs"] and oinfo["crs"] == info["crs"]:
        from rasterio.warp import reproject, Resampling
        dst = np.full((H, W), np.nan, np.float32)
        reproject(source=d, destination=dst, src_transform=info["transform"], src_crs=info["crs"],
                  dst_transform=oinfo["transform"], dst_crs=oinfo["crs"], src_nodata=np.nan,
                  dst_nodata=np.nan, resampling=Resampling.bilinear)
        coverage = float(np.isfinite(dst).mean())
        if coverage < 0.1:
            raise ValueError("DSM 与影像几乎不重叠（覆盖率 %.1f%%），请检查两者是否为同一区域。" % (coverage * 100))
        d, filled = fill_nan(dst)
        return d, {"align": "georef-reproject", "coverage": coverage, "filled": filled, "crs": info["crs"]}
    d, filled = fill_nan(d)
    if d.shape != (H, W):
        d = cv2.resize(d, (W, H), interpolation=cv2.INTER_LINEAR)
    return d, {"align": "pixel-resize", "coverage": 1.0, "filled": filled, "crs": info["crs"]}


# ------------------------------------------------------------------------------------------ math
def quat_from_matrix(R):
    """Rotation matrices (N,3,3) -> unit quaternions (N,4) as [w,x,y,z] with w >= 0."""
    R = np.asarray(R, np.float64)
    q = np.zeros((R.shape[0], 4))
    m00, m01, m02 = R[:, 0, 0], R[:, 0, 1], R[:, 0, 2]
    m10, m11, m12 = R[:, 1, 0], R[:, 1, 1], R[:, 1, 2]
    m20, m21, m22 = R[:, 2, 0], R[:, 2, 1], R[:, 2, 2]
    tr = m00 + m11 + m22
    c1 = tr > 0
    c2 = (~c1) & (m00 > m11) & (m00 > m22)
    c3 = (~c1) & (~c2) & (m11 > m22)
    c4 = ~(c1 | c2 | c3)
    if c1.any():
        s = np.sqrt(np.maximum(tr[c1] + 1.0, 1e-12)) * 2
        q[c1] = np.stack([0.25 * s, (m21[c1] - m12[c1]) / s, (m02[c1] - m20[c1]) / s, (m10[c1] - m01[c1]) / s], 1)
    if c2.any():
        s = np.sqrt(np.maximum(1.0 + m00[c2] - m11[c2] - m22[c2], 1e-12)) * 2
        q[c2] = np.stack([(m21[c2] - m12[c2]) / s, 0.25 * s, (m01[c2] + m10[c2]) / s, (m02[c2] + m20[c2]) / s], 1)
    if c3.any():
        s = np.sqrt(np.maximum(1.0 + m11[c3] - m00[c3] - m22[c3], 1e-12)) * 2
        q[c3] = np.stack([(m02[c3] - m20[c3]) / s, (m01[c3] + m10[c3]) / s, 0.25 * s, (m12[c3] + m21[c3]) / s], 1)
    if c4.any():
        s = np.sqrt(np.maximum(1.0 + m22[c4] - m00[c4] - m11[c4], 1e-12)) * 2
        q[c4] = np.stack([(m10[c4] - m01[c4]) / s, (m02[c4] + m20[c4]) / s, (m12[c4] + m21[c4]) / s, 0.25 * s], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    return q


def matrix_from_quat(q):
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], 1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], 1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], 1),
    ], 1)


def quat_z_to(n):
    """Shortest-arc quaternion rotating local +z onto unit normals n (N,3); valid for n_z > -0.99."""
    q = np.stack([1.0 + n[:, 2], -n[:, 1], n[:, 0], np.zeros(len(n))], 1)
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def encode_rot(q):
    return np.clip(np.rint(q * 128.0 + 128.0), 0, 255).astype(np.uint8)


# ------------------------------------------------------------------------------------------ walls
def wall_edges(zw, bw, cw, ext_x, ext_y, min_jump):
    """Height jumps between 4-neighbour cells whose higher side is a building."""
    wh, ww = zw.shape
    sx, sy = ext_x / ww, ext_y / wh
    X = (np.arange(ww) + 0.5) * sx - ext_x / 2.0
    Y = ext_y / 2.0 - (np.arange(wh) + 0.5) * sy
    out = []
    # east-west neighbours: a=(r,c) west, b=(r,c+1) east; shared edge is a north-south line
    za, zb = zw[:, :-1], zw[:, 1:]
    a_hi = za > zb
    hb = np.where(a_hi, bw[:, :-1], bw[:, 1:])
    m = (np.abs(za - zb) > min_jump) & hb
    r, c = np.nonzero(m)
    if r.size:
        ah = a_hi[r, c]
        out.append(dict(
            x=X[c] + sx / 2.0, y=Y[r], nx=np.where(ah, 1.0, -1.0), ny=np.zeros(r.size),
            zlo=np.minimum(za[r, c], zb[r, c]), zhi=np.maximum(za[r, c], zb[r, c]),
            elen=np.full(r.size, sy),
            chi=np.where(ah[:, None], cw[r, c], cw[r, c + 1]), clo=np.where(ah[:, None], cw[r, c + 1], cw[r, c])))
    # north-south neighbours: a=(r,c) north, b=(r+1,c) south; shared edge is an east-west line
    za, zb = zw[:-1, :], zw[1:, :]
    a_hi = za > zb
    hb = np.where(a_hi, bw[:-1, :], bw[1:, :])
    m = (np.abs(za - zb) > min_jump) & hb
    r, c = np.nonzero(m)
    if r.size:
        ah = a_hi[r, c]
        out.append(dict(
            x=X[c], y=Y[r] - sy / 2.0, nx=np.zeros(r.size), ny=np.where(ah, -1.0, 1.0),
            zlo=np.minimum(za[r, c], zb[r, c]), zhi=np.maximum(za[r, c], zb[r, c]),
            elen=np.full(r.size, sx),
            chi=np.where(ah[:, None], cw[r, c], cw[r + 1, c]), clo=np.where(ah[:, None], cw[r + 1, c], cw[r, c])))
    if not out:
        return None
    return {k: np.concatenate([o[k] for o in out]) for k in out[0]}


def coarse_grids(zs, bld, rgb, ext_x, ext_y, step):
    import cv2
    gh, gw = zs.shape
    ww = max(4, int(round(ext_x / step)))
    wh = max(4, int(round(ext_y / step)))
    if ww >= gw and wh >= gh:
        return zs, bld, rgb.astype(np.float32)
    zw = cv2.resize(zs, (ww, wh), interpolation=cv2.INTER_AREA)
    bw = cv2.resize(bld.astype(np.float32), (ww, wh), interpolation=cv2.INTER_AREA) > 0.5
    cw = cv2.resize(rgb.astype(np.float32), (ww, wh), interpolation=cv2.INTER_AREA)
    return zw, bw, cw


def expand_walls(E, vstep, thick):
    dz = E["zhi"] - E["zlo"]
    k = np.maximum(1, np.ceil(dz / vstep)).astype(np.int64)
    total = int(k.sum())
    idx = np.repeat(np.arange(k.size), k)
    j = np.arange(total) - np.repeat(np.cumsum(k) - k, k)
    kk = k[idx].astype(np.float64)
    t = (j + 0.5) / kk
    z = E["zlo"][idx] + t * dz[idx]
    hstep = dz[idx] / kk
    nx, ny = E["nx"][idx], E["ny"][idx]
    zeros, ones = np.zeros(total), np.ones(total)
    e1 = np.stack([-ny, nx, zeros], 1)        # along the facade
    e2 = np.stack([zeros, zeros, ones], 1)    # vertical
    e3 = np.stack([nx, ny, zeros], 1)         # outward normal
    q = quat_from_matrix(np.stack([e1, e2, e3], 2))
    pos = np.stack([E["x"][idx], E["y"][idx], z], 1)
    scale = np.stack([0.62 * E["elen"][idx], 0.62 * np.maximum(hstep, 0.02), np.full(total, thick)], 1)
    tt = t[:, None]
    col = (E["chi"][idx] * (0.5 + 0.5 * tt) + E["clo"][idx] * (0.5 - 0.5 * tt)) * (0.62 + 0.25 * tt)
    return pos, scale, q, np.clip(col, 0, 255), e3


# ------------------------------------------------------------------------------------------ pipeline
def reconstruct(args, st):
    import cv2
    from scipy import ndimage

    st.update(stage="load", progress=3, msg="读取影像 %s" % os.path.basename(args.image))
    arr, oinfo = read_raster(args.image)
    rgb = to_rgb8(arr)
    H, W = rgb.shape[:2]
    if H < 32 or W < 32:
        raise ValueError("影像太小（%d×%d）。" % (W, H))
    if oinfo["georef"] and not oinfo["geographic"]:
        px, py = oinfo["res"]
        scale_src = "GeoTIFF 像元 %.3f m" % px
    else:
        px = py = float(args.width) / W
        scale_src = "按场景宽度 %.0f m 推算" % args.width
    ext_x, ext_y = W * px, H * py
    st.update(stage="load", progress=8, msg="影像 %d×%d，%s，范围 %.1f×%.1f m" % (W, H, scale_src, ext_x, ext_y))

    dsm_info = None
    if args.dsm:
        st.update(stage="dsm", progress=12, msg="读取并对齐 DSM %s" % os.path.basename(args.dsm))
        dsm, dsm_info = load_dsm(args.dsm, oinfo, (H, W))
        st.update(stage="dsm", progress=18, msg="DSM 对齐方式 %s，覆盖 %.1f%%，高程 %.2f–%.2f m" % (
            dsm_info["align"], dsm_info["coverage"] * 100, float(dsm.min()), float(dsm.max())))
    else:
        dsm = np.zeros((H, W), np.float32)
        st.update(stage="dsm", progress=18, msg="未提供 DSM：生成平坦地表（本机没有单目深度模型权重）")

    # ---- working grid
    cell = max(px, py, math.sqrt(ext_x * ext_y / float(args.surf_budget)))
    gw = max(16, int(round(ext_x / cell)))
    gh = max(16, int(round(ext_y / cell)))
    cx, cy = ext_x / gw, ext_y / gh
    cm = 0.5 * (cx + cy)
    rgb_g = cv2.resize(rgb, (gw, gh), interpolation=cv2.INTER_AREA)
    z_g = cv2.resize(dsm.astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA)
    z_g = ndimage.median_filter(z_g, size=3, mode="nearest")
    st.update(stage="grid", progress=25, msg="工作网格 %d×%d，单元 %.3f m" % (gw, gh, cm))

    # ---- terrain (DTM) by grey opening on a 0.5 m grid
    res_c = max(0.5, cm)
    cw_, ch_ = max(8, int(round(ext_x / res_c))), max(8, int(round(ext_y / res_c)))
    zc = cv2.resize(z_g, (cw_, ch_), interpolation=cv2.INTER_AREA)
    open_m = min(48.0, 0.45 * min(ext_x, ext_y))
    k = max(3, int(round(open_m / res_c)) | 1)
    dtm_c = ndimage.grey_opening(zc, size=(k, k), mode="nearest")
    dtm_c = ndimage.gaussian_filter(dtm_c, sigma=max(1.0, k / 6.0), mode="nearest")
    dtm = np.minimum(cv2.resize(dtm_c, (gw, gh), interpolation=cv2.INTER_LINEAR), z_g)
    ndsm = z_g - dtm
    st.update(stage="terrain", progress=35, msg="地面模型：%.0f m 灰度开运算，nDSM 最大 %.1f m" % (open_m, float(ndsm.max())))

    # ---- buildings = high & not vegetation
    rgbf = rgb_g.astype(np.float32) / 255.0
    exg = 2 * rgbf[..., 1] - rgbf[..., 0] - rgbf[..., 2]
    veg = exg > args.veg_exg
    bld = (ndsm > args.min_height) & ~veg
    r = max(1, int(round(0.6 / cm)))
    stc = np.ones((2 * r + 1, 2 * r + 1), bool)
    bld = ndimage.binary_opening(bld, structure=stc)
    bld = ndimage.binary_closing(bld, structure=stc)
    bld = ndimage.binary_fill_holes(bld)
    lab, n = ndimage.label(bld)
    areas = np.bincount(lab.ravel()) * cx * cy
    keep = areas >= args.min_area
    keep[0] = False
    bld = keep[lab]
    lab, n = ndimage.label(bld)
    st.update(stage="classify", progress=45, msg="识别建筑 %d 栋（占地 %.1f%%），植被 %.1f%%" % (
        n, bld.mean() * 100, veg.mean() * 100))

    z0 = float(np.percentile(dtm, 2))
    zs = (z_g - z0).astype(np.float64)
    X = (np.arange(gw) + 0.5) * cx - ext_x / 2.0
    Y = ext_y / 2.0 - (np.arange(gh) + 0.5) * cy

    buildings = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        m = lab[sl] == i
        mp = np.pad(m.astype(np.uint8), 1)
        cs, _ = cv2.findContours(mp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            continue
        c = max(cs, key=cv2.contourArea)
        c = cv2.approxPolyDP(c, max(1.0, 0.5 / cm), True).reshape(-1, 2)
        if len(c) < 3:
            continue
        cols = c[:, 0] - 1 + sl[1].start
        rows = c[:, 1] - 1 + sl[0].start
        ring = [[round(float((cc + 0.5) * cx - ext_x / 2.0), 2), round(float(ext_y / 2.0 - (rr + 0.5) * cy), 2)]
                for cc, rr in zip(cols, rows)]
        base = float(np.median(dtm[sl][m])) - z0
        roof = float(np.median(zs[sl][m]))
        yy, xx = np.nonzero(m)
        buildings.append({
            "id": "b%03d" % len(buildings),
            "area_m2": round(float(m.sum() * cx * cy), 1),
            "height_m": round(max(0.0, roof - base), 2),
            "base": round(base, 2),
            "top": round(roof, 2),
            "centroid": [round(float(X[xx.mean().round().astype(int) + sl[1].start]), 2),
                         round(float(Y[yy.mean().round().astype(int) + sl[0].start]), 2)],
            "ring": ring,
        })

    # ---- surface surfels
    gy, gx = np.gradient(zs, cy, cx)
    nrm = np.stack([-gx, gy, np.ones_like(zs)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    steep = nrm[..., 2] < 0.5
    nrm[steep] = (0.0, 0.0, 1.0)
    nz = nrm[..., 2]
    XX, YY = np.meshgrid(X, Y)
    s_pos = np.stack([XX, YY, zs], -1).reshape(-1, 3)
    sp = (0.7 * cm / np.sqrt(nz)).reshape(-1)
    s_scale = np.stack([sp, sp, np.full(sp.size, 0.12 * cm)], 1)
    s_n = nrm.reshape(-1, 3)
    s_q = quat_z_to(s_n)
    s_col = rgb_g.reshape(-1, 3).astype(np.float64)
    st.update(stage="surface", progress=60, msg="屋顶/地表面元 %d 个" % len(s_pos))

    # ---- facade surfels with a gaussian budget
    step = max(cm, args.wall_step)
    min_jump = max(0.8, 4 * cm)
    # the opened mask sits slightly inside the roof edge; widen it so the jump cells qualify
    bld_w = ndimage.binary_dilation(bld, iterations=max(1, int(round(0.5 / cm))))
    E, wall_n = None, 0
    for _ in range(6):
        zw, bw, cwg = coarse_grids(zs, bld_w, rgb_g, ext_x, ext_y, step)
        E = wall_edges(zw, bw, cwg, ext_x, ext_y, min_jump)
        if E is None:
            break
        wall_n = int(np.maximum(1, np.ceil((E["zhi"] - E["zlo"]) / step)).sum())
        if wall_n <= args.wall_budget:
            break
        step *= math.sqrt(wall_n / float(args.wall_budget)) * 1.05
    if E is not None:
        w_pos, w_scale, w_q, w_col, w_n = expand_walls(E, step, 0.1 * step)
    else:
        w_pos = np.zeros((0, 3)); w_scale = np.zeros((0, 3)); w_q = np.zeros((0, 4)); w_col = np.zeros((0, 3)); w_n = np.zeros((0, 3))
    st.update(stage="facade", progress=75, msg="立面面元 %d 个（步长 %.2f m，高差阈值 %.2f m）" % (len(w_pos), step, min_jump))

    # ---- self-check of the rotation encoding: local +z must map to the intended normal
    for q, nn in ((s_q, s_n), (w_q, w_n)):
        if len(q):
            pick = np.linspace(0, len(q) - 1, min(len(q), 2000)).astype(int)
            Rm = matrix_from_quat(q[pick])
            err = np.abs(Rm[:, :, 2] - nn[pick]).max()
            if err > 1e-6:
                raise RuntimeError("四元数自检失败（误差 %.3g）" % err)

    # ---- write splat
    st.update(stage="write", progress=85, msg="写出 .splat")
    N = len(s_pos) + len(w_pos)
    rec = np.zeros(N, SPLAT_DTYPE)
    rec["p"] = np.concatenate([s_pos, w_pos]).astype(np.float32)
    rec["s"] = np.concatenate([s_scale, w_scale]).astype(np.float32)
    col = np.concatenate([s_col, w_col])
    rec["c"][:, :3] = np.clip(np.rint(col), 0, 255).astype(np.uint8)
    rec["c"][:len(s_pos), 3] = 245
    rec["c"][len(s_pos):, 3] = 235
    rec["r"] = encode_rot(np.concatenate([s_q, w_q]))
    if not np.isfinite(rec["p"]).all() or not np.isfinite(rec["s"]).all():
        raise RuntimeError("输出包含非有限数值。")
    os.makedirs(args.out_dir, exist_ok=True)
    splat_path = os.path.join(args.out_dir, args.stem + ".splat")
    tmp = splat_path + ".part"
    rec.tofile(tmp)
    os.replace(tmp, splat_path)

    # ---- preview (ortho x hillshade, building outlines)
    st.update(stage="preview", progress=92, msg="生成预览图")
    light = np.array([-0.45, 0.45, 0.77]); light /= np.linalg.norm(light)
    gy2, gx2 = np.gradient(zs, cy, cx)
    n2 = np.stack([-gx2, gy2, np.ones_like(zs)], -1)
    n2 /= np.linalg.norm(n2, axis=-1, keepdims=True)
    shade = np.clip(n2 @ light, 0, 1)
    prev = np.clip(rgb_g.astype(np.float32) * (0.55 + 0.45 * shade[..., None] / max(light[2], 1e-6)), 0, 255).astype(np.uint8)
    edge = bld & ~ndimage.binary_erosion(bld, iterations=max(1, int(round(0.3 / cm))))
    prev[edge] = (83, 227, 255)
    sc = 720.0 / max(gw, gh)
    if sc < 1:
        prev = cv2.resize(prev, (max(1, int(gw * sc)), max(1, int(gh * sc))), interpolation=cv2.INTER_AREA)
    preview_name = args.stem + ".png"
    pdir = args.preview_dir or args.out_dir
    os.makedirs(pdir, exist_ok=True)
    ok, png = cv2.imencode(".png", cv2.cvtColor(prev, cv2.COLOR_RGB2BGR))
    if ok:
        png.tofile(os.path.join(pdir, preview_name))

    # ---- metadata
    origin = None
    if oinfo["georef"]:
        tr = oinfo["transform"]
        ox, oy = tr * (W / 2.0, H / 2.0)
        origin = {"crs": oinfo["crs"], "x": round(float(ox), 3), "y": round(float(oy), 3), "z": round(z0, 3)}
    n_b = len(buildings)
    metrics = "%.0f×%.0f m · %d 栋 · %dk 高斯 · 本机 DSM 直建（未做 SfM/光度优化）" % (ext_x, ext_y, n_b, round(N / 1000.0))
    meta = {
        "file": args.stem + ".splat",
        "title": args.title or ("本机重建 · %s" % args.stem),
        "metrics": metrics,
        "desc": ("本机回退重建：%s → 地表/屋顶面元（%.2f m 网格，按 DSM 法向定向，正射影像着色）+ 建筑高差处立面面元（颜色由屋顶边缘与贴墙地面估计）。"
                 "建筑由 nDSM>%.1f m 且非植被（ExG>%.2f）提取。未运行 SfM 与 3DGS 光度优化，立面无真实纹理。") % (
                    "正射影像 + DSM" if args.dsm else "正射影像（无 DSM，平坦）", cm, args.min_height, args.veg_exg),
        "preview": preview_name,
        "engine": "twin_studio/recon_local.py",
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": {"image": os.path.abspath(args.image), "dsm": os.path.abspath(args.dsm) if args.dsm else None,
                   "image_size": [W, H], "pixel_m": [round(px, 4), round(py, 4)], "scale_source": scale_src,
                   "dsm_info": dsm_info},
        "params": {"cell_m": round(cm, 4), "surf_budget": args.surf_budget, "wall_budget": args.wall_budget,
                   "wall_step_m": round(step, 3), "wall_min_jump_m": round(min_jump, 2), "dtm_open_m": round(open_m, 1),
                   "min_height_m": args.min_height, "min_area_m2": args.min_area, "veg_exg": args.veg_exg},
        "counts": {"gaussians": int(N), "surface": int(len(s_pos)), "facade": int(len(w_pos)), "buildings": n_b},
        "extent_m": [round(ext_x, 2), round(ext_y, 2)],
        "bbox": {"min": [round(float(v), 3) for v in rec["p"].min(0)], "max": [round(float(v), 3) for v in rec["p"].max(0)]},
        "origin": origin,
        "up": "+z",
        "units": "m",
        "buildings": buildings,
    }
    meta_path = os.path.join(args.out_dir, args.stem + ".meta.json")
    with open(meta_path + ".part", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(meta_path + ".part", meta_path)

    # ---- buildings in the viewer schema (same frame as the splat: offset 0)
    lonlat = {}
    if origin and origin.get("crs"):
        try:
            from rasterio.warp import transform as rio_transform
            xs = [origin["x"] + b["centroid"][0] for b in buildings]
            ys = [origin["y"] + b["centroid"][1] for b in buildings]
            if xs:
                lons, lats = rio_transform(origin["crs"], "EPSG:4326", xs, ys)
                lonlat = {i: (round(float(lats[i]), 7), round(float(lons[i]), 7)) for i in range(len(xs))}
        except Exception as e:
            print("lat/lon transform skipped:", e, flush=True)
    blist = []
    for i, b in enumerate(buildings):
        ring = b["ring"]
        per = sum(math.hypot(ring[(j + 1) % len(ring)][0] - ring[j][0], ring[(j + 1) % len(ring)][1] - ring[j][1])
                  for j in range(len(ring)))
        lat, lon = lonlat.get(i, (None, None))
        blist.append({
            "id": i, "ring": ring + [ring[0]], "base": b["base"], "top": b["top"], "height_m": b["height_m"],
            "floors": max(1, int(round(b["height_m"] / 3.2))), "area_m2": b["area_m2"], "perim_m": round(per, 1),
            "cx": b["centroid"][0], "cy": b["centroid"][1], "lat": lat, "lon": lon,
            "geo_source": "geotiff" if lat is not None else "unknown", "material": "", "color": "",
            "source": "nDSM footprint (recon_local)",
        })
    bdata = {"crs": "scene_local_m", "geo": bool(lonlat), "origin": origin, "count": len(blist),
             "street_msg": "" if lonlat else "未提供地理坐标", "buildings": blist}
    bpath = os.path.join(args.out_dir, args.stem + ".buildings.json")
    with open(bpath + ".part", "w", encoding="utf-8") as f:
        json.dump(bdata, f, ensure_ascii=False)
    os.replace(bpath + ".part", bpath)
    return meta, splat_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Twin Studio local ortho/DSM -> Gaussian splat reconstruction")
    ap.add_argument("--image", required=True)
    ap.add_argument("--dsm", default="")
    ap.add_argument("--width", type=float, default=220.0, help="scene width in metres when the image is not georeferenced")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--preview-dir", default="")
    ap.add_argument("--stem", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--status", default="")
    ap.add_argument("--surf-budget", type=int, default=900000)
    ap.add_argument("--wall-budget", type=int, default=600000)
    ap.add_argument("--wall-step", type=float, default=0.15)
    ap.add_argument("--min-height", type=float, default=2.5)
    ap.add_argument("--min-area", type=float, default=20.0)
    ap.add_argument("--veg-exg", type=float, default=0.08)
    args = ap.parse_args(argv)
    st = Status(args.status)
    try:
        if not os.path.isfile(args.image):
            raise FileNotFoundError("影像不存在：%s" % args.image)
        if args.dsm and not os.path.isfile(args.dsm):
            raise FileNotFoundError("DSM 不存在：%s" % args.dsm)
        if not (5 <= args.width <= 5000):
            raise ValueError("场景宽度应在 5–5000 m 之间。")
        meta, path = reconstruct(args, st)
        st.update(status="done", done=True, stage="done", progress=100,
                  msg="完成：%s（%s）" % (os.path.basename(path), meta["metrics"]),
                  model=meta["file"], stem=args.stem, counts=meta["counts"], url="/splat/" + meta["file"])
        return 0
    except Exception as e:
        st.update(status="error", stage="error", error=str(e) or type(e).__name__, msg=str(e),
                  trace=traceback.format_exc()[-2000:])
        return 1


if __name__ == "__main__":
    sys.exit(main())