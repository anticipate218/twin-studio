"""基于已生成的材质，渲染干净的建筑街景（去掉树/车/人/招牌）。"""
import json
import os
import subprocess
import sys

from PIL import Image

from .config import BASE_DIR


def _fit_cover(img, width, height):
    from PIL import Image as _Image
    w, h = img.size
    s = max(width / float(w), height / float(h))
    nw, nh = int(round(w * s)), int(round(h * s))
    img = img.resize((nw, nh), _Image.LANCZOS)
    x, y = (nw - width) // 2, (nh - height) // 2
    return img.crop((x, y, x + width, y + height))


def _canny_from(img, path):
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
    lo = max(30, int(np.median(gray) * 0.6))
    hi = min(220, max(lo + 40, int(lo * 2.2)))
    edge = cv2.Canny(gray, lo, hi)
    Image.fromarray(edge).convert('RGB').save(path)
    return path


CLEAN_NEGATIVE = ('different building, invented architecture, new facade, changed floor count, '
                  'changed window layout, detached house, row of houses, trees, vegetation, cars, '
                  'people, signs, text, watermark, logo, blurry, low quality, distorted perspective, '
                  'overexposure, blown highlights, hdr, painting, illustration, cartoon, 3d render, cgi, deformed windows')


def render_clean_photo(config, photo, prompt, outdir, size=768, height=512, n=2, steps=32,
                       seed=4321, strength=0.55, cn_scale=0.65, ipa_scale=0.55):
    """以真实街景为底图做低幅度重绘，保留建筑体量与构图，只去掉遮挡物。"""
    os.makedirs(outdir, exist_ok=True)
    src = Image.open(photo).convert('RGB')
    base = _fit_cover(src, size, height)
    init_path = os.path.join(outdir, 'init.png')
    base.save(init_path)
    guide = _canny_from(base, os.path.join(outdir, 'guide.png'))
    cmd = [sys.executable, '-m', 'agent.generate', '--ref', photo, '--init', init_path,
           '--canny', guide, '--prompt', prompt, '--negative', CLEAN_NEGATIVE,
           '--size', str(size), '--height', str(height), '--strength', str(strength),
           '--cn-scale', str(cn_scale), '--ipa-scale', str(ipa_scale), '--steps', str(steps),
           '--scale', '6.0', '--n', str(n), '--seed', str(seed), '--outdir', outdir]
    subprocess.run(cmd, check=True, cwd=BASE_DIR)
    metas = []
    for root, _, files in os.walk(outdir):
        if 'meta.json' in files:
            with open(os.path.join(root, 'meta.json'), encoding='utf-8') as f:
                metas.append(json.load(f))
    if not metas:
        return []
    return metas[-1]['candidates']


def render_clean(config, material, structure, prompt, outdir, size=768, height=512, n=2, steps=30, seed=4321, use_structure=False, floors=3, bays=5):
    """material: 材质图；structure: 校正立面（可为 None）。返回候选列表。"""
    os.makedirs(outdir, exist_ok=True)
    # 自动挑一块边缘最少的材质区域，减少门窗/树等结构干扰
    try:
        import numpy as np
        import cv2
        arr = np.array(Image.open(material).convert('RGB'))
        h, w = arr.shape[:2]
        best = (1e9, None)
        frac = 0.4
        for fy in (0.05, 0.2, 0.35, 0.5):
            for fx in (0.05, 0.2, 0.35, 0.5):
                x0, y0 = int(fx*w), int(fy*h)
                x1, y1 = int((fx+frac)*w), int((fy+frac)*h)
                crop = arr[y0:y1, x0:x1]
                if crop.size == 0:
                    continue
                edges = cv2.Canny(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), 60, 160).mean()
                if edges < best[0]:
                    best = (edges, crop)
        if best[1] is not None:
            Image.fromarray(best[1]).save(os.path.join(outdir, 'material_crop.png'))
            material = os.path.join(outdir, 'material_crop.png')
    except Exception:
        pass
    cmd = [sys.executable, '-m', 'agent.generate', '--ref', material, '--prompt', prompt,
           '--n', str(n), '--steps', str(steps), '--seed', str(seed),
           '--outdir', outdir]
    if use_structure:
        guide = make_guide(os.path.join(outdir, 'guide.png'), width=size, height=height, floors=max(1, int(floors)), bays=bays)
        cmd += ['--size', str(size), '--height', str(height), '--cn-scale', '0.65', '--ipa-scale', '0.2', '--steps', str(max(steps, 30)), '--canny', guide]
    else:
        cmd += ['--size', str(size), '--height', str(height), '--ipa-scale', '0.2', '--steps', str(max(steps, 30)), '--no-canny']
    subprocess.run(cmd, check=True, cwd=BASE_DIR)

    metas = []
    for root, _, files in os.walk(outdir):
        if 'meta.json' in files:
            with open(os.path.join(root, 'meta.json'), encoding='utf-8') as f:
                metas.append(json.load(f))
    if not metas:
        return []
    return metas[-1]['candidates']


def make_guide(path, width=512, height=768, floors=3, bays=5):
    """生成整栋建筑的正立面线稿，用作 ControlNet Canny 的结构约束。"""
    from PIL import ImageDraw
    img = Image.new('RGB', (width, height), (255, 255, 255))
    d = ImageDraw.Draw(img)
    left, right = int(width * 0.12), int(width * 0.88)
    top, bottom = int(height * 0.16), int(height * 0.92)
    lw = max(2, width // 160)
    d.rectangle([left, top, right, bottom], outline=(0, 0, 0), width=lw)
    for i in range(1, floors + 1):
        y = top + (bottom - top) * i / floors
        d.line([left, y, right, y], fill=(0, 0, 0), width=lw)
    for j in range(1, bays):
        x = left + (right - left) * j / bays
        d.line([x, top, x, bottom], fill=(0, 0, 0), width=lw)
    door_w = int((right - left) / bays * 0.6)
    d.rectangle([(left + right) // 2 - door_w // 2, bottom - (bottom - top) // floors,
                 (left + right) // 2 + door_w // 2, bottom], outline=(0, 0, 0), width=lw)
    img.save(path)
    return path


def extract_material_patch(src, outdir, frac=0.4):
    """从立面图里挑边缘最少的区域作为材质参考。"""
    import numpy as np
    import cv2
    arr = np.array(Image.open(src).convert('RGB'))
    h, w = arr.shape[:2]
    best = (1e9, None)
    for fy in (0.05, 0.2, 0.35, 0.5):
        for fx in (0.05, 0.2, 0.35, 0.5):
            x0, y0 = int(fx*w), int(fy*h)
            x1, y1 = int((fx+frac)*w), int((fy+frac)*h)
            crop = arr[y0:y1, x0:x1]
            if crop.size == 0:
                continue
            edges = cv2.Canny(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), 60, 160).mean()
            if edges < best[0]:
                best = (edges, crop)
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, 'material_patch.png')
    if best[1] is None:
        Image.open(src).convert('RGB').save(out)
    else:
        Image.fromarray(best[1]).save(out)
    return out


def render_scene_text(config, prompt, outdir, ref=None, size=768, height=512, n=4, steps=30,
                      seed=4321, scale=7.0):
    """纯文生图生成街景：不使用 init/canny/IP-Adapter，参考图仅作占位。"""
    from .prompt import SCENE_NEGATIVE
    os.makedirs(outdir, exist_ok=True)
    ref = ref or config.get('fallback_ref')
    if not ref:
        raise RuntimeError('文生街景需要一张占位参考图路径')
    cmd = [sys.executable, '-m', 'agent.generate', '--ref', ref, '--prompt', prompt,
           '--negative', SCENE_NEGATIVE, '--size', str(size), '--height', str(height),
           '--steps', str(steps), '--scale', str(scale), '--n', str(n), '--seed', str(seed),
           '--no-ipa', '--no-canny', '--outdir', outdir]
    subprocess.run(cmd, check=True, cwd=BASE_DIR)
    metas = []
    for root, _, files in os.walk(outdir):
        if 'meta.json' in files:
            with open(os.path.join(root, 'meta.json'), encoding='utf-8') as f:
                metas.append(json.load(f))
    if not metas:
        return []
    return metas[-1]['candidates']
