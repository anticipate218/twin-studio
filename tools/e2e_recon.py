# -*- coding: utf-8 -*-
"""End-to-end check of image upload -> local reconstruction -> model library.

Usage:  python tools/e2e_recon.py            (spawns server.py on 127.0.0.1:8097, stops it afterwards)
        set E2E_EXTERNAL=1 & set E2E_PORT=8090 & python tools/e2e_recon.py   (use an already running server)
"""
import json, os, subprocess, sys, time, urllib.error, urllib.request
from urllib.parse import quote, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("E2E_PORT", "8097"))
EXTERNAL = os.environ.get("E2E_EXTERNAL") == "1"
B = "http://127.0.0.1:%d" % PORT
IMG = os.path.join(ROOT, "data", "doc_build", "img", "lite_top.jpg")
RESULTS = []


def req(method, path, data=None, ctype=None, timeout=60, raw=False):
    r = urllib.request.Request(B + path, data=data, method=method)
    if ctype:
        r.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            body = f.read()
            return f.status, (body if raw else json.loads(body or b"null"))
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body[:200].decode("utf-8", "replace")


def post_json(path, obj):
    return req("POST", path, json.dumps(obj).encode(), "application/json")


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, ("  | " + str(detail)[:240]) if detail else ""), flush=True)


def poll(jid, limit=240):
    t0, last = time.time(), None
    while time.time() - t0 < limit:
        code, s = req("GET", "/api/recon/job/" + quote(jid))
        if code != 200:
            return code, s
        line = (s.get("status"), s.get("stage"), s.get("progress"))
        if line != last:
            print("      poll %s %s %s" % line, flush=True)
            last = line
        if s.get("status") in ("done", "error"):
            return code, s
        time.sleep(0.8)
    return 0, {"status": "timeout"}


def main():
    proc = None
    if not EXTERNAL:
        logf = open(os.path.join(ROOT, "data", "e2e_server.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([sys.executable, "server.py", "--port", str(PORT)], cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT)
        print("spawned server pid", proc.pid, flush=True)
    try:
        for _ in range(60):
            try:
                code, sysinfo = req("GET", "/api/system", timeout=5)
                if code == 200:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            check("server up", False, "no /api/system response on " + B)
            return
        rec = sysinfo.get("recon") or {}
        lim = (rec.get("local") or {}).get("limits") or {}
        check("system: recon mode reported", rec.get("mode") in ("local", "remote", "legacy"), rec.get("mode"))
        check("system: upload limits exposed", lim.get("max_mb") and lim.get("image_ext"), lim)
        local = rec.get("mode") == "local"

        code, r = req("POST", "/api/recon/upload?kind=image&name=empty.jpg", b"", "image/jpeg")
        check("reject empty upload (4xx)", 400 <= code < 500, (code, r))
        code, r = req("POST", "/api/recon/upload?kind=image&name=fake.jpg", b"not really a jpeg file", "image/jpeg")
        check("reject extension/content mismatch (4xx)", 400 <= code < 500, (code, r))
        code, r = req("POST", "/api/recon/upload?kind=image&name=evil.exe", b"MZ\x90\x00" * 8, "application/octet-stream")
        check("reject unsupported extension (4xx)", 400 <= code < 500, (code, r))
        code, r = req("GET", "/api/recon/job/..%2F..%2Fserver.py")
        check("reject path-traversal job id (4xx)", 400 <= code < 500, (code, r))
        code, r = post_json("/api/recon/cancel", {"id": "nope-does-not-exist"})
        check("cancel unknown job -> 4xx", 400 <= code < 500, (code, r))

        data = open(IMG, "rb").read()
        code, up = req("POST", "/api/recon/upload?kind=image&name=lite_top.jpg&width=220&title=" + quote("e2e flat test"), data, "image/jpeg", timeout=120)
        check("upload real JPEG", code == 200 and isinstance(up, dict) and up.get("id"), (code, up))
        if code != 200:
            return
        jid = up["id"]
        code, up2 = req("POST", "/api/recon/upload?kind=image&name=lite_top_copy.jpg&width=220&title=" + quote("e2e cancel test"), data, "image/jpeg", timeout=120)
        check("second upload of same bytes flags duplicate_of", code == 200 and up2.get("duplicate_of") == jid, (code, up2))
        jid2 = up2.get("id") if code == 200 else None

        if not local:
            print("recon mode is not local; skipping local reconstruction checks", flush=True)
            return
        code, st = post_json("/api/recon/start", {"id": jid, "width": 220, "title": "e2e flat test"})
        check("start flat (no DSM) job", code == 200, (code, st))
        code, s = poll(jid)
        check("flat job reaches done", s.get("status") == "done", {k: s.get(k) for k in ("status", "stage", "error", "log_tail")})
        check("result marked flat", s.get("flat") is True, s.get("flat"))
        for key in ("splat_url", "preview", "scene_url"):
            check("result has " + key, bool(s.get(key)), s.get(key))
        if s.get("splat_url"):
            c, b = req("GET", s["splat_url"], raw=True, timeout=120)
            check("splat downloadable, size multiple of 32", c == 200 and len(b) > 0 and len(b) % 32 == 0, (c, len(b) if isinstance(b, bytes) else b))
        if s.get("preview"):
            c, b = req("GET", s["preview"], raw=True)
            check("preview image served", c == 200 and isinstance(b, bytes) and len(b) > 100, (c, len(b) if isinstance(b, bytes) else b))
        if s.get("buildings_url"):
            c, b = req("GET", s["buildings_url"])
            check("buildings JSON served", c == 200, (c, str(b)[:120]))
        if s.get("scene_url"):
            file = unquote(s["scene_url"].split("/scene/", 1)[-1])
            c, m = req("GET", "/api/models")
            files = [x.get("file") for x in (m.get("models") or [])] if isinstance(m, dict) else []
            check("model listed in /api/models with scene file id", file in files, (file, files[:5]))
        c, j = req("GET", "/api/recon/jobs")
        row = next((x for x in (j.get("jobs") or []) if x.get("id") == jid), None) if isinstance(j, dict) else None
        check("job in history as done", row and row.get("status") == "done", row)

        if jid2:
            code, st = post_json("/api/recon/start", {"id": jid2})
            check("start second job", code == 200, (code, st))
            code, cr = post_json("/api/recon/cancel", {"id": jid2})
            check("cancel running job accepted", code == 200, (code, cr))
            code, s2 = poll(jid2, 60)
            ok = s2.get("status") == "error" and s2.get("cancelled")
            if s2.get("status") == "done":
                print("      note: job finished before cancel took effect", flush=True)
            check("cancelled job ends as error+cancelled (or finished first)", ok or s2.get("status") == "done", {k: s2.get(k) for k in ("status", "cancelled", "error")})
            # 等工作线程把 exit_code 写进状态文件再停服，避免停服时正在写盘
            stp2 = os.path.join(ROOT, "data", "recon", "jobs", jid2 + ".json")
            t0, settled = time.time(), None
            while time.time() - t0 < 20:
                try:
                    with open(stp2, encoding="utf-8") as f:
                        d = json.load(f)
                    if "exit_code" in d or d.get("status") == "done":
                        settled = d
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.3)
            check("cancelled job worker settled (exit_code recorded)", settled is not None,
                  settled and {k: settled.get(k) for k in ("status", "exit_code", "cancelled")})
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(10)
            except Exception:
                proc.kill()
            print("server stopped", flush=True)
            ids = [x for x in (locals().get("jid"), locals().get("jid2")) if x]
            left = [f for d in (os.path.join(ROOT, "data", "recon", "jobs"), os.path.join(ROOT, "data", "recon", "uploads"))
                    if os.path.isdir(d) for f in os.listdir(d) if f.endswith(".tmp") and any(f.startswith(i) for i in ids)]
            if ids:
                check("no stale .tmp left for e2e jobs", not left, left)
        n_ok = sum(ok for _, ok in RESULTS)
        print("SUMMARY %d/%d passed" % (n_ok, len(RESULTS)), flush=True)
        if n_ok != len(RESULTS):
            sys.exit(1)


if __name__ == "__main__":
    main()
