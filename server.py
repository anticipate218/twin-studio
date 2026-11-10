#!/usr/bin/env python3
"""Twin Studio server — local backend for the city digital-twin modeling & rendering studio.

Standard library only. Reads model assets and material-agent outputs, serves the
three.js front-end in ./static, streams .splat models with HTTP Range support, exposes the
material agent's runs / memory, proxies 3DGS reconstruction jobs to the legacy web3d service
(port 8080) and saves GLB exports under ./data/exports.

When the remote citytwin host (or the legacy web3d proxy) is unavailable, reconstruction falls
back to ./recon_local.py: orthophoto + DSM -> ground/roof/facade Gaussian surfels written as
.splat + buildings.json + preview under ./data/recon (never into ../web3d). That path does NOT
run SfM or photometric 3DGS optimisation; job status and model metadata say so explicitly.

    python server.py [--host 127.0.0.1] [--port 8090] [--open]

Environment overrides: TWIN_WEB3D, TWIN_AGENT, TWIN_LEGACY (http://127.0.0.1:8080),
TWIN_REMOTE_HOST (127.0.0.1), TWIN_REMOTE_PORT (22),
TWIN_RECON_MODE (auto | local | remote; auto = remote only when the legacy proxy answers
HTTP and the remote SSH port is reachable, otherwise local DSM reconstruction).
"""
import hashlib
import argparse
import importlib.util
import json
import mimetypes
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse

VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB3D = os.path.abspath(os.environ.get("TWIN_WEB3D") or os.path.join(HERE, "data", "library"))
AGENT = os.path.abspath(os.environ.get("TWIN_AGENT") or os.path.join(HERE, "material_agent"))
STATIC = os.path.join(HERE, "static")
VENDOR = os.path.join(HERE, "vendor")
DATA = os.path.join(HERE, "data")
EXPORTS = os.path.join(DATA, "exports")
JOBS_DIR = os.path.join(DATA, "agent_jobs")
LEGACY = (os.environ.get("TWIN_LEGACY") or "http://127.0.0.1:8080").rstrip("/")
REMOTE_HOST = os.environ.get("TWIN_REMOTE_HOST") or "127.0.0.1"
REMOTE_PORT = int(os.environ.get("TWIN_REMOTE_PORT") or 22)
MODELS_DIR = os.path.join(WEB3D, "models")
PREVIEWS_DIR = os.path.join(WEB3D, "previews")
RECON_DIR = os.path.join(DATA, "recon")
RECON_MODELS = os.path.join(RECON_DIR, "models")
RECON_PREVIEWS = os.path.join(RECON_DIR, "previews")
RECON_JOBS = os.path.join(RECON_DIR, "jobs")
RECON_UPLOADS = os.path.join(RECON_DIR, "uploads")
RECON_SCRIPT = os.path.join(HERE, "recon_local.py")
RECON_MODE = (os.environ.get("TWIN_RECON_MODE") or "auto").strip().lower()
RECON_UPLOAD_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".img"}
# PATCH upload-pipeline: user uploads -> local / remote reconstruction
RECON_DSM_EXT = {".tif", ".tiff"}
# magic-byte families each extension may contain (".img" = ERDAS Imagine or a renamed GeoTIFF)
RECON_EXT_MAGIC = {".jpg": {"jpeg"}, ".jpeg": {"jpeg"}, ".png": {"png"}, ".webp": {"webp"},
                   ".tif": {"tiff", "bigtiff"}, ".tiff": {"tiff", "bigtiff"}, ".img": {"erdas-img", "tiff", "bigtiff"}}
RECON_KEEP_DAYS = 30           # raw uploads older than this are purged (models / previews are kept)
RECON_HISTORY = 20             # jobs listed by /api/recon/jobs
MODEL_DIRS = (MODELS_DIR, RECON_MODELS)        # web3d first (read-only), then local reconstructions
PREVIEW_DIRS = (PREVIEWS_DIR, RECON_PREVIEWS)
# PATCH fina: the final delivery package (data/fina) replaces ../web3d as the model + evidence source.
# TWIN_USE_FINA=0 falls back to ../web3d; TWIN_FINA overrides the package location.
FINA = os.path.abspath(os.environ.get("TWIN_FINA") or os.path.join(DATA, "fina"))
FINA_ON = (os.environ.get("TWIN_USE_FINA") or "1").strip() != "0" and os.path.isfile(os.path.join(FINA, "MASTER_MANIFEST.json"))
FINA_MODEL_DIRS = tuple(os.path.join(FINA, "models", s) for s in ("potsdam", "polytech"))
if FINA_ON:
    MODEL_DIRS = FINA_MODEL_DIRS + (RECON_MODELS,)
RUNS_DIR = os.path.join(AGENT, "runs")
MAX_EXPORT = 300 * 1024 * 1024
MAX_UPLOAD = 500 * 1024 * 1024
CHUNK = 1024 * 1024

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
AGENT_FILE_EXT = IMG_EXT | {".md", ".json"}
AGENT_FILE_ROOTS = {"runs", "scan", "memory"}
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,96}$")
SECRET_KEY = re.compile(r"key|token|secret|pass", re.I)

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("text/markdown", ".md")
mimetypes.add_type("image/webp", ".webp")


# ---------------------------------------------------------------------------------------- helpers
def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


_PATH_LOCKS = {}
_PATH_LOCKS_GUARD = threading.Lock()


def path_lock(path):
    """One RLock per file: serialises in-process JSON readers/writers (on Windows os.replace fails while the target is open)."""
    key = os.path.normcase(os.path.abspath(path))
    with _PATH_LOCKS_GUARD:
        lk = _PATH_LOCKS.get(key)
        if lk is None:
            lk = _PATH_LOCKS[key] = threading.RLock()
        return lk


def read_json(path, default=None):
    with path_lock(path):
        for attempt in range(3):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))   # another process (recon_local.py) is replacing the file
            except (OSError, ValueError):
                return default
        return default


def read_text(path, default=""):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def inside(base, path):
    """True when `path` resolves inside directory `base` (no traversal, no symlink escape)."""
    try:
        b = os.path.realpath(base)
        p = os.path.realpath(path)
        return os.path.commonpath([b, p]) == b
    except ValueError:
        return False


def safe_join(base, rel):
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel or any(part in ("..", "") for part in rel.split("/")):
        return None
    p = os.path.join(base, *rel.split("/"))
    return p if inside(base, p) else None


def tcp_up(host, port, timeout=1.2):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def num(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


class TTLCache:
    def __init__(self):
        self._d = {}
        self._lock = threading.Lock()

    def get(self, key, ttl, fn):
        now = time.time()
        with self._lock:
            hit = self._d.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        val = fn()
        with self._lock:
            self._d[key] = (time.time(), val)
        return val

    def drop(self, key):
        with self._lock:
            self._d.pop(key, None)


CACHE = TTLCache()


# ---------------------------------------------------------------------------------------- models
METRIC_PATTERNS = {
    "psnr": re.compile(r"PSNR\s*([0-9]+(?:\.[0-9]+)?)", re.I),
    "ssim": re.compile(r"SSIM\s*([0-9]*\.[0-9]+)", re.I),
    "lpips": re.compile(r"LPIPS\s*([0-9]*\.[0-9]+)", re.I),
    "gaussians_k": re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*k\s*高斯", re.I),
    "buildings": re.compile(r"([0-9]+)\s*栋"),
}
EXTENT_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*[×x*]\s*([0-9]+(?:\.[0-9]+)?)\s*m")


def parse_metrics(text):
    out = {}
    text = text or ""
    for k, rx in METRIC_PATTERNS.items():
        m = rx.search(text)
        if m:
            out[k] = float(m.group(1)) if k != "buildings" else int(m.group(1))
    m = EXTENT_RE.search(text)
    if m:
        out["extent"] = "%s×%s m" % (m.group(1), m.group(2))
    return out


def model_group(fname):
    f = fname.lower()
    if f.startswith("pots"):
        return "Potsdam"
    if f.startswith("polytech") or f.startswith("dsm"):
        return "Polytech"
    if re.match(r"^\d{8}_\d{6}", f):
        return "Upload"
    return "Other"


def preview_url(rel_or_name, stem):
    cands = []
    if rel_or_name:
        cands.append(os.path.basename(str(rel_or_name).replace("\\", "/")))
    cands += [stem + ".png", stem.replace("polytech_", "") + ".png", stem + ".jpg"]
    for c in cands:
        p = os.path.join(PREVIEWS_DIR, c)
        if c and os.path.isfile(p):
            return "/preview/" + quote(c)
    return None


def find_file(dirs, name):
    """First existing file called `name` in `dirs` (web3d first, then data/recon), or None."""
    if not name or name in (".", "..") or os.path.basename(name) != name or "\\" in name or "/" in name:
        return None
    for d in dirs:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return None


def list_models():
    reg = read_json(os.path.join(WEB3D, "models.json"), {}) or {}
    items = reg.get("items") if isinstance(reg, dict) else reg
    items = items if isinstance(items, list) else []
    seen = set()
    out = []

    def entry(folder, fname, meta, registered, origin):
        path = os.path.join(folder, fname)
        st = os.stat(path)
        stem = fname[:-6] if fname.lower().endswith(".splat") else fname
        bjson = os.path.join(folder, stem + ".buildings.json")
        meta = meta or {}
        metrics_text = meta.get("metrics", "") if isinstance(meta.get("metrics", ""), str) else ""
        if origin == "local":
            pv = os.path.basename(str(meta.get("preview") or (stem + ".png")))
            preview = ("/preview/" + quote(pv)) if find_file((RECON_PREVIEWS,), pv) else None
        else:
            preview = preview_url(meta.get("preview"), stem)
        return {
            "file": fname,
            "stem": stem,
            "title": meta.get("title") or stem,
            "desc": meta.get("desc", ""),
            "metrics_text": metrics_text,
            "metrics": parse_metrics(metrics_text),
            "group": model_group(fname),
            "preview": preview,
            "size": st.st_size,
            "gaussians": st.st_size // 32,
            "valid": st.st_size > 0 and st.st_size % 32 == 0,
            "registered": registered,
            "buildings": ("/api/buildings/" + quote(stem)) if os.path.isfile(bjson) else None,
            "mtime": int(st.st_mtime),
            "url": "/splat/" + quote(fname),
            "origin": origin,
            "engine": str(meta.get("engine", "")) if origin == "local" else "",
        }

    if FINA_ON:
        for sc in fina_manifest():
            mp = fina_path(sc.get("model"))
            if not mp or not os.path.isfile(mp):
                continue
            fname = os.path.basename(mp)
            if fname in seen or not SAFE_ID.match(fname):
                continue
            seen.add(fname)
            meta = {"title": sc.get("name") or fname[:-6], "desc": sc.get("note") or "",
                    "metrics": fina_metrics_text(sc, os.path.getsize(mp))}
            e = entry(os.path.dirname(mp), fname, meta, True, "fina")
            e["scene"] = sc.get("key")
            e["final"] = bool(sc.get("final"))
            if isinstance(sc.get("metrics"), dict):
                e["metrics"].update({k: v for k, v in sc["metrics"].items() if isinstance(v, (int, float))})
            out.append(e)
        items = []
    for it in items:
        if not isinstance(it, dict):
            continue
        fname = os.path.basename(str(it.get("file", "")))
        if not fname or fname in seen or not os.path.isfile(os.path.join(MODELS_DIR, fname)):
            continue
        seen.add(fname)
        out.append(entry(MODELS_DIR, fname, it, True, "web3d"))
    if not FINA_ON and os.path.isdir(MODELS_DIR):
        for fname in sorted(os.listdir(MODELS_DIR)):
            if fname.lower().endswith(".splat") and fname not in seen:
                seen.add(fname)
                out.append(entry(MODELS_DIR, fname, None, False, "web3d"))
    if os.path.isdir(RECON_MODELS):
        for fname in sorted(os.listdir(RECON_MODELS)):
            if not fname.lower().endswith(".splat") or fname in seen or not SAFE_ID.match(fname):
                continue
            seen.add(fname)
            meta = read_json(os.path.join(RECON_MODELS, fname[:-6] + ".meta.json"), None)
            meta = meta if isinstance(meta, dict) else None
            out.append(entry(RECON_MODELS, fname, meta, meta is not None, "local"))
    return out


# ---------------------------------------------------------------------------------------- fina package
FINA_FILE_EXT = IMG_EXT | {".json", ".md", ".csv"}
FINA_FLOOR_H = 3.2          # floors are only estimated from height: the package has no floor counts


def _under(path, base):
    p = os.path.normcase(os.path.abspath(path))
    b = os.path.normcase(os.path.abspath(base))
    return p == b or p.startswith(b.rstrip("\\/") + os.sep)


def fina_path(rel):
    # package-relative path ("evidence/potsdam/ortho/b0000.jpg") -> absolute path inside FINA, else None
    s = str(rel or "").replace("\\", "/")
    parts = [x for x in s.split("/") if x not in ("", ".")]
    if not parts or ".." in parts or ":" in parts[0]:
        return None
    p = os.path.abspath(os.path.join(FINA, *parts))
    return p if _under(p, FINA) else None


def fina_manifest():
    m = read_json(os.path.join(FINA, "MASTER_MANIFEST.json"), {}) or {}
    sc = m.get("scenes") if isinstance(m, dict) else None
    return [s for s in sc if isinstance(s, dict) and s.get("model")] if isinstance(sc, list) else []


def fina_scene(stem):
    for s in fina_manifest():
        if os.path.splitext(os.path.basename(str(s["model"])))[0] == stem:
            return s
    return None


def fina_metrics_text(sc, size):
    parts = []
    mt = sc.get("metrics") if isinstance(sc.get("metrics"), dict) else {}
    for k, lab, f in (("psnr", "PSNR", "%.2f"), ("ssim", "SSIM", "%.4f"), ("lpips", "LPIPS", "%.4f")):
        if isinstance(mt.get(k), (int, float)):
            parts.append(lab + " " + f % mt[k])
    g = sc.get("gaussians") if isinstance(sc.get("gaussians"), (int, float)) else size // 32
    parts.append("%.0fk 高斯" % (g / 1000.0))
    if isinstance(sc.get("buildings"), int):
        parts.append("%d 栋" % sc["buildings"])
    return " · ".join(parts)


def load_buildings(path):
    if not FINA_ON or not path or not _under(path, FINA):
        return read_json(path)
    try:
        key = "fina_b:%s:%d" % (path, int(os.path.getmtime(path)))
    except OSError:
        return None
    return CACHE.get(key, 600, lambda: fina_normalize(path, read_json(path)))


def fina_normalize(path, data):
    # package sidecars: ring/cx/cy in the source CRS, base absolute, peak = building height.
    # The splat lives in (source - offset), so subtract offset.json from XY and Z.
    if not isinstance(data, dict) or not isinstance(data.get("buildings"), list):
        return data
    stem = os.path.basename(path)[:-len(".buildings.json")]
    off = read_json(os.path.join(os.path.dirname(path), stem + ".offset.json"), {}) or {}
    o = off.get("offset") if isinstance(off, dict) else None
    try:
        ox, oy, oz = ([float(v) for v in o] + [0.0, 0.0, 0.0])[:3] if isinstance(o, list) else (0.0, 0.0, 0.0)
    except (TypeError, ValueError):
        ox = oy = oz = 0.0
    out = []
    for b in data["buildings"]:
        if not isinstance(b, dict):
            continue
        try:
            ring = [[round(float(p[0]) - ox, 3), round(float(p[1]) - oy, 3)] for p in (b.get("ring") or [])]
            base = float(b.get("base") or 0.0) - oz
            if b.get("peak") is not None:
                height = float(b["peak"])
            else:
                height = float(b.get("top") or 0.0) - float(b.get("base") or 0.0)
        except (TypeError, ValueError, IndexError):
            continue
        if len(ring) < 3:
            continue
        nb = dict(b)
        nb["ring"] = ring
        for k, d in (("cx", ox), ("cy", oy)):
            if isinstance(b.get(k), (int, float)):
                nb[k] = round(b[k] - d, 3)
        nb["base"] = round(base, 3)
        nb["top"] = round(base + height, 3)
        nb["height_m"] = round(height, 2)
        if nb.get("floors") is None and height > 0:
            nb["floors"] = max(1, int(round(height / FINA_FLOOR_H)))
            nb["floors_est"] = True
        ag = b.get("agent") if isinstance(b.get("agent"), dict) else {}
        for k in ("name", "material", "color", "color_hex", "lat", "lon", "level"):
            if nb.get(k) in (None, "") and ag.get(k) not in (None, ""):
                nb[k] = ag[k]
        if not nb.get("source"):
            nb["source"] = "成果包" + ((" · 证据等级 %s" % ag["level"]) if ag.get("level") else "")
        out.append(nb)
    res = dict(data)
    res["buildings"] = out
    res["stem"] = stem
    res["aligned"] = True
    res["offset_removed"] = [ox, oy, oz]
    res["crs"] = ("%s → 模型局部坐标（已减 offset）" % data["crs"]) if data.get("crs") else "模型局部坐标（已减 offset）"
    res["evidence_api"] = "/api/evidence/" + quote(stem)
    return res


def fina_evidence_index(rel):
    p = fina_path(rel)
    d = read_json(p, {}) if p else {}
    recs = d.get("buildings") if isinstance(d, dict) and "buildings" in d else d
    idx = {"bid": {}, "id": {}, "agent_bid": {}, "key": {}}
    if isinstance(recs, dict):
        for k, r in recs.items():
            if isinstance(r, dict):
                idx["key"].setdefault(str(k), r)
        recs = list(recs.values())
    for r in recs if isinstance(recs, list) else []:
        if isinstance(r, dict):
            for k in ("bid", "id", "agent_bid"):
                if r.get(k) is not None:
                    idx[k].setdefault(str(r[k]), r)
    return idx


def _fina_rel(s, base_dir):
    s = s.strip()
    if not s or len(s) > 400 or os.path.splitext(s)[1].lower() not in IMG_EXT:
        return None
    norm = s.replace("\\", "/")
    low = norm.lower()
    cands = [norm]
    if base_dir:
        cands.append(base_dir + "/" + norm)
        parent = os.path.dirname(base_dir).replace("\\", "/")
        if parent:
            cands.append(parent + "/" + norm)  # package paths like "potsdam/agent/imgs/.." are relative to evidence/
    for seg in ("evidence/", "models/"):
        i = low.rfind("/" + seg)
        if i >= 0:
            cands.append(norm[i + 1:])
    for c in cands:
        p = fina_path(c)
        if p and os.path.isfile(p):
            return os.path.relpath(p, FINA).replace("\\", "/")
    return None


def _fina_walk(obj, base_dir, imgs, links, label="", depth=0):
    if depth > 5:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            _fina_walk(v, base_dir, imgs, links, str(k), depth + 1)
    elif isinstance(obj, list):
        for v in obj[:200]:
            _fina_walk(v, base_dir, imgs, links, label, depth + 1)
    elif isinstance(obj, str):
        s = obj.strip()
        if s.startswith(("http://", "https://")):
            if s not in links and len(links) < 40:
                links[s] = label
        else:
            rel = _fina_rel(s, base_dir)
            if rel and rel not in imgs and len(imgs) < 60:
                imgs[rel] = label


def _fina_clean_osm(o):
    # drop empty OSM tag values ("building": "") so the panel only lists real tags
    if isinstance(o, dict):
        o = {k: v for k, v in o.items() if v not in (None, "", [], {})}
        return o or None
    return o


def fina_evidence(stem, bid):
    import json as _json
    if not FINA_ON:
        return None
    sc = fina_scene(stem)
    p = find_file(FINA_MODEL_DIRS, stem + ".buildings.json")
    if not sc or not p:
        return None
    data = load_buildings(p)
    blds = data.get("buildings") if isinstance(data, dict) else None
    b = next((x for x in blds or [] if str(x.get("id")) == str(bid)), None)
    if b is None:
        return None
    ag = b.get("agent") if isinstance(b.get("agent"), dict) else {}
    evrel = str(sc.get("evidence") or "")
    idx = CACHE.get("fina_ev:" + evrel, 600, lambda: fina_evidence_index(evrel)) if evrel else {}
    rec, how = None, None
    for rk, val, tag in (("agent_bid", ag.get("agent_bid"), "agent_bid"), ("bid", ag.get("agent_bid"), "agent_bid->bid"),
                         ("bid", ag.get("bid"), "agent.bid"), ("id", ag.get("agent_bid"), "agent_bid->id"),
                         ("key", ag.get("agent_bid"), "agent_bid->key"),
                         ("id", b.get("id"), "id"), ("bid", b.get("id"), "id->bid")):
        if val is not None and str(val) in (idx.get(rk) or {}):
            rec, how = idx[rk][str(val)], tag
            break
    base_dir = os.path.dirname(evrel).replace("\\", "/")
    imgs, links = {}, {}
    if rec:
        _fina_walk(rec, base_dir, imgs, links)
    _fina_walk(ag, base_dir, imgs, links)

    ae = (rec or {}).get("agent_evidence")
    ae = ae if isinstance(ae, dict) else {}

    def pick(*keys):
        for k in keys:
            for d in (rec or {}, ae, ag):
                v = d.get(k)
                if v not in (None, "", [], {}):
                    return v
        return None

    text = pick("agent_evidence", "evidence", "summary")
    if isinstance(text, (dict, list)):
        text = _json.dumps(text, ensure_ascii=False)
    quotes = pick("quotes")
    sheet = fina_path(base_dir + "/agent_evidence_sheet.jpg") if base_dir else None
    return {
        "stem": stem, "id": b.get("id"), "scene": sc.get("key"), "scene_name": sc.get("name"),
        "matched_by": how, "evidence_json": evrel,
        "name": pick("name"), "sidecar_name": ag.get("name"),
        "name_match": (str((rec or {}).get("name") or ae.get("name") or "") == str(ag.get("name") or "")) if rec else None, "level": pick("level"), "score": pick("score"),
        "match": pick("match"), "material": pick("material"), "color": pick("color"), "color_hex": pick("color_hex"),
        "osm": _fina_clean_osm(pick("osm_tags", "osm")), "wiki": pick("agent_wiki_pages", "wiki_pages"),
        "text": str(text)[:2000] if text else None,
        "quotes": quotes[:12] if isinstance(quotes, list) else quotes,
        "images": [{"url": "/fina/" + quote(r), "label": l, "path": r} for r, l in imgs.items()],
        "links": [{"url": u, "label": l} for u, l in links.items()],
        "sheet": ("/fina/" + quote(os.path.relpath(sheet, FINA).replace("\\", "/"))) if sheet and os.path.isfile(sheet) else None,
    }


# ---------------------------------------------------------------------------------------- material agent
def agent_url_for(path):
    """Map an absolute path in an imported report
    onto this checkout of material_agent and return a /agentfile/ URL when the file exists."""
    if not path:
        return None
    parts = [p for p in re.split(r"[\\/]+", str(path)) if p]
    for i, p in enumerate(parts):
        if p in AGENT_FILE_ROOTS:
            rel = parts[i:]
            local = os.path.join(AGENT, *rel)
            if os.path.isfile(local):
                return "/agentfile/" + "/".join(quote(x) for x in rel)
    return None


def local_url(run_dir, *rel):
    p = os.path.join(run_dir, *rel)
    if os.path.isfile(p):
        r = os.path.relpath(p, AGENT).replace("\\", "/")
        return "/agentfile/" + "/".join(quote(x) for x in r.split("/"))
    return None


def find_dict_with(obj, key, depth=0):
    if depth > 4:
        return None
    if isinstance(obj, dict):
        if key in obj and isinstance(obj.get(key), (str, int, float)):
            return obj
        for v in obj.values():
            r = find_dict_with(v, key, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj[:20]:
            r = find_dict_with(v, key, depth + 1)
            if r is not None:
                return r
    return None


def crit_score(crit, fallback=None):
    if not isinstance(crit, dict):
        return fallback
    for k in ("overall", "score", "total", "final"):
        v = num(crit.get(k))
        if v is not None:
            return v
    vals = [num(crit.get(k)) for k in ("structure", "material", "color", "quality", "tileable")]
    vals = [v for v in vals if v is not None]
    if vals:
        return round(sum(vals) / len(vals), 2)
    return fallback


def report_prompt(report, run_dir):
    best = report.get("best") or {}
    ev = report.get("evidence") or {}
    for src in (report, best, ev):
        if isinstance(src, dict):
            for k in ("prompt", "material_prompt", "positive_prompt"):
                v = src.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    md = read_text(os.path.join(run_dir, "final", "REPORT.md"))
    m = re.search(r"#+[^\n]*(?:提示词|[Pp]rompt)[^\n]*\n+(?:```[a-z]*\n)?(.+?)(?:\n```|\n#|\Z)", md, re.S)
    return m.group(1).strip() if m else ""


def legacy_score(md):
    m = re.search(r"(?:总分|综合|得分|评分|score)\D{0,8}([0-5](?:\.[0-9]+)?)", md, re.I)
    return float(m.group(1)) if m else None


def count_images(run_dir, limit=4000):
    n, first = 0, None
    for dp, dn, fn in os.walk(run_dir):
        dn.sort()
        for f in sorted(fn):
            if os.path.splitext(f)[1].lower() in IMG_EXT:
                n += 1
                if first is None:
                    first = os.path.join(dp, f)
                if n >= limit:
                    return n, first
    return n, first


def run_time(rid):
    m = re.match(r"^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})", rid)
    return "%s-%s-%s %s:%s:%s" % m.groups() if m else None


def summarize_run(rid):
    d = os.path.join(RUNS_DIR, rid)
    report = read_json(os.path.join(d, "report.json")) or read_json(os.path.join(d, "final", "report.json"))
    texture = local_url(d, "final", "texture.png")
    base = {"id": rid, "time": run_time(rid), "texture": texture}
    if isinstance(report, dict):
        best = report.get("best") or {}
        crit = best.get("critique") or {}
        ev = report.get("evidence") or {}
        vision = find_dict_with(ev, "material") or {}
        clean_best = report.get("clean_best") or {}
        addr = report.get("address") or {}
        base.update({
            "kind": "agent",
            "score": num(best.get("score")) if num(best.get("score")) is not None else crit_score(crit),
            "confidence": report.get("confidence"),
            "rounds": report.get("rounds_used"),
            "elapsed": num(report.get("elapsed_s")),
            "material": vision.get("material", ""),
            "color": vision.get("color", ""),
            "lighting": vision.get("lighting", ""),
            "address": addr.get("value", "") if isinstance(addr, dict) else str(addr or ""),
            "clean_status": report.get("clean_status"),
            "clean_score": crit_score(clean_best.get("critique"), num(clean_best.get("score"))),
            "thumb": texture or agent_url_for(best.get("path")),
            "images": None,
        })
        if not base["texture"]:
            base["texture"] = agent_url_for(report.get("final_image")) or agent_url_for(best.get("path"))
        return base
    n, first = count_images(d)
    md = read_text(os.path.join(d, "final", "REPORT.md"))
    kind = "empty" if n == 0 else "legacy" if md or texture else "incomplete" if (
        os.path.isfile(os.path.join(d, "state.json")) or os.path.isfile(os.path.join(d, "evidence.json"))) else "experiment"
    first_url = None
    if first:
        rel = os.path.relpath(first, AGENT).replace("\\", "/")
        first_url = "/agentfile/" + "/".join(quote(x) for x in rel.split("/"))
    base.update({"kind": kind, "score": legacy_score(md) if md else None, "images": n,
                 "thumb": texture or first_url, "material": "", "color": "", "lighting": "", "address": ""})
    return base


def list_runs():
    if not os.path.isdir(RUNS_DIR):
        return []
    out = []
    for rid in sorted(os.listdir(RUNS_DIR), reverse=True):
        if SAFE_ID.match(rid) and os.path.isdir(os.path.join(RUNS_DIR, rid)):
            try:
                out.append(summarize_run(rid))
            except Exception as e:  # one broken run must not hide the others
                out.append({"id": rid, "kind": "error", "error": str(e), "score": None})
    return out


def run_detail(rid):
    d = os.path.join(RUNS_DIR, rid)
    if not SAFE_ID.match(rid) or not os.path.isdir(d):
        return None
    out = summarize_run(rid)
    report = read_json(os.path.join(d, "report.json")) or read_json(os.path.join(d, "final", "report.json"))
    images = {}
    for key, names in (("texture", ["texture.png", "texture.jpg"]), ("reference", ["reference.jpg", "reference.png"]),
                       ("facade", ["facade.png", "facade.jpg"]), ("clean_view", ["clean_view.png", "clean_view.jpg"])):
        for n in names:
            u = local_url(d, "final", n)
            if u:
                images[key] = u
                break
    cands = []
    for sub in ("candidates", ""):
        root = os.path.join(d, sub) if sub else d
        if not os.path.isdir(root):
            continue
        for dp, dn, fn in os.walk(root):
            dn.sort()
            if not sub and os.path.basename(dp) == "final":
                continue
            for f in sorted(fn):
                if os.path.splitext(f)[1].lower() in IMG_EXT:
                    rel = os.path.relpath(os.path.join(dp, f), AGENT).replace("\\", "/")
                    url = "/agentfile/" + "/".join(quote(x) for x in rel.split("/"))
                    if url not in images.values() and all(c["url"] != url for c in cands):
                        cands.append({"url": url, "name": f})
            if len(cands) >= 60:
                break
        if cands:
            break
    out["images"] = images
    out["candidates"] = cands[:60]
    if isinstance(report, dict):
        best = report.get("best") or {}
        ev = report.get("evidence") or {}
        coord = report.get("coordinate") or {}
        clean_best = report.get("clean_best") or {}
        pois = []
        for p in (ev.get("pois") or [])[:20]:
            if isinstance(p, dict):
                pois.append({"title": p.get("title") or p.get("name", ""), "category": p.get("category") or p.get("type", ""),
                             "distance": p.get("distance") or p.get("_distance"), "address": p.get("address", "")})
        vision = find_dict_with(ev, "material") or {}
        out.update({
            "coordinate": coord.get("wgs84") if isinstance(coord, dict) else None,
            "vision": {k: vision.get(k) for k in ("material", "color", "lighting", "storeys", "style") if vision.get(k) is not None},
            "critique": best.get("critique") or {},
            "seam": num(best.get("seam")),
            "clean": clean_best.get("critique") or {},
            "prompt": report_prompt(report, d),
            "clean_prompt": report.get("clean_prompt") or "",
            "pois": pois,
        })
    else:
        out.update({"critique": {}, "clean": {}, "prompt": report_prompt({}, d), "pois": [], "vision": {}})
    return out


def agent_status():
    cfg = {}
    env_map = {}
    reason = ""
    try:
        spec = importlib.util.spec_from_file_location("_twin_agent_config", os.path.join(AGENT, "agent", "config.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cfg = dict(getattr(mod, "DEFAULTS", {}) or {})
        for name in dir(mod):
            v = getattr(mod, name)
            if isinstance(v, dict) and v and all(isinstance(x, str) and x.isupper() for x in v.values()) and name != "DEFAULTS":
                env_map = v
    except Exception as e:
        reason = "无法读取 agent/config.py：%s" % e
    local = read_json(os.path.join(AGENT, "config.local.json"), {}) or {}
    if isinstance(local, dict):
        cfg.update(local)
    for k, env in env_map.items():
        if os.environ.get(env):
            cfg[k] = os.environ[env]
    keys = {k: bool(str(cfg.get(k) or "").strip()) for k in ("tencent_key", "amap_key", "mapillary_token", "glm_key")}
    secrets_in_repo = any(SECRET_KEY.search(k) and str(v or "").strip() for k, v in (local.items() if isinstance(local, dict) else []))
    sd_dir = str(cfg.get("sd_dir") or "")
    models_dir = os.path.dirname(os.path.dirname(os.path.dirname(sd_dir))) if sd_dir else ""
    sd_ok = bool(sd_dir) and os.path.isdir(sd_dir)
    torch_ok = bool(gpu_info())
    can = sd_ok and torch_ok and not reason
    if not reason:
        if not sd_ok:
            reason = "Stable Diffusion 权重目录不存在（%s）。把 realistic-vision-v51 / ControlNet / IP-Adapter 放到该目录，或在 config.local.json 中设置 sd_dir、cn_canny、cn_depth、ipa_dir 后即可生成。" % (sd_dir or "未配置")
        elif not torch_ok:
            reason = "未检测到 NVIDIA GPU。"
    return {"root": AGENT, "models_dir": models_dir, "models_dir_exists": bool(models_dir) and os.path.isdir(models_dir),
            "sd_dir": sd_dir, "sd_dir_exists": sd_ok, "keys": keys, "secrets_in_repo": bool(secrets_in_repo),
            "can_generate": bool(can), "reason": "" if can else reason}


def memory_info():
    mem = os.path.join(AGENT, "memory")
    index = read_json(os.path.join(mem, "index.json"), {}) or {}
    failures = read_json(os.path.join(mem, "failures.json"), {}) or {}

    def counts_of(obj, depth=0):
        if depth > 3:
            return None
        if isinstance(obj, dict):
            if obj and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in obj.values()):
                return {str(k): v for k, v in obj.items()}
            for k in ("counts", "by_type", "by_kind", "stats", "summary"):
                if k in obj:
                    r = counts_of(obj[k], depth + 1)
                    if r:
                        return r
            if obj and all(isinstance(v, list) for v in obj.values()):
                return {str(k): len(v) for k, v in obj.items()}
            for v in obj.values():
                r = counts_of(v, depth + 1)
                if r:
                    return r
        if isinstance(obj, list):
            c = {}
            for e in obj:
                if isinstance(e, dict):
                    t = e.get("type") or e.get("kind") or e.get("tag") or e.get("reason") or e.get("dim")
                    if t:
                        c[str(t)] = c.get(str(t), 0) + 1
            return c or None
        return None

    buildings = {}
    bdir = os.path.join(mem, "buildings")
    if os.path.isdir(bdir):
        for dp, _, fn in os.walk(bdir):
            for f in fn:
                if f.endswith(".json"):
                    b = read_json(os.path.join(dp, f), {}) or {}
                    hist = b.get("history") or b.get("attempts") or []
                    buildings[f[:-5]] = {"attempts": len(hist) if isinstance(hist, list) else hist,
                                         "best_score": b.get("best_score"), "address": b.get("address")}
    return {"index": index, "failure_counts": counts_of(failures) or {}, "buildings": buildings}


# ---------------------------------------------------------------------------------------- system
def gpu_info():
    def probe():
        exe = shutil.which("nvidia-smi")
        if not exe:
            return []
        try:
            out = subprocess.run([exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
                                 capture_output=True, text=True, timeout=6).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        res = []
        for line in out.strip().splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) >= 3:
                res.append({"name": p[0], "memory_total": p[1], "driver": p[2]})
        return res
    return CACHE.get("gpu", 300, probe)


def system_info():
    def build():
        return {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "gpu": gpu_info(),
            "legacy": {"url": LEGACY, "up": (legacy_ok := legacy_up())},
            "remote": {"host": REMOTE_HOST, "port": REMOTE_PORT, "up": (remote_ok := tcp_up(REMOTE_HOST, REMOTE_PORT))},
            "recon": {"mode": recon_mode(legacy_ok, remote_ok), "setting": RECON_MODE, "local": local_recon_info()},
            "agent": agent_status(),
            "studio": {"version": VERSION, "root": HERE, "exports_dir": EXPORTS},
            "paths": {"web3d": WEB3D, "agent": AGENT, "fina": FINA if FINA_ON else None},
        }
    return CACHE.get("system", 15, build)


def legacy_up():
    """True only when LEGACY answers like web3d/serve.py (GET /api/models -> JSON).

    A bare TCP probe is not enough: another application may own port 8080, so a port that
    accepts connections is not necessarily the reconstruction proxy.
    """
    u = urlparse(LEGACY)
    if not tcp_up(u.hostname or "127.0.0.1", u.port or 80):
        return False
    try:
        with urllib.request.urlopen(LEGACY + "/api/models", timeout=3) as r:
            if r.status != 200:
                return False
            data = json.loads(r.read().decode("utf-8", "replace"))
        return isinstance(data, (list, dict))
    except (urllib.error.URLError, OSError, ValueError):
        return False


def legacy_request(method, path, body=None, ctype=None, timeout=600):
    req = urllib.request.Request(LEGACY + path, data=body, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ---------------------------------------------------------------------------------------- local reconstruction
LOCAL_ENGINE = "local-dsm-splat"
LOCAL_NOTE = ("本机直建：正射影像（+ 可选 DSM GeoTIFF）生成地表/屋顶/立面高斯面元；有 DSM 时提取真实建筑高度，"
              "无 DSM 时只生成平坦地表。未做 SfM，未做 3DGS 光度优化，不是远端 3DGS 训练结果。")
MAGIC_LABEL = {"jpeg": "JPEG", "png": "PNG", "tiff": "TIFF", "bigtiff": "BigTIFF", "webp": "WebP", "erdas-img": "ERDAS IMG"}


def recon_limits():
    return {"image_ext": sorted(RECON_UPLOAD_EXT), "dsm_ext": sorted(RECON_DSM_EXT),
            "max_mb": MAX_UPLOAD // (1024 * 1024), "width_m": [5, 5000], "keep_days": RECON_KEEP_DAYS}


def sniff_bytes(h):
    """Format family from the first bytes of a raster, or None."""
    h = bytes(h or b"")
    if h[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if h[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if h[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if h[:4] in (b"II+\x00", b"MM\x00+"):
        return "bigtiff"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "webp"
    if h[:15] == b"EHFA_HEADER_TAG":
        return "erdas-img"
    return None


def clean_title(s, limit=60):
    return re.sub(r"[\x00-\x1f\x7f<>\"\\]", "", str(s or "")).strip()[:limit]
RECON_PROCS = {}
RECON_LOCK = threading.Lock()


def write_json_atomic(path, obj):
    tmp = "%s.%d.tmp" % (path, threading.get_ident())
    with path_lock(path):   # 同进程内的读写串行化，os.replace 不再被自己的读者卡住
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=1)
            for attempt in range(20):
                try:
                    os.replace(tmp, path)
                    return
                except PermissionError:   # 仅剩跨进程竞争（recon_local.py 也写这个状态文件）
                    time.sleep(0.05 * (attempt + 1))
            os.replace(tmp, path)
        except BaseException:
            # 序列化失败 / replace 最终失败 / 线程被中断：不留下半截 .tmp
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise


STALE_TMP = re.compile(r"\.json\.\d+\.tmp$")


def sweep_stale_tmp(max_age=60):
    """Remove *.json.<thread>.tmp left behind by a killed process (write_json_atomic never reached os.replace)."""
    n = 0
    now = time.time()
    for d in (RECON_JOBS, RECON_UPLOADS):
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if not STALE_TMP.search(f):
                continue
            p = os.path.join(d, f)
            try:
                if now - os.path.getmtime(p) > max_age:
                    os.remove(p)
                    n += 1
            except OSError:
                pass
    if n:
        log("stale tmp removed", n)
    return n


def _has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _script_deps(path):
    """Third-party modules imported at top level of a script (indented imports are optional)."""
    std = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names) | {"__future__"}
    mods = set()
    for line in read_text(path).splitlines():
        m = re.match(r"(?:from|import)\s+([A-Za-z_]\w*)", line)
        if m:
            mods.add(m.group(1))
    return sorted(m for m in mods if m not in std)


def local_recon_info():
    info = {"engine": LOCAL_ENGINE, "script": RECON_SCRIPT, "python": sys.executable, "outputs": RECON_DIR,
            "requires_dsm": False, "note": LOCAL_NOTE, "available": False, "deps": [], "missing": [], "reason": "",
            "limits": recon_limits()}
    if not os.path.isfile(RECON_SCRIPT):
        info["reason"] = "缺少 %s" % RECON_SCRIPT
        return info
    deps = _script_deps(RECON_SCRIPT)
    missing = [m for m in deps if not _has_module(m)]
    info["deps"] = deps
    info["missing"] = missing
    if missing:
        info["reason"] = "当前 Python 缺少依赖：" + ", ".join(missing)
        return info
    info["available"] = True
    return info


def recon_mode(legacy=None, remote=None):
    """'remote' = forward to the web3d proxy + citytwin host; 'local' = recon_local.py on this box."""
    if RECON_MODE in ("local", "remote"):
        return RECON_MODE
    if legacy is None:
        legacy = legacy_up()
    if remote is None:
        remote = tcp_up(REMOTE_HOST, REMOTE_PORT)
    return "remote" if (legacy and remote) else "local"


def recon_status_path(jid):
    return os.path.join(RECON_JOBS, jid + ".json")


def recon_upload_manifest(jid):
    return os.path.join(RECON_UPLOADS, jid + ".json")


def recon_job_started(jid):
    """'running' / 'done' when the job must not be started again, else None."""
    job = RECON_PROCS.get(jid)
    if job is not None and job["proc"].poll() is None:
        return "running"
    st = local_recon_job(jid, drop_cache=False)
    if isinstance(st, dict) and st.get("status") in ("running", "done"):
        return st.get("status")
    return None


def find_duplicate_upload(field, sha, exclude=""):
    if not sha or not os.path.isdir(RECON_UPLOADS):
        return None
    for f in sorted(os.listdir(RECON_UPLOADS), reverse=True):
        if not f.endswith(".json") or f[:-5] == exclude:
            continue
        man = read_json(os.path.join(RECON_UPLOADS, f), None)
        if isinstance(man, dict) and man.get(field) == sha:
            return f[:-5]
    return None


def prune_recon_uploads(days=RECON_KEEP_DAYS):
    """Delete raw uploaded rasters older than `days` (manifest kept, marked purged); models stay."""
    if not os.path.isdir(RECON_UPLOADS):
        return 0
    root = os.path.abspath(RECON_UPLOADS)
    now = time.time()
    n = 0
    for f in os.listdir(RECON_UPLOADS):
        p = os.path.join(RECON_UPLOADS, f)
        if f.endswith(".part"):
            try:
                if os.path.getmtime(p) < now - 3600:
                    os.remove(p)
            except OSError:
                pass
            continue
        jid = f[:-5]
        if not f.endswith(".json") or not SAFE_ID.match(jid):
            continue
        job = RECON_PROCS.get(jid)
        if job is not None and job["proc"].poll() is None:
            continue
        man = read_json(p, None)
        if not isinstance(man, dict) or man.get("purged"):
            continue
        try:
            if os.path.getmtime(p) > now - days * 86400:
                continue
        except OSError:
            continue
        for k in ("image", "dsm"):
            fp = man.get(k)
            if fp and os.path.dirname(os.path.abspath(fp)) == root and os.path.isfile(fp):
                try:
                    os.remove(fp)
                    n += 1
                except OSError:
                    pass
        man["purged"] = time.strftime("%Y-%m-%d %H:%M:%S")
        write_json_atomic(p, man)
    if n:
        log("recon uploads purged", n)
    return n


def recon_job_list(limit=RECON_HISTORY):
    """Recent user uploads with their reconstruction status, newest first."""
    out = []
    if not os.path.isdir(RECON_UPLOADS):
        return out
    names = sorted((f for f in os.listdir(RECON_UPLOADS) if f.endswith(".json") and SAFE_ID.match(f[:-5])), reverse=True)
    for f in names[:limit]:
        jid = f[:-5]
        man = read_json(os.path.join(RECON_UPLOADS, f), None)
        if not isinstance(man, dict):
            continue
        st = local_recon_job(jid, drop_cache=False) or {}
        status = st.get("status") or "uploaded"
        out.append({
            "id": jid, "title": man.get("title") or "", "created": man.get("created"),
            "image_name": man.get("image_name"), "image_size": man.get("image_size"),
            "dsm_name": man.get("dsm_name"), "dsm_size": man.get("dsm_size"), "width": man.get("width"),
            "flat": not man.get("dsm"), "purged": bool(man.get("purged")),
            "status": status, "stage": st.get("stage"), "progress": st.get("progress"), "msg": st.get("msg"),
            "error": st.get("error"), "cancelled": bool(st.get("cancelled")), "elapsed": st.get("elapsed"),
            "model": st.get("model"), "counts": st.get("counts"), "preview": st.get("preview"),
            "scene_url": st.get("scene_url"), "splat_url": st.get("splat_url"), "buildings_url": st.get("buildings_url"),
        })
    return out


def _cache_drop(*keys):
    for k in keys:
        try:
            CACHE.drop(k)
        except Exception:
            pass


def start_local_recon(jid, image, dsm, width, title=""):
    info = local_recon_info()
    if not info["available"]:
        raise ValueError("本机重建不可用：" + info["reason"])
    if not os.path.isfile(image):
        raise ValueError("影像文件不存在：%s" % os.path.basename(image))
    if dsm and not os.path.isfile(dsm):
        raise ValueError("DSM 文件不存在：%s" % os.path.basename(dsm))
    stem = jid + "_local"
    stp = recon_status_path(jid)
    logp = os.path.join(RECON_JOBS, jid + ".log")
    with RECON_LOCK:
        busy = [k for k, j in RECON_PROCS.items() if j["proc"].poll() is None]
        if busy:
            raise ValueError("已有本机重建任务在运行：%s" % busy[0])
        for d in (RECON_MODELS, RECON_PREVIEWS, RECON_JOBS):
            os.makedirs(d, exist_ok=True)
        base = {"engine": LOCAL_ENGINE, "mode": "local", "job": jid, "stem": stem, "started": time.time(),
                "flat": not dsm, "title": title}
        write_json_atomic(stp, dict(base, status="running", state="running", stage="queued", progress=1, done=False,
                                    msg=("本机直建已启动：影像 + DSM" if dsm else "本机直建已启动：仅影像（平坦地表）")
                                    + "，未做 SfM / 3DGS 光度优化"))
        cmd = [sys.executable, RECON_SCRIPT, "--image", image]
        if dsm:
            cmd += ["--dsm", dsm]
        cmd += ["--width", "%g" % width, "--out-dir", RECON_MODELS, "--preview-dir", RECON_PREVIEWS,
                "--stem", stem, "--title", title or ("本机重建 · " + jid), "--status", stp]
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        fh = open(logp, "w", encoding="utf-8")
        try:
            proc = subprocess.Popen(cmd, cwd=HERE, stdout=fh, stderr=subprocess.STDOUT, env=env,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            fh.close()
            write_json_atomic(stp, dict(base, status="error", state="error", done=False,
                                        error="无法启动 recon_local.py：%s" % e))
            raise ValueError("无法启动 recon_local.py：%s" % e)
        job = {"id": jid, "stem": stem, "proc": proc, "log": logp, "status_path": stp,
               "started": time.time(), "cmd": cmd, "code": None}
        RECON_PROCS[jid] = job

    def watch():
        code = proc.wait()
        fh.close()
        job["code"] = code
        st = read_json(stp, None)
        st = st if isinstance(st, dict) else {}
        if code != 0 or st.get("status") != "done":
            tail = read_text(logp).splitlines()[-30:]
            st.update({"status": "error", "state": "error", "done": False, "exit_code": code,
                       "error": st.get("error") or ("recon_local.py 退出码 %d：%s" % (code, tail[-1] if tail else "无输出")),
                       "log_tail": tail})
            if job.get("cancelled"):
                st.update({"cancelled": True, "stage": "cancelled", "error": "已由用户取消", "msg": "已由用户取消"})
            write_json_atomic(stp, st)
            for d in (RECON_MODELS, RECON_PREVIEWS):
                for fn in (os.listdir(d) if os.path.isdir(d) else []):
                    if fn.startswith(stem + ".") and fn.endswith(".part"):
                        try:
                            os.remove(os.path.join(d, fn))
                        except OSError:
                            pass
        _cache_drop("models", "system")
        log("local recon", jid, "exit", code, st.get("status"))

    threading.Thread(target=watch, daemon=True).start()
    log("local recon started", jid, " ".join(cmd))
    return job


def local_recon_job(jid, drop_cache=True):
    """Status of a local job (data/recon/jobs/<id>.json) in the shape modeling.js polls, or None."""
    stp = recon_status_path(jid)
    job = RECON_PROCS.get(jid)
    if job is None and not os.path.isfile(stp):
        return None
    alive = job is not None and job["proc"].poll() is None
    st = read_json(stp, None)
    if not isinstance(st, dict):
        st = ({"status": "running", "stage": "starting", "progress": 1, "msg": ""} if alive
              else {"status": "error", "error": "状态文件无法读取：%s" % os.path.basename(stp)})
    st = dict(st)
    if job is None and st.get("status") == "running":
        try:
            stale = time.time() - os.path.getmtime(stp) > 900
        except OSError:
            stale = False
        if stale:
            st.update({"status": "error", "stage": "error", "error": "任务中断：状态超过 15 分钟未更新（服务可能已重启），请重新提交"})
    if job is not None and job.get("cancelled") and st.get("status") != "done":
        st.update({"status": "error", "cancelled": True, "stage": "cancelled", "error": "已由用户取消", "msg": "已由用户取消"})
    man = read_json(recon_upload_manifest(jid), None)
    if isinstance(man, dict):
        st["title"] = man.get("title") or st.get("title") or ""
        st["flat"] = not man.get("dsm")
        st["image_name"] = man.get("image_name")
        st["dsm_name"] = man.get("dsm_name")
    if alive and st.get("status") == "done":
        st["status"] = "running"     # outputs are written; wait for the process to exit cleanly
        st["done"] = False
    st["job"] = st["id"] = jid
    st["mode"] = "local"
    st.setdefault("engine", LOCAL_ENGINE)
    st["state"] = st.get("status")
    st["note"] = LOCAL_NOTE
    if st.get("status") == "done" and st.get("model"):
        model = os.path.basename(str(st["model"]))
        stem = model[:-6] if model.lower().endswith(".splat") else model
        st["scene_url"] = "#/scene/" + quote(model)
        st["splat_url"] = "/splat/" + quote(model)
        if find_file(MODEL_DIRS, stem + ".buildings.json"):
            st["buildings_url"] = "/api/buildings/" + quote(stem)
        if find_file((RECON_PREVIEWS,), stem + ".png"):
            st["preview"] = "/preview/" + quote(stem + ".png")
        if drop_cache:
            _cache_drop("models")
    if st.get("status") == "error" and "log_tail" not in st and job is not None:
        st["log_tail"] = read_text(job["log"]).splitlines()[-30:]
    return st


def cancel_local_recon(jid):
    job = RECON_PROCS.get(jid)
    if job is None or job["proc"].poll() is not None:
        raise ValueError("任务 %s 当前没有在运行" % jid)
    job["cancelled"] = True
    st = read_json(job["status_path"], None)
    st = st if isinstance(st, dict) else {}
    st.update({"status": "error", "state": "error", "done": False, "cancelled": True, "stage": "cancelled",
               "error": "已由用户取消", "msg": "已由用户取消"})
    write_json_atomic(job["status_path"], st)
    try:
        job["proc"].terminate()
    except OSError:
        pass
    log("local recon cancelled", jid)
    return st


# ---------------------------------------------------------------------------------------- agent jobs
JOBS = {}
JOBS_LOCK = threading.Lock()


def start_agent_job(params):
    st = agent_status()
    if not st["can_generate"]:
        raise ValueError(st["reason"])
    with JOBS_LOCK:
        if any(j["status"] == "running" for j in JOBS.values()):
            raise ValueError("已有一个材质生成任务在运行。")
    lat, lon = num(params.get("lat")), num(params.get("lon"))
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("经纬度无效。")
    rounds = int(min(6, max(1, num(params.get("rounds")) or 3)))
    seeds = int(min(16, max(1, num(params.get("seeds")) or 8)))
    os.makedirs(JOBS_DIR, exist_ok=True)
    jid = time.strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6]
    logp = os.path.join(JOBS_DIR, jid + ".log")
    cmd = [sys.executable, "-m", "agent", "run", "--lat", "%.6f" % lat, "--lon", "%.6f" % lon,
           "--rounds", str(rounds), "--seeds", str(seeds)]
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    fh = open(logp, "w", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=AGENT, stdout=fh, stderr=subprocess.STDOUT, env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    job = {"id": jid, "status": "running", "cmd": cmd, "log": logp, "proc": proc, "fh": fh, "started": time.time(), "run_id": None}
    with JOBS_LOCK:
        JOBS[jid] = job

    def watch():
        code = proc.wait()
        fh.close()
        txt = read_text(logp)
        m = re.findall(r"runs[\\/](\d{8}_\d{6})", txt)
        job["run_id"] = m[-1] if m else None
        job["status"] = "done" if code == 0 else "failed(%d)" % code
        CACHE.drop("runs")
        log("agent job", jid, job["status"])
    threading.Thread(target=watch, daemon=True).start()
    log("agent job started", jid, " ".join(cmd))
    return jid


def agent_job_status(jid):
    job = JOBS.get(jid)
    if not job:
        return None
    lines = read_text(job["log"]).splitlines()
    return {"id": jid, "status": job["status"], "run_id": job["run_id"], "log_tail": lines[-40:],
            "elapsed": round(time.time() - job["started"], 1)}


# ---------------------------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "TwinStudio/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("TWIN_VERBOSE"):
            log(self.address_string(), fmt % args)

    # ---- responses
    def _headers(self, code, ctype, length, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._headers(code, "application/json; charset=utf-8", len(body), {"Cache-Control": "no-store"})
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, code, msg):
        self._json({"ok": False, "error": msg}, code)

    # ---- local reconstruction fallback (recon_local.py: no SfM, no photometric 3DGS)
    def _save_upload(self, path, limit, magic=None):
        """Stream the body to `path` via .part; `magic` = allowed sniff_bytes() families (checked on the first chunk)."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            self.close_connection = True
            raise ValueError("上传内容为空（0 字节）")
        if n > limit:
            self.close_connection = True
            raise ValueError("文件过大：%.1f MB，上限 %d MB" % (n / 1048576.0, limit // (1024 * 1024)))
        tmp = path + ".part"
        left = n
        fam = None
        h = hashlib.sha256()
        try:
            with open(tmp, "wb") as f:
                while left > 0:
                    buf = self.rfile.read(min(CHUNK, left))
                    if not buf:
                        break
                    if left == n:
                        fam = sniff_bytes(buf[:32])
                        if magic is not None and fam not in magic:
                            self.close_connection = True
                            raise ValueError("文件内容与扩展名不符：检测到 %s，应为 %s" % (
                                MAGIC_LABEL.get(fam, "未知格式"), " / ".join(sorted(MAGIC_LABEL.get(m, m) for m in magic))))
                    f.write(buf)
                    h.update(buf)
                    left -= len(buf)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        if left:
            self.close_connection = True
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise ValueError("上传中断，还差 %d 字节" % left)
        os.replace(tmp, path)
        return {"size": n, "sha256": h.hexdigest(), "format": fam}

    def _recon_local_upload(self):
        q = parse_qs(urlparse(self.path).query)

        def g(k, d=""):
            return (q.get(k) or [d])[0]

        kind = g("kind")
        if kind not in ("image", "dsm"):
            self.close_connection = True
            return self._error(400, "kind 必须是 image 或 dsm")
        raw_name = os.path.basename(g("name", "upload.img").replace("\\", "/"))
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", raw_name) or "upload.img"
        ext = os.path.splitext(name)[1].lower()
        shown = clean_title(raw_name, 120) or name
        width = min(5000.0, max(5.0, num(g("width", "220")) or 220.0))
        title = clean_title(g("title"))
        os.makedirs(RECON_UPLOADS, exist_ok=True)
        if kind == "image":
            if ext not in RECON_UPLOAD_EXT:
                self.close_connection = True
                return self._error(415, "不支持的影像格式「%s」，请上传 %s" % (
                    ext or "无扩展名", " / ".join(sorted(e[1:].upper() for e in RECON_UPLOAD_EXT))))
            info = local_recon_info()
            if not info["available"]:
                self.close_connection = True
                return self._error(503, "本机重建不可用：" + info["reason"])
            prune_recon_uploads()
            jid = time.strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:4]
            img = os.path.join(RECON_UPLOADS, jid + ext)
            meta = self._save_upload(img, MAX_UPLOAD, RECON_EXT_MAGIC[ext])
            dup = find_duplicate_upload("image_sha256", meta["sha256"], exclude=jid)
            write_json_atomic(recon_upload_manifest(jid), {
                "id": jid, "image": img, "image_name": shown, "image_size": meta["size"],
                "image_sha256": meta["sha256"], "image_format": meta["format"], "width": width, "title": title,
                "created": time.strftime("%Y-%m-%d %H:%M:%S")})
            log("local recon upload", jid, shown, meta["size"], meta["format"], "dup=%s" % dup)
            return self._json({"ok": True, "id": jid, "mode": "local", "engine": LOCAL_ENGINE, "requires_dsm": False,
                               "image_name": shown, "size": meta["size"], "format": MAGIC_LABEL.get(meta["format"]),
                               "duplicate_of": dup, "note": LOCAL_NOTE})
        jid = g("id")
        if not SAFE_ID.match(jid):
            self.close_connection = True
            return self._error(400, "bad job id")
        if ext not in RECON_DSM_EXT:
            self.close_connection = True
            return self._error(415, "DSM 必须是 GeoTIFF（.tif / .tiff），收到「%s」" % (ext or "无扩展名"))
        man = read_json(recon_upload_manifest(jid), None)
        if not isinstance(man, dict) or not os.path.isfile(str(man.get("image", ""))):
            self.close_connection = True
            return self._error(404, "找不到任务 %s 的影像，请重新上传影像" % jid)
        state = recon_job_started(jid)
        if state:
            self.close_connection = True
            return self._error(409, "任务 %s %s，不能再替换 DSM" % (jid, "正在运行" if state == "running" else "已完成"))
        dsm = os.path.join(RECON_UPLOADS, jid + ".dsm" + ext)
        meta = self._save_upload(dsm, MAX_UPLOAD, RECON_EXT_MAGIC[ext])
        if meta["sha256"] == man.get("image_sha256"):
            os.remove(dsm)
            return self._error(400, "DSM 与影像是同一个文件，请选择单独的 DSM 高程文件")
        man.update({"dsm": dsm, "dsm_name": shown, "dsm_size": meta["size"], "dsm_sha256": meta["sha256"], "width": width})
        if title:
            man["title"] = title
        write_json_atomic(recon_upload_manifest(jid), man)
        log("local recon dsm", jid, shown, meta["size"])
        if g("start", "1").lower() in ("0", "false", "no"):
            return self._json({"ok": True, "id": jid, "mode": "local", "started": False, "dsm_name": shown, "size": meta["size"]})
        try:
            job = start_local_recon(jid, man["image"], dsm, width, man.get("title") or "")
        except ValueError as e:
            return self._error(409, str(e))
        return self._json({"ok": True, "id": jid, "mode": "local", "engine": LOCAL_ENGINE, "stem": job["stem"], "started": True,
                           "flat": False, "jobs": [{"id": jid}], "status_url": "/api/recon/job/" + quote(jid), "note": LOCAL_NOTE})

    def _recon_local_start(self):
        raw = self._body(64 * 1024)
        p = json.loads(raw.decode("utf-8") or "{}")
        jid = str(p.get("id", ""))
        if not SAFE_ID.match(jid):
            return self._error(400, "bad job id")
        man = read_json(recon_upload_manifest(jid), None)
        if not isinstance(man, dict) or not os.path.isfile(str(man.get("image", ""))):
            return self._error(404, "找不到任务 %s 的影像（可能已超过 %d 天被清理），请重新上传影像" % (jid, RECON_KEEP_DAYS))
        state = recon_job_started(jid)
        if state:
            return self._error(409, "任务 %s %s，无需重复启动" % (jid, "正在运行" if state == "running" else "已完成"))
        width = min(5000.0, max(5.0, num(p.get("width")) or num(man.get("width")) or 220.0))
        title = clean_title(p.get("title")) or man.get("title") or ""
        if title != man.get("title") or width != man.get("width"):
            man.update({"title": title, "width": width})
            write_json_atomic(recon_upload_manifest(jid), man)
        dsm = str(man.get("dsm") or "")
        if dsm and not os.path.isfile(dsm):
            dsm = ""
        try:
            job = start_local_recon(jid, man["image"], dsm, width, title)
        except ValueError as e:
            return self._error(409, str(e))
        return self._json({"ok": True, "id": jid, "mode": "local", "engine": LOCAL_ENGINE, "stem": job["stem"], "started": True,
                           "flat": not dsm, "jobs": [{"id": jid}], "status_url": "/api/recon/job/" + quote(jid), "note": LOCAL_NOTE})

    def _file(self, path, cache="no-cache", ctype=None):
        if not path or not os.path.isfile(path):
            return self._error(404, "not found")
        size = os.path.getsize(path)
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/json", "text/javascript"):
            ctype += "; charset=utf-8"
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range")
        extra = {"Accept-Ranges": "bytes", "Cache-Control": cache,
                 "Last-Modified": time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(os.path.getmtime(path)))}
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                return self._headers(416, "text/plain", 0, {"Content-Range": "bytes */%d" % size})
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                return self._headers(416, "text/plain", 0, {"Content-Range": "bytes */%d" % size})
            code = 206
            extra["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
        self._headers(code, ctype, end - start + 1, extra)
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(CHUNK, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def _body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            raise ValueError("请求体为空")
        if n > limit:
            raise ValueError("请求体过大（上限 %d MB）" % (limit // 1024 // 1024))
        return self.rfile.read(n)

    # ---- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        try:
            if path in ("/lite", "/lite/", "/static/lite", "/static/lite/", "/static/lite/index.html"):
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path in ("/", "/index.html"):
                return self._file(os.path.join(STATIC, "index.html"))
            if path.startswith("/static/"):
                return self._file(safe_join(STATIC, path[len("/static/"):]))
            if path.startswith("/vendor/"):
                return self._file(safe_join(VENDOR, path[len("/vendor/"):]), cache="public, max-age=86400")
            if path == "/api/health":
                return self._json({"ok": True, "version": VERSION})
            if path == "/api/system":
                return self._json(system_info())
            if path == "/api/models":
                return self._json({"models": CACHE.get("models", 10, list_models)})
            if path.startswith("/api/buildings/"):
                stem = path[len("/api/buildings/"):]
                if not SAFE_ID.match(stem):
                    return self._error(400, "bad model name")
                p = find_file(MODEL_DIRS, stem + ".buildings.json")
                data = load_buildings(p) if p else None
                return self._json(data if isinstance(data, dict) else {"buildings": []}, 200 if data else 404)
            if path.startswith("/api/evidence/"):
                rest = path[len("/api/evidence/"):].split("/")
                if len(rest) != 2 or not SAFE_ID.match(rest[0]) or not re.match(r"^-?[0-9]{1,7}$", rest[1]):
                    return self._error(400, "bad evidence request")
                ev = fina_evidence(rest[0], int(rest[1]))
                return self._json(ev if ev else {"error": "no evidence"}, 200 if ev else 404)
            if path.startswith("/fina/"):
                p = fina_path(path[len("/fina/"):]) if FINA_ON else None
                if not p or os.path.splitext(p)[1].lower() not in FINA_FILE_EXT or not os.path.isfile(p):
                    return self._error(404, "not found")
                return self._file(p, cache="public, max-age=3600")
            if path.startswith("/splat/"):
                name = path[len("/splat/"):]
                if not SAFE_ID.match(name) or not name.lower().endswith(".splat"):
                    return self._error(400, "bad model name")
                return self._file(find_file(MODEL_DIRS, name), cache="public, max-age=3600", ctype="application/octet-stream")
            if path.startswith("/preview/"):
                name = path[len("/preview/"):]
                if not SAFE_ID.match(name) or os.path.splitext(name)[1].lower() not in IMG_EXT:
                    return self._error(400, "bad preview name")
                return self._file(find_file(PREVIEW_DIRS, name), cache="public, max-age=3600")
            if path == "/api/runs":
                return self._json({"runs": CACHE.get("runs", 20, list_runs)})
            if path.startswith("/api/runs/"):
                d = run_detail(path[len("/api/runs/"):])
                return self._json(d) if d else self._error(404, "run not found")
            if path == "/api/memory":
                return self._json(memory_info())
            if path.startswith("/agentfile/"):
                rel = path[len("/agentfile/"):]
                top = rel.split("/", 1)[0]
                p = safe_join(AGENT, rel)
                if top not in AGENT_FILE_ROOTS or not p or os.path.splitext(p)[1].lower() not in AGENT_FILE_EXT:
                    return self._error(403, "forbidden")
                return self._file(p, cache="public, max-age=600")
            if path == "/api/exports":
                items = []
                if os.path.isdir(EXPORTS):
                    for f in sorted(os.listdir(EXPORTS), reverse=True):
                        if f.lower().endswith(".glb"):
                            items.append({"name": f, "size": os.path.getsize(os.path.join(EXPORTS, f)), "url": "/exports/" + quote(f)})
                return self._json({"exports": items, "dir": EXPORTS})
            if path.startswith("/exports/"):
                name = path[len("/exports/"):]
                if not SAFE_ID.match(name):
                    return self._error(400, "bad name")
                return self._file(os.path.join(EXPORTS, name), ctype="model/gltf-binary")
            if path == "/api/recon/jobs":
                return self._json({"ok": True, "jobs": recon_job_list(), "limits": recon_limits()})
            if path.startswith("/api/recon/job/"):
                ljid = unquote(path[len("/api/recon/job/"):])
                if SAFE_ID.match(ljid):
                    lst = local_recon_job(ljid)
                    if lst is not None:
                        return self._json(lst)
            if path.startswith("/api/recon/job/"):
                jid = path[len("/api/recon/job/"):]
                if not SAFE_ID.match(jid):
                    return self._error(400, "bad job id")
                if not legacy_up():
                    return self._error(404, "重建任务不存在：%s（本机无此任务，旧版 web3d 服务 %s 未运行）" % (unquote(jid), LEGACY))
                code, body = legacy_request("GET", "/job/%s.json" % quote(jid), timeout=30)
                return self._raw_json(code, body)
            if path.startswith("/api/agent/jobs/"):
                st = agent_job_status(path[len("/api/agent/jobs/"):])
                return self._json(st) if st else self._error(404, "job not found")
            return self._error(404, "not found")
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass
        except Exception as e:
            log("GET error", path, repr(e))
            try:
                self._error(500, str(e))
            except OSError:
                pass

    def _raw_json(self, code, body):
        try:
            obj = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            obj = {"ok": False, "error": body.decode("utf-8", "replace")[:400] or ("HTTP %d" % code)}
        return self._json(obj, code)

    def do_POST(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        q = parse_qs(u.query)
        g = lambda k, d="": (q.get(k) or [d])[0]
        try:
            if path == "/api/exports":
                body = self._body(MAX_EXPORT)
                if body[:4] != b"glTF":
                    return self._error(400, "不是有效的 GLB 文件")
                name = os.path.basename(g("name"))
                if not SAFE_ID.match(name) or not name.lower().endswith(".glb"):
                    name = time.strftime("twin_city_%Y%m%d_%H%M%S.glb")
                os.makedirs(EXPORTS, exist_ok=True)
                p = os.path.join(EXPORTS, name)
                with open(p, "wb") as f:
                    f.write(body)
                log("export saved", p, len(body))
                return self._json({"ok": True, "name": name, "path": p, "url": "/exports/" + quote(name), "size": len(body)})
            if path == "/api/recon/upload":
                if recon_mode() == "local":
                    return self._recon_local_upload()
                if not legacy_up():
                    return self._error(503, "旧版 web3d 服务（%s）未运行" % LEGACY)
                kind = g("kind")
                name = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(g("name", "upload.jpg"))) or "upload.jpg"
                width = num(g("width", "220")) or 220
                if kind not in ("image", "dsm"):
                    return self._error(400, "kind 必须是 image 或 dsm")
                ext = os.path.splitext(name)[1].lower()
                if ext not in (RECON_UPLOAD_EXT if kind == "image" else RECON_DSM_EXT):
                    self.close_connection = True
                    return self._error(415, "不支持的%s格式「%s」" % ("影像" if kind == "image" else "DSM", ext or "无扩展名"))
                params = {"kind": kind, "name": name}
                if kind == "dsm":
                    jid = g("id")
                    if not SAFE_ID.match(jid):
                        return self._error(400, "bad job id")
                    if not tcp_up(REMOTE_HOST, REMOTE_PORT):
                        return self._error(503, "远端重建主机 %s:%d 不可达" % (REMOTE_HOST, REMOTE_PORT))
                    params.update({"id": jid, "w": "%g" % width, "h": "1"})
                body = self._body(MAX_UPLOAD)
                code, resp = legacy_request("POST", "/upload?" + urlencode(params), body, self.headers.get("Content-Type") or "application/octet-stream")
                return self._raw_json(code, resp)
            if path == "/api/recon/cancel":
                p = json.loads(self._body(64 * 1024).decode("utf-8") or "{}")
                jid = str(p.get("id", ""))
                if not SAFE_ID.match(jid):
                    return self._error(400, "bad job id")
                try:
                    cancel_local_recon(jid)
                except ValueError as e:
                    return self._error(409, str(e))
                return self._json({"ok": True, "id": jid, "status": "error", "cancelled": True})
            if path == "/api/recon/start":
                if recon_mode() == "local":
                    return self._recon_local_start()
                p = json.loads(self._body(64 * 1024).decode("utf-8"))
                jid = str(p.get("id", ""))
                width = num(p.get("width")) or 220
                if not SAFE_ID.match(jid):
                    return self._error(400, "bad job id")
                if not tcp_up(REMOTE_HOST, REMOTE_PORT):
                    return self._error(503, "远端重建主机 %s:%d 不可达，任务无法派发" % (REMOTE_HOST, REMOTE_PORT))
                code, resp = legacy_request("POST", "/start?" + urlencode({"id": jid, "w": "%g" % width, "h": "1"}), b"", "application/octet-stream")
                return self._raw_json(code, resp)
            if path == "/api/agent/run":
                p = json.loads(self._body(64 * 1024).decode("utf-8"))
                try:
                    jid = start_agent_job(p)
                except ValueError as e:
                    return self._error(409, str(e))
                return self._json({"ok": True, "job_id": jid})
            return self._error(404, "not found")
        except ValueError as e:
            return self._error(400, str(e))
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass
        except Exception as e:
            log("POST error", path, repr(e))
            try:
                self._error(500, str(e))
            except OSError:
                pass


def main():
    sweep_stale_tmp()
    ap = argparse.ArgumentParser(description="Twin Studio server")
    ap.add_argument("--host", default=os.environ.get("TWIN_HOST", "127.0.0.1"),
                    help="监听地址，默认仅本机 127.0.0.1；局域网访问用 0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("TWIN_PORT", 8090)))
    ap.add_argument("--open", action="store_true", help="启动后打开浏览器")
    a = ap.parse_args()
    for p, label in ((STATIC, "static"), (os.path.join(VENDOR, "three", "three.module.js"), "vendor/three")):
        if not os.path.exists(p):
            sys.exit("缺少 %s：%s" % (label, p))
    os.makedirs(DATA, exist_ok=True)
    try:
        httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    except OSError as e:
        sys.exit("端口 %s:%d 无法监听（%s）。是否已有 Twin Studio 在运行？" % (a.host, a.port, e))
    httpd.daemon_threads = True
    pidfile = os.path.join(DATA, "server.pid")
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))
    url = "http://%s:%d/" % ("127.0.0.1" if a.host in ("0.0.0.0", "") else a.host, a.port)
    log("Twin Studio %s" % VERSION)
    log("web3d  :", WEB3D, "(%s)" % ("ok" if os.path.isdir(MODELS_DIR) else "missing models/"))
    log("agent  :", AGENT, "(%s)" % ("ok" if os.path.isdir(RUNS_DIR) else "missing runs/"))
    log("legacy :", LEGACY, "| remote:", "%s:%d" % (REMOTE_HOST, REMOTE_PORT))
    log("recon  :", "mode=%s" % RECON_MODE, "| local outputs:", RECON_DIR)
    log("serving:", url, "(listening on %s:%d)" % (a.host, a.port))
    if a.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        try:
            os.remove(pidfile)
        except OSError:
            pass
        log("stopped")


if __name__ == "__main__":
    main()
