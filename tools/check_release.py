"""Release hygiene checks; reports locations, never secret values."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'GitHub token': re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}'),
    'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'AWS key': re.compile(r'AKIA[0-9A-Z]{16}'),
    'service token': re.compile(r'sk-[A-Za-z0-9_-]{24,}'),
    'embedded credential': re.compile(r'''(?i)["'](?:tencent_key|amap_key|glm_key|api_key|mapillary_token|password)["'] *: *["'][A-Za-z0-9._/+=-]{20,}["']'''),
}
BLOCKED_SUFFIXES = {'.docx','.zip','.gz','.splat','.glb','.ply','.safetensors','.ckpt','.pth','.pt','.pem','.key'}


def check():
    names = subprocess.check_output(['git','ls-files','-z'], cwd=ROOT).decode('utf-8').split(chr(0))
    names = [name for name in names if name]
    if not names: raise RuntimeError('No tracked/staged files to check; stage the release first.')
    failures = []
    for name in names:
        path = ROOT/name
        if not path.is_file(): continue
        if name.startswith(('data/', 'versions/')) or path.name in ('config.local.json','.env') or path.suffix in BLOCKED_SUFFIXES:
            failures.append((name,'runtime/private file'))
        if path.stat().st_size > 10*1024*1024: failures.append((name,'file exceeds 10 MB'))
        if path.suffix in ('.jpg','.png','.webp'): continue
        text = path.read_text(encoding='utf-8', errors='replace')
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(text): failures.append((name, label+' at line '+str(text.count(chr(10),0,match.start())+1)))
    readme = (ROOT/'README.md').read_text(encoding='utf-8')
    links = re.findall(r'(?:src|href)="([^"#]+)"', readme)
    links += [part.split(')',1)[0] for part in readme.split('](')[1:]]
    for target in links:
        if not target or '://' in target or target.startswith('#'): continue
        if not (ROOT/target).exists(): failures.append(('README.md','broken local link: '+target))
    for path, reason in failures: print(path+': '+reason)
    print('Release hygiene: %d files, %d finding(s)' % (len(names), len(failures)))
    return bool(failures)


if __name__ == '__main__': sys.exit(check())
