"""材质agent 工作流：取证 -> 生成 -> 评判 -> 迭代 -> 交付。"""
import datetime
import json
import logging
import os
import subprocess
import sys
import time

from PIL import Image

from . import critique as critique_mod
from . import facade
from . import llm
from . import prompt as prompt_mod
from .config import BASE_DIR, load_config
from .amap import Amap, AmapError
from .maps import MapError, TencentMap
from .memory import Memory
from .render import extract_material_patch, render_clean, render_clean_photo, render_scene_text
from .coords import wgs84_to_gcj02
from .streetview import Mapillary, StreetviewError

log = logging.getLogger('agent')


class Workflow:
    def __init__(self, config=None):
        self.cfg = config or load_config()
        self.map = TencentMap(self.cfg)
        self.amap = Amap(self.cfg)
        self.sv = Mapillary(self.cfg)

    # ---------- helpers ----------
    def _save_state(self, run_dir, state):
        with open(os.path.join(run_dir, 'state.json'), 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)

    def _gen_round(self, run_dir, ref, prompt, round_idx, p, use_canny=True, negative=None):
        outdir = os.path.join(run_dir, 'candidates', f'round_{round_idx}')
        cmd = [sys.executable, '-m', 'agent.generate', '--ref', ref, '--prompt', prompt,
               '--size', str(p['size']), '--n', str(p.get('seeds') or p['n']), '--steps', str(p['steps']),
               '--scale', str(p.get('cfg', 7.0)), '--ipa-scale', str(p.get('ipa_scale', 0.0)),
               '--seed', str(p['seed'] + (round_idx - 1) * 100), '--outdir', outdir]
        if negative:
            cmd += ['--negative', negative]
        if not (p['use_canny'] and use_canny):
            cmd.append('--no-canny')
        if float(p.get('ipa_scale', 0.0)) <= 0:
            cmd.append('--no-ipa')
        log.info('generate round %d', round_idx)
        subprocess.run(cmd, check=True, cwd=BASE_DIR)
        metas = []
        for root, _, files in os.walk(outdir):
            if 'meta.json' in files:
                with open(os.path.join(root, 'meta.json'), encoding='utf-8') as f:
                    metas.append(json.load(f))
        if not metas:
            raise RuntimeError('生成失败：未找到 meta.json')
        return metas[-1]['candidates']

    # ---------- main ----------
    def run(self, lat, lon, ref=None, facade_points=None, rounds=3, n=4, seeds=8, keep=2, size=512,
            steps=26, seed=1234, use_canny=True, radius=150, outdir=None, votes=3, render=True, render_rounds=3,
            ipa_scale=0.0, cfg=7.0, render_mode='text', render_seeds=4, render_steps=30, scene_scale=7.0):
        run_id = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        run_dir = os.path.join(outdir or self.cfg['runs_dir'], run_id)
        os.makedirs(os.path.join(run_dir, 'streetview'), exist_ok=True)
        os.makedirs(self.cfg['logs_dir'], exist_ok=True)
        fh = logging.FileHandler(os.path.join(self.cfg['logs_dir'], run_id + '.log'), encoding='utf-8')
        fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        log.addHandler(fh)
        params = dict(rounds=rounds, n=n, seeds=seeds, keep=keep, size=size,
                      steps=steps, seed=seed, use_canny=use_canny, votes=votes,
                      ipa_scale=ipa_scale, cfg=cfg, render_mode=render_mode,
                      render_seeds=render_seeds, render_steps=render_steps, scene_scale=scene_scale)
        state = {'run_id': run_id, 'phase': 'RESOLVE', 'round': 0, 'rounds': [], 'input': {
            'lat': lat, 'lon': lon, 'ref': ref, 'facade_points': facade_points, **params}}
        self._save_state(run_dir, state)
        mem = Memory(os.path.join(BASE_DIR, 'memory'))
        prior = mem.find_near(lat, lon)
        prior_entry = mem.get(prior[0]['key']) if prior else None
        if prior:
            log.info('命中历史建筑 %s（最近 %s 分）', prior[0]['key'], prior[0].get('best_score'))
        state['memory_prior'] = prior[:3]
        t0 = time.time()

        # RESOLVE
        glat, glon = wgs84_to_gcj02(lat, lon)
        address, district, pois, geo_src = None, None, [], None
        try:
            rev = self.map.reverse(glat, glon)
            address = rev.get('address')
            district = (rev.get('address_component') or {}).get('district')
            geo_src = 'tencent'
        except MapError as e:
            log.warning('腾讯逆地理失败: %s', e)
            try:
                rev = self.amap.reverse(glat, glon)
                address, district = rev.get('address'), rev.get('district')
                geo_src = 'amap'
            except AmapError as e2:
                log.warning('高德逆地理失败: %s', e2)
        try:
            pois = self.map.nearby_pois(glat, glon, radius)
        except MapError as e:
            log.warning('腾讯 POI 失败: %s', e)
            try:
                pois = self.amap.nearby_pois(glat, glon, radius)
                geo_src = geo_src or 'amap'
            except AmapError as e2:
                log.warning('高德 POI 失败: %s', e2)
        log.info('坐标 %s,%s -> %s | POI %d', lat, lon, address, len(pois))
        state['phase'] = 'STREETVIEW'
        self._save_state(run_dir, state)

        # STREETVIEW
        ref_img, vision, source_photo = None, None, None
        facade_info = {'rectified': False, 'path': None, 'corners': None}
        if ref:
            ref_img = ref
            source_photo = ref
            vision = llm.describe(self.cfg, ref)
            if facade_points:
                try:
                    src = facade.read_image(ref)
                    pts = [[float(x) for x in q.split(',')] for q in facade_points.split()]
                    warped, _ = facade.rectify_facade(src, pts, size, size)
                    fpath = os.path.join(run_dir, 'streetview', 'facade.png')
                    facade.write_image(fpath, warped)
                    facade_info = {'rectified': True, 'path': fpath,
                                   'corners': facade.order_points(pts).round(1).tolist()}
                    ref_img = fpath
                    log.info('参考图已按四角校正')
                except Exception as e:
                    log.warning('参考图校正失败: %s', e)
        else:
            try:
                images = self.sv.images(lat, lon)
            except StreetviewError as e:
                log.warning('街景失败: %s', e)
                images = []
            downloaded = []
            for i, im in enumerate(images[:6]):
                url = im.get('thumb_2048_url')
                if not url:
                    continue
                path = os.path.join(run_dir, 'streetview', f'mly_{i}_{im["id"]}.jpg')
                try:
                    self.sv.download(url, path)
                    downloaded.append((path, im))
                except Exception as e:
                    log.warning('街景下载失败: %s', e)

            def _luma(p):
                im = Image.open(p).convert('L').resize((32, 32))
                return sum(im.getdata()) / 1024.0

            downloaded.sort(key=lambda item: _luma(item[0]), reverse=True)
            for path, im in downloaded:
                lum = _luma(path)
                if lum < self.cfg.get('min_luma', 45):
                    log.info('跳过偏暗街景 %s (luma=%.0f)', os.path.basename(path), lum)
                    continue
                v = llm.describe(self.cfg, path)
                log.info('街景 %s -> %s', os.path.basename(path), v)
                if not v or not v.get('facade_visible'):
                    continue
                ref_img, vision = path, v
                source_photo = path
                src = facade.read_image(path)
                pts = None
                if facade_points:
                    pts = [[float(x) for x in q.split(',')] for q in facade_points.split()]
                else:
                    pts = facade.auto_quad(src)
                    if pts is None:
                        bb = llm.bbox(self.cfg, path)
                        if bb:
                            crop, ox, oy = facade.crop_norm(src, bb)
                            if crop is not None:
                                q = facade.auto_quad(crop)
                                if q is not None:
                                    pts = q + [ox, oy]
                if pts is not None:
                    warped, _ = facade.rectify_facade(src, pts, size, size)
                    fpath = os.path.join(run_dir, 'streetview', 'facade.png')
                    facade.write_image(fpath, warped)
                    facade_info = {'rectified': True, 'path': fpath,
                                   'corners': facade.order_points(pts).round(1).tolist()}
                    ref_img = fpath
                    break
                log.info('街景无四边形，沿用原图')
        if ref_img is None:
            fallback = self.cfg.get('fallback_ref')
            if fallback and os.path.exists(fallback):
                log.warning('使用回退参考图 %s', fallback)
                ref_img = fallback
                source_photo = fallback
                vision = llm.describe(self.cfg, ref_img)

        scene_desc = llm.scene_describe(self.cfg, source_photo) if source_photo else None
        if scene_desc:
            log.info('scene: %s', scene_desc)

        state['phase'] = 'PROMPT'
        state['facade'] = facade_info
        self._save_state(run_dir, state)

        if vision is None and prior:
            e = mem.get(prior[0]['key'])
            if e and e.get('material'):
                vision = {'facade_visible': True, 'material': e.get('material'), 'color': e.get('color'),
                          'storeys': None, 'style': 'urban', 'confidence': 0.4, 'source': 'memory'}
                log.info('无街景，沿用历史记忆材质 %s / %s', vision['material'], vision.get('color'))

        prompt, kinds = prompt_mod.build_prompt(address, pois, vision)
        if prior_entry and prior_entry.get('best_prompt') and (prior_entry.get('best_score') or 0) >= 4.0:
            prompt = prior_entry['best_prompt']
            params['seed'] = prior_entry.get('best_seed') or params['seed']
            state['prompt_reused'] = True
            log.info('复用历史最佳 prompt（%s 分）与 seed=%s', prior_entry.get('best_score'), params['seed'])
        evidence = {
            'coordinate': {'wgs84': [lat, lon], 'gcj02': [glat, glon], 'confidence': 0.95},
            'address': {'value': address, 'district': district, 'source': geo_src or '-',
                        'confidence': 0.9 if address else 0.0},
            'pois': [{k: p.get(k) for k in ('title', 'address', 'category', 'distance_m')} for p in pois],
            'vision': vision,
            'scene': scene_desc,
            'facade': facade_info,
            'ref': ref_img,
            'source_photo': source_photo,
            'prompt': prompt,
        }
        with open(os.path.join(run_dir, 'evidence.json'), 'w', encoding='utf-8') as f:
            json.dump(evidence, f, ensure_ascii=False, indent=2)
        log.info('prompt: %s', prompt)

        # GENERATE / CRITIQUE / REVISE
        best, cur_prompt = None, prompt
        for r in range(1, rounds + 1):
            state['phase'], state['round'] = 'GENERATE', r
            self._save_state(run_dir, state)
            gen_ref = ref_img
            gen_canny = False
            cands = self._gen_round(run_dir, gen_ref, cur_prompt, r, params, use_canny=gen_canny,
                                    negative=prompt_mod.build_negative())
            if len(cands) > params['keep']:
                for c in cands:
                    c['seam'] = critique_mod.seam_error(c['path'])
                cands.sort(key=lambda c: (c.get('seam') is None, c.get('seam') or 999.0))
                log.info('seam search: %s', [(c['seed'], c.get('seam')) for c in cands[:5]])
                cands = cands[:params['keep']]

            state['phase'] = 'CRITIQUE'
            self._save_state(run_dir, state)
            scored = []
            for c in cands:
                crit = critique_mod.critique(self.cfg, c['path'], evidence, ref_img, votes=params['votes'])
                c['critique'] = crit
                c['prompt'] = cur_prompt
                c.update({k: crit[k] for k in critique_mod.WEIGHTS})
                c['score'], c['pass'] = crit['score'], crit['pass']
                scored.append(c)
                log.info('r%d seed=%s score=%s pass=%s issues=%s',
                         r, c['seed'], crit['score'], crit['pass'], crit['issues'])
            scored.sort(key=lambda x: x['score'], reverse=True)
            state['rounds'].append({'round': r, 'prompt': cur_prompt, 'candidates': scored})
            self._save_state(run_dir, state)
            if scored and scored[0]['pass']:
                best = scored[0]
                break
            if r < rounds:
                cur_prompt = prompt_mod.revise(cur_prompt, scored[0]['critique'], vision or {}, r)
                state['phase'] = 'REVISE'
                self._save_state(run_dir, state)
                log.info('revise: %s', cur_prompt)

        allc = [c for rd in state['rounds'] for c in rd['candidates']]
        if best is None and allc:
            tile_ok = [c for c in allc if (c.get('seam') or 999) <= 25]
            if tile_ok:
                best = max(tile_ok, key=lambda x: x['score'])
                log.info('没有通过项，选接缝达标的最佳候选 seed=%s seam=%s score=%s',
                         best['seed'], best.get('seam'), best['score'])
            else:
                best = min(allc, key=lambda x: (x.get('seam') or 999, -x['score']))
                log.info('没有通过项且接缝均超标，选接缝最小候选 seed=%s seam=%s score=%s',
                         best['seed'], best.get('seam'), best['score'])

        # RENDER: 默认文生街景 + prompt 变体搜索；img2img 仅作保真对照
        clean_image, clean_prompt, clean_best, clean_status = None, None, None, 'skipped'
        clean_mode = render_mode
        render_rounds_log = []
        if render and best and source_photo:
            state['phase'] = 'RENDER'
            self._save_state(run_dir, state)
            vis = vision or {}
            prev_best, stagnation = None, 0
            for rr in range(1, render_rounds + 1):
                if render_mode == 'img2img':
                    if rr == 1:
                        clean_prompt = prompt_mod.clean_prompt(vis, kinds)
                    prompt_sets = [('revise' if rr > 1 else 'base', clean_prompt)]
                else:
                    if rr == 1:
                        prompt_sets = prompt_mod.scene_variants(vis, kinds)
                    else:
                        prompt_sets = prompt_mod.scene_mutations(
                            clean_best['prompt'], clean_best['critique'], vis, rr)
                if rr == 1:
                    log.info('street mode=%s variants=%s', render_mode,
                             [(n, p) for n, p in prompt_sets])
                scored = []
                for vi, (vname, vprompt) in enumerate(prompt_sets):
                    outdir = os.path.join(run_dir, 'clean', f'round_{rr}')
                    try:
                        if render_mode == 'img2img':
                            cands = render_clean_photo(self.cfg, source_photo, vprompt, outdir,
                                                       size=768, height=512, n=2, steps=32,
                                                       seed=seed + rr * 7, strength=0.55)
                        else:
                            cands = render_scene_text(self.cfg, vprompt, outdir, ref=source_photo,
                                                      size=768, height=512, n=render_seeds,
                                                      steps=render_steps, seed=seed + rr * 17 + vi * 3,
                                                      scale=scene_scale)
                    except Exception as e:
                        log.warning('街景生成失败（%s）: %s', vname, e)
                        continue
                    for c in cands:
                        if render_mode == 'img2img':
                            crit = critique_mod.streetview_critique(self.cfg, c['path'], evidence,
                                                                    ref_path=source_photo, votes=3)
                        else:
                            crit = critique_mod.scene_match_critique(self.cfg, c['path'], evidence,
                                                                     ref_path=source_photo,
                                                                     votes=max(1, params['votes']))
                        c['critique'] = crit
                        c['prompt'] = vprompt
                        c['variant'] = vname
                        c['score'], c['pass'] = crit['score'], crit['pass']
                        scored.append(c)
                        log.info('street r%d %s seed=%s score=%s fidelity=%s material=%s env=%s ssim=%s pass=%s issues=%s',
                                 rr, vname, c['seed'], crit['score'], crit.get('fidelity'),
                                 crit.get('material'), crit.get('environment'), crit.get('ssim'),
                                 crit['pass'], crit['issues'])
                if not scored:
                    break
                scored.sort(key=lambda x: x['score'], reverse=True)
                render_rounds_log.append({'round': rr,
                                          'variants': [{'name': n, 'prompt': p} for n, p in prompt_sets],
                                          'candidates': scored})
                if clean_best is None or scored[0]['score'] > clean_best['score']:
                    clean_best = scored[0]
                    clean_image = scored[0]['path']
                if scored[0]['pass']:
                    clean_status = 'ok'
                    break
                crit0 = scored[0]['critique']
                improved = scored[0]['score'] - (prev_best if prev_best is not None else -1)
                prev_best = max(prev_best if prev_best is not None else -1, scored[0]['score'])
                if improved < 0.1:
                    stagnation += 1
                else:
                    stagnation = 0
                if stagnation >= 2:
                    log.info('street plateau, stop')
                    break
                if rr < render_rounds:
                    if render_mode == 'img2img':
                        add = []
                        if crit0.get('fidelity', 5) < 4:
                            add.append('keep the same building massing, floor count, window layout and storefront rhythm')
                        if crit0.get('realism', 5) < 4:
                            add.append('photographic, natural light, 35mm lens')
                        if crit0.get('completeness', 5) < 4:
                            add.append('entire building visible from ground to roof')
                        if crit0.get('cleanliness', 5) < 4:
                            add.append('no trees, no cars, no people, no signs')
                        if crit0.get('focus', 5) < 4:
                            add.append('single building centered, no neighboring buildings')
                        sug = (crit0.get('suggestion') or '')[:100]
                        if sug:
                            add.append(sug)
                        add.append(f'variation {rr}')
                        clean_prompt += ', ' + ', '.join(add)
                    log.info('street next round from best (score=%s, variant=%s): %s',
                             clean_best['score'], clean_best.get('variant'), clean_best['prompt'])
            if clean_best is not None:
                clean_prompt = clean_best['prompt']
            if clean_best is not None and clean_status != 'ok':
                clean_status = ('low_fidelity' if (clean_best['critique'].get('fidelity') or 0) < 4
                                else 'not_passed')
        elif render and best:
            log.warning('没有原始街景，跳过街景生成（文生街景需要真实街景做评判）')

        # FINALIZE
        from .report import write_final
        report = {'run_id': run_id,
                  'coordinate': evidence['coordinate'],
                  'address': evidence['address'],
                  'rounds_used': len(state['rounds']),
                  'elapsed_s': round(time.time() - t0, 1),
                  'best': best,
                  'clean_image': clean_image,
                  'clean_prompt': clean_prompt,
                  'clean_best': clean_best,
                  'clean_status': clean_status,
                  'clean_mode': clean_mode,
                  'render_rounds_log': render_rounds_log,
                  'evidence': evidence,
                  'confidence': None}
        state['phase'] = 'FINALIZE'
        final_dir = write_final(run_dir, report, evidence, cur_prompt, state['rounds'])
        self._save_state(run_dir, state)
        entry = mem.record_run(report, evidence, cur_prompt, state['rounds'])
        report['memory_key'] = entry['key']
        report['run_dir'] = run_dir
        report['final_dir'] = final_dir
        log.info('done score=%s -> %s', best['score'] if best else None, final_dir)
        log.removeHandler(fh)
        fh.close()
        return report
