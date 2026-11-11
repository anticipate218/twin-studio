"""Build the public, browser-only experience site without private data."""
import argparse
import json
from pathlib import Path
import re
import shutil
import struct
import zlib
from create_demo import create_demo

ROOT = Path(__file__).resolve().parents[1]
VIDEO_NAME = 'Twin_Studio_60s_Promo.mp4'
VIDEO_URL = 'https://github.com/anticipate218/twin-studio/releases/download/showcase-video/' + VIDEO_NAME


def png(path, width, height, pixel):
    data = bytearray()
    for y in range(height):
        data.append(0)
        for x in range(width): data.extend(pixel(x,y))
    def chunk(kind, value):
        return struct.pack('>I',len(value))+kind+value+struct.pack('>I',zlib.crc32(kind+value)&0xffffffff)
    path.write_bytes(bytes([137,80,78,71,13,10,26,10])+chunk(b'IHDR',struct.pack('>2I5B',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(data,9))+chunk(b'IEND',b''))


def build(output, video_file=None):
    out = Path(output).resolve()
    marker = out/'.twin-demo-build'
    if out.exists():
        if not marker.is_file(): raise ValueError('Refusing to replace an unmarked directory: '+str(out))
        if out == ROOT or ROOT.is_relative_to(out): raise ValueError('Invalid site output directory')
        shutil.rmtree(out)
    out.mkdir(parents=True)
    marker.write_text('Generated public static site',encoding='utf-8')
    shutil.copytree(ROOT/'static',out/'static')
    shutil.copytree(ROOT/'vendor',out/'vendor')
    (out/'app').mkdir()
    (out/'assets').mkdir()
    for name in ('site.css','site.js'):
        shutil.copy2(ROOT/'web'/name,out/name)
    for name in ('video-cover.jpg','banner.svg'):
        shutil.copy2(ROOT/'docs/images'/name,out/'assets'/name)
    video_src = VIDEO_URL
    if video_file:
        video = Path(video_file).resolve()
        if not video.is_file(): raise FileNotFoundError(video)
        shutil.copy2(video,out/'assets'/VIDEO_NAME)
        video_src = 'assets/'+VIDEO_NAME
    landing=(ROOT/'web/index.html').read_text(encoding='utf-8').replace('__VIDEO_SOURCE__',video_src)
    (out/'index.html').write_text(landing,encoding='utf-8')
    (out/'.nojekyll').touch()

    demo=out/'demo'
    summary=create_demo(demo)
    (demo/'materials').mkdir()
    materials=[]
    for name,title,color in [('brick','砖墙示例',(153,76,62)),('glass','玻璃幕墙示例',(90,125,145)),('stone','浅色石材示例',(181,174,151))]:
        def pixel(x,y,base=color):
            if x%64<3 or y%128<4: return tuple(max(0,c-25) for c in base)
            if 13<x%64<50 and 27<y%128<94:
                return (190,217,225) if x%32<3 or y%32<3 else (36,64,85)
            return base
        png(demo/'materials'/(name+'.png'),256,256,pixel)
        materials.append({'id':name+'-demo','title':title,'file':'materials/'+name+'.png'})
    buildings=json.loads((demo/'models/demo_city.buildings.json').read_text(encoding='utf-8'))
    model={'title':'示例街区 · 12 栋建筑','desc':'程序化合成示例，用于在线体验。不是实测城市或训练成果。','size':Path(summary['path']).stat().st_size,'gaussians':summary['gaussians'],'metrics':{'buildings':12},'metrics_text':'合成示例 · 12 栋建筑'}
    (demo/'demo.json').write_text(json.dumps({'model':model,'buildings':buildings,'materials':materials},ensure_ascii=False),encoding='utf-8')
    (demo/'evidence').mkdir()
    for b in buildings['buildings']:
        evidence={'synthetic':True,'name':'合成建筑 #'+str(b['id'])+' · 关联展示示例','level':'演示','images':[{'url':'../demo/materials/'+m['file'].split('/')[-1],'label':'合成材质示意'} for m in materials],'text':'这些图像由程序绘制，仅演示资料关联结构，不是真实照片、证据等级或质量评分。','links':[],'quotes':[]}
        (demo/'evidence'/str(b['id'])).write_text(json.dumps(evidence,ensure_ascii=False),encoding='utf-8')
    for name in ('demo-api.js','demo-system.js','demo.css'):
        shutil.copy2(ROOT/'web'/name,demo/{'demo-api.js':'api.js','demo-system.js':'system.js'}.get(name,name))

    html=(ROOT/'static/index.html').read_text(encoding='utf-8')
    html=html.replace('href="/static/','href="../static/').replace('src="/static/','src="../static/')
    match=re.search(r'<script type="importmap">(.*?)</script>',html,re.S)
    imports=json.loads(match.group(1))
    imports['imports']={k:v.replace('/vendor/','../vendor/') for k,v in imports['imports'].items()}
    imports['imports']['../static/js/api.js']='../demo/api.js'
    html=html[:match.start()]+'<script type="importmap">'+json.dumps(imports)+'</script>'+html[match.end():]
    html=html.replace('</head>','<link rel="stylesheet" href="../demo/demo.css"></head>')
    notice='<div class="demo-notice" role="note"><span>在线体验 · 合成示例数据 · 所有编辑仅在浏览器内</span><nav><a href="../#video">宣传视频</a><a href="https://github.com/anticipate218/twin-studio" target="_blank" rel="noopener">完整源码 ↗</a></nav></div>'
    html=html.replace('<div id="app">','<div id="app">'+notice)
    html=html.replace('<button class="fchip" data-group="Potsdam">Potsdam</button>','<button class="fchip" data-group="Demo">示例场景</button>')
    html=re.sub(r'<button class="fchip" data-group="(?:Polytech|Upload|unregistered)">.*?</button>','',html)
    (out/'app/index.html').write_text(html,encoding='utf-8')
    (out/'static/index.html').write_text('<meta http-equiv="refresh" content="0;url=../app/">',encoding='utf-8')
    replacements={
      'app.js':[("from './system.js'","from '../../demo/system.js'"),('工作台已连接','浏览器体验'),('工作台服务正常 · 点击查看系统总览','浏览器本地运行 · 查看体验说明')],
      'material.js':[("this.filter = 'agent'","this.filter = 'all'"),("agent: '材质生成记录'","demo: '演示纹理', agent: '材质生成记录'"),('项目材质','示例材质')],
      'modeling.js':[('种真实纹理','种示例纹理'),('已发起 GLB 下载，并保存到项目。','已发起 GLB 下载，并保留在当前浏览会话中。刷新后清空。'),('填写项目位置，点击“生成项目材质”开始。运行前会检查本地生成条件。','在线体验不运行 GPU 生成。请部署完整版并配置模型权重，或在材质工坊尝试示例纹理。')],
      'scene.js':[("const explanation = level === 'C'","const explanation = ev.synthetic ? '这些资料为程序生成的界面示例，不是真实照片、实测证据或可信等级。' : level === 'C'"),('ev = await r.json();','ev = await r.json(); if (ev.synthetic && Array.isArray(ev.images)) ev.images = ev.images.map(m => ({ ...m, url: new URL(m.url, location.href).href }));')],
    }
    for name, changes in replacements.items():
        p=out/'static/js'/name;text=p.read_text(encoding='utf-8')
        for old,new in changes:
            if old not in text: raise ValueError('Static adaptation target missing: '+name+' / '+old)
            text=text.replace(old,new)
        p.write_text(text,encoding='utf-8')
    return {'output':str(out),'files':sum(p.is_file() for p in out.rglob('*')),'gaussians':summary['gaussians'],'local_video':bool(video_file)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'_site')
    parser.add_argument('--video-file',type=Path)
    args=parser.parse_args()
    print(json.dumps(build(args.output,args.video_file)))
