"""评判器：GLM 多次打分取中位数 + 白平衡后 Lab 色差 + 接缝误差。"""
import base64
import io
import statistics

import numpy as np
from PIL import Image

from . import llm

WEIGHTS = {'structure': 0.30, 'material': 0.30, 'color': 0.20, 'quality': 0.10, 'tileable': 0.10}
PASS_SCORE = 4.0
HARD_KEYS = ('structure', 'material')


def _gray_world(arr):
    mean = arr.reshape(-1, 3).mean(axis=0)
    if np.any(mean <= 1e-3):
        return arr
    scale = mean.mean() / mean
    return np.clip(arr * scale, 0, 255)


def _lab_mean(path):
    im = Image.open(path).convert('RGB').resize((64, 64))
    a = _gray_world(np.asarray(im, dtype=np.float32))
    a = a / 255.0
    a = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = (a.reshape(-1, 3) @ m.T) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.array([116 * f[:, 1].mean() - 16,
                     500 * (f[:, 0].mean() - f[:, 1].mean()),
                     200 * (f[:, 1].mean() - f[:, 2].mean())])


def delta_e(path_a, path_b):
    try:
        return round(float(np.linalg.norm(_lab_mean(path_a) - _lab_mean(path_b))), 1)
    except Exception:
        return None


def seam_error(path):
    """粗略无缝度：左右/上下边缘的灰度差，越小越接近可平铺。"""
    try:
        g = np.asarray(Image.open(path).convert('L'), dtype=np.float32)
        col = np.abs(g[:, 0] - g[:, -1]).mean()
        row = np.abs(g[0, :] - g[-1, :]).mean()
        return round(float((col + row) / 2), 1)
    except Exception:
        return None


def tileable_score(se):
    if se is None:
        return None
    if se <= 8:
        return 5.0
    if se <= 15:
        return 4.0
    if se <= 25:
        return 3.0
    return 2.0


def side_by_side(cand, ref, size=512):
    a = Image.open(cand).convert('RGB').resize((size, size))
    b = Image.open(ref).convert('RGB').resize((size, size))
    canvas = Image.new('RGB', (size * 2 + 12, size), (25, 25, 25))
    canvas.paste(a, (0, 0))
    canvas.paste(b, (size + 12, 0))
    buf = io.BytesIO()
    canvas.save(buf, format='JPEG', quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def _prompt_for(evidence, ref_path, de):
    vision = evidence.get('vision') or {}
    return ('You are a strict facade-texture reviewer. '
            + ('LEFT image is the GENERATED texture; RIGHT image is the REAL streetview reference.\n'
               if ref_path else '')
            + f'Evidence: material={vision.get("material")}, color={vision.get("color")}, '
              f'lighting={vision.get("lighting")}, storeys={vision.get("storeys")}, '
              f'address={(evidence.get("address") or {}).get("value")}\n'
            + (f'Mean color difference after white balance (deltaE): {de}\n' if de is not None else '')
            + 'Ignore lighting and exposure differences when judging color; compare material color. '
              'Return STRICT JSON only:\n'
              '{"structure":1-5,"material":1-5,"color":1-5,"quality":1-5,"tileable":1-5,'
              '"hard_fail":true/false,"issues":["..."],"suggestion":"..."}\n'
              'structure = window/floor/edge layout compared with the reference; '
              'material = matches reference material; color = matches reference color; '
              'quality = sharp, no distortion/artifacts; tileable = seamless texture potential. '
              'hard_fail = true if text/watermark/people/severe distortion present.')


def _one(config, image_b64, prompt):
    try:
        return llm.chat_json(config, image_b64, prompt, 350)
    except Exception:
        return None


def _median(values):
    return float(statistics.median(values)) if values else 3.0


def critique(config, image_path, evidence, ref_path=None, votes=3):
    de = delta_e(image_path, ref_path) if ref_path else None
    prompt = _prompt_for(evidence, ref_path, de)
    image_b64 = side_by_side(image_path, ref_path) if ref_path else llm._jpeg_b64(image_path)

    votes = max(1, int(votes or 1))
    raw = [r for r in (_one(config, image_b64, prompt) for _ in range(votes)) if r]

    if not raw:
        merged = {k: 3.0 for k in WEIGHTS}
        merged.update({'hard_fail': False, 'issues': ['critique unavailable'], 'suggestion': ''})
    else:
        merged = {}
        for k in WEIGHTS:
            vals = []
            for r in raw:
                try:
                    vals.append(float(r.get(k, 3)))
                except Exception:
                    vals.append(3.0)
            merged[k] = _median(vals)
        merged['hard_fail'] = sum(1 for r in raw if r.get('hard_fail')) > len(raw) / 2
        svals = []
        for r in raw:
            try:
                svals.append(int(float(r.get('storeys'))))
            except (TypeError, ValueError):
                pass
        merged['storeys'] = int(round(sorted(svals)[len(svals) // 2])) if svals else None
        issues, seen = [], set()
        for r in raw:
            for it in (r.get('issues') or []):
                if it not in seen:
                    seen.add(it)
                    issues.append(it)
        merged['issues'] = issues
        merged['suggestion'] = next((r.get('suggestion') for r in raw if r.get('suggestion')), '')

    se = seam_error(image_path)
    ts = tileable_score(se)
    merged['seam_error'] = se
    if ts is not None:
        merged['tileable'] = ts
        if ts < 4:
            merged['issues'] = list(merged.get('issues') or []) + [f'seam error {se}']

    if de is not None and de > 25 and merged['color'] > 3:
        merged['color'] = 3.0
        merged['issues'] = list(merged.get('issues') or []) + [f'color deltaE {de}']
    merged['delta_e'] = de
    merged['votes'] = len(raw)
    per_scores = [round(sum(float(r.get(k, 3)) * w for k, w in WEIGHTS.items()), 2) for r in raw] or [0.0]
    merged['score_per_vote'] = per_scores
    merged['score_std'] = round(float(np.std(per_scores)), 2) if len(per_scores) > 1 else 0.0
    merged['score'] = round(sum(merged[k] * w for k, w in WEIGHTS.items()), 2)
    merged['pass'] = (not merged['hard_fail']) and merged['score'] >= PASS_SCORE and all(
        merged[k] >= 4 for k in HARD_KEYS)
    return merged


STREET_WEIGHTS = {'realism': 0.20, 'completeness': 0.15, 'cleanliness': 0.15,
                  'focus': 0.10, 'material': 0.10, 'fidelity': 0.30}


def structural_similarity(path_a, path_b, size=160):
    """同一构图的灰度 SSIM（全局窗口），作为“是否还是同一栋楼”的客观旁证。"""
    try:
        a = np.asarray(Image.open(path_a).convert('L').resize((size, size)), dtype=np.float64)
        b = np.asarray(Image.open(path_b).convert('L').resize((size, size)), dtype=np.float64)
        c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
        mu_a, mu_b = a.mean(), b.mean()
        va, vb = a.var(), b.var()
        cov = ((a - mu_a) * (b - mu_b)).mean()
        return round(float(((2 * mu_a * mu_b + c1) * (2 * cov + c2)) /
                           ((mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2))), 3)
    except Exception:
        return None


def streetview_critique(config, image_path, evidence, ref_path=None, votes=1):
    """评判干净街景：是否真实、整栋完整、无杂物、主体唯一、材质一致、与原建筑同一栋。"""
    vision = evidence.get('vision') or {}
    ss = structural_similarity(image_path, ref_path) if ref_path else None
    prompt = ('You are a strict reviewer of a generated street-level photograph. '
              'Judge whether it looks like a real photo of ONE target building.\n'
              + ('LEFT image is the GENERATED clean view; RIGHT image is the REAL streetview of the same target.\n'
                 if ref_path else '')
              + f'Evidence: material={vision.get("material")}, color={vision.get("color")}, '
                f'address={(evidence.get("address") or {}).get("value")}\n'
              + (f'Objective structural similarity (SSIM 0-1, higher = same composition): {ss}\n' if ss is not None else '')
              + 'Return STRICT JSON only:\n'
              '{"realism":1-5,"completeness":1-5,"cleanliness":1-5,"focus":1-5,"material":1-5,'
              '"fidelity":1-5,"hard_fail":true/false,"issues":["..."],"suggestion":"..."}\n'
              'realism = looks like a real photograph, not a render; '
              'completeness = one whole building visible from ground to roof; '
              'cleanliness = no trees/cars/people/signs blocking the facade; '
              'focus = a single target building is centered, not a whole street; '
              'material = facade material matches the evidence; '
              'fidelity = the SAME building as the reference: massing, floor count, window layout, storefront rhythm '
              '(4-5 only if clearly the same building; 1-2 if a different or invented building). '
              'hard_fail = true if distorted geometry, duplicated buildings or text artifacts.')
    image_b64 = side_by_side(image_path, ref_path) if ref_path else llm._jpeg_b64(image_path)
    raw = []
    for _ in range(max(1, votes)):
        try:
            raw.append(llm.chat_json(config, image_b64, prompt, 350))
        except Exception:
            pass
    if not raw:
        merged = {k: 3.0 for k in STREET_WEIGHTS}
        merged.update({'hard_fail': False, 'issues': ['streetview critique unavailable'], 'suggestion': ''})
    else:
        merged = {}
        for k in STREET_WEIGHTS:
            vals = []
            for r in raw:
                try:
                    vals.append(float(r.get(k, 3)))
                except Exception:
                    vals.append(3.0)
            merged[k] = _median(vals)
        merged['hard_fail'] = sum(1 for r in raw if r.get('hard_fail')) > len(raw) / 2
        svals = []
        for r in raw:
            try:
                svals.append(int(float(r.get('storeys'))))
            except (TypeError, ValueError):
                pass
        merged['storeys'] = int(round(sorted(svals)[len(svals) // 2])) if svals else None
        issues, seen = [], set()
        for r in raw:
            for it in (r.get('issues') or []):
                if it not in seen:
                    seen.add(it)
                    issues.append(it)
        merged['issues'] = issues
        merged['suggestion'] = next((r.get('suggestion') for r in raw if r.get('suggestion')), '')
    text = ' '.join(str(i).lower() for i in merged.get('issues') or [])
    if any(w in text for w in ('tree', 'vegetation', 'car', 'people', 'sign', 'obscur')):
        merged['cleanliness'] = min(merged['cleanliness'], 3.0)
    if any(w in text for w in ('multiple building', 'several building', 'whole street', 'row of buildings', 'many buildings')):
        merged['hard_fail'] = True
    if any(w in text for w in ('different building', 'not the same', 'invented', 'another building')):
        merged['fidelity'] = min(merged['fidelity'], 2.0)
    if ss is not None and ss < 0.30:
        merged['fidelity'] = min(merged['fidelity'], 3.0)
    merged['ssim'] = ss
    merged['votes'] = len(raw)
    merged['score'] = round(sum(merged[k] * w for k, w in STREET_WEIGHTS.items()), 2)
    need = ('realism', 'completeness', 'focus', 'cleanliness')
    if ref_path:
        need += ('fidelity',)
    merged['pass'] = (not merged['hard_fail']) and merged['score'] >= 4.0 and all(
        merged[k] >= 4 for k in need)
    return merged



SCENE_WEIGHTS = {'fidelity': 0.30, 'material': 0.20, 'environment': 0.15,
                 'realism': 0.15, 'composition': 0.10, 'completeness': 0.10}


def scene_match_critique(config, image_path, evidence, ref_path=None, votes=1):
    """文生街景评判：与真实街景的语义接近度，而不是像素复刻。"""
    vision = evidence.get('vision') or {}
    ss = structural_similarity(image_path, ref_path) if ref_path else None
    prompt = ('You compare a GENERATED street-level photo (LEFT) with the REAL street view of the target (RIGHT). '
              'The goal is a photorealistic reconstruction that is clearly the same kind of building and street, '
              'not a pixel copy.\n'
              + f'Evidence: material={vision.get("material")}, color={vision.get("color")}, '
                f'storeys={vision.get("storeys")}, lighting={vision.get("lighting")}, '
                f'address={(evidence.get("address") or {}).get("value")}\n'
              + (f'Objective structural similarity (SSIM 0-1, composition hint only): {ss}\n' if ss is not None else '')
              + 'Return STRICT JSON only:\n'
              '{"fidelity":1-5,"material":1-5,"environment":1-5,"realism":1-5,'
              '"composition":1-5,"completeness":1-5,"hard_fail":true/false,'
              '"issues":["..."],"suggestion":"..."}\n'
              'fidelity = same building TYPE and layout: floor count, podium massing, storefront rhythm, facade character. '
              '4-5 if clearly the same kind of retail podium and a person could plausibly place it on the same street; '
              '1-2 if generic or a different building type. This is semantic fidelity, not a pixel copy. '
              'material = facade material and color match the evidence. '
              'environment = street context clearly present and similar: sidewalk trees, road/curb, night lighting, city surroundings. '
              'realism = looks like a real photograph, not a render. '
              'composition = similar viewpoint: flat facade, centered, seen from across the street at eye level. '
              'completeness = whole building visible from ground to roof. '
              'storeys = count the visible floors of the generated building (integer). '
              'hard_fail = true if distorted geometry, duplicated buildings, or text artifacts.')
    image_b64 = side_by_side(image_path, ref_path) if ref_path else llm._jpeg_b64(image_path)
    raw = []
    for _ in range(max(1, votes)):
        try:
            raw.append(llm.chat_json(config, image_b64, prompt, 400))
        except Exception:
            pass
    if not raw:
        merged = {k: 3.0 for k in SCENE_WEIGHTS}
        merged.update({'hard_fail': False, 'issues': ['scene critique unavailable'], 'suggestion': ''})
    else:
        merged = {}
        for k in SCENE_WEIGHTS:
            vals = []
            for r in raw:
                try:
                    vals.append(float(r.get(k, 3)))
                except Exception:
                    vals.append(3.0)
            merged[k] = _median(vals)
        merged['hard_fail'] = sum(1 for r in raw if r.get('hard_fail')) > len(raw) / 2
        svals = []
        for r in raw:
            try:
                svals.append(int(float(r.get('storeys'))))
            except (TypeError, ValueError):
                pass
        merged['storeys'] = int(round(sorted(svals)[len(svals) // 2])) if svals else None
        issues, seen = [], set()
        for r in raw:
            for it in (r.get('issues') or []):
                if it not in seen:
                    seen.add(it)
                    issues.append(it)
        merged['issues'] = issues
        merged['suggestion'] = next((r.get('suggestion') for r in raw if r.get('suggestion')), '')
    text = ' '.join(str(i).lower() for i in merged.get('issues') or [])
    ref_storeys = vision.get('storeys')
    try:
        ref_storeys = int(ref_storeys)
    except (TypeError, ValueError):
        ref_storeys = None
    if ref_storeys and merged.get('storeys') and abs(merged['storeys'] - ref_storeys) >= 1:
        merged['fidelity'] = min(merged['fidelity'], 3.0)
        merged['issues'] = list(merged.get('issues') or []) + [
            f'floor count mismatch: generated {merged["storeys"]} vs reference {ref_storeys}']
    if any(w in text for w in ('different building', 'invented', 'another building', 'generic')):
        merged['fidelity'] = min(merged['fidelity'], 2.0)
    if any(w in text for w in ('multiple building', 'duplicated', 'several building', 'row of buildings')):
        merged['hard_fail'] = True
    merged['ssim'] = ss
    merged['votes'] = len(raw)
    merged['score'] = round(sum(merged[k] * w for k, w in SCENE_WEIGHTS.items()), 2)
    merged['pass'] = ((not merged['hard_fail']) and merged['score'] >= 4.0
                      and merged['fidelity'] >= 4 and merged['material'] >= 4)
    return merged
