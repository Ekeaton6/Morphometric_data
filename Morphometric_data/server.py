#!/usr/bin/env python3
"""
Cichlid morphometric annotation server.

Run:  python3 server.py            (uses config.json next to this file)
      python3 server.py --config /path/to/config.json

Dependencies: Pillow, openpyxl (only for .xlsx metadata).
Everything else is the Python standard library.
"""
import argparse
import csv
import datetime
import hashlib
import io
import json
import math
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import urllib.parse
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageOps, ImageStat

try:  # optional: automatic guesses need numpy + opencv
    import detect as DETECT
    DETECT_ERR = None
except Exception as _e:  # pragma: no cover
    DETECT = None
    DETECT_ERR = str(_e)

APP_VERSION = "0.5.0"
DETECT_VERSION = "1"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

Image.MAX_IMAGE_PIXELS = 200_000_000

STATUSES = ["not_started", "in_progress", "annotated", "approved"]
INITIALS_RE = re.compile(r"^[A-Za-z0-9]{1,6}$")


# --------------------------------------------------------------------------
# Config / static definitions
# --------------------------------------------------------------------------
def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def resolve(path):
    if path is None:
        return None
    path = os.path.expanduser(path)
    return path if os.path.isabs(path) else os.path.join(APP_DIR, path)


class App:
    def __init__(self, config_path, overrides=None):
        with open(config_path) as f:
            self.cfg = json.load(f)
        self.cfg.update({k: v for k, v in (overrides or {}).items() if v is not None})
        c = self.cfg
        self.image_dir = resolve(c["image_dir"])
        self.metadata_file = resolve(c["metadata_file"])
        self.data_dir = resolve(c.get("data_dir", "data"))
        self.cache_dir = os.path.join(self.data_dir, "cache")
        self.sidecar_dir = os.path.join(self.data_dir, "annotations")
        for d in (self.data_dir, self.cache_dir, self.sidecar_dir):
            os.makedirs(d, exist_ok=True)

        with open(resolve(c.get("landmarks_file", "landmarks.json"))) as f:
            self.landmarks = json.load(f)
        with open(resolve(c.get("colorchart_file", "colorchart.json"))) as f:
            self.colorchart = json.load(f)

        self.id_col = c.get("id_column", "File Name")
        self.group_col = c.get("group_column", "Species")
        self.fish_col = c.get("fish_id_column", "PIT ID")
        self.list_cols = c.get("list_columns", [])

        self.db_path = os.path.join(self.data_dir, "annotations.db")
        self.db_lock = threading.Lock()
        self.presence = {}
        self.presence_lock = threading.Lock()
        self._init_db()

        self.reload_index()
        self.migrate_landmarks()
        self._img_cache = OrderedDict()   # small LRU of decoded full images
        self._img_cache_lock = threading.Lock()
        self._info_cache = {}
        self.detect_dir = os.path.join(self.data_dir, "detect")
        os.makedirs(self.detect_dir, exist_ok=True)
        self._detect_locks = {}
        self._detect_lock = threading.Lock()
        self.detect_progress = {"done": 0, "total": 0, "running": False}
        if DETECT is None:
            print("Auto-detection unavailable (%s). Run: pip install numpy opencv-python-headless" % DETECT_ERR)
        elif self.cfg.get("precompute_detection", True):
            threading.Thread(target=self._precompute_detection, daemon=True).start()

    # ---------------- automatic guesses ----------------
    def detect_path(self, iid):
        return os.path.join(self.detect_dir, safe_name(iid) + ".json")

    def detect(self, iid, force=False):
        if DETECT is None:
            return {"available": False, "reason": DETECT_ERR}
        p = self.detect_path(iid)
        with self._detect_lock:
            lk = self._detect_locks.setdefault(iid, threading.Lock())
        with lk:
            if not force and os.path.exists(p):
                try:
                    with open(p) as f:
                        d = json.load(f)
                    if d.get("version") == DETECT_VERSION:
                        return d
                except ValueError:
                    pass
            t0 = datetime.datetime.now()
            with Image.open(self.paths[iid]) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                res = DETECT.detect_all(im)
            d = {"available": True, "version": DETECT_VERSION, "image_id": iid, "created": now_iso(),
                 "seconds": round((datetime.datetime.now() - t0).total_seconds(), 2), "result": res}
            tmp = p + ".tmp"
            with open(tmp, "w") as f:
                json.dump(d, f, default=float)
            os.replace(tmp, p)
            return d

    def _precompute_detection(self):
        """Background: compute guesses for images that aren't annotated yet, in list order."""
        import time
        time.sleep(3)
        try:
            anns = self.all_anns()
            todo = [i for i in self.sorted_ids() if i in self.paths and i not in anns]
            self.detect_progress = {"done": 0, "total": len(todo), "running": True}
            for iid in todo:
                try:
                    if not os.path.exists(self.detect_path(iid)):
                        self.detect(iid)
                except Exception as e:
                    print("detect failed for %s: %s" % (iid, e))
                self.detect_progress["done"] += 1
        finally:
            self.detect_progress["running"] = False

    # ---------------- metadata + image index ----------------
    def reload_index(self):
        self.metadata = load_metadata(self.metadata_file, self.cfg.get("metadata_sheet"))
        self.meta_columns = list(self.metadata[0].keys()) if self.metadata else []
        index = {}
        dupes = []
        for root, dirs, files in os.walk(self.image_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fn in files:
                if fn.startswith("."):
                    continue
                if os.path.splitext(fn)[1].lower() in (".jpg", ".jpeg", ".png", ".tif", ".tiff"):
                    if fn in index:
                        dupes.append(fn)
                    index[fn] = os.path.join(root, fn)
        self.paths = index
        self.meta_by_id = OrderedDict()
        for row in self.metadata:
            iid = str(row.get(self.id_col, "")).strip()
            if iid:
                self.meta_by_id[iid] = row
        missing = [i for i in self.meta_by_id if i not in self.paths]
        print("Metadata rows: %d | images found: %d | missing files: %d | duplicate names: %d"
              % (len(self.meta_by_id), len(self.paths), len(missing), len(dupes)))
        if missing:
            print("  first missing:", missing[:5])

        order = self.cfg.get("group_order")
        if not order:
            order = []
            for r in self.meta_by_id.values():
                g = str(r.get(self.group_col, "") or "Unassigned")
                if g not in order:
                    order.append(g)
        self.group_order = order

    def group_of(self, iid):
        return str(self.meta_by_id[iid].get(self.group_col, "") or "Unassigned")

    def sorted_ids(self):
        def key(iid):
            row = self.meta_by_id[iid]
            g = self.group_of(iid)
            gi = self.group_order.index(g) if g in self.group_order else 999
            fid = str(row.get(self.fish_col, ""))
            try:
                fnum = (0, float(fid), "")
            except ValueError:
                fnum = (1, 0, fid)
            return (gi, fnum, str(row.get("Photo Date", "")), iid)
        return sorted(self.meta_by_id.keys(), key=key)

    # ---------------- database ----------------
    def db(self):
        con = sqlite3.connect(self.db_path, timeout=30)
        con.row_factory = sqlite3.Row
        return con

    def _init_db(self):
        with self.db() as con:
            con.executescript("""
            CREATE TABLE IF NOT EXISTS annotations(
              image_id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL,
              annotator TEXT, annotated_at TEXT, approver TEXT, approved_at TEXT,
              created_at TEXT, updated_at TEXT, updated_by TEXT,
              landmark_set TEXT, app_version TEXT);
            CREATE TABLE IF NOT EXISTS history(
              id INTEGER PRIMARY KEY AUTOINCREMENT, image_id TEXT, ts TEXT, user TEXT,
              action TEXT, status TEXT, data TEXT);
            CREATE INDEX IF NOT EXISTS hist_img ON history(image_id);
            """)
            cols = [r[1] for r in con.execute("PRAGMA table_info(annotations)").fetchall()]
            if "rev" not in cols:  # revision counter for edit-conflict detection (added in 0.5)
                con.execute("ALTER TABLE annotations ADD COLUMN rev INTEGER DEFAULT 0")

    # ---------------- who has which image open ----------------
    PRESENCE_TIMEOUT = 45  # seconds without a heartbeat before a viewer is forgotten

    def presence_ping(self, iid, sid, user, dirty):
        import time
        now = time.time()
        with self.presence_lock:
            self._presence_prune(now)
            ent = self.presence.setdefault(iid, {}).setdefault(sid, {"since": now_iso()})
            ent.update(user=user or "", last=now, dirty=bool(dirty))
            others = [{"user": e["user"], "since": e["since"], "dirty": e["dirty"]}
                      for s, e in self.presence.get(iid, {}).items() if s != sid]
        return others

    def presence_leave(self, iid, sid):
        with self.presence_lock:
            self.presence.get(iid, {}).pop(sid, None)

    def presence_all(self):
        import time
        with self.presence_lock:
            self._presence_prune(time.time())
            return {iid: [e["user"] for e in d.values()] for iid, d in self.presence.items() if d}

    def _presence_prune(self, now):
        for iid in list(self.presence):
            d = self.presence[iid]
            for s in [s for s, e in d.items() if now - e["last"] > self.PRESENCE_TIMEOUT]:
                d.pop(s)
            if not d:
                self.presence.pop(iid)

    def get_ann(self, iid, con=None):
        own = con is None
        con = con or self.db()
        r = con.execute("SELECT * FROM annotations WHERE image_id=?", (iid,)).fetchone()
        if own:
            con.close()
        if not r:
            return None
        d = dict(r)
        d["data"] = json.loads(d["data"])
        return d

    def all_anns(self):
        con = self.db()
        rows = con.execute("SELECT * FROM annotations").fetchall()
        con.close()
        out = {}
        for r in rows:
            d = dict(r)
            d["data"] = json.loads(d["data"])
            out[d["image_id"]] = d
        return out

    def migrate_landmarks(self):
        """Convert annotations saved under an older version of this landmark set (renumbering
        per landmarks.json 'migrations'). The database is backed up first. Records that were
        'annotated' or 'approved' go back to 'in progress' because the new points still need
        placing; every change is written to the history."""
        migs = self.landmarks.get("migrations") or []
        if not migs:
            return
        name, cur = str(self.landmarks.get("name")), self.lm_set_tag()
        con = self.db()
        rows = [dict(r) for r in con.execute("SELECT * FROM annotations").fetchall()]
        con.close()
        todo = []
        for r in rows:
            tag = r.get("landmark_set") or ""
            nm, _, ver = tag.partition("@")
            if nm != name or tag == cur:
                continue
            m = next((m for m in migs if ver in m.get("from_versions", [])), None)
            if m:
                todo.append((r, m))
        if not todo:
            return
        import shutil
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = os.path.join(self.data_dir, "annotations_backup_before_%s_%s.db" % (safe_name(cur), stamp))
        shutil.copy2(self.db_path, backup)
        ts = now_iso()
        n_down = 0
        with self.db_lock, self.db() as con:
            for r, m in todo:
                data = json.loads(r["data"])
                old = data.get("landmarks") or {}
                data["landmarks"] = {m["map"][k]: v for k, v in old.items() if k in m["map"]}
                data.setdefault("migration_log", []).append(
                    {"ts": ts, "from": r["landmark_set"], "to": cur,
                     "dropped": sorted(k for k in old if k not in m["map"])})
                status = r["status"]
                new_status = "in_progress" if status in ("annotated", "approved") else status
                if new_status != status:
                    n_down += 1
                con.execute("""UPDATE annotations SET data=?, status=?, landmark_set=?,
                               approver=CASE WHEN ?='approved' THEN NULL ELSE approver END,
                               approved_at=CASE WHEN ?='approved' THEN NULL ELSE approved_at END
                               WHERE image_id=?""",
                            (json.dumps(data), new_status, cur, status, status, r["image_id"]))
                con.execute("INSERT INTO history(image_id,ts,user,action,status,data) VALUES (?,?,?,?,?,?)",
                            (r["image_id"], ts, "SYSTEM",
                             "landmarks renumbered %s -> %s%s" % (r["landmark_set"], cur,
                                 ("; status %s -> %s (new points to place)" % (status, new_status)) if new_status != status else ""),
                             new_status, json.dumps(data)))
        for r, _ in todo:
            rec = self.get_ann(r["image_id"])
            if rec and r["image_id"] in self.meta_by_id:
                try:
                    self.write_sidecar(r["image_id"], rec)
                except Exception as e:
                    print("sidecar failed for %s: %s" % (r["image_id"], e))
        print("Migrated %d annotation(s) to %s (%d set back to 'in progress'). Backup: %s"
              % (len(todo), cur, n_down, backup))

    def lm_set_tag(self):
        return "%s@%s" % (self.landmarks.get("name"), self.landmarks.get("version"))

    def save(self, iid, data, user, action, base_rev=None, force=False):
        """base_rev = revision the client last loaded/saved (-1 = it saw no saved annotation).
        If someone else saved in between, refuse (409, conflict) unless force=True."""
        ts = now_iso()
        with self.db_lock, self.db() as con:
            cur = self.get_ann(iid, con)
            if cur and cur["status"] == "approved":
                raise ApiError(409, "This annotation is approved and locked. Reopen it to edit.")
            cur_rev = (cur.get("rev") or 0) if cur else -1
            if base_rev is not None and not force and int(base_rev) != cur_rev:
                raise ApiError(409, "%s saved this image at %s, after you opened it."
                               % (cur["updated_by"] or "Someone", cur["updated_at"]),
                               {"conflict": True, "updated_by": cur["updated_by"],
                                "updated_at": cur["updated_at"], "rev": cur_rev})
            new_rev = cur_rev + 1 if cur else 1
            if action == "submit":
                status = "annotated"
            elif cur and cur["status"] == "annotated":
                status = "annotated"
            else:
                status = "in_progress"
            annotator = user if action == "submit" else (cur["annotator"] if cur else None)
            annotated_at = ts if action == "submit" else (cur["annotated_at"] if cur else None)
            created = cur["created_at"] if cur else ts
            con.execute("""INSERT OR REPLACE INTO annotations
                (image_id,status,data,annotator,annotated_at,approver,approved_at,created_at,updated_at,updated_by,landmark_set,app_version,rev)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (iid, status, json.dumps(data), annotator, annotated_at, None, None,
                         created, ts, user, self.lm_set_tag(), APP_VERSION, new_rev))
            if action != "autosave" or (force and cur):
                con.execute("INSERT INTO history(image_id,ts,user,action,status,data) VALUES (?,?,?,?,?,?)",
                            (iid, ts, user, action + (" (overwrote %s's newer save)" % cur["updated_by"] if force and cur and base_rev is not None and int(base_rev) != cur_rev else ""),
                             status, json.dumps(data)))
        rec = self.get_ann(iid)
        self.write_sidecar(iid, rec)
        return rec

    def approve(self, iid, user):
        ts = now_iso()
        with self.db_lock, self.db() as con:
            cur = self.get_ann(iid, con)
            if not cur or cur["status"] != "annotated":
                raise ApiError(400, "Only images marked 'Annotated' can be approved.")
            if (cur["annotator"] or "").upper() == user.upper():
                raise ApiError(400, "The approver must be different from the annotator (%s)." % cur["annotator"])
            con.execute("UPDATE annotations SET status='approved', approver=?, approved_at=?, updated_at=?, updated_by=?, rev=COALESCE(rev,0)+1 WHERE image_id=?",
                        (user, ts, ts, user, iid))
            con.execute("INSERT INTO history(image_id,ts,user,action,status,data) VALUES (?,?,?,?,?,?)",
                        (iid, ts, user, "approve", "approved", json.dumps(cur["data"])))
        rec = self.get_ann(iid)
        self.write_sidecar(iid, rec)
        return rec

    def reopen(self, iid, user):
        ts = now_iso()
        with self.db_lock, self.db() as con:
            cur = self.get_ann(iid, con)
            if not cur or cur["status"] != "approved":
                raise ApiError(400, "Only approved annotations can be reopened.")
            con.execute("UPDATE annotations SET status='annotated', approver=NULL, approved_at=NULL, updated_at=?, updated_by=?, rev=COALESCE(rev,0)+1 WHERE image_id=?",
                        (ts, user, iid))
            con.execute("INSERT INTO history(image_id,ts,user,action,status,data) VALUES (?,?,?,?,?,?)",
                        (iid, ts, user, "reopen (approval by %s removed)" % cur["approver"], "annotated", json.dumps(cur["data"])))
        rec = self.get_ann(iid)
        self.write_sidecar(iid, rec)
        return rec

    def history(self, iid):
        con = self.db()
        rows = con.execute("SELECT ts,user,action,status FROM history WHERE image_id=? ORDER BY id DESC", (iid,)).fetchall()
        con.close()
        return [dict(r) for r in rows]

    # ---------------- derived values / sidecars ----------------
    def derived(self, rec):
        data = rec["data"]
        ppm = None
        ruler = data.get("ruler") or {}
        if ruler.get("present") and ruler.get("p1") and ruler.get("p2") and ruler.get("mm"):
            d = math.hypot(ruler["p2"][0] - ruler["p1"][0], ruler["p2"][1] - ruler["p1"][1])
            if d > 0 and float(ruler["mm"]) > 0:
                ppm = d / float(ruler["mm"])
        fish = data.get("fish")
        lms = OrderedDict()
        for lm in self.landmarks["landmarks"]:
            p = (data.get("landmarks") or {}).get(lm["id"])
            if not p:
                lms[lm["id"]] = None
                continue
            e = {"x": p.get("x"), "y": p.get("y"), "absent": bool(p.get("absent")), "moved": bool(p.get("moved"))}
            if fish and p.get("x") is not None and not e["absent"]:
                u, v = fish_frame(p["x"], p["y"], fish)
                e["u"], e["v"] = u, v
                if ppm:
                    e["u_mm"], e["v_mm"] = u / ppm, v / ppm
            lms[lm["id"]] = e
        return {"px_per_mm": ppm, "landmarks": lms}

    def image_info(self, iid):
        if iid in self._info_cache:
            return self._info_cache[iid]
        path = self.paths[iid]
        with Image.open(path) as im:
            w, h = im.size
            try:
                orient = im.getexif().get(0x0112, 1) or 1
            except Exception:
                orient = 1
        if orient in (5, 6, 7, 8):
            w, h = h, w
        info = {"width": w, "height": h, "exif_orientation": orient,
                "file_path": os.path.relpath(path, self.image_dir),
                "file_bytes": os.path.getsize(path)}
        self._info_cache[iid] = info
        return info

    def write_sidecar(self, iid, rec):
        out = OrderedDict()
        out["image_id"] = iid
        out["image"] = self.image_info(iid) if iid in self.paths else None
        out["metadata"] = self.meta_by_id.get(iid)
        for k in ("status", "annotator", "annotated_at", "approver", "approved_at",
                  "created_at", "updated_at", "updated_by", "landmark_set", "app_version"):
            out[k] = rec.get(k)
        out["annotation"] = rec["data"]
        out["derived"] = self.derived(rec)
        out["coordinate_notes"] = ("x,y = pixels in the full-resolution image after applying EXIF orientation, origin top-left. "
                                   "u,v = pixels in the fish frame: u along the fish box from the head edge toward the tail, "
                                   "v from the dorsal edge of the box toward ventral. *_mm = divided by px_per_mm.")
        fn = os.path.join(self.sidecar_dir, safe_name(iid) + ".json")
        tmp = fn + ".tmp"
        with open(tmp, "w") as f:
            json.dump(out, f, indent=1, default=str)
        os.replace(tmp, fn)

    # ---------------- images ----------------
    def cache_path(self, iid, kind):
        path = self.paths[iid]
        st = os.stat(path)
        h = hashlib.md5(("%s|%s|%s" % (iid, st.st_mtime, st.st_size)).encode()).hexdigest()[:16]
        return os.path.join(self.cache_dir, kind, h + ".jpg")

    def derived_image(self, iid, kind):
        """kind: thumb (240px), display (1600px), full (EXIF-corrected full res)."""
        path = self.paths[iid]
        if kind == "full":
            info = self.image_info(iid)
            if info["exif_orientation"] == 1 and path.lower().endswith((".jpg", ".jpeg")):
                return path
        out = self.cache_path(iid, kind)
        if os.path.exists(out):
            return out
        os.makedirs(os.path.dirname(out), exist_ok=True)
        size = {"thumb": 240, "display": 1600}.get(kind)
        with Image.open(path) as im:
            if size:
                im.draft("RGB", (size, size))
            im = ImageOps.exif_transpose(im).convert("RGB")
            if size:
                im.thumbnail((size, size), Image.LANCZOS)
            tmp = out + ".%d.tmp" % threading.get_ident()
            im.save(tmp, "JPEG", quality=85 if kind == "thumb" else 92)
            os.replace(tmp, out)
        return out

    def full_image(self, iid):
        with self._img_cache_lock:
            if iid in self._img_cache:
                self._img_cache.move_to_end(iid)
                return self._img_cache[iid]
        with Image.open(self.paths[iid]) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.load()
        with self._img_cache_lock:
            self._img_cache[iid] = im
            while len(self._img_cache) > 3:
                self._img_cache.popitem(last=False)
        return im

    def sample_colors(self, iid, points, size):
        im = self.full_image(iid)
        W, H = im.size
        half = max(1, int(size) // 2)
        out = []
        for p in points:
            x, y = int(round(p[0])), int(round(p[1]))
            box = (max(0, x - half), max(0, y - half), min(W, x + half + 1), min(H, y + half + 1))
            if box[2] <= box[0] or box[3] <= box[1]:
                out.append(None)
                continue
            st = ImageStat.Stat(im.crop(box))
            med = [int(v) for v in st.median]
            out.append({"rgb": med, "rgb_mean": [round(v, 2) for v in st.mean],
                        "rgb_sd": [round(v, 2) for v in st.stddev],
                        "lab": [round(v, 3) for v in srgb_to_lab(med)],
                        "n_px": (box[2] - box[0]) * (box[3] - box[1])})
        return out

    # ---------------- template ----------------
    def default_template(self):
        x0, y0, x1, y1 = self.landmarks["reference_rect"]
        t = OrderedDict()
        for lm in self.landmarks["landmarks"]:
            rx, ry = lm["ref"]
            t[lm["id"]] = [(rx - x0) / float(x1 - x0), (ry - y0) / float(y1 - y0)]
        return t

    def template_path(self):
        return os.path.join(self.data_dir, "template_%s.json" % safe_name(self.lm_set_tag()))

    def template(self):
        p = self.template_path()
        if os.path.exists(p):
            with open(p) as f:
                d = json.load(f)
            base = self.default_template()
            base.update(d.get("points", {}))
            return {"source": "learned", "n": d.get("n"), "created": d.get("created"), "points": base}
        return {"source": "reference image", "n": 0, "points": self.default_template()}

    def recompute_template(self):
        # Records saved under an older version of the same landmark set still count;
        # only landmark IDs that exist in the current set are averaged.
        sums, counts = {}, {}
        n_img = 0
        current_ids = set(l["id"] for l in self.landmarks["landmarks"])
        set_name = str(self.landmarks.get("name"))
        for iid, rec in self.all_anns().items():
            if rec["status"] not in ("annotated", "approved"):
                continue
            if str(rec.get("landmark_set") or "").split("@")[0] != set_name:
                continue
            fish = rec["data"].get("fish")
            if not fish or not fish.get("w") or not fish.get("h"):
                continue
            n_img += 1
            for lid, p in (rec["data"].get("landmarks") or {}).items():
                if lid not in current_ids or not p or p.get("absent") or p.get("x") is None:
                    continue
                u, v = fish_frame(p["x"], p["y"], fish)
                s = sums.setdefault(lid, [0.0, 0.0])
                s[0] += u / fish["w"]
                s[1] += v / fish["h"]
                counts[lid] = counts.get(lid, 0) + 1
        if n_img < 3:
            raise ApiError(400, "Need at least 3 annotated images (have %d)." % n_img)
        pts = {k: [sums[k][0] / counts[k], sums[k][1] / counts[k]] for k in sums}
        with open(self.template_path(), "w") as f:
            json.dump({"n": n_img, "created": now_iso(), "points": pts}, f, indent=1)
        return self.template()

    # ---------------- listing ----------------
    def list_images(self):
        anns = self.all_anns()
        rows = []
        for iid in self.sorted_ids():
            m = self.meta_by_id[iid]
            a = anns.get(iid)
            rows.append({
                "id": iid,
                "group": self.group_of(iid),
                "fish_id": str(m.get(self.fish_col, "")),
                "meta": {c: m.get(c, "") for c in self.list_cols},
                "status": a["status"] if a else "not_started",
                "annotator": a["annotator"] if a else None,
                "approver": a["approver"] if a else None,
                "updated_at": a["updated_at"] if a else None,
                "updated_by": a["updated_by"] if a else None,
                "stale_landmark_set": bool(a and a.get("landmark_set") != self.lm_set_tag()),
                "file_found": iid in self.paths,
            })
        return rows

    # ---------------- exports ----------------
    def export_records(self, which):
        allowed = {"approved": ("approved",), "annotated": ("annotated", "approved"),
                   "all": ("in_progress", "annotated", "approved")}.get(which, ("annotated", "approved"))
        anns = self.all_anns()
        for iid in self.sorted_ids():
            a = anns.get(iid)
            if a and a["status"] in allowed:
                yield iid, a

    def export_wide(self, which):
        buf = io.StringIO()
        w = csv.writer(buf)
        lms = [l["id"] for l in self.landmarks["landmarks"]]
        n_patch = len(self.colorchart["patches"])
        header = ["image_id"] + self.meta_columns + [
            "status", "annotator", "annotated_at", "approver", "approved_at", "landmark_set", "app_version",
            "image_width", "image_height", "exif_orientation", "px_per_mm", "ruler_mm",
            "fish_cx", "fish_cy", "fish_length_px", "fish_height_px", "fish_angle_deg", "fish_mirrored",
            "fish_length_mm", "fish_height_mm", "chart_present",
            "chart_source", "ruler_source", "fish_source", "notes"]
        for l in lms:
            header += ["%s_x" % l, "%s_y" % l, "%s_u" % l, "%s_v" % l, "%s_u_mm" % l, "%s_v_mm" % l, "%s_absent" % l]
        for n in range(1, n_patch + 1):
            header += ["c%d_R" % n, "c%d_G" % n, "c%d_B" % n, "c%d_L" % n, "c%d_a" % n, "c%d_b" % n, "c%d_damaged" % n]
        w.writerow(header)
        for iid, a in self.export_records(which):
            d = a["data"]
            der = self.derived(a)
            info = self.image_info(iid) if iid in self.paths else {}
            meta = self.meta_by_id.get(iid, {})
            fish = d.get("fish") or {}
            ruler = d.get("ruler") or {}
            ppm = der["px_per_mm"]
            chart = d.get("chart") or {}
            row = [iid] + [meta.get(c, "") for c in self.meta_columns] + [
                a["status"], a["annotator"], a["annotated_at"], a["approver"], a["approved_at"],
                a["landmark_set"], a["app_version"], info.get("width"), info.get("height"),
                info.get("exif_orientation"), fmt(ppm), ruler.get("mm") if ruler.get("present") else "",
                fmt(fish.get("cx")), fmt(fish.get("cy")), fmt(fish.get("w")), fmt(fish.get("h")),
                fmt(fish.get("angle")), fish.get("mirror", ""),
                fmt(fish["w"] / ppm) if ppm and fish.get("w") else "",
                fmt(fish["h"] / ppm) if ppm and fish.get("h") else "",
                chart.get("present", ""), source_of(chart), source_of(ruler), source_of(fish),
                (d.get("notes") or "").replace("\n", " ")]
            for l in lms:
                e = der["landmarks"].get(l)
                if not e:
                    row += [""] * 7
                    continue
                row += [fmt(e.get("x")), fmt(e.get("y")), fmt(e.get("u")), fmt(e.get("v")),
                        fmt(e.get("u_mm")), fmt(e.get("v_mm")), int(e["absent"])]
            patches = {p.get("n"): p for p in (chart.get("patches") or [])}
            for n in range(1, n_patch + 1):
                p = patches.get(n) or {}
                rgb = p.get("rgb") or ["", "", ""]
                lab = p.get("lab") or ["", "", ""]
                row += list(rgb) + list(lab) + [int(bool(p.get("damaged"))) if p else ""]
            w.writerow(row)
        return buf.getvalue()

    def export_landmarks_long(self, which):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["image_id", "group", "fish_id", "status", "landmark", "landmark_name", "use",
                    "x", "y", "u", "v", "u_mm", "v_mm", "absent", "moved_from_guess", "px_per_mm"])
        names = {l["id"]: l for l in self.landmarks["landmarks"]}
        for iid, a in self.export_records(which):
            der = self.derived(a)
            m = self.meta_by_id.get(iid, {})
            for lid, e in der["landmarks"].items():
                if not e:
                    continue
                w.writerow([iid, self.group_of(iid), m.get(self.fish_col, ""), a["status"], lid,
                            names[lid]["name"], names[lid].get("use", "shape"),
                            fmt(e.get("x")), fmt(e.get("y")), fmt(e.get("u")), fmt(e.get("v")),
                            fmt(e.get("u_mm")), fmt(e.get("v_mm")), int(e["absent"]), int(e["moved"]),
                            fmt(der["px_per_mm"])])
        return buf.getvalue()

    def export_colors_long(self, which):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["image_id", "group", "status", "patch", "patch_name", "x", "y",
                    "R", "G", "B", "R_mean", "G_mean", "B_mean", "L", "a", "b", "damaged",
                    "ref_R", "ref_G", "ref_B"])
        ref = {p["n"]: p for p in self.colorchart["patches"]}
        for iid, a in self.export_records(which):
            chart = a["data"].get("chart") or {}
            if not chart.get("present"):
                continue
            for p in chart.get("patches") or []:
                r = ref.get(p.get("n"), {})
                rgb = p.get("rgb") or ["", "", ""]
                mean = p.get("rgb_mean") or ["", "", ""]
                lab = p.get("lab") or ["", "", ""]
                rs = r.get("ref_srgb") or ["", "", ""]
                w.writerow([iid, self.group_of(iid), a["status"], p.get("n"), r.get("name", ""),
                            fmt(p.get("x")), fmt(p.get("y"))] + list(rgb) + list(mean) + list(lab) +
                           [int(bool(p.get("damaged")))] + list(rs))
        return buf.getvalue()

    def export_tps(self, which, include):
        """TPS file (tpsDig / geomorph::readland.tps). Coordinates are in the fish frame,
        in pixels, with y flipped so y increases dorsally (TPS convention). Absent points are
        written as -1 -1 (use readland.tps(..., negNA = TRUE)). SCALE = mm per pixel."""
        lms = [l for l in self.landmarks["landmarks"]
               if include == "all" or l.get("use", "shape") == "shape"]
        out = []
        for iid, a in self.export_records(which):
            fish = a["data"].get("fish")
            if not fish:
                continue
            der = self.derived(a)
            out.append("LM=%d" % len(lms))
            for l in lms:
                e = der["landmarks"].get(l["id"])
                if not e or e.get("u") is None:
                    out.append("-1 -1")
                else:
                    out.append("%.3f %.3f" % (e["u"], fish["h"] - e["v"]))
            out.append("IMAGE=%s" % iid)
            out.append("ID=%s" % iid)
            if der["px_per_mm"]:
                out.append("SCALE=%.8f" % (1.0 / der["px_per_mm"]))
        return "\n".join(out) + "\n"

    def export_sliders(self):
        """Semilandmark definition for geomorph (gpagen(..., curves = sliders)).
        Columns before/slide/after are 1-based positions in the TPS landmark order."""
        order = [l["id"] for l in self.landmarks["landmarks"]]
        pos = {lid: i + 1 for i, lid in enumerate(order)}
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["before", "slide", "after"])
        for c in self.landmarks.get("curves") or []:
            chain = [c["from"]] + list(c["points"]) + [c["to"]]
            for i in range(1, len(chain) - 1):
                w.writerow([pos[chain[i - 1]], pos[chain[i]], pos[chain[i + 1]]])
        return buf.getvalue()


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, code, msg, extra=None):
        Exception.__init__(self, msg)
        self.extra = extra or {}
        self.code = code
        self.msg = msg


def source_of(obj):
    """manual | auto-confirmed | auto-adjusted | auto-unchecked (blank if not placed)."""
    if not obj:
        return ""
    a = obj.get("auto")
    if not a:
        return "manual"
    if a.get("edited"):
        return "auto-adjusted"
    return "auto-confirmed" if a.get("reviewed") else "auto-unchecked"


def fmt(v):
    if v is None or v == "":
        return ""
    if isinstance(v, float):
        return "%.4f" % v
    return v


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9._@-]+", "_", s)


def fish_frame(x, y, fish):
    a = math.radians(fish["angle"])
    dx, dy = x - fish["cx"], y - fish["cy"]
    xl = dx * math.cos(a) + dy * math.sin(a)
    yl = -dx * math.sin(a) + dy * math.cos(a)
    u = xl + fish["w"] / 2.0
    v = (fish["h"] / 2.0 - yl) if fish.get("mirror") else (yl + fish["h"] / 2.0)
    return u, v


def srgb_to_lab(rgb):
    def lin(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = [lin(c) for c in rgb]
    X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b

    def f(t):
        return t ** (1.0 / 3) if t > 216.0 / 24389 else (24389.0 / 27 * t + 16) / 116
    fx, fy, fz = f(X / 0.95047), f(Y / 1.0), f(Z / 1.08883)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, datetime.datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def load_metadata(path, sheet=None):
    rows = []
    if path.lower().endswith((".xlsx", ".xlsm")):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb[sheet] if sheet else wb.worksheets[0]
        it = ws.iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else "" for h in next(it)]
        for r in it:
            if r is None or all(v is None for v in r):
                continue
            rows.append(OrderedDict((header[i], _cell(v)) for i, v in enumerate(r)
                                    if i < len(header) and header[i]))
        wb.close()
    else:
        with open(path, newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                rows.append(OrderedDict((k.strip(), v) for k, v in r.items() if k))
    return rows


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
APP = None


class Handler(BaseHTTPRequestHandler):
    server_version = "FishAnnotator/" + APP_VERSION

    def log_message(self, fmt_, *args):
        if "/img/" in self.path:
            return
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt_ % args))

    # --- responses
    def send_json(self, obj, code=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, ctype, filename=None):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if filename:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, cache=True):
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-cache")
        self.end_headers()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError(400, "Invalid JSON")

    def image_id(self, q):
        iid = (q.get("id") or [""])[0]
        if iid not in APP.meta_by_id:
            raise ApiError(404, "Unknown image id: %s" % iid)
        return iid

    def user_of(self, body):
        u = str(body.get("user") or "").strip().upper()
        if not INITIALS_RE.match(u):
            raise ApiError(400, "Please enter your initials (1-6 letters/numbers) at the top of the page.")
        return u

    # --- routing
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        try:
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            p = url.path
            if method == "GET":
                if p in ("/", "/index.html"):
                    return self.send_file(os.path.join(STATIC_DIR, "index.html"), cache=False)
                if p == "/annotate":
                    return self.send_file(os.path.join(STATIC_DIR, "annotate.html"), cache=False)
                if p.startswith("/static/"):
                    fp = os.path.normpath(os.path.join(STATIC_DIR, p[len("/static/"):]))
                    if not fp.startswith(STATIC_DIR) or not os.path.isfile(fp):
                        raise ApiError(404, "Not found")
                    return self.send_file(fp, cache=False)
                if p.startswith("/img/"):
                    kind = p[len("/img/"):]
                    if kind not in ("thumb", "display", "full"):
                        raise ApiError(404, "Not found")
                    iid = self.image_id(q)
                    if iid not in APP.paths:
                        raise ApiError(404, "Image file not found on disk")
                    return self.send_file(APP.derived_image(iid, kind))
                if p == "/api/config":
                    return self.send_json({"app_version": APP_VERSION, "landmarks": APP.landmarks,
                                           "colorchart": APP.colorchart, "list_columns": APP.list_cols,
                                           "group_order": APP.group_order, "landmark_set": APP.lm_set_tag()})
                if p == "/api/images":
                    return self.send_json({"images": APP.list_images(), "group_order": APP.group_order})
                if p == "/api/image":
                    iid = self.image_id(q)
                    m = APP.meta_by_id[iid]
                    fid = str(m.get(APP.fish_col, ""))
                    sibs = [i for i in APP.sorted_ids() if i != iid and str(APP.meta_by_id[i].get(APP.fish_col, "")) == fid
                            and APP.group_of(i) == APP.group_of(iid)]
                    return self.send_json({
                        "id": iid, "group": APP.group_of(iid), "metadata": m,
                        "info": APP.image_info(iid) if iid in APP.paths else None,
                        "annotation": APP.get_ann(iid), "siblings": sibs,
                        "history": APP.history(iid), "template": APP.template(),
                        "landmark_set": APP.lm_set_tag()})
                if p == "/api/template":
                    return self.send_json(APP.template())
                if p == "/api/detect":
                    iid = self.image_id(q)
                    force = (q.get("force") or ["0"])[0] == "1"
                    return self.send_json(APP.detect(iid, force))
                if p == "/api/presence_all":
                    return self.send_json(APP.presence_all())
                if p == "/api/detect_progress":
                    return self.send_json(dict(APP.detect_progress, available=DETECT is not None))
                if p.startswith("/api/export/"):
                    which = (q.get("status") or ["annotated"])[0]
                    name = p[len("/api/export/"):]
                    stamp = datetime.date.today().isoformat()
                    if name == "wide.csv":
                        return self.send_text(APP.export_wide(which), "text/csv", "annotations_wide_%s_%s.csv" % (which, stamp))
                    if name == "landmarks_long.csv":
                        return self.send_text(APP.export_landmarks_long(which), "text/csv", "landmarks_long_%s_%s.csv" % (which, stamp))
                    if name == "colors_long.csv":
                        return self.send_text(APP.export_colors_long(which), "text/csv", "colors_long_%s_%s.csv" % (which, stamp))
                    if name == "landmarks.tps":
                        inc = (q.get("include") or ["shape"])[0]
                        return self.send_text(APP.export_tps(which, inc), "text/plain", "landmarks_%s_%s_%s.tps" % (inc, which, stamp))
                    if name == "sliders.csv":
                        return self.send_text(APP.export_sliders(), "text/csv", "sliders_%s.csv" % safe_name(APP.lm_set_tag()))
                raise ApiError(404, "Not found")
            else:
                body = self.body_json()
                if p == "/api/save":
                    iid = body.get("id")
                    if iid not in APP.meta_by_id:
                        raise ApiError(404, "Unknown image id")
                    action = body.get("action", "save")
                    if action not in ("autosave", "save", "submit"):
                        raise ApiError(400, "Bad action")
                    rec = APP.save(iid, body.get("data") or {}, self.user_of(body), action,
                                   base_rev=body.get("base_rev"), force=bool(body.get("force")))
                    return self.send_json({"annotation": rec, "history": APP.history(iid)})
                if p == "/api/presence":
                    iid = body.get("id")
                    sid = str(body.get("session") or "")[:64]
                    if iid not in APP.meta_by_id or not sid:
                        raise ApiError(400, "Bad presence request")
                    others = APP.presence_ping(iid, sid, str(body.get("user") or "")[:6].upper(), body.get("dirty"))
                    cur = APP.get_ann(iid)
                    return self.send_json({"others": others,
                                           "rev": (cur.get("rev") or 0) if cur else -1,
                                           "updated_by": cur["updated_by"] if cur else None,
                                           "updated_at": cur["updated_at"] if cur else None,
                                           "status": cur["status"] if cur else "not_started"})
                if p == "/api/presence/leave":
                    APP.presence_leave(body.get("id"), str(body.get("session") or ""))
                    return self.send_json({"ok": True})
                if p == "/api/approve":
                    iid = body.get("id")
                    if iid not in APP.meta_by_id:
                        raise ApiError(404, "Unknown image id")
                    rec = APP.approve(iid, self.user_of(body))
                    return self.send_json({"annotation": rec, "history": APP.history(iid)})
                if p == "/api/reopen":
                    iid = body.get("id")
                    if iid not in APP.meta_by_id:
                        raise ApiError(404, "Unknown image id")
                    rec = APP.reopen(iid, self.user_of(body))
                    return self.send_json({"annotation": rec, "history": APP.history(iid)})
                if p == "/api/sample_colors":
                    iid = body.get("id")
                    if iid not in APP.paths:
                        raise ApiError(404, "Unknown image id")
                    return self.send_json({"samples": APP.sample_colors(iid, body.get("points") or [], body.get("size") or 20)})
                if p == "/api/template/recompute":
                    return self.send_json(APP.recompute_template())
                if p == "/api/reload":
                    APP.reload_index()
                    return self.send_json({"ok": True, "n": len(APP.meta_by_id)})
                raise ApiError(404, "Not found")
        except ApiError as e:
            self.send_json(dict(e.extra, error=e.msg), e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # pragma: no cover
            import traceback
            traceback.print_exc()
            try:
                self.send_json({"error": "Server error: %s" % e}, 500)
            except Exception:
                pass


DEFAULT_PORT = 8024


def tunnel_help(port):
    """The ssh command users run on their own computer to reach this server."""
    import getpass
    import socket
    try:
        user = getpass.getuser()
    except Exception:
        user = "your-username"
    host = socket.getfqdn() or socket.gethostname() or "this-server"
    return ("\nTo use it from your own computer, open an SSH tunnel there:\n"
            "    ssh -N -L {p}:localhost:{p} {u}@{h}\n"
            "(use your own username on this server; keep that window open), then browse to\n"
            "    http://localhost:{p}\n"
            "If {p} is already in use on your computer, pick another local port, e.g.\n"
            "    ssh -N -L 9{p2}:localhost:{p} {u}@{h}   ->   http://localhost:9{p2}\n").format(
        p=port, p2=str(port)[-3:], u=user, h=host)


def main():
    global APP
    ap = argparse.ArgumentParser(
        description="Cichlid annotation web server. Port priority: --port, then the FA_PORT "
                    "environment variable, then 'port' in config.json, then %d." % DEFAULT_PORT)
    ap.add_argument("--config", default=os.path.join(APP_DIR, "config.json"))
    ap.add_argument("--port", type=int, help="port to listen on (default %d)" % DEFAULT_PORT)
    ap.add_argument("--host", help="address to bind (default 127.0.0.1 = reachable only through an SSH tunnel)")
    ap.add_argument("--images", help="image folder (overrides config.json image_dir)")
    ap.add_argument("--metadata", help="metadata .xlsx/.csv (overrides config.json metadata_file)")
    ap.add_argument("--data", help="data folder for annotations (overrides config.json data_dir)")
    args = ap.parse_args()
    APP = App(args.config, {"image_dir": args.images, "metadata_file": args.metadata, "data_dir": args.data})
    host = args.host or os.environ.get("FA_HOST") or APP.cfg.get("host") or "127.0.0.1"
    port = args.port or (int(os.environ["FA_PORT"]) if os.environ.get("FA_PORT") else None) \
        or (int(APP.cfg["port"]) if APP.cfg.get("port") else None) or DEFAULT_PORT
    try:
        srv = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print("\nCould not listen on port %d (%s). Another program (or another copy of this server)\n"
              "is probably using it. Start with a different port, e.g.:  bash start.sh --port %d\n"
              % (port, e, port + 1))
        sys.exit(1)
    srv.daemon_threads = True
    print("\nFish annotator %s listening on %s:%d  (Ctrl+C to stop)" % (APP_VERSION, host, port))
    if host in ("127.0.0.1", "localhost"):
        print(tunnel_help(port))
    else:
        print("WARNING: bound to %s - anyone who can reach this machine on port %d can use the app\n"
              "(there are no passwords; initials only)." % (host, port))
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
