"""提示词构造：证据 -> prompt。"""

MATERIALS = ('brick', 'stone', 'paint', 'tile', 'curtain_wall', 'metal', 'wood', 'concrete')
CTX_MAP = {'写字楼': 'office building', '商务': 'office building', '住宅': 'residential building',
           '小区': 'residential building', '商场': 'retail building', '购物': 'retail building',
           '酒店': 'hotel', '学校': 'school', '医院': 'hospital', '工业': 'industrial building'}

TEXTURE_CORE = {
    'brick': 'brick wall, running bond, recessed mortar joints, weathered surface',
    'stone': 'stone slab surface, fine grain speckle, tight joints, honed finish',
    'paint': 'matte painted plaster wall, smooth finish, subtle roller stipple, no pattern',
    'tile': 'ceramic wall tile, square tiles, thin grout lines, slight glaze variation',
    'curtain_wall': 'glass curtain wall panels, anodized aluminum mullions, regular grid, reflective panels',
    'metal': 'brushed aluminum panel, fine linear grain, matte anodized finish',
    'wood': 'vertical wood siding, natural grain, narrow planks, matte oil finish',
    'concrete': 'fair-faced concrete, formwork board marks, subtle stains',
}

TEXTURE_NEGATIVE = (
    'building, house, room, corner, furniture, window, door, landscape, sky, people, cars, '
    'text, watermark, logo, vignette, lighting gradient, overexposed, blurry, low quality, '
    'oversaturated, painting, illustration, 3d render'
)


def build_prompt(address, pois, vision):
    """材质样张 prompt：不含建筑词，固定词序，控制在 CLIP 77 token 内。"""
    kinds = 'urban building'
    for p in pois:
        cat = p.get('category') or ''
        for key, val in CTX_MAP.items():
            if key in cat:
                kinds = val
                break
        if kinds != 'urban building':
            break
    vision = vision or {}
    material = vision.get('material') or 'brick'
    if material not in MATERIALS:
        material = 'brick'
    color = (vision.get('color') or '').strip()
    core = TEXTURE_CORE[material]
    head = f'{color} {core}'.strip() if color and color not in ('unknown', '-') else core
    prompt = (f'seamless repeating texture of {head}, flat material sample, straight-on close-up, '
              'even diffuse light, no building, no windows, no perspective, high detail')
    return prompt, kinds


def build_negative():
    return TEXTURE_NEGATIVE


def clean_prompt(vision, kinds='urban building'):
    """干净街景：基于真实街景重绘，必须保持同一栋建筑。"""
    vision = vision or {}
    material = vision.get('material') or 'unknown'
    color = vision.get('color') or 'unknown'
    if material not in MATERIALS:
        material = 'concrete'
    light = ('keep the original night lighting and exposure'
             if vision.get('lighting') in ('night', 'dusk') else 'natural daylight')
    return ('clean photo of this exact same building, identical massing, same floor count, '
            'same window layout and storefront rhythm, '
            f'same {material} facade in {color} color, keep the real street, sky and camera angle, '
            f'remove trees, cars, people and signs blocking the facade, {light}, '
            '35mm lens, sharp focus, photorealistic')


def revise(prompt, critique, vision, round_idx):
    add = []
    if critique['material'] < 4 and vision.get('material'):
        add.append(f'{vision["material"]} material clearly visible')
    if critique['color'] < 4 and vision.get('color'):
        add.append(f'{vision["color"]} color dominant')
    if critique['structure'] < 4:
        add.append('consistent repeat scale, straight courses, no distorted pattern')
    if critique['quality'] < 4:
        add.append('sharp focus, high detail, no distortion, no blur')
    if critique['tileable'] < 4:
        add.append('seamless repeating texture, uniform edges')
    if critique.get('suggestion'):
        add.append(str(critique['suggestion'])[:60])
    add.append(f'variation {round_idx}')
    return prompt + ', ' + ', '.join(add)


SCENE_MATERIAL = {
    'brick': 'brick facade',
    'stone': 'stone slab facade',
    'paint': 'painted plaster facade',
    'tile': 'ceramic tile facade',
    'curtain_wall': 'glass curtain wall with mullions',
    'metal': 'metal panel facade',
    'wood': 'wood siding facade',
    'concrete': 'fair-faced concrete facade',
}

SCENE_NEGATIVE = (
    'black and white, monochrome, different building, invented architecture, detached house, '
    'row of houses, corner building, corner view, tower, high-rise, whole street, cars, people, signs, text, watermark, logo, '
    'blurry, low quality, distorted perspective, fisheye, overexposed, hdr, painting, '
    'illustration, cartoon, 3d render, cgi, deformed windows'
)

# CLIP 上限 77 token；英文约 1.3 token/词，留余量
SCENE_TOKEN_BUDGET = 72


def _scene_tokens(text):
    return int(len(text.split()) * 1.3)


def scene_prompt(vision, kinds='retail building', address=None, scene=None):
    """文生街景基础 prompt：用视觉证据（楼层/材质/颜色/光照），不引用照片。"""
    v = vision or {}
    storeys = v.get('storeys')
    floors = ''
    try:
        n = int(storeys)
        if 1 <= n <= 12:
            floors = 'single-storey ' if n == 1 else ('two-storey ' if n == 2 else f'{n}-storey ')
    except (TypeError, ValueError):
        pass
    light = 'night' if v.get('lighting') in ('night', 'dusk') else 'daylight'
    mat = SCENE_MATERIAL.get(v.get('material'), SCENE_MATERIAL['concrete'])
    color = (v.get('color') or '').strip()
    if color in ('unknown', '-', 'none'):
        color = ''
    head = ' '.join(x for x in (color, mat) if x)
    building = kinds if kinds and kinds != 'urban building' else 'retail building'
    return (f'color {light} street photo of a {floors}{head} {building}, warm lit storefronts, '
            'leafy trees in front, flat single facade, no corner, 24mm eye-level view from across the street, '
            'full building in frame, road in lower third, photorealistic')


SCENE_VARIANT_TAILS = [
    ('base', ''),
    ('light', 'vivid warm storefront light, blue dusk sky'),
    ('env', 'dense trees cover upper facade, low railing'),
    ('camera', 'slight upward tilt, facade centered'),
]


def _append(prompt, clause):
    if clause and clause.lower() not in prompt.lower():
        if _scene_tokens(prompt + ', ' + clause) <= SCENE_TOKEN_BUDGET:
            return prompt + ', ' + clause
    return prompt


def scene_variants(vision, kinds='retail building'):
    """第一轮并行试探 4 个 prompt 方向，由评判挑出最接近真实街景的一支。"""
    base = scene_prompt(vision, kinds)
    return [(name, _append(base, tail)) for name, tail in SCENE_VARIANT_TAILS]


def scene_mutations(best_prompt, critique, vision, round_idx, scene=None):
    """围绕当前最佳 prompt 做 3 个定向变体，只补最弱的维度。"""
    order = ['fidelity', 'environment', 'composition', 'material', 'realism', 'completeness']
    dims = sorted(SCENE_CLAUSES, key=lambda k: (critique.get(k, 3), order.index(k)))
    out = [('keep', best_prompt)]
    seen = {best_prompt}
    for i, k in enumerate(dims):
        if critique.get(k, 3) >= 4 and i < len(dims) - 1:
            continue
        clause = SCENE_CLAUSES[k][(round_idx + i - 1) % len(SCENE_CLAUSES[k])]
        cand = _append(best_prompt, clause)
        if cand not in seen:
            out.append((k, cand))
            seen.add(cand)
        if len(out) >= 3:
            break
    return out


SCENE_CLAUSES = {
    'fidelity': [
        'same two-storey podium massing, wide storefront bays',
        'same floor count and storefront rhythm, long horizontal facade',
    ],
    'environment': [
        'dense street trees partially cover the facade, wide sidewalk',
        'leafy trees and wet asphalt road in front',
    ],
    'material': [
        'warm light behind the glass, white mullions',
        'glass panels reflecting warm interior light',
    ],
    'realism': [
        'natural night exposure, sharp 35mm photo',
        'realistic dusk colors, vivid warm storefronts',
    ],
    'composition': [
        'facade fills the frame, straight-on view',
        'centered symmetrical facade from across the street',
    ],
    'completeness': [
        'ground floor to roof edge visible',
        'full building height in frame',
    ],
}


def revise_scene(base_prompt, critique, vision, round_idx, scene=None):
    """从基础 prompt 重建：只补最弱的 2 个维度，避免多轮叠加超 token。"""
    sc = scene or {}
    order = ['fidelity', 'environment', 'composition', 'material', 'realism', 'completeness']
    dims = sorted(SCENE_CLAUSES, key=lambda k: (critique.get(k, 3), order.index(k)))
    add = []
    for k in dims:
        if critique.get(k, 3) >= 4:
            continue
        if k == 'fidelity' and sc.get('distinctive'):
            distinct = [d for d in sc['distinctive']
                        if not any(w in d.lower() for w in ('sign', 'logo', 'text', 'brand'))]
            cand = (distinct or SCENE_CLAUSES['fidelity'])[(round_idx - 1) % len(distinct or SCENE_CLAUSES['fidelity'])]
        elif k == 'environment' and sc.get('street') and sc['street'].lower() not in base_prompt.lower():
            cand = sc['street']
        elif k == 'material' and sc.get('facade') and sc['facade'].lower() not in base_prompt.lower():
            cand = sc['facade']
        else:
            cand = SCENE_CLAUSES[k][(round_idx - 1) % len(SCENE_CLAUSES[k])]
        add.append(cand)
        if len(add) >= 2:
            break
    out = base_prompt
    for a in add:
        a = a.strip(' ,.')
        if not a or a.lower() in out.lower():
            continue
        if _scene_tokens(out + ', ' + a) > SCENE_TOKEN_BUDGET:
            break
        out += ', ' + a
    if out == base_prompt:
        extra = 'photorealistic 35mm street photograph'
        if _scene_tokens(out + ', ' + extra) <= SCENE_TOKEN_BUDGET:
            out += ', ' + extra
    return out
