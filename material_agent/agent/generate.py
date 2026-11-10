"""材质生成模块：参考立面 + 边缘/深度条件 -> 扩散候选图。

用法：
  python -m agent.generate --ref facade.jpg --prompt "red brick facade ..." --size 512 --n 4
输出：<outdir>/<run_id>/cand_XX_seedXXXX.png + meta.json
"""
import argparse, json, os, time, datetime
import numpy as np
import cv2
import torch
from PIL import Image
from diffusers import (StableDiffusionControlNetPipeline, StableDiffusionControlNetImg2ImgPipeline,
                       ControlNetModel, StableDiffusionPipeline, StableDiffusionImg2ImgPipeline)
from diffusers.pipelines.controlnet.multicontrolnet import MultiControlNetModel

from .config import BASE_DIR, load_config

_CFG = load_config()
SD_DIR = _CFG['sd_dir']
CN_CANNY = _CFG['cn_canny']
CN_DEPTH = _CFG['cn_depth']
IPA_DIR = _CFG['ipa_dir']
IPA_WEIGHT = _CFG['ipa_weight']


def build_pipeline(use_canny=True, use_depth=False, use_ipa=True, ipa_scale=0.5, model_dir=None, img2img=False):
    nets = []
    if use_canny:
        nets.append(ControlNetModel.from_pretrained(CN_CANNY, torch_dtype=torch.float16))
    if use_depth:
        nets.append(ControlNetModel.from_pretrained(CN_DEPTH, torch_dtype=torch.float16))
    controlnet = None
    if len(nets) > 1:
        controlnet = MultiControlNetModel(nets)
    elif len(nets) == 1:
        controlnet = nets[0]

    kwargs = dict(torch_dtype=torch.float16, safety_checker=None, requires_safety_checker=False)
    if controlnet is not None:
        cls = StableDiffusionControlNetImg2ImgPipeline if img2img else StableDiffusionControlNetPipeline
        pipe = cls.from_pretrained(model_dir or SD_DIR, controlnet=controlnet, **kwargs)
    else:
        cls = StableDiffusionImg2ImgPipeline if img2img else StableDiffusionPipeline
        pipe = cls.from_pretrained(model_dir or SD_DIR, **kwargs)

    if use_ipa:
        pipe.load_ip_adapter(IPA_DIR, subfolder='models', weight_name=IPA_WEIGHT)
        pipe.set_ip_adapter_scale(ipa_scale)
    return pipe.to('cuda')


def make_conditions(ref, W, H, use_canny, use_depth):
    ref = ref.convert('RGB').resize((W, H), Image.LANCZOS)
    gray = cv2.cvtColor(np.array(ref), cv2.COLOR_RGB2GRAY)
    maps = []
    if use_canny:
        maps.append(Image.fromarray(cv2.Canny(gray, 100, 200)).convert('RGB'))
    if use_depth:
        maps.append(Image.fromarray(gray).convert('RGB'))
    if not maps:
        return ref, None
    return ref, maps[0] if len(maps) == 1 else maps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prompt', required=True)
    ap.add_argument('--negative', default='multiple buildings, row of buildings, trees, vegetation, cars, people, signs, text, watermark, logo, blurry, low quality, distorted perspective, fisheye, oversaturated, painting, illustration, cartoon, 3d render, cgi, deformed windows')
    ap.add_argument('--ref', required=True)
    ap.add_argument('--init', default=None, help='img2img 底图：保留原图结构与构图')
    ap.add_argument('--strength', type=float, default=0.45, help='img2img 重绘幅度，越小越接近底图')
    ap.add_argument('--canny', default=None)
    ap.add_argument('--depth', default=None)
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--height', type=int, default=None)
    ap.add_argument('--model', default=None, help='覆盖基础模型目录')
    ap.add_argument('--steps', type=int, default=20)
    ap.add_argument('--scale', type=float, default=7.5)
    ap.add_argument('--n', type=int, default=4)
    ap.add_argument('--seed', type=int, default=1234)
    ap.add_argument('--ipa-scale', type=float, default=0.5)
    ap.add_argument('--cn-scale', type=float, default=1.0)
    ap.add_argument('--no-ipa', action='store_true')
    ap.add_argument('--no-canny', action='store_true')
    ap.add_argument('--depth-from-ref', action='store_true', help='无深度图时用灰度近似（仅联调）')
    ap.add_argument('--outdir', default=os.path.join(BASE_DIR, 'runs'))
    a = ap.parse_args()

    W = a.size
    H = a.height or a.size
    use_canny = not a.no_canny
    use_depth = a.depth_from_ref
    ref = Image.open(a.ref)
    init = Image.open(a.init).convert('RGB').resize((W, H), Image.LANCZOS) if a.init else None
    if a.canny:
        edge = Image.open(a.canny).convert('RGB').resize((W, H))
    if a.depth:
        depth = Image.open(a.depth).convert('RGB').resize((W, H))

    pipe = build_pipeline(use_canny, use_depth, not a.no_ipa, a.ipa_scale, model_dir=a.model,
                          img2img=init is not None)
    if a.canny or a.depth:
        ref_sized = ref.convert('RGB').resize((W, H), Image.LANCZOS)
        maps = []
        if a.canny:
            maps.append(edge)
        if a.depth:
            maps.append(depth)
        cond = maps[0] if len(maps) == 1 else maps
    else:
        ref_sized, cond = make_conditions(ref, W, H, use_canny, use_depth)

    run_id = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    outdir = os.path.join(a.outdir, run_id)
    os.makedirs(outdir, exist_ok=True)

    torch.cuda.reset_peak_memory_stats()
    records = []
    for i in range(a.n):
        seed = a.seed + i
        gen = torch.Generator('cuda').manual_seed(seed)
        t0 = time.time()
        kw = dict(prompt=a.prompt, negative_prompt=a.negative, num_inference_steps=a.steps,
                  guidance_scale=a.scale, width=W, height=H, generator=gen)
        if init is not None:
            kw['image'] = init
            kw['strength'] = a.strength
            if cond is not None:
                kw['control_image'] = cond
                kw['controlnet_conditioning_scale'] = a.cn_scale
        elif cond is not None:
            kw['image'] = cond
            kw['controlnet_conditioning_scale'] = a.cn_scale
        if not a.no_ipa:
            kw['ip_adapter_image'] = ref_sized
        img = pipe(**kw).images[0]
        path = os.path.join(outdir, f'cand_{i:02d}_seed{seed}.png')
        img.save(path)
        records.append({'index': i, 'seed': seed, 'path': path, 'time_s': round(time.time() - t0, 2)})
        print(f'[{i+1}/{a.n}] seed={seed} {records[-1]["time_s"]}s -> {path}', flush=True)

    meta = {
        'run_id': run_id, 'prompt': a.prompt, 'negative': a.negative, 'ref': a.ref,
        'init': a.init, 'strength': a.strength if a.init else None,
        'size': [W, H], 'steps': a.steps, 'guidance': a.scale, 'ipa_scale': a.ipa_scale,
        'use_canny': use_canny, 'use_depth': use_depth, 'use_ipa': not a.no_ipa,
        'peak_vram_gb': round(torch.cuda.max_memory_allocated() / 1024**3, 2),
        'candidates': records,
    }
    with open(os.path.join(outdir, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print('DONE', outdir, 'peak', meta['peak_vram_gb'], 'GB')


if __name__ == '__main__':
    main()
