"""Agent 运行时记忆：按建筑聚合历史结果，供后续复用与统计。"""
import datetime
import json
import os

from .coords import haversine_m

FAIL_TAGS = {
    'no_streetview': ('no streetview', 'streetview', '街景', 'mapillary'),
    'occlusion': ('tree', 'occlu', '遮挡', 'pole', 'vehicle', 'car'),
    'color': ('color', '色差', 'tint'),
    'material': ('material', '材质'),
    'structure': ('structure', 'window', 'edge', 'floor', '结构'),
    'quality': ('blur', 'distort', 'artifact', 'quality', '模糊', '畸变'),
    'tileable': ('tile', 'seam', '平铺', '接缝'),
    'hard_fail': ('watermark', 'text', 'people', '人脸', '水印'),
}


def _now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def make_key(lat, lon, decimals=4):
    return f'{lat:.{decimals}f}_{lon:.{decimals}f}'


def classify_issues(issues):
    tags = set()
    for text in issues or []:
        low = str(text).lower()
        for tag, words in FAIL_TAGS.items():
            if any(w in low for w in words):
                tags.add(tag)
    return sorted(tags)


class Memory:
    def __init__(self, root):
        self.root = root
        self.buildings_dir = os.path.join(root, 'buildings')
        self.index_path = os.path.join(root, 'index.json')
        self.failures_path = os.path.join(root, 'failures.json')
        os.makedirs(self.buildings_dir, exist_ok=True)
        self.index = self._load_json(self.index_path, {'buildings': []})
        self.failures = self._load_json(self.failures_path, {'counts': {}, 'recent': []})

    # ---------- storage ----------
    @staticmethod
    def _load_json(path, default):
        if os.path.exists(path):
            try:
                with open(path, encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return default

    @staticmethod
    def _save_json(path, obj):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _entry_path(self, key):
        return os.path.join(self.buildings_dir, key[:2] if len(key) > 2 else '00', key + '.json')

    def get(self, key):
        p = self._entry_path(key)
        if not os.path.exists(p):
            return None
        with open(p, encoding='utf-8') as f:
            return json.load(f)

    # ---------- query ----------
    def find_near(self, lat, lon, radius_m=50):
        hits = []
        for b in self.index.get('buildings', []):
            d = haversine_m(lat, lon, b['lat'], b['lon'])
            if d <= radius_m:
                hits.append((d, b))
        hits.sort(key=lambda x: x[0])
        return [dict(b, distance_m=round(d, 1)) for d, b in hits]

    def stats(self):
        bs = self.index.get('buildings', [])
        scores = [b.get('best_score') for b in bs if b.get('best_score') is not None]
        passed = [s for s in scores if s >= 4.0]
        return {
            'buildings': len(bs),
            'attempts': sum(b.get('attempts', 0) for b in bs),
            'avg_best_score': round(sum(scores) / len(scores), 2) if scores else None,
            'pass_rate': round(len(passed) / len(scores), 3) if scores else None,
            'failure_counts': self.failures.get('counts', {}),
            'top': sorted(bs, key=lambda b: b.get('best_score') or 0, reverse=True)[:5],
        }

    # ---------- write ----------
    def _bump_failures(self, tags, run_id):
        counts = self.failures.setdefault('counts', {})
        for t in tags:
            counts[t] = counts.get(t, 0) + 1
        recent = self.failures.setdefault('recent', [])
        recent.append({'run_id': run_id, 'tags': tags, 'ts': _now()})
        self.failures['recent'] = recent[-50:]
        self._save_json(self.failures_path, self.failures)

    def record_run(self, report, evidence, prompt, rounds):
        coord = evidence['coordinate']
        lat, lon = coord['wgs84']
        key = make_key(lat, lon)
        now = _now()
        entry = self.get(key) or {
            'key': key, 'lat': lat, 'lon': lon, 'created_at': now,
            'attempts': 0, 'history': [],
        }
        best = report.get('best') or {}
        crit = best.get('critique') or {}
        issues = crit.get('issues') or []
        tags = classify_issues(issues)

        entry['attempts'] += 1
        entry['updated_at'] = now
        entry['address'] = (evidence.get('address') or {}).get('value')
        vision = evidence.get('vision') or {}
        entry['material'] = vision.get('material')
        entry['color'] = vision.get('color')
        entry['last_prompt'] = prompt
        entry['failure_tags'] = sorted(set(entry.get('failure_tags') or []) | set(tags))
        entry['history'].append({
            'run_id': report['run_id'], 'ts': now,
            'score': best.get('score'), 'pass': crit.get('pass'),
            'rounds': report.get('rounds_used'),
            'issues': issues, 'tags': tags,
            'material': vision.get('material'), 'color': vision.get('color'),
            'seed': best.get('seed'), 'prompt': best.get('prompt'),
            'final_image': report.get('final_image'),
        })
        entry['history'] = entry['history'][-20:]

        if best.get('prompt') and not entry.get('best_prompt'):
            entry['best_prompt'] = best.get('prompt')
            entry['best_seed'] = best.get('seed')
        if best.get('score') is not None and (entry.get('best_score') is None or best['score'] > entry['best_score']):
            entry['best_score'] = best['score']
            entry['best_run'] = report['run_id']
            entry['best_image'] = report.get('final_image')
            entry['best_prompt'] = best.get('prompt') or prompt
            entry['best_seed'] = best.get('seed')

        p = self._entry_path(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(entry, f, ensure_ascii=False, indent=2)

        row = next((b for b in self.index['buildings'] if b['key'] == key), None)
        summary = {'key': key, 'lat': lat, 'lon': lon, 'address': entry.get('address'),
                   'attempts': entry['attempts'], 'best_score': entry.get('best_score'),
                   'updated_at': now, 'best_run': entry.get('best_run')}
        if row:
            row.update(summary)
        else:
            self.index['buildings'].append(summary)
        self._save_json(self.index_path, self.index)
        self._bump_failures(tags, report['run_id'])
        self.export_markdown()
        return entry

    def export_markdown(self):
        bs = sorted(self.index.get('buildings', []), key=lambda b: b.get('updated_at') or '', reverse=True)
        lines = ['# Agent 记忆', '', f'更新：{_now()}', '',
                 '| 建筑 | 坐标 | 次数 | 最佳分 | 最近运行 |', '| --- | --- | --- | --- | --- |']
        for b in bs[:50]:
            name = (b.get('address') or b['key']).replace('|', '/')
            lines.append(f'| {name} | {b["lat"]:.5f}, {b["lon"]:.5f} | {b.get("attempts", 0)} | '
                         f'{b.get("best_score", "-")} | {b.get("best_run", "-")} |')
        counts = self.failures.get('counts', {})
        if counts:
            lines += ['', '## 失败类型', '', '| 类型 | 次数 |', '| --- | --- |']
            for k, v in sorted(counts.items(), key=lambda x: -x[1]):
                lines.append(f'| {k} | {v} |')
        with open(os.path.join(self.root, 'MEMORY.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
