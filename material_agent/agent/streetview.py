"""Mapillary 街景检索与下载。"""
import math

import requests

GRAPH = 'https://graph.mapillary.com/images'
FIELDS = 'id,captured_at,compass_angle,is_pano,quality_score,sequence,thumb_2048_url,geometry'


class StreetviewError(RuntimeError):
    pass


class Mapillary:
    def __init__(self, config):
        self.token = config.get('mapillary_token')
        self.proxy = config.get('mapillary_proxy')
        self.proxies = {'http': self.proxy, 'https': self.proxy} if self.proxy else None

    def images(self, lat, lon, radius_deg=0.0008, limit=20, max_dist_m=80, min_quality=0.0):
        if not self.token:
            raise StreetviewError('mapillary_token 未配置')
        bbox = f'{lon - radius_deg},{lat - radius_deg},{lon + radius_deg},{lat + radius_deg}'
        try:
            r = requests.get(GRAPH, params={'access_token': self.token, 'bbox': bbox,
                                            'fields': FIELDS, 'limit': limit},
                             proxies=self.proxies, timeout=25)
            d = r.json()
        except Exception as e:
            raise StreetviewError(f'mapillary 请求失败: {e}')
        if 'data' not in d:
            raise StreetviewError(f'mapillary 错误: {d}')
        out = []
        for it in d['data']:
            g = (it.get('geometry') or {}).get('coordinates') or [None, None]
            if g[0] is None:
                continue
            dist = math.hypot((g[0] - lon) * 111320 * math.cos(math.radians(lat)), (g[1] - lat) * 110540)
            if dist > max_dist_m or (it.get('quality_score') or 0) < min_quality:
                continue
            it['distance_m'] = round(dist, 1)
            out.append(it)
        out.sort(key=lambda x: (-(x.get('quality_score') or 0), x.get('distance_m', 99)))
        return out

    def download(self, url, path):
        r = requests.get(url, proxies=self.proxies, timeout=60)
        r.raise_for_status()
        with open(path, 'wb') as f:
            f.write(r.content)
        return path
