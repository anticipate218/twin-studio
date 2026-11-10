"""智谱 GLM 视觉接口封装。"""
import base64
import io
import json
import re

import requests
from PIL import Image

URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'


class LLMError(RuntimeError):
    pass


def _jpeg_b64(path, max_side=1024, quality=90):
    im = Image.open(path).convert('RGB')
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, format='JPEG', quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def chat(config, image_b64, prompt, max_tokens=350, temperature=0.1):
    key = config.get('glm_key')
    if not key:
        raise LLMError('glm_key 未配置')
    body = {
        'model': config.get('glm_model', 'glm-4v-flash'),
        'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + image_b64}},
            {'type': 'text', 'text': prompt},
        ]}],
        'temperature': temperature,
        'max_tokens': max_tokens,
    }
    r = requests.post(URL, headers={'Authorization': 'Bearer ' + key}, json=body, timeout=60)
    data = r.json()
    if 'choices' not in data:
        raise LLMError(str(data)[:200])
    return data['choices'][0]['message']['content']


def chat_json(config, image_b64, prompt, max_tokens=350):
    text = chat(config, image_b64, prompt, max_tokens)
    m = re.search(r'\{.*\}', text, re.S)
    if not m:
        raise LLMError('返回中没有 JSON: ' + text[:120])
    return json.loads(m.group(0))


def describe(config, image_path):
    prompt = ('You are an architecture facade analyst. Look at this street-level photo and '
              'return STRICT JSON only: {"facade_visible": true/false, "material": "...", '
              '"color": "...", "storeys": number|null, "style": "...", "lighting": "day|dusk|night", '
              '"confidence": 0..1}. '
              'Material must be one of: brick, stone, paint, tile, curtain_wall, metal, wood, concrete.')
    try:
        return chat_json(config, _jpeg_b64(image_path), prompt, 200)
    except Exception:
        return None


def bbox(config, image_path):
    prompt = ('Return STRICT JSON only: {"bbox":[x0,y0,x1,y1]} with coordinates normalized to 0..1, '
              'covering the largest building facade. Exclude trees, vehicles, sky and road.')
    try:
        obj = chat_json(config, _jpeg_b64(image_path), prompt, 120)
        bb = obj.get('bbox')
        if not bb or len(bb) != 4:
            return None
        x0, y0, x1, y1 = [float(v) for v in bb]
        if x1 <= x0 or y1 <= y0:
            return None
        return [max(0.0, x0), max(0.0, y0), min(1.0, x1), min(1.0, y1)]
    except Exception:
        return None


def scene_describe(config, image_path):
    """把真实街景描述成可写进文生图 prompt 的短属性（不含品牌/文字）。"""
    prompt = ('Describe this street-level photo for a text-to-image model. '
              'Return STRICT JSON only: {"building_type":"...","massing":"...","facade":"...",'
              '"storefront":"...","street":"...","camera":"...","lighting":"day|dusk|night",'
              '"distinctive":["...","..."]}. '
              'Each field must be a SHORT phrase (4-10 words), no brand names, no text/logos. '
              'building_type: e.g. luxury retail podium, office tower, residential block. '
              'massing: overall shape and floor count. facade: material, color, mullions, bands. '
              'storefront: ground-floor glazing and lighting. street: trees, road, railing, sidewalk. '
              'camera: viewpoint and lens. distinctive: 2-3 visually recognizable features.')
    try:
        return chat_json(config, _jpeg_b64(image_path), prompt, 350)
    except Exception:
        return None
