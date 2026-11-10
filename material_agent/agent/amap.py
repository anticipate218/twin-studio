"""高德地图：逆地理与周边 POI（GCJ02）。"""
import requests

BASE = 'https://restapi.amap.com/v3'


class AmapError(RuntimeError):
    pass


class Amap:
    def __init__(self, config):
        self.key = config.get('amap_key')
        self.session = requests.Session()

    def _get(self, path, **params):
        if not self.key:
            raise AmapError('amap_key 未配置')
        params['key'] = self.key
        r = self.session.get(f'{BASE}/{path}', params=params, timeout=15)
        d = r.json()
        if str(d.get('status')) != '1':
            raise AmapError(f'amap {path}: {d.get("infocode")} {d.get("info")}')
        return d

    def reverse(self, lat, lon):
        d = self._get('geocode/regeo', location=f'{lon},{lat}')
        rc = d['regeocode']
        ac = rc.get('addressComponent', {})
        return {'address': rc.get('formatted_address'), 'district': ac.get('district'),
                'street': (ac.get('streetNumber') or {}).get('street')}

    def nearby_pois(self, lat, lon, radius=150, limit=10):
        d = self._get('place/around', location=f'{lon},{lat}', radius=radius, offset=20, page=1)
        out = []
        for it in d.get('pois', []):
            loc = it.get('location') or ''
            out.append({'id': it.get('id'), 'title': it.get('name'), 'address': it.get('address'),
                        'category': it.get('type'), 'location': loc,
                        'distance_m': int(it['distance']) if str(it.get('distance', '')).isdigit() else None})
        out.sort(key=lambda x: x.get('distance_m') or 1e9)
        return out[:limit]
