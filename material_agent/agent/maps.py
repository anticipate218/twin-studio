"""腾讯位置服务：逆地理与周边 POI。"""
import requests

BASE = 'https://apis.map.qq.com/ws'


class MapError(RuntimeError):
    pass


class TencentMap:
    def __init__(self, config):
        self.key = config.get('tencent_key')
        self.session = requests.Session()

    def _get(self, path, **params):
        if not self.key:
            raise MapError('tencent_key 未配置')
        params['key'] = self.key
        r = self.session.get(f'{BASE}/{path}', params=params, timeout=15)
        d = r.json()
        if d.get('status') != 0:
            raise MapError(f'tencent {path}: {d.get("status")} {d.get("message")}')
        return d

    def reverse(self, lat, lon):
        return self._get('geocoder/v1/', location=f'{lat},{lon}')['result']

    def nearby_pois(self, lat, lon, radius=150, keywords=('大厦', '小区', '写字楼', '商场'), page_size=10, limit=10):
        seen, out, errors = set(), [], []
        for kw in keywords:
            try:
                d = self._get('place/v1/search', keyword=kw,
                              boundary=f'nearby({lat},{lon},{radius})', page_size=page_size)
            except MapError as e:
                errors.append(e)
                continue
            for it in d.get('data', []):
                if it['id'] in seen:
                    continue
                seen.add(it['id'])
                out.append({'id': it['id'], 'title': it.get('title'), 'address': it.get('address'),
                            'category': it.get('category'), 'location': it.get('location'),
                            'distance_m': it.get('_distance')})
        if not out and errors:
            raise errors[-1]
        out.sort(key=lambda x: x.get('distance_m') or 1e9)
        return out[:limit]
