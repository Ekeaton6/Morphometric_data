"""
Automatic first guesses for the color chart, ruler scale and fish box.

Everything here is a *guess* that the annotator reviews and drags into place.
All returned coordinates are in full-resolution, EXIF-oriented image pixels.

Requires numpy + opencv-python-headless. If they are missing, detection is
simply unavailable and the app falls back to manual placement.
"""
import math

import numpy as np
import cv2

WORK = 1600  # long side of the working image (px)

# ColorChecker-layout reference sRGB (patch 1..24). Only used to decide the chart's
# orientation, so approximate values for a copy card are fine.
REF_SRGB = [
    [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
    [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
    [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
    [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52]]


def _load(pil_img):
    """PIL (oriented RGB) -> working-size BGR array + scale factor (full = work * s)."""
    w, h = pil_img.size
    s = max(w, h) / float(WORK)
    if s > 1:
        small = pil_img.resize((int(round(w / s)), int(round(h / s))))
    else:
        s = 1.0
        small = pil_img
    arr = cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2BGR)
    return arr, s


# ---------------------------------------------------------------------------
# Color chart
# ---------------------------------------------------------------------------
def _square_candidates(bgr):
    """Square-ish bright/colored blobs that stand out from a darker surround."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    H, W = v.shape
    cands = []
    for block in (51, 101):
        for C in (-8, -20):
            th = cv2.adaptiveThreshold(v, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, block, C)
            th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            cnts, _ = cv2.findContours(th, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            for c in cnts:
                a = cv2.contourArea(c)
                if a < (W * H) * 2e-4 or a > (W * H) * 0.02:
                    continue
                (cx, cy), (rw, rh), ang = cv2.minAreaRect(c)
                if rw < 1 or rh < 1:
                    continue
                ar = max(rw, rh) / min(rw, rh)
                if ar > 1.35:
                    continue
                if a / (rw * rh) < 0.8:
                    continue
                cands.append((cx, cy, math.sqrt(rw * rh), ang % 90))
    # de-duplicate (same patch found at several thresholds)
    cands.sort(key=lambda t: -t[2])
    out = []
    for c in cands:
        if all(math.hypot(c[0] - o[0], c[1] - o[1]) > 0.5 * o[2] for o in out):
            out.append(c)
    return out


def _grid_group(cands):
    """Find the biggest group of similar-size squares on a regular grid."""
    if len(cands) < 6:
        return None
    pts = np.array([[c[0], c[1]] for c in cands])
    size = np.array([c[2] for c in cands])
    best = None
    n = len(cands)
    # neighbour graph: similar size, spacing 1.05-1.9 x side
    adj = [[] for _ in range(n)]
    for i in range(n):
        d = np.hypot(pts[:, 0] - pts[i, 0], pts[:, 1] - pts[i, 1])
        ok = (d > 1.05 * size[i]) & (d < 1.9 * size[i]) & (np.abs(size - size[i]) < 0.3 * size[i])
        adj[i] = list(np.where(ok)[0])
    seen = set()
    for i in range(n):
        if i in seen or len(adj[i]) < 1:
            continue
        comp, stack = [], [i]
        seen.add(i)
        while stack:
            k = stack.pop()
            comp.append(k)
            for j in adj[k]:
                if j not in seen:
                    seen.add(j)
                    stack.append(j)
        if 8 <= len(comp) <= 40:
            score = len(comp) * np.median(size[comp]) - 3 * max(0, len(comp) - 24) * np.median(size[comp])
            if best is None or score > best[0]:
                best = (score, comp)
    return None if best is None else [cands[k] for k in best[1]]


def detect_chart(bgr):
    cands = _square_candidates(bgr)
    group = _grid_group(cands)
    if not group:
        return None
    P = np.array([[g[0], g[1]] for g in group])
    side = float(np.median([g[2] for g in group]))
    # dominant orientation of the grid from the squares themselves
    angs = np.radians(np.array([g[3] for g in group]))  # square orientation is 90-deg periodic
    a = math.atan2(np.mean(np.sin(4 * angs)), np.mean(np.cos(4 * angs))) / 4.0
    ux = np.array([math.cos(a), math.sin(a)])
    uy = np.array([-math.sin(a), math.cos(a)])
    X = P @ ux
    Y = P @ uy
    # spacing: median nearest-neighbour distance
    D = np.hypot(P[:, None, 0] - P[None, :, 0], P[:, None, 1] - P[None, :, 1])
    np.fill_diagonal(D, 1e9)
    sp = float(np.median(D.min(axis=1)))
    gi = np.round((X - X.min()) / sp).astype(int)
    gj = np.round((Y - Y.min()) / sp).astype(int)
    ni, nj = gi.max() + 1, gj.max() + 1
    # need a 6x4 (or 4x6) grid; allow a missing edge row/col only if the other dim fits
    if sorted((ni, nj)) != [4, 6]:
        return {"ok": False, "reason": "grid %dx%d" % (ni, nj), "n": len(group)}
    # least squares affine: [i, j, 1] -> (x, y)
    A = np.c_[gi, gj, np.ones(len(gi))]
    cx, _, _, _ = np.linalg.lstsq(A, P[:, 0], rcond=None)
    cy, _, _, _ = np.linalg.lstsq(A, P[:, 1], rcond=None)
    resid = np.hypot(A @ cx - P[:, 0], A @ cy - P[:, 1])
    if np.median(resid) > 0.25 * sp:
        return {"ok": False, "reason": "irregular grid"}

    def at(i, j):
        return np.array([cx[0] * i + cx[1] * j + cx[2], cy[0] * i + cy[1] * j + cy[2]])

    # corners of the fitted grid in (i, j)
    long_is_i = ni == 6
    L, S = (ni, nj) if long_is_i else (nj, ni)

    def g(l, s):  # l along the 6-axis, s along the 4-axis
        return at(l, s) if long_is_i else at(s, l)

    rgb = bgr[:, :, ::-1].astype(np.float32)

    def samp(p):
        x, y = int(round(p[0])), int(round(p[1]))
        r = max(1, int(side * 0.2))
        return np.median(rgb[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1].reshape(-1, 3), axis=0)

    meas = {(l, s_): samp(g(l, s_)) for l in range(6) for s_ in range(4)}
    ref = np.array(REF_SRGB, dtype=np.float32)
    # 4 candidate orientations (the 6-axis is known): flip along l and/or s.
    fits = []
    for fl in (False, True):
        for fs in (False, True):
            M = []
            for n in range(24):
                col, row = n % 6, n // 6
                l = 5 - col if fl else col
                s_ = 3 - row if fs else row
                M.append(meas[(l, s_)])
            M = np.array(M)
            A = np.c_[M, np.ones(24)]
            coef, _, _, _ = np.linalg.lstsq(A, ref, rcond=None)
            rms = float(np.sqrt(np.mean((A @ coef - ref) ** 2)))
            fits.append((rms, fl, fs))
    fits.sort()
    rms, fl, fs = fits[0]

    def patch_pos(n):
        col, row = (n - 1) % 6, (n - 1) // 6
        return g(5 - col if fl else col, 3 - row if fs else row)

    corners = [patch_pos(1), patch_pos(6), patch_pos(24), patch_pos(19)]
    ratio = fits[1][0] / max(rms, 1e-6)
    conf = min(1.0, len(group) / 22.0) * min(1.0, (ratio - 1.0) / 0.4) * (1.0 if rms < 40 else 0.5)
    return {"ok": True, "corners": [c.tolist() for c in corners], "n_patches": len(group),
            "spacing": sp, "side": side, "fit_rms": round(rms, 1), "orientation_margin": round(ratio, 2),
            "confidence": round(max(0.0, conf), 2)}


# ---------------------------------------------------------------------------
# Ruler (mm ticks)
# ---------------------------------------------------------------------------
CHART_PITCH_MM = 23.4   # centre-to-centre patch spacing on the lab's chart (measured from ruler hits)


def _line_kernel(length, theta):
    L = int(length) | 1
    k = np.zeros((L, L), np.float32)
    c = L // 2
    dx, dy = math.cos(theta) * c, math.sin(theta) * c
    cv2.line(k, (int(round(c - dx)), int(round(c - dy))), (int(round(c + dx)), int(round(c + dy))), 1.0, 1)
    return k / max(k.sum(), 1)


def _stripe_energy(gray, lam, theta):
    """Quadrature Gabor energy for stripes with period `lam` px whose normal points along `theta`."""
    sigma = 1.6 * lam
    ks = int(6 * sigma) | 1
    r0 = cv2.filter2D(gray, cv2.CV_32F, cv2.getGaborKernel((ks, ks), sigma, theta, lam, 2.5, 0))
    r1 = cv2.filter2D(gray, cv2.CV_32F, cv2.getGaborKernel((ks, ks), sigma, theta, lam, 2.5, math.pi / 2))
    return np.sqrt(r0 * r0 + r1 * r1)


def _profile(gray, origin, a, d, t0, t1, half_w, step=0.5):
    ts = np.arange(t0, t1, step, dtype=np.float32)
    ws = np.linspace(-half_w, half_w, 5, dtype=np.float32)
    X = origin[0] + ts[None, :] * a[0] + ws[:, None] * d[0]
    Y = origin[1] + ts[None, :] * a[1] + ws[:, None] * d[1]
    v = cv2.remap(gray, X.astype(np.float32), Y.astype(np.float32), cv2.INTER_LINEAR)
    return ts, v.mean(axis=0)


def _find_ticks(ts, prof, lam):
    """Positions of dark tick centres along the profile and the fitted period."""
    step = ts[1] - ts[0]
    pr = prof - cv2.blur(prof.reshape(1, -1).astype(np.float32), (int(3 * lam / step) | 1, 1)).ravel()
    pr = cv2.GaussianBlur(pr.reshape(1, -1), (0, 0), sigmaX=max(0.6, 0.12 * lam / step)).ravel()
    # FFT period near lam
    n = len(pr)
    if n < 20 * lam / step:
        return None
    F = np.abs(np.fft.rfft((pr - pr.mean()) * np.hanning(n), n=4 * n))
    freqs = np.fft.rfftfreq(4 * n, d=step)
    band = (freqs > 1 / (1.3 * lam)) & (freqs < 1 / (0.77 * lam))
    if not band.any():
        return None
    i = np.argmax(np.where(band, F, 0))
    per = 1.0 / freqs[i]
    peak_ratio = F[i] / (np.median(F[band]) + 1e-6)
    # local minima (ticks are dark)
    mins = []
    w = max(1, int(0.35 * per / step))
    for j in range(w, n - w):
        seg = pr[j - w:j + w + 1]
        if pr[j] == seg.min() and pr[j] < 0:
            if not mins or ts[j] - mins[-1] > 0.6 * per:
                # sub-sample refinement
                y0, y1, y2 = pr[j - 1], pr[j], pr[j + 1]
                den = (y0 - 2 * y1 + y2)
                off = 0.5 * (y0 - y2) / den if den != 0 else 0.0
                mins.append(ts[j] + off * step)
    if len(mins) < 15:
        return None
    m = np.array(mins)
    # Sequential indexing: each gap is converted to a whole number of periods using the
    # *local* period, so a small period error can't accumulate over 150 ticks.
    # Runs are broken at gaps that aren't close to a whole number of periods.
    runs, cur_m, cur_i = [], [m[0]], [0]
    loc = per
    for x in m[1:]:
        gap = x - cur_m[-1]
        q = gap / loc
        nq = int(round(q))
        if nq >= 1 and nq <= 3 and abs(q - nq) < 0.28:
            cur_m.append(x)
            cur_i.append(cur_i[-1] + nq)
            if len(cur_m) >= 6:  # update local period from the recent ticks
                loc = (cur_m[-1] - cur_m[-6]) / (cur_i[-1] - cur_i[-6])
        else:
            runs.append((cur_m, cur_i))
            cur_m, cur_i, loc = [x], [0], per
    runs.append((cur_m, cur_i))
    rm, ri = max(runs, key=lambda r: r[1][-1])
    if len(rm) < 15:
        return None
    rm, ri = np.array(rm), np.array(ri, dtype=float)
    slope, icpt = np.polyfit(ri, rm, 1)
    res = rm - (slope * ri + icpt)
    keep = np.abs(res) < 0.25 * slope
    if keep.sum() < 15:
        return None
    slope, icpt = np.polyfit(ri[keep], rm[keep], 1)
    res = rm[keep] - (slope * ri[keep] + icpt)
    return {"period": float(slope), "t_first": float(icpt), "n_idx": int(ri.max()), "n_ticks": int(keep.sum()),
            "resid": float(np.std(res)), "peak_ratio": float(peak_ratio)}


def detect_ruler(pil_img, chart):
    """Returns {'ok', 'p1', 'p2', 'mm', 'px_per_mm'} in full-res pixels."""
    W, H = pil_img.size
    prior = bool(chart and chart.get("ok"))
    if not prior:
        # every tray photo has a chart; without one (e.g. X-rays) there's no ruler either
        return {"ok": False, "reason": "no color chart, ruler search skipped"}
    if prior:
        mm_full = chart["spacing"] / CHART_PITCH_MM
        target = 6.0
        k = min(1.0, target / mm_full)
        lams = [mm_full * k]
    else:
        k = min(1.0, 1600.0 / max(W, H))
        lams = list(np.geomspace(3.5, 12, 8))
    img = pil_img.convert("L")
    if k < 1:
        img = img.resize((int(round(W * k)), int(round(H * k))), resample=2)
    gray = np.asarray(img).astype(np.float32)
    best = None
    for lam in lams:
        for deg in range(0, 180, 15):
            th = math.radians(deg)
            E = _stripe_energy(gray, lam, th)
            # ruler axis runs along theta (stripe normal); smooth ~15 mm along it
            E = cv2.filter2D(E, -1, _line_kernel(15 * lam, th))
            if chart and chart.get("ok"):
                # suppress the chart itself
                cs = np.array(chart["corners"]) * (k / 1.0)
                pad = chart["spacing"] * k
                x0, y0 = cs.min(axis=0) - pad
                x1, y1 = cs.max(axis=0) + pad
                E[max(0, int(y0)):int(y1), max(0, int(x0)):int(x1)] = 0
            v = float(E.max())
            if best is None or v > best[0]:
                best = (v, lam, th, E)
    v, lam, th, E = best
    yx = np.unravel_index(np.argmax(E), E.shape)
    # region of strong energy around the max -> ruler extent & exact axis
    mask = (E > 0.45 * v).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask)
    comp = lab == lab[yx]
    ys, xs = np.nonzero(comp)
    wts = E[ys, xs]
    P = np.c_[xs, ys].astype(np.float64)
    c = (P * wts[:, None]).sum(0) / wts.sum()
    C = np.cov((P - c).T, aweights=wts)
    evals, evecs = np.linalg.eigh(C)
    a = evecs[:, 1]
    if abs(math.atan2(a[1], a[0]) - th) % math.pi > math.pi / 3 and abs(math.atan2(a[1], a[0]) - th) % math.pi < 2 * math.pi / 3:
        a = np.array([math.cos(th), math.sin(th)])  # component too short to trust its shape
    if a[0] < 0 or (abs(a[0]) < 1e-6 and a[1] < 0):
        a = -a
    d = np.array([-a[1], a[0]])
    t = (P - c) @ a
    t0, t1 = float(t.min()) - 2 * lam, float(t.max()) + 2 * lam
    # the component centre may sit off the short-tick line: scan across for the best profile
    bestp = None
    for off in np.linspace(-2.0 * lam, 2.0 * lam, 17):
        o = c + d * off
        ts, prof = _profile(gray, o, a, d, t0, t1, 0.25 * lam)
        r = _find_ticks(ts, prof, lam)
        if r and (bestp is None or r["n_ticks"] * r["peak_ratio"] > bestp[0]["n_ticks"] * bestp[0]["peak_ratio"]):
            bestp = (r, o)
    if not bestp:
        return {"ok": False, "reason": "no regular tick row found"}
    r, o = bestp
    per = r["period"]
    # Which side of the tick line is the ruler body? The 5 mm / 10 mm ticks extend into it,
    # so ~3.5 mm inside there is strong energy at a 5-mm period; outside there isn't.
    # Better cue: the inch scale (1/16" ticks = 1.5875 mm period) runs along the *other*
    # long edge of the ruler, 15-35 mm across the body. Fish can't imitate that period.
    side_e = {}
    for sign in (1, -1):
        e_best = 0.0
        for off in np.arange(12, 36, 1.0):
            o2 = o + d * sign * off * per
            ts_, pr_ = _profile(gray, o2, a, d, t0, t1, 0.25 * per)
            pr_ = pr_ - cv2.blur(pr_.reshape(1, -1).astype(np.float32), (int(6 * per / (ts_[1] - ts_[0])) | 1, 1)).ravel()
            F = np.abs(np.fft.rfft(pr_ * np.hanning(len(pr_))))
            fr = np.fft.rfftfreq(len(pr_), d=ts_[1] - ts_[0])
            band = (fr > 1 / (1.5875 * 1.06 * per)) & (fr < 1 / (1.5875 * 0.94 * per))
            if band.any():
                e_best = max(e_best, float(F[band].max() / (np.median(F) + 1e-6)))
        side_e[sign] = e_best
    body_sign = 1 if side_e[1] >= side_e[-1] else -1
    body_dir = (d * body_sign).tolist()
    # ---- snap to whole-cm lines and extend to the full scale (e.g. 0-15 cm) ----
    # cm ticks are the longest: 4-7 mm into the body only they (and a bit of the 5-mm ticks) remain.
    body = d * body_sign

    def darkness(ks):
        ks = np.asarray(ks, dtype=np.float64)
        tpos = r["t_first"] + ks * per
        tot = np.zeros(len(ks))
        for off in (4.0, 5.0, 6.0, 7.0):
            base = o + body * off * per
            X = base[0] + np.outer(tpos, [a[0]] * 5) + np.outer(np.ones(len(ks)), np.linspace(-0.45, 0.45, 5) * per * a[0])
            Y = base[1] + np.outer(tpos, [a[1]] * 5) + np.outer(np.ones(len(ks)), np.linspace(-0.45, 0.45, 5) * per * a[1])
            v = cv2.remap(gray, X.astype(np.float32), Y.astype(np.float32), cv2.INTER_LINEAR)
            tot += np.maximum(0, (v[:, [0, 4]].mean(axis=1) - v[:, 2]))   # centre darker than sides
        return tot
    n_mm = r["n_idx"]
    ks = np.arange(-12, n_mm + 13)
    dk = darkness(ks)
    inrun = (ks >= 0) & (ks <= n_mm)
    phase_score = [dk[inrun & (ks % 10 == ph)].mean() if (inrun & (ks % 10 == ph)).any() else 0 for ph in range(10)]
    ph = int(np.argmax(phase_score))
    cm_k = ks[inrun & (ks % 10 == ph)]
    cm_dark = dict(zip(ks.tolist(), dk.tolist()))
    med = float(np.median([cm_dark[int(x)] for x in cm_k])) if len(cm_k) else 0.0
    cm_ok = len(cm_k) >= 2 and med > 1.5 * float(np.median(dk[inrun])) + 1e-6
    if cm_ok:
        kmin, kmax = int(cm_k.min()), int(cm_k.max())
        # extend by up to one cm at each end when a cm tick is clearly there (ticks lost to glare)
        if cm_dark.get(kmin - 10, 0) > 0.5 * med:
            kmin -= 10
        if cm_dark.get(kmax + 10, 0) > 0.5 * med:
            kmax += 10
        if kmax - kmin > 150:           # the rulers used are 15 cm
            kmax = kmin + 150
        use_mm = kmax - kmin
        t_start = r["t_first"] + kmin * per
    else:
        use_mm = (n_mm // 10) * 10 if n_mm >= 10 else n_mm
        t_start = r["t_first"]
    p1 = o + a * t_start
    p2 = o + a * (t_start + per * use_mm)
    px_per_mm_full = per / k
    conf = min(1.0, r["n_ticks"] / 80.0) * (1.0 if r["resid"] < 0.1 * per else 0.6) * min(1.0, r["peak_ratio"] / 8.0)
    if prior:
        ratio = px_per_mm_full / mm_full
        if not 0.9 < ratio < 1.11:
            conf *= 0.3
    if not cm_ok:
        conf *= 0.7   # ends not confirmed on cm lines
    return {"ok": True, "p1": (p1 / k).tolist(), "p2": (p2 / k).tolist(), "mm": int(use_mm),
            "px_per_mm": px_per_mm_full, "n_ticks": r["n_ticks"], "confidence": round(conf, 2),
            "on_cm_lines": bool(cm_ok),
            "body_dir": body_dir, "body_side_margin": round(max(side_e.values()) / max(min(side_e.values()), 1e-6), 2)}


# ---------------------------------------------------------------------------
# Fish box
# ---------------------------------------------------------------------------
def detect_fish(bgr, chart_w, ruler_w):
    """bgr = working image; chart_w / ruler_w = detections in working-image pixels (or None).
    Returns {'ok', 'cx','cy','w','h','angle','mirror'} in working pixels."""
    H, W = bgr.shape[:2]
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    excl = np.zeros((H, W), np.uint8)
    if chart_w:
        # corners = centres of patches 1, 6, 24, 19. The card has ~1 patch of margin on three
        # sides and a wider printed strip below the gray row.
        c1, c6, c24, c19 = [np.array(p) for p in chart_w["corners"]]
        sp = chart_w["spacing"]
        right = (c6 - c1) / (np.linalg.norm(c6 - c1) + 1e-6)
        down = (c19 - c1) / (np.linalg.norm(c19 - c1) + 1e-6)
        poly = np.array([c1 - right * 0.9 * sp - down * 0.85 * sp, c6 + right * 0.9 * sp - down * 0.85 * sp,
                         c24 + right * 0.9 * sp + down * 2.2 * sp, c19 - right * 0.9 * sp + down * 2.2 * sp])
        cv2.fillConvexPoly(excl, poly.astype(np.int32), 1)
    # large very dark regions (the black number bag) are not fish
    Lc = lab[:, :, 0]
    dark = (Lc < 80).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    nd, ld, sd, _ = cv2.connectedComponentsWithStats(dark)
    bagmask = np.zeros((H, W), np.uint8)
    for i in range(1, nd):
        if sd[i, cv2.CC_STAT_AREA] > 0.04 * W * H:
            ys_, xs_ = np.nonzero(ld == i)
            (_, _), (bw_, bh_), _ = cv2.minAreaRect(np.c_[xs_, ys_].astype(np.float32))
            if max(bw_, bh_) / max(min(bw_, bh_), 1) > 2.2:
                continue  # elongated dark object: probably a dark fish, not the bag
            hull = cv2.convexHull(np.c_[xs_, ys_].astype(np.int32))
            cv2.fillConvexPoly(bagmask, hull, 1)
    if chart_w:
        bagmask[excl > 0] = 0  # the chart card itself is handled separately
    bagmask = cv2.dilate(bagmask, np.ones((9, 9), np.uint8))
    rul = np.zeros((H, W), np.uint8)
    if ruler_w:
        # only a thin strip along the tick line: it separates a fish that touches the ruler
        p1, p2 = np.array(ruler_w["p1"]), np.array(ruler_w["p2"])
        a = (p2 - p1) / (np.linalg.norm(p2 - p1) + 1e-6)
        d = np.array([-a[1], a[0]])
        mm = ruler_w["px_per_mm"]
        q1, q2 = p1 - a * 22 * mm, p2 + a * 22 * mm
        if ruler_w.get("body_dir") and ruler_w.get("body_side_margin", 0) > 1.3:
            b = np.array(ruler_w["body_dir"])  # ruler body side: exclude the whole ruler
            poly = np.array([q1 - b * 3 * mm, q2 - b * 3 * mm, q2 + b * 34 * mm, q1 + b * 34 * mm])
        else:  # unsure: only a thin strip along the tick line
            poly = np.array([q1 + d * 3 * mm, q2 + d * 3 * mm, q2 - d * 3 * mm, q1 - d * 3 * mm])
        cv2.fillConvexPoly(rul, poly.astype(np.int32), 1)
    excl = np.maximum(excl, rul)
    # background = heavy median of a small copy, with known objects painted out first
    sm = cv2.resize(lab, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    known = cv2.resize(np.maximum(excl, bagmask), (W // 4, H // 4), interpolation=cv2.INTER_NEAREST)
    if known.any():
        sm = cv2.inpaint(sm, known, 5, cv2.INPAINT_TELEA)
    kk = (min(sm.shape[:2]) // 4) | 1
    bg = np.dstack([cv2.medianBlur(sm[:, :, c], min(kk, 255)) for c in range(3)])
    bg = cv2.resize(bg, (W, H), interpolation=cv2.INTER_LINEAR)
    diff = lab.astype(np.float32) - bg.astype(np.float32)
    diff[:, :, 0] *= 0.7
    dist = np.sqrt((diff ** 2).sum(axis=2))
    excl = np.maximum(excl, bagmask)
    border = int(0.02 * min(W, H))
    excl[:border] = 1
    excl[-border:] = 1
    excl[:, :border] = 1
    excl[:, -border:] = 1
    vals = dist[excl == 0]
    if vals.size == 0:
        return {"ok": False, "reason": "nothing left to search"}
    thr = max(12.0, float(np.percentile(vals, 90)) * 0.9)
    thr = min(thr, 40.0)
    # hysteresis: weak foreground pixels are kept only when connected to strong ones
    weak = ((dist > 0.65 * thr) & (excl == 0)).astype(np.uint8)
    weak = cv2.morphologyEx(weak, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    strong = (dist > thr) & (excl == 0)
    nw, lw, _, _ = cv2.connectedComponentsWithStats(weak)
    keep = np.zeros(nw, bool)
    keep[np.unique(lw[strong & (weak > 0)])] = True
    keep[0] = False
    mask = keep[lw].astype(np.uint8)
    k = max(3, int(0.006 * max(W, H)) | 1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, labm, stats, cent = cv2.connectedComponentsWithStats(mask)
    best = None
    best_any = None
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 0.001 * W * H or area > 0.2 * W * H:
            continue
        ys, xs = np.nonzero(labm[stats[i, 1]:stats[i, 1] + stats[i, 3], stats[i, 0]:stats[i, 0] + stats[i, 2]] == i)
        pts = np.c_[xs + stats[i, 0], ys + stats[i, 1]].astype(np.float32)
        (cx, cy), (rw, rh), ang = cv2.minAreaRect(pts)
        L, S = max(rw, rh), min(rw, rh)
        if S < 3:
            continue
        aspect = L / S
        fill = area / (rw * rh)
        if aspect < 1.6 or aspect > 7 or fill < 0.35:
            continue
        if fill > 0.86:
            continue  # rigid rectangles (ruler band, labels, tape), never a fish outline
        # prefer big, solid, fish-shaped (aspect ~2.5-4) blobs with strong contrast
        contrast = float(dist[ys + stats[i, 1], xs + stats[i, 0]].mean())
        shape = math.exp(-((math.log(aspect / 3.0)) ** 2) / 0.35)
        score = area * shape * min(fill / 0.6, 1.0) * min(contrast / 25.0, 1.5)
        if ruler_w:
            mmw = ruler_w["px_per_mm"]
            if not (20 * mmw < L < 200 * mmw):
                continue
            # fish are laid out close to the ruler (hard preference, see below)
            p1, p2 = np.array(ruler_w["p1"]), np.array(ruler_w["p2"])
            span = np.linalg.norm(p2 - p1) / mmw
            a_ = (p2 - p1) / (np.linalg.norm(p2 - p1) + 1e-6)
            v_ = np.array([cx, cy]) - p1
            dperp = abs(v_[0] * a_[1] - v_[1] * a_[0]) / mmw
            dpar = float(v_ @ a_) / mmw
            near = dperp < 75 and -45 < dpar < span + 45
        else:
            near = True
        cand = (score, i, pts, (cx, cy), (rw, rh), ang, aspect, fill)
        if near and (best is None or score > best[0]):
            best = cand
        if best_any is None or score > best_any[0]:
            best_any = cand
    if best is None and not ruler_w:
        best = best_any   # without a ruler we have no location prior
    if best is None:
        return {"ok": False, "reason": "no fish-shaped object found"}
    score, i, pts, (cx, cy), (rw, rh), ang, aspect, fill = best
    # principal axis via PCA (more stable than minAreaRect's angle)
    c = pts.mean(axis=0)
    C = np.cov((pts - c).T)
    ev, evec = np.linalg.eigh(C)
    ax = evec[:, 1]
    if ax[0] < 0:
        ax = -ax  # point roughly rightwards
    nrm = np.array([-ax[1], ax[0]])
    t = (pts - c) @ ax
    s = (pts - c) @ nrm
    t0, t1 = float(t.min()), float(t.max())
    s0, s1 = float(np.percentile(s, 0.5)), float(np.percentile(s, 99.5))
    Lb = t1 - t0
    # head end = the end whose 25%-station is thicker (tail end narrows at the peduncle)

    def thick(frac):
        tt = t0 + frac * Lb
        band = np.abs(t - tt) < 0.04 * Lb
        return float(s[band].max() - s[band].min()) if band.sum() > 5 else 0.0
    # All tray photos in this project are taken head-left, so that is the default; the
    # thickness test only overrides it when the evidence is strong.
    ratio_ht = thick(0.25) / max(thick(0.75), 1e-6)
    head_left = ratio_ht > 0.6
    # box: pad a little for fins that didn't segment cleanly
    pad_t, pad_s = 0.04 * Lb, 0.08 * (s1 - s0)
    tc = (t0 + t1) / 2
    sc = (s0 + s1) / 2
    ctr = c + ax * tc + nrm * sc
    w = Lb + 2 * pad_t
    h = (s1 - s0) + 2 * pad_s
    angle = math.degrees(math.atan2(ax[1], ax[0]))
    if not head_left:
        angle += 180
    angle %= 360
    mirror = math.cos(math.radians(angle)) < 0
    conf = min(1.0, shape + 0.2) * min(1.0, fill / 0.55)
    return {"ok": True, "cx": float(ctr[0]), "cy": float(ctr[1]), "w": float(w), "h": float(h),
            "angle": angle, "mirror": bool(mirror), "confidence": round(conf, 2),
            "head_ratio": round(thick(0.25) / max(thick(0.75), 1e-6), 2)}


# ---------------------------------------------------------------------------
# public entry
# ---------------------------------------------------------------------------
def detect_all(pil_img):
    bgr, s = _load(pil_img)
    out = {"work_scale": s}
    try:
        ch = detect_chart(bgr)
    except Exception as e:  # pragma: no cover
        ch = {"ok": False, "reason": "error: %s" % e}
    if ch and ch.get("ok"):
        ch["corners"] = [[x * s, y * s] for x, y in ch["corners"]]
        ch["spacing"] *= s
        ch["side"] *= s
    out["chart"] = ch or {"ok": False, "reason": "not found"}
    try:
        out["ruler"] = detect_ruler(pil_img, out["chart"])
    except Exception as e:  # pragma: no cover
        out["ruler"] = {"ok": False, "reason": "error: %s" % e}
    # fish (in working pixels, then scaled)
    try:
        cw = None
        if out["chart"].get("ok"):
            cw = {"corners": [[x / s, y / s] for x, y in out["chart"]["corners"]], "spacing": out["chart"]["spacing"] / s}
        rw = None
        if out["ruler"].get("ok"):
            rw = {"p1": [v / s for v in out["ruler"]["p1"]], "p2": [v / s for v in out["ruler"]["p2"]],
                  "px_per_mm": out["ruler"]["px_per_mm"] / s,
                  "body_dir": out["ruler"].get("body_dir"), "body_side_margin": out["ruler"].get("body_side_margin", 0)}
        # no chart -> not a tray photo (X-ray etc.): don't guess
        fb = detect_fish(bgr, cw, rw) if cw else {"ok": False, "reason": "no color chart, fish search skipped"}
        if fb.get("ok"):
            for kk in ("cx", "cy", "w", "h"):
                fb[kk] *= s
        out["fish"] = fb
    except Exception as e:  # pragma: no cover
        out["fish"] = {"ok": False, "reason": "error: %s" % e}
    return out
