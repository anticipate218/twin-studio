"""命令行入口：run / rectify / runs / show。"""
import argparse
import json
import logging
import os
import sys

from . import __version__
from .config import BASE_DIR, load_config


def setup_logging(cfg, run_id=None, verbose=False):
    os.makedirs(cfg['logs_dir'], exist_ok=True)
    handlers = [logging.StreamHandler(sys.stdout)]
    if run_id:
        handlers.append(logging.FileHandler(os.path.join(cfg['logs_dir'], f'{run_id}.log'), encoding='utf-8'))
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s',
                        handlers=handlers, force=True)


def cmd_run(a):
    from .workflow import Workflow
    cfg = load_config(a.config)
    setup_logging(cfg, verbose=a.verbose)
    parse = lambda s: s if not s else s
    wf = Workflow(cfg)
    report = wf.run(a.lat, a.lon, ref=a.ref, facade_points=a.facade_points,
                    rounds=a.rounds, n=a.n, size=a.size, steps=a.steps, seed=a.seed, seeds=a.seeds, keep=a.keep,
                    use_canny=not a.no_canny, radius=a.radius, outdir=a.outdir, votes=a.votes, render=not a.no_render, render_rounds=a.render_rounds,
                    ipa_scale=a.ipa_scale, cfg=a.cfg, render_mode=a.render_mode,
                    render_seeds=a.render_seeds, render_steps=a.render_steps, scene_scale=a.scene_scale)
    print(json.dumps({'run_dir': report['run_dir'], 'final_dir': report['final_dir'],
                      'score': report['best']['score'] if report.get('best') else None,
                      'confidence': report.get('confidence')}, ensure_ascii=False, indent=2))


def cmd_rectify(a):
    from . import facade
    img = facade.read_image(a.image)
    pts = None
    if a.points_json:
        pts = json.load(open(a.points_json, encoding='utf-8'))
        if isinstance(pts, dict):
            pts = pts.get('points')
    elif a.points:
        pts = [[float(v) for v in p.split(',')] for p in a.points.split()]
    elif a.auto:
        pts = facade.auto_quad(img)
        if pts is None:
            sys.exit('未找到四边形，请用 --points 指定')
    else:
        sys.exit('需要 --points / --points-json / --auto')
    warped, _ = facade.rectify_facade(img, pts, a.width, a.height, a.margin)
    facade.write_image(a.out, warped)
    print(f'OK {a.out} {warped.shape[1]}x{warped.shape[0]}')


def cmd_runs(a):
    cfg = load_config(a.config)
    runs_dir = a.outdir or cfg['runs_dir']
    if not os.path.isdir(runs_dir):
        return
    rows = []
    for name in sorted(os.listdir(runs_dir), reverse=True):
        p = os.path.join(runs_dir, name)
        rep = os.path.join(p, 'report.json')
        score = conf = None
        if os.path.exists(rep):
            with open(rep, encoding='utf-8') as f:
                r = json.load(f)
            score = (r.get('best') or {}).get('score')
            conf = r.get('confidence')
        rows.append((name, score, conf, p))
        if len(rows) >= a.limit:
            break
    for name, score, conf, p in rows:
        print(f'{name}  score={score}  confidence={conf}  {p}')


def cmd_show(a):
    run_dir = a.run_dir
    for fn in ('final/REPORT.md', 'report.json', 'state.json'):
        p = os.path.join(run_dir, fn)
        if os.path.exists(p):
            print(f'===== {fn} =====')
            print(open(p, encoding='utf-8').read()[:4000])



def cmd_memory(a):
    from .memory import Memory
    m = Memory(os.path.join(BASE_DIR, 'memory'))
    if a.action == 'stats':
        print(json.dumps(m.stats(), ensure_ascii=False, indent=2))
    elif a.action == 'list':
        rows = sorted(m.index.get('buildings', []), key=lambda b: b.get('updated_at') or '', reverse=True)
        for b in rows[:a.limit]:
            print(f"{b['key']}  score={b.get('best_score')}  attempts={b.get('attempts')}  {b.get('address') or ''}")
    elif a.action == 'show':
        e = m.get(a.key)
        print(json.dumps(e, ensure_ascii=False, indent=2) if e else 'not found: ' + a.key)
    elif a.action == 'failures':
        print(json.dumps(m.failures.get('counts', {}), ensure_ascii=False, indent=2))
    elif a.action == 'export':
        m.export_markdown()
        print('OK memory/MEMORY.md')


def main(argv=None):
    ap = argparse.ArgumentParser(prog='agent', description=f'材质agent v{__version__}')
    ap.add_argument('--config', default=None, help='config.local.json 路径')
    sub = ap.add_subparsers(dest='cmd', required=True)

    r = sub.add_parser('run', help='跑一栋建筑')
    r.add_argument('--lat', type=float, required=True)
    r.add_argument('--lon', type=float, required=True)
    r.add_argument('--ref', default=None, help='强制参考图（跳过街景）')
    r.add_argument('--facade-points', default=None, help='"x,y x,y x,y x,y"')
    r.add_argument('--rounds', type=int, default=3)
    r.add_argument('--seeds', type=int, default=8, help='每轮先生成的 seed 数（按接缝筛选）')
    r.add_argument('--keep', type=int, default=2, help='接缝筛后送去评判的候选数')
    r.add_argument('--n', type=int, default=4)
    r.add_argument('--size', type=int, default=512)
    r.add_argument('--steps', type=int, default=26)
    r.add_argument('--seed', type=int, default=1234)
    r.add_argument('--radius', type=int, default=150)
    r.add_argument('--no-canny', action='store_true')
    r.add_argument('--ipa-scale', type=float, default=0.0, help='IP-Adapter 强度；材质样张默认 0（纯文生图）')
    r.add_argument('--cfg', type=float, default=7.0, help='guidance scale')
    r.add_argument('--votes', type=int, default=3, help='评判投票次数')
    r.add_argument('--no-render', action='store_true', help='跳过干净街景生成')
    r.add_argument('--render-rounds', type=int, default=3, help='街景重做轮数')
    r.add_argument('--render-mode', choices=['text', 'img2img'], default='text', help='街景生成方式：text 文生图迭代 prompt；img2img 原图重绘')
    r.add_argument('--render-seeds', type=int, default=2, help='文生街景每个 prompt 变体的 seed 数')
    r.add_argument('--render-steps', type=int, default=30)
    r.add_argument('--scene-scale', type=float, default=7.0, help='文生街景 CFG')
    r.add_argument('--outdir', default=None)
    r.add_argument('--verbose', action='store_true')
    r.set_defaults(func=cmd_run)

    q = sub.add_parser('rectify', help='立面校正')
    q.add_argument('--image', required=True)
    q.add_argument('--out', required=True)
    q.add_argument('--points', default=None)
    q.add_argument('--points-json', default=None)
    q.add_argument('--auto', action='store_true')
    q.add_argument('--width', type=int, default=None)
    q.add_argument('--height', type=int, default=None)
    q.add_argument('--margin', type=float, default=0.0)
    q.set_defaults(func=cmd_rectify)

    s = sub.add_parser('runs', help='列出运行记录')
    s.add_argument('--limit', type=int, default=10)
    s.add_argument('--outdir', default=None)
    s.set_defaults(func=cmd_runs)

    w = sub.add_parser('show', help='查看某次运行')
    w.add_argument('run_dir')
    w.set_defaults(func=cmd_show)


    mm = sub.add_parser('memory', help='运行时记忆')
    mm.add_argument('action', choices=['stats', 'list', 'show', 'failures', 'export'])
    mm.add_argument('--limit', type=int, default=10)
    mm.add_argument('key', nargs='?', default=None)
    mm.set_defaults(func=cmd_memory)

    a = ap.parse_args(argv)
    a.func(a)


if __name__ == '__main__':
    main()
