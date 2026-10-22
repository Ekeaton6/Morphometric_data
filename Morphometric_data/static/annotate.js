(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const S = {
    id: params.get("id"),
    tab: 1, mode: null, pending: [], selected: null,
    dirty: false, saving: false, locked: false,
    img: null, imgFull: null, W: 0, H: 0,
  };
  const CORNER_PATCHES = [1, 6, 24, 19];           // order of the 4 clicks
  const CORNER_GRID = [[0, 0], [5, 0], [5, 3], [0, 3]];
  const CHART_PROMPTS = [
    "Click the CENTER of patch 1 (chart's top-left corner patch)",
    "Click the CENTER of patch 6 (top-right corner patch)",
    "Click the CENTER of patch 24 (bottom-right, black)",
    "Click the CENTER of patch 19 (bottom-left, white)",
  ];

  bindUserInput($("user"), () => { if (S.dirty) scheduleAutosave(); });

  // =====================================================================
  // Loading
  // =====================================================================
  async function init() {
    if (!S.id) { toast("No image id given", true); return; }
    const [cfg, img] = await Promise.all([api("/api/config"), api("/api/image?id=" + encodeURIComponent(S.id))]);
    S.cfg = cfg;
    S.lmDefs = cfg.landmarks.landmarks;
    S.lmById = {}; S.lmDefs.forEach((l, i) => { S.lmById[l.id] = l; l._i = i; });
    S.groups = cfg.landmarks.groups;
    S.chartDef = cfg.colorchart;
    S.info = img.info; S.meta = img.metadata; S.group = img.group;
    S.template = img.template;
    S.W = img.info.width; S.H = img.info.height;
    applyRecord(img.annotation, img.history);
    document.title = S.id + " – Annotate";
    $("title").textContent = S.id;
    renderMeta(img);
    loadImages();
    buildViewers();
    buildLmList();
    renderAll();
    if (params.get("tab") === "2") setTab(2);
    autoDetect(false);
    presencePing();
  }

  // =====================================================================
  // Automatic guesses (chart, ruler, fish box)
  // =====================================================================
  function setDetectState(t) { $("detectState").textContent = t || ""; }

  async function autoDetect(force) {
    if (S.locked) return;
    const d = S.data;
    const need = force || !d.fish || (d.chart.present && !d.chart.corners) || (d.ruler.present && !d.ruler.p1);
    if (!need) return;
    setDetectState("Detecting…");
    let r;
    try {
      r = await api("/api/detect?id=" + encodeURIComponent(S.id) + (force ? "&force=1" : ""));
    } catch (e) { setDetectState("Auto-detect failed: " + e.message); return; }
    if (!r.available) { setDetectState("Auto-detect not installed on the server"); return; }
    if (S.locked) return;
    const res = r.result || {};
    const got = [], missed = [];
    const ch = res.chart || {}, ru = res.ruler || {}, fi = res.fish || {};
    if (d.chart.present && (force || !d.chart.corners)) {
      if (ch.ok) {
        d.chart.corners = ch.corners; d.chart.offsets = {};
        d.chart.auto = { confidence: ch.confidence, reviewed: false, edited: false };
        got.push("chart"); scheduleSample();
      } else missed.push("chart");
    }
    if (d.ruler.present && (force || !d.ruler.p1)) {
      if (ru.ok) {
        d.ruler.p1 = ru.p1; d.ruler.p2 = ru.p2; d.ruler.mm = ru.mm;
        d.ruler.auto = { confidence: ru.confidence, reviewed: false, edited: false, on_cm_lines: !!ru.on_cm_lines };
        got.push("ruler");
      } else missed.push("ruler");
    }
    if (force || !d.fish) {
      if (fi.ok) {
        d.fish = { cx: fi.cx, cy: fi.cy, w: fi.w, h: fi.h, angle: fi.angle, mirror: !!fi.mirror,
          auto: { confidence: fi.confidence, reviewed: false, edited: false } };
        got.push("fish box");
        if (force) { // points follow the new box
          S.lmDefs.forEach(l => { const p = d.landmarks[l.id]; if (p && !p.moved) delete d.landmarks[l.id]; });
        }
      } else missed.push("fish box");
    }
    setDetectState((got.length ? "Auto-detected: " + got.join(", ") + "." : "") +
      (missed.length ? " Not found: " + missed.join(", ") + " (place manually)." : ""));
    if (force) changed(); // a re-run is an explicit edit; a first prefill is saved with your next change
    renderAll();
    if (S.tab === 2) setTab(2);
  }

  function touch(kind) {
    const o = kind === "fish" ? S.data.fish : S.data[kind];
    if (o && o.auto) o.auto.edited = true;
  }

  function renderAuto() {
    const items = { chart: S.data.chart.present ? S.data.chart : null, ruler: S.data.ruler.present ? S.data.ruler : null, fish: S.data.fish };
    Object.keys(items).forEach(k => {
      const el = $("auto_" + k), o = items[k];
      if (!o || !o.auto) { el.innerHTML = ""; el.className = "autonote"; return; }
      const a = o.auto, pct = Math.round((a.confidence || 0) * 100);
      const done = a.reviewed || a.edited;
      el.className = "autonote" + (done ? " ok" : "");
      let extra = "";
      if (k === "ruler" && !a.on_cm_lines && !done) extra = " Endpoints may be ~1 mm off a cm line.";
      el.innerHTML = done
        ? `Auto-detected · ${a.edited ? "adjusted" : "confirmed"}`
        : `Auto-detected (confidence ${pct}%). Check it.${extra} <button data-ok="${k}" ${S.locked ? "disabled" : ""}>Looks right</button>`;
      const b = el.querySelector("button");
      if (b) b.onclick = () => { a.reviewed = true; changed(); renderAuto(); };
    });
  }

  function emptyData() {
    return {
      chart: { present: true, corners: null, offsets: {}, patches: [], sample_px: null },
      ruler: { present: true, p1: null, p2: null, mm: 10 },
      fish: null, landmarks: {}, notes: "",
    };
  }

  function applyRecord(rec, history) {
    S.rec = rec;
    S.status = rec ? rec.status : "not_started";
    const d = rec ? rec.data : emptyData();
    const e = emptyData();
    S.data = Object.assign(e, d);
    S.data.chart = Object.assign(emptyData().chart, d.chart || {});
    S.data.ruler = Object.assign(emptyData().ruler, d.ruler || {});
    S.data.chart.offsets = S.data.chart.offsets || {};
    S.data.landmarks = S.data.landmarks || {};
    S.locked = S.status === "approved";
    S.history = history || [];
    S.dirty = false;
  }

  function loadImages() {
    const disp = new Image();
    disp.onload = () => {
      S.img = disp;
      v1.fit(0, 0, S.W, S.H, 0.02);
      renderAll();
      const full = new Image();
      full.onload = () => { S.imgFull = full; v1.render(); v2.render(); };
      full.src = "/img/full?id=" + encodeURIComponent(S.id);
    };
    disp.onerror = () => toast("Could not load image", true);
    disp.src = "/img/display?id=" + encodeURIComponent(S.id);
  }
  function bestImg() { return S.imgFull || S.img; }

  // =====================================================================
  // Colour chart geometry
  // =====================================================================
  function chartH() {
    const c = S.data.chart;
    if (!c.corners || c.corners.length !== 4) return null;
    return homography(CORNER_GRID, c.corners);
  }
  function patchRC(n) { return [(n - 1) % 6, Math.floor((n - 1) / 6)]; }
  function patchBase(H, n) { const [c, r] = patchRC(n); return H(c, r); }
  function patchCenter(H, n) {
    const b = patchBase(H, n), o = S.data.chart.offsets[n] || [0, 0];
    return [b[0] + o[0], b[1] + o[1]];
  }
  function chartSpacing(H) {
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const c = S.data.chart.corners;
    return (d(c[0], c[1]) / 5 + d(c[3], c[2]) / 5 + d(c[0], c[3]) / 3 + d(c[1], c[2]) / 3) / 4;
  }
  function samplePx(H) { return Math.max(4, Math.round(chartSpacing(H) * 0.28)); }

  let sampleTimer = null, samplePromise = null;
  function scheduleSample() {
    clearTimeout(sampleTimer);
    sampleTimer = setTimeout(() => { sampleTimer = null; samplePromise = doSample(); }, 300);
  }
  async function flushSample() {
    if (sampleTimer) { clearTimeout(sampleTimer); sampleTimer = null; samplePromise = doSample(); }
    if (samplePromise) await samplePromise.catch(() => {});
  }
  async function doSample() {
    const H = chartH();
    const c = S.data.chart;
    if (!H || !c.present) return;
    const pts = [], ns = [];
    for (let n = 1; n <= 24; n++) { pts.push(patchCenter(H, n)); ns.push(n); }
    const size = samplePx(H);
    try {
      const r = await api("/api/sample_colors", { id: S.id, points: pts, size });
      const old = {}; (c.patches || []).forEach(p => old[p.n] = p);
      c.patches = ns.map((n, i) => Object.assign({ n, x: pts[i][0], y: pts[i][1], damaged: !!(old[n] && old[n].damaged) }, r.samples[i] || {}));
      c.sample_px = size;
      renderSwatches();
    } catch (e) { toast("Color sampling failed: " + e.message, true); }
  }

  // =====================================================================
  // Viewer 1: whole image
  // =====================================================================
  let v1, v2;
  function buildViewers() {
    v1 = new CanvasViewer($("cv1"), {
      draw: (ctx) => { const im = bestImg(); if (im) ctx.drawImage(im, 0, 0, S.W, S.H); },
      overlay: overlay1,
      handles: handles1,
      onClick: click1,
    });
    v1.clickCursor = "crosshair";
    v2 = new CanvasViewer($("cv2"), {
      draw: draw2, overlay: overlay2, handles: handles2, onClick: click2,
    });
    v2.clickCursor = "default";
    document.querySelectorAll("[data-z1]").forEach(b => b.onclick = () => {
      const k = b.dataset.z1;
      if (k === "fit") v1.fit(0, 0, S.W, S.H, 0.02); else v1.zoomCenter(k === "in" ? 1.5 : 1 / 1.5);
    });
    document.querySelectorAll("[data-z2]").forEach(b => b.onclick = () => {
      const k = b.dataset.z2;
      if (k === "fit") fit2();
      else if (k === "sel") zoomToSelected();
      else v2.zoomCenter(k === "in" ? 1.5 : 1 / 1.5);
    });
    new ResizeObserver(drawRef).observe($("refcv"));
    new ResizeObserver(drawRef).observe($("refzoom"));
  }

  function marker(ctx, x, y, color, r, dashed) {
    ctx.save();
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.65)";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    if (dashed) ctx.setLineDash([3, 3]);
    ctx.lineWidth = 2; ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function label(ctx, x, y, text, color, bg) {
    ctx.save();
    ctx.font = "bold 12px -apple-system, sans-serif";
    const w = ctx.measureText(text).width + 6;
    ctx.fillStyle = bg || "rgba(255,255,255,.9)";
    ctx.fillRect(x, y - 13, w, 16);
    ctx.strokeStyle = color || "#333"; ctx.lineWidth = 1;
    ctx.strokeRect(x + .5, y - 12.5, w - 1, 15);
    ctx.fillStyle = "#111";
    ctx.fillText(text, x + 3, y);
    ctx.restore();
  }
  function sq(ctx, x, y, s, color, lw) {
    ctx.save(); ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = (lw || 1.5) + 2;
    ctx.strokeRect(x - s, y - s, 2 * s, 2 * s);
    ctx.strokeStyle = color; ctx.lineWidth = lw || 1.5;
    ctx.strokeRect(x - s, y - s, 2 * s, 2 * s); ctx.restore();
  }

  function overlay1(ctx, v) {
    const T = (p) => v.toScreen(p[0], p[1]);
    // ---- chart
    const c = S.data.chart, H = chartH();
    if (H && c.present) {
      const outline = [[-0.5, -0.5], [5.5, -0.5], [5.5, 3.5], [-0.5, 3.5]].map(p => T(H(p[0], p[1])));
      ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 1.5;
      ctx.beginPath(); outline.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke(); ctx.restore();
      const half = samplePx(H) / 2 * v.scale;
      const damaged = {}; (c.patches || []).forEach(p => damaged[p.n] = p.damaged);
      for (let n = 1; n <= 24; n++) {
        const [sx, sy] = T(patchCenter(H, n));
        const corner = CORNER_PATCHES.includes(n);
        sq(ctx, sx, sy, Math.max(half, 3), damaged[n] ? "#ff4d4d" : (corner ? "#ffe14d" : "#fff"), corner ? 2.5 : 1.5);
        ctx.save(); ctx.font = "bold 11px sans-serif"; ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
        ctx.strokeText(n, sx - Math.max(half, 3), sy - Math.max(half, 3) - 3); ctx.fillText(n, sx - Math.max(half, 3), sy - Math.max(half, 3) - 3); ctx.restore();
      }
      const [mx, my] = T(H(2.5, 1.5));
      ctx.save(); ctx.fillStyle = "rgba(255,225,77,.9)"; ctx.beginPath(); ctx.arc(mx, my, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#000"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.fillText("✥", mx, my + 4); ctx.restore();
    }
    // ---- ruler
    const r = S.data.ruler;
    if (r.present && r.p1 && r.p2) {
      const a = T(r.p1), b = T(r.p2);
      ctx.save(); ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = "#ff3df5"; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
      marker(ctx, a[0], a[1], "#ff3df5", 6); marker(ctx, b[0], b[1], "#ff3df5", 6);
      const ppm = pxPerMM();
      label(ctx, (a[0] + b[0]) / 2 + 8, (a[1] + b[1]) / 2 - 8, `${r.mm} mm${ppm ? " = " + (ppm * r.mm).toFixed(1) + " px" : ""}`, "#ff3df5");
    }
    // ---- fish box
    const f = S.data.fish;
    if (f) {
      const cs = Fish.corners(f).map(T);
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = 4;
      ctx.beginPath(); cs.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = "#39d5ff"; ctx.lineWidth = 2; ctx.stroke();
      // head edge highlighted
      ctx.strokeStyle = "#ff5a36"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cs[0][0], cs[0][1]); ctx.lineTo(cs[3][0], cs[3][1]); ctx.stroke();
      ctx.restore();
      const hp = T(Fish.fromLocal(f, -f.w / 2, 0));
      label(ctx, hp[0] + 8, hp[1] + 4, "HEAD", "#ff5a36");
      const dp = T(Fish.fromLocal(f, 0, f.mirror ? f.h / 2 : -f.h / 2));
      label(ctx, dp[0] - 24, dp[1] + (f.mirror ? -8 : 20), "dorsal", "#39d5ff");
      if (!S.locked && !S.mode) {
        handles1(v).filter(h => h.kind === "fish").forEach(h => {
          const [x, y] = v.toScreen(h.x, h.y);
          ctx.save();
          if (h.rot) {
            const cp = T(Fish.fromLocal(f, 0, -f.h / 2));
            ctx.strokeStyle = "#39d5ff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cp[0], cp[1]); ctx.lineTo(x, y); ctx.stroke();
            ctx.fillStyle = "#39d5ff"; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#000"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.fillText("⟳", x, y + 4);
          } else if (h.move) {
            ctx.fillStyle = "rgba(57,213,255,.9)"; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#000"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.fillText("✥", x, y + 4);
          } else {
            ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
            ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10);
          }
          ctx.restore();
        });
      }
    }
    // ---- pending clicks
    S.pending.forEach((p, i) => { const [x, y] = T(p); marker(ctx, x, y, "#ffe14d", 7); label(ctx, x + 9, y - 6, String(i + 1), "#ffe14d"); });
  }

  function handles1(v) {
    if (S.locked || S.mode) return [];
    const hs = [];
    const f = S.data.fish;
    if (f) {
      const L = (xl, yl) => Fish.fromLocal(f, xl, yl);
      const mk = (pos, extra) => Object.assign({ x: pos[0], y: pos[1], r: 10, kind: "fish", onEnd: m => { if (m) { touch("fish"); changed(); } } }, extra);
      hs.push(mk([f.cx, f.cy], { move: true, cursor: "move", loupe: false, onDrag: (x, y) => { f.cx = x; f.cy = y; } }));
      const edge = (which) => (x, y) => {
        const [xl, yl] = Fish.toLocal(f, x, y);
        let l = -f.w / 2, r = f.w / 2, t = -f.h / 2, b = f.h / 2;
        if (which === "head") l = Math.min(xl, r - 10);
        if (which === "tail") r = Math.max(xl, l + 10);
        if (which === "top") t = Math.min(yl, b - 10);
        if (which === "bot") b = Math.max(yl, t + 10);
        const c = Fish.fromLocal(f, (l + r) / 2, (t + b) / 2);
        f.cx = c[0]; f.cy = c[1]; f.w = r - l; f.h = b - t;
      };
      hs.push(mk(L(-f.w / 2, 0), { cursor: "ew-resize", label: "head edge", onDrag: edge("head") }));
      hs.push(mk(L(f.w / 2, 0), { cursor: "ew-resize", label: "tail edge", onDrag: edge("tail") }));
      hs.push(mk(L(0, -f.h / 2), { cursor: "ns-resize", onDrag: edge("top") }));
      hs.push(mk(L(0, f.h / 2), { cursor: "ns-resize", onDrag: edge("bot") }));
      hs.push(mk(L(0, -f.h / 2 - 34 / v.scale), {
        rot: true, cursor: "alias", loupe: false,
        onDrag: (x, y, e) => {
          let a = Math.atan2(y - f.cy, x - f.cx) * 180 / Math.PI + 90;
          if (e && e.shiftKey) a = Math.round(a / 5) * 5;
          f.angle = ((a % 360) + 360) % 360;
        }
      }));
    }
    const r = S.data.ruler;
    if (r.present && r.p1 && r.p2) {
      ["p1", "p2"].forEach(k => hs.push({ x: r[k][0], y: r[k][1], r: 10, color: "#ff3df5", label: "ruler",
        onDrag: (x, y) => { r[k] = [x, y]; }, onEnd: m => { if (m) { touch("ruler"); changed(); } } }));
    }
    const c = S.data.chart, H = chartH();
    if (H && c.present) {
      const mid = H(2.5, 1.5);
      hs.push({ x: mid[0], y: mid[1], r: 9, cursor: "move", loupe: false, _last: mid.slice(),
        onDown() { this._last = [this.x, this.y]; },
        onDrag(x, y) {
          const dx = x - this._last[0], dy = y - this._last[1]; this._last = [x, y];
          c.corners = c.corners.map(p => [p[0] + dx, p[1] + dy]);
        }, onEnd: m => { if (m) { touch("chart"); scheduleSample(); changed(); } } });
      for (let n = 1; n <= 24; n++) {
        const p = patchCenter(H, n);
        const ci = CORNER_PATCHES.indexOf(n);
        hs.push({ x: p[0], y: p[1], r: 9, color: "#ffe14d", label: "patch " + n,
          onDrag: (x, y) => {
            const o = c.offsets[n] || [0, 0];
            if (ci >= 0) c.corners[ci] = [x - o[0], y - o[1]];
            else { const b = patchBase(H, n); c.offsets[n] = [x - b[0], y - b[1]]; }
          },
          onEnd: m => { if (m) { touch("chart"); scheduleSample(); changed(); } } });
      }
    }
    return hs;
  }

  function click1(x, y) {
    if (!S.mode || S.locked) return;
    S.pending.push([x, y]);
    if (S.mode === "chart" && S.pending.length === 4) {
      S.data.chart.corners = S.pending.slice(); S.data.chart.offsets = {}; S.data.chart.present = true; S.data.chart.auto = null;
      endMode(); scheduleSample(); changed();
    } else if (S.mode === "ruler" && S.pending.length === 2) {
      S.data.ruler.p1 = S.pending[0]; S.data.ruler.p2 = S.pending[1]; S.data.ruler.present = true; S.data.ruler.auto = null;
      endMode(); changed();
    } else if (S.mode === "fish" && S.pending.length === 2) {
      const [a, b] = S.pending;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 10) { S.pending = []; toast("Those clicks are too close together", true); return; }
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      S.data.fish = { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, w: L * 1.06, h: L * 0.44,
        angle: ((ang % 360) + 360) % 360, mirror: Math.cos(ang * Math.PI / 180) < 0 };
      endMode(); changed();
    }
    updatePrompt(); v1.render();
  }

  function startMode(m) {
    if (S.locked) return;
    S.mode = m; S.pending = [];
    updatePrompt(); v1.render();
  }
  function endMode() { S.mode = null; S.pending = []; updatePrompt(); }
  function updatePrompt() {
    const p = $("prompt1");
    let t = "";
    if (S.mode === "chart") t = CHART_PROMPTS[S.pending.length];
    if (S.mode === "ruler") t = S.pending.length ? `Click the second ruler mark (${S.data.ruler.mm} mm from the first)` : "Click the first ruler mark (e.g. the 0 cm line)";
    if (S.mode === "fish") t = S.pending.length ? "Click the TAIL end (tip of the caudal fin)" : "Click the SNOUT tip";
    p.style.display = t ? "" : "none";
    p.textContent = t ? t + "   (Esc to cancel)" : "";
    ["placeChart", "placeRuler", "placeFish"].forEach(id => $(id).classList.remove("active"));
    if (S.mode) $({ chart: "placeChart", ruler: "placeRuler", fish: "placeFish" }[S.mode]).classList.add("active");
  }

  function pxPerMM() {
    const r = S.data.ruler;
    if (!r.present || !r.p1 || !r.p2 || !(r.mm > 0)) return null;
    return Math.hypot(r.p2[0] - r.p1[0], r.p2[1] - r.p1[1]) / r.mm;
  }

  // =====================================================================
  // Viewer 2: fish frame
  // =====================================================================
  function draw2(ctx, v) {
    const f = S.data.fish, im = bestImg();
    if (!f || !im) return;
    ctx.save();
    const m = Fish.matrix(f);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(im, 0, 0, S.W, S.H);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "rgba(20,22,26,.55)";
    ctx.beginPath();
    ctx.rect(-f.w * 3, -f.h * 6, f.w * 7, f.h * 13);
    ctx.rect(0, 0, f.w, f.h);
    ctx.fill("evenodd");
    ctx.lineWidth = 1 / v.scale; ctx.strokeStyle = "rgba(57,213,255,.7)";
    ctx.strokeRect(0, 0, f.w, f.h);
    ctx.restore();
  }

  function lmUV(id) {
    const p = S.data.landmarks[id];
    if (!p || p.absent || p.x == null || !S.data.fish) return null;
    return Fish.toUV(S.data.fish, p.x, p.y);
  }
  function lmColor(def) { return (S.groups[def.group] || {}).color || "#fff"; }

  function overlay2(ctx, v) {
    if (!S.data.fish) return;
    // semilandmark curves: dashed outline through from -> points -> to
    curves().forEach(c => {
      const P = curveChain(c);
      if (!P) return;
      const D = spline(P, 12).map(p => v.toScreen.apply(v, Fish.toUV(S.data.fish, p[0], p[1])));
      ctx.save(); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.strokeStyle = lmColor(S.lmById[c.points[0]]);
      ctx.beginPath(); D.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke();
      ctx.restore();
    });
    const lines = S.cfg.landmarks.lines || [];
    ctx.save(); ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
    lines.forEach(([a, b]) => {
      const pa = lmUV(a), pb = lmUV(b);
      if (!pa || !pb) return;
      const A = v.toScreen(pa[0], pa[1]), B = v.toScreen(pb[0], pb[1]);
      ctx.strokeStyle = lmColor(S.lmById[a]);
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    });
    ctx.restore();
    const showLabels = true;
    S.lmDefs.forEach(def => {
      const uv = lmUV(def.id);
      if (!uv) return;
      const [x, y] = v.toScreen(uv[0], uv[1]);
      const p = S.data.landmarks[def.id];
      const sel = S.selected === def.id;
      if (sel) {
        ctx.save(); ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      marker(ctx, x, y, lmColor(def), sel ? 7 : 6, !p.moved);
      if (showLabels) label(ctx, x + 9, y - 7, def.id, lmColor(def), sel ? "#ffe14d" : null);
    });
  }

  function handles2() {
    if (S.locked || !S.data.fish) return [];
    const hs = [];
    S.lmDefs.forEach(def => {
      const uv = lmUV(def.id);
      if (!uv) return;
      hs.push({ x: uv[0], y: uv[1], r: 11, color: lmColor(def), label: def.id,
        onDown: () => select(def.id, false),
        onDrag: (u, v) => {
          const [x, y] = Fish.fromUV(S.data.fish, u, v);
          const p = S.data.landmarks[def.id]; p.x = x; p.y = y; p.moved = true;
        },
        onEnd: m => { if (m) { afterPointMoved(def.id); changed(); renderLmList(); } } });
    });
    // selected point wins when overlapping
    const si = hs.findIndex(h => h.label === S.selected);
    if (si >= 0) hs.push(hs.splice(si, 1)[0]);
    return hs;
  }

  function click2(u, v) {
    if (S.locked || !S.selected || !S.data.fish) return;
    const p = S.data.landmarks[S.selected];
    if (!p || p.absent || p.x == null) {
      const [x, y] = Fish.fromUV(S.data.fish, u, v);
      S.data.landmarks[S.selected] = { x, y, moved: true, absent: false };
      afterPointMoved(S.selected);
      changed(); renderLmList(); v2.render();
    }
  }

  function fit2() {
    const f = S.data.fish; if (!f) return;
    v2.fit(-0.02 * f.w, -0.04 * f.h, 1.02 * f.w, 1.04 * f.h, 0.01);
  }
  function zoomToSelected() {
    const uv = S.selected && lmUV(S.selected);
    if (uv) v2.centerOn(uv[0], uv[1], Math.max(v2.scale, (v2.w / (S.data.fish.w * 0.18))));
  }

  function templatePoint(id) {
    const t = (S.template.points || {})[id];
    const f = S.data.fish;
    if (!t || !f) return null;
    return Fish.fromUV(f, t[0] * f.w, t[1] * f.h);
  }
  function ensureLandmarks(onlyUnmoved) {
    if (!S.data.fish) return false;
    let n = 0;
    S.lmDefs.forEach(def => {
      const p = S.data.landmarks[def.id];
      if (!p || (onlyUnmoved && !p.moved && !p.absent)) {
        const g = templatePoint(def.id);
        if (g) { S.data.landmarks[def.id] = { x: g[0], y: g[1], moved: false, absent: false }; n++; }
      }
    });
    // fresh guesses on a curve start out evenly spaced
    if (n) curves().forEach(c => { if (c.points.every(id => !(S.data.landmarks[id] || {}).moved)) respaceCurve(c); });
    return n;
  }

  // ---------------- semilandmark curves (e.g. 8-15 on the craniofacial slope) ----------------
  let autoSpace = (() => { try { return localStorage.getItem("fa_autospace") !== "0"; } catch (e) { return true; } })();
  function curves() { return (S.cfg && S.cfg.landmarks.curves) || []; }
  function curvesTouching(id) { return curves().filter(c => c.from === id || c.to === id || c.points.includes(id)); }
  function curveChain(c) {
    const ids = [c.from].concat(c.points, [c.to]);
    const ps = ids.map(id => S.data.landmarks[id]);
    if (ps.some(p => !p || p.absent || p.x == null)) return null;
    return ps.map(p => [p.x, p.y]);
  }
  // Catmull-Rom spline through all points -> dense polyline
  function spline(P, per) {
    const out = [], n = P.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = P[Math.max(i - 1, 0)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(i + 2, n - 1)];
      for (let k = 0; k < per; k++) {
        const t = k / per, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map(j => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t +
          (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    out.push(P[n - 1].slice());
    return out;
  }
  // Move the curve's semilandmarks so they are equally spaced (by arc length) along the
  // smooth outline through 'from', the current semilandmarks and 'to'.
  function respaceCurve(c) {
    const P = curveChain(c);
    if (!P) return false;
    const D = spline(P, 24);
    const cum = [0];
    for (let i = 1; i < D.length; i++) cum.push(cum[i - 1] + Math.hypot(D[i][0] - D[i - 1][0], D[i][1] - D[i - 1][1]));
    const L = cum[cum.length - 1], m = c.points.length;
    if (!(L > 0)) return false;
    let j = 1;
    c.points.forEach((id, k) => {
      const t = L * (k + 1) / (m + 1);
      while (j < cum.length - 1 && cum[j] < t) j++;
      const f = (t - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
      const p = S.data.landmarks[id];
      p.x = D[j - 1][0] + f * (D[j][0] - D[j - 1][0]);
      p.y = D[j - 1][1] + f * (D[j][1] - D[j - 1][1]);
    });
    return true;
  }
  // after the user moves point `id`
  function afterPointMoved(id) {
    const cs = curvesTouching(id);
    cs.forEach(c => {
      if (c.points.includes(id)) c.points.forEach(pid => { const p = S.data.landmarks[pid]; if (p) p.moved = true; });
      if (autoSpace) respaceCurve(c);
    });
  }

  function select(id, center) {
    S.selected = id;
    renderLmList(); drawRef(); v2.render();
    if (center) {
      const uv = lmUV(id);
      if (uv) {
        const [sx, sy] = v2.toScreen(uv[0], uv[1]);
        if (sx < 40 || sy < 40 || sx > v2.w - 40 || sy > v2.h - 40) v2.centerOn(uv[0], uv[1]);
      }
    }
  }

  // ---------------- reference panel ----------------
  let refImg = null;
  function drawRef() {
    const L = S.cfg && S.cfg.landmarks;
    if (!L) return;
    if (!refImg) {
      refImg = new Image(); refImg.onload = drawRef; refImg.src = "/static/" + L.reference_image; return;
    }
    if (!refImg.complete) return;
    const def = S.selected ? S.lmById[S.selected] : null;
    const [vx0, vy0, vx1, vy1] = L.reference_view || [0, 0, refImg.naturalWidth, refImg.naturalHeight];
    const paint = (cv, x0, y0, x1, y1, ring) => {
      const r = cv.getBoundingClientRect(); if (r.width < 2) return;
      const d = window.devicePixelRatio || 1;
      cv.width = r.width * d; cv.height = r.height * d;
      const ctx = cv.getContext("2d");
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.fillStyle = "#eef1f4"; ctx.fillRect(0, 0, r.width, r.height);
      const s = Math.min(r.width / (x1 - x0), r.height / (y1 - y0));
      const ox = (r.width - (x1 - x0) * s) / 2, oy = (r.height - (y1 - y0) * s) / 2;
      ctx.drawImage(refImg, x0, y0, x1 - x0, y1 - y0, ox, oy, (x1 - x0) * s, (y1 - y0) * s);
      if (def) {
        const px = ox + (def.ref[0] - x0) * s, py = oy + (def.ref[1] - y0) * s;
        ctx.strokeStyle = "#000"; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(px, py, ring, 0, 7); ctx.stroke();
        ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(px, py, ring, 0, 7); ctx.stroke();
      }
    };
    paint($("refcv"), vx0, vy0, vx1, vy1, 16);
    if (def) {
      const R = 150;
      paint($("refzoom"), def.ref[0] - R, def.ref[1] - R, def.ref[0] + R, def.ref[1] + R, 22);
    } else paint($("refzoom"), vx0, vy0, vx1, vy1, 0);
    const g = def ? (S.groups[def.group] || {}) : {};
    $("reftext").innerHTML = def ? `
      <div class="big"><span style="color:${g.color === "#ffffff" ? "#777" : g.color}">●</span> ${esc(def.id)}</div>
      <div style="font-size:16px;font-weight:600;margin:4px 0 8px">${esc(def.name)}</div>
      <div class="kv"><div>Group</div><div>${esc(g.label || def.group)}</div>
      <div>Type</div><div>${def.curve ? "Semilandmark (slides along the outline)" : "Fixed landmark"}</div>
      <div>Required</div><div>${def.optional ? "Optional" : "Yes"}</div>
      <div>Point</div><div>${def._i + 1} of ${S.lmDefs.length}</div></div>
      ${def.description ? `<p>${esc(def.description)}</p>` : ""}
      ${def.curve ? (() => { const c = curves().find(cc => cc.id === def.curve); return c ? `<p style="font-size:13px">${esc(c.description || "")} ${autoSpace ? "" : "<b>Auto-spacing is off.</b>"}</p>` : ""; })() : ""}
      <p class="muted" style="font-size:12px">Reference: example specimen. Tab = next point.</p>`
      : `<div class="muted">Select a landmark (click it, or press Tab) to see where it goes on the reference fish.</div>`;
  }

  // =====================================================================
  // Side panel
  // =====================================================================
  function renderSwatches() {
    const c = S.data.chart;
    const by = {}; (c.patches || []).forEach(p => by[p.n] = p);
    $("swatches").innerHTML = S.chartDef.patches.map(d => {
      const p = by[d.n];
      const col = p && p.rgb ? `rgb(${p.rgb.join(",")})` : "#e5e7eb";
      const title = `${d.n}. ${d.name}` + (p && p.rgb ? `\nmeasured RGB ${p.rgb.join(", ")}\nLab ${p.lab.map(v => v.toFixed(1)).join(", ")}` : "") + `\nreference RGB ${d.ref_srgb.join(", ")}` + (p && p.damaged ? "\nFLAGGED DAMAGED" : "") + "\n(click to toggle damaged)";
      return `<div class="sw ${p && p.damaged ? "damaged" : ""}" data-n="${d.n}" title="${esc(title)}" style="background:${col}"><span class="n">${d.n}</span><span class="ref" style="background:rgb(${d.ref_srgb.join(",")})"></span></div>`;
    }).join("");
    $("swatches").querySelectorAll(".sw").forEach(el => el.onclick = () => {
      if (S.locked) return;
      const n = +el.dataset.n;
      const p = (c.patches || []).find(q => q.n === n);
      if (!p) { toast("Place the chart first"); return; }
      p.damaged = !p.damaged; changed(); renderSwatches(); v1.render();
    });
  }

  function renderSide1() {
    const d = S.data;
    $("noChart").checked = !d.chart.present;
    $("noRuler").checked = !d.ruler.present;
    $("rulerMM").value = d.ruler.mm;
    const ppm = pxPerMM();
    $("rulerInfo").textContent = !d.ruler.present ? "No scale: measurements will be in pixels only." :
      ppm ? `${ppm.toFixed(3)} px/mm  (${(1000 / ppm).toFixed(2)} µm per px)` : "Not placed yet.";
    const f = d.fish;
    $("fishInfo").innerHTML = f ? `Box: ${f.w.toFixed(0)} × ${f.h.toFixed(0)} px` + (ppm ? ` = ${(f.w / ppm).toFixed(1)} × ${(f.h / ppm).toFixed(1)} mm` : "") + `, angle ${f.angle.toFixed(1)}°` : "Not drawn yet. Click the snout tip, then the tail tip; adjust the edges afterwards.";
    ["placeChart", "placeRuler", "placeFish", "resetNudges", "flipHT", "flipDV", "noChart", "noRuler", "rulerMM"].forEach(id => $(id).disabled = S.locked);
    $("flipHT").disabled = $("flipDV").disabled = S.locked || !f;
    $("redetect").disabled = S.locked;
    renderSwatches();
    renderAuto();
  }

  function buildLmList() {
    // points are listed in number order (= Tab order = export order); colours show the group
    let html = `<div class="muted" style="font-size:11px;display:flex;flex-wrap:wrap;gap:4px 10px;margin:2px 0 6px">` +
      Object.keys(S.groups).map(g => `<span><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;border:1px solid #333;background:${S.groups[g].color}"></span> ${esc(S.groups[g].label)}</span>`).join("") + `</div>`;
    if (curves().length) {
      html += `<label class="row-flex" style="font-size:12px;margin-bottom:6px" title="After you move a semilandmark (or its end points), all semilandmarks on that curve slide to equal spacing along the outline">
        <input type="checkbox" id="autoSpace" ${autoSpace ? "checked" : ""}> Keep ${esc(curves().map(c => c.points[0] + "–" + c.points[c.points.length - 1]).join(", "))} evenly spaced</label>`;
    }
    S.lmDefs.forEach(def => {
      html += `<div class="lm" data-id="${esc(def.id)}"><span class="dot" style="background:${lmColor(def)}"></span><span class="id">${esc(def.id)}</span><span class="nm">${esc(def.name)}${def.optional ? ' <span class="muted">(opt.)</span>' : ""}</span>
        <label class="muted" style="font-size:11px" title="Point not visible / not applicable"><input type="checkbox" class="abs"> absent</label></div>`;
    });
    $("lmlist").innerHTML = html;
    const as = $("autoSpace");
    if (as) as.addEventListener("change", () => {
      autoSpace = as.checked;
      try { localStorage.setItem("fa_autospace", autoSpace ? "1" : "0"); } catch (e) { /* ignore */ }
      if (autoSpace && !S.locked && curves().some(c => respaceCurve(c))) { changed(); v2.render(); }
      drawRef();
    });
    $("lmlist").querySelectorAll(".lm").forEach(el => {
      el.addEventListener("click", e => { if (!e.target.closest("label")) select(el.dataset.id, true); });
      el.querySelector(".abs").addEventListener("change", e => setAbsent(el.dataset.id, e.target.checked));
    });
  }
  function setAbsent(id, absent) {
    if (S.locked) return;
    const p = S.data.landmarks[id] || {};
    p.absent = absent;
    if (!absent && p.x == null) { const g = templatePoint(id); if (g) { p.x = g[0]; p.y = g[1]; p.moved = false; } }
    S.data.landmarks[id] = p;
    changed(); renderLmList(); v2.render();
  }
  function renderLmList() {
    let moved = 0, absent = 0;
    S.lmDefs.forEach(def => {
      const el = $("lmlist").querySelector(`.lm[data-id="${CSS.escape(def.id)}"]`);
      const p = S.data.landmarks[def.id];
      el.classList.toggle("sel", S.selected === def.id);
      el.classList.toggle("absent", !!(p && p.absent));
      el.querySelector(".dot").classList.toggle("guess", !(p && p.moved));
      const cb = el.querySelector(".abs"); cb.checked = !!(p && p.absent); cb.disabled = S.locked;
      if (p && p.absent) absent++; else if (p && p.moved) moved++;
    });
    $("lmProgress").textContent = `· ${moved + absent}/${S.lmDefs.length} checked`;
    $("reguess").disabled = $("resetAll").disabled = S.locked || !S.data.fish;
    const sel = $("lmlist").querySelector(".lm.sel");
    if (sel && S.tab === 2) sel.scrollIntoView({ block: "nearest" });
  }

  function renderStatus() {
    $("statusBadge").innerHTML = badge(S.status);
    const r = S.rec || {};
    $("statusKV").innerHTML = `<div>Status</div><div>${badge(S.status)}</div>
      <div>Annotator</div><div>${esc(r.annotator || "–")}${r.annotated_at ? ` <span class="muted">${esc(fmtTime(r.annotated_at))}</span>` : ""}</div>
      <div>Approver</div><div>${esc(r.approver || "–")}${r.approved_at ? ` <span class="muted">${esc(fmtTime(r.approved_at))}</span>` : ""}</div>
      <div>Last saved</div><div>${r.updated_at ? esc(fmtTime(r.updated_at)) + " · " + esc(r.updated_by || "") : "never"}</div>
      <div>Landmark set</div><div>${esc(r.landmark_set || S.cfg.landmark_set)}${r.landmark_set && r.landmark_set !== S.cfg.landmark_set ? ' <span class="warn">(older set)</span>' : ""}</div>
      <div>Guess template</div><div>${esc(S.template.source)}${S.template.n ? " (n=" + S.template.n + ")" : ""}</div>`;
    $("lockNote").style.display = S.locked ? "" : "none";
    $("saveBtn").disabled = S.locked;
    $("submitBtn").disabled = S.locked;
    $("submitBtn").textContent = S.status === "annotated" ? "Re-submit as annotated" : "Mark annotated";
    $("approveBtn").style.display = S.status === "annotated" ? "" : "none";
    $("reopenBtn").style.display = S.locked ? "" : "none";
    $("notes").value = S.data.notes || "";
    $("notes").disabled = S.locked;
    $("history").innerHTML = S.history.length ? S.history.map(h => `<div>${esc(fmtTime(h.ts))} · <b>${esc(h.user)}</b> · ${esc(h.action)}</div>`).join("") : "No saved history yet.";
    updateSaveState();
  }

  function renderMeta(img) {
    const m = img.metadata;
    $("metaKV").innerHTML = Object.keys(m).map(k => `<div>${esc(k)}</div><div>${esc(m[k])}</div>`).join("") +
      `<div>Image size</div><div>${img.info.width} × ${img.info.height} px</div>` +
      `<div>File</div><div style="word-break:break-all">${esc(img.info.file_path)}</div>`;
    $("siblings").innerHTML = img.siblings.length ? `<div class="muted" style="font-size:12px">Other photos of this fish:</div>` +
      img.siblings.map(s => `<div><a href="/annotate?id=${encodeURIComponent(s)}">${esc(s)}</a></div>`).join("") : "";
  }

  function updateSaveState(text) {
    $("saveState").textContent = text || (S.locked ? "Locked (approved)" : S.saving ? "Saving…" : S.dirty ? (getUser() ? "Unsaved changes" : "Unsaved – enter initials to autosave") : (S.rec ? "All changes saved" : ""));
  }

  function renderAll() {
    renderSide1(); renderLmList(); renderStatus(); drawRef();
    $("tabinfo").textContent = S.data.fish ? "" : "Draw the fish box on tab 1 before placing landmarks";
    if (v1) v1.render(); if (v2) v2.render();
  }

  // =====================================================================
  // Changes / saving
  // =====================================================================
  let autosaveTimer = null;
  function changed() {
    if (S.locked) return;
    S.dirty = true;
    renderSide1();
    $("tabinfo").textContent = S.data.fish ? "" : "Draw the fish box on tab 1 before placing landmarks";
    updateSaveState();
    scheduleAutosave();
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!getUser() || S.locked) { updateSaveState(); return; }
    autosaveTimer = setTimeout(() => save("autosave").catch(() => {}), 4000);
  }

  function payload() {
    const d = JSON.parse(JSON.stringify(S.data));
    d.notes = $("notes").value;
    d.ruler.px_per_mm = pxPerMM();
    d.image_size = [S.W, S.H];
    d.template_source = S.template.source + (S.template.n ? " n=" + S.template.n : "");
    const H = chartH();
    if (H && d.chart.present) {
      d.chart.patches = (d.chart.patches || []).map(p => { const c = patchCenter(H, p.n); return Object.assign(p, { x: c[0], y: c[1] }); });
    }
    return d;
  }

  async function save(action, force) {
    if (S.locked) return false;
    let user = getUser();
    if (!user && action !== "autosave") user = await askUser();
    if (!user) { updateSaveState(); return false; }
    clearTimeout(autosaveTimer);
    await flushSample();
    if (S.conflict && !force) {
      updateSaveState("Not saved: someone else saved this image");
      if (action !== "autosave") showConflict(action);
      return false;
    }
    S.saving = true; updateSaveState();
    try {
      const r = await api("/api/save", { id: S.id, action, user, data: payload(), base_rev: myRev(), force: !!force });
      S.rec = r.annotation; S.status = r.annotation.status; S.history = r.history;
      S.data.notes = $("notes").value;
      S.dirty = false; S.saving = false; S.conflict = null; S.remote = null;
      renderStatus(); renderPresence();
      if (action !== "autosave") toast(action === "submit" ? "Marked as annotated" : (force ? "Saved (overwrote the other version)" : "Saved"));
      return true;
    } catch (e) {
      S.saving = false;
      if (e.data && e.data.conflict) {
        S.conflict = e.data;
        updateSaveState("Not saved: someone else saved this image");
        showConflict(action);
      } else {
        updateSaveState("Save failed");
        toast(e.message, true);
      }
      return false;
    }
  }

  // =====================================================================
  // Multi-user: who else has this image open, and save conflicts
  // =====================================================================
  const SESSION = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  S.others = [];
  function myRev() { return S.rec ? (S.rec.rev || 0) : -1; }

  async function presencePing() {
    if (!S.id) return;
    try {
      const r = await api("/api/presence", { id: S.id, session: SESSION, user: getUser(), dirty: S.dirty });
      S.others = r.others || [];
      // someone else saved since we loaded / last saved
      S.remote = (r.rev !== myRev() && !S.saving) ? r : null;
    } catch (e) { /* server briefly unreachable: keep last state */ }
    renderPresence();
  }

  function renderPresence() {
    const bar = $("presenceBar");
    if (!bar) return;
    const parts = [];
    let alert = false;
    if (S.others.length) {
      const who = S.others.map(o => `<b>${esc(o.user || "someone without initials")}</b> (since ${esc(fmtTime(o.since).split(" ").pop())}${o.dirty ? ", has unsaved edits" : ""})`).join(", ");
      parts.push(`This image is also open by ${who}. If you both edit it, saves will conflict: agree who annotates it.`);
    }
    if (S.remote && !S.conflict) {
      alert = true;
      parts.push(`<b>${esc(S.remote.updated_by || "Someone")}</b> saved a newer version at ${esc(fmtTime(S.remote.updated_at))}.` +
        (S.dirty ? " Your unsaved edits are based on the older version." : "") +
        ` <button id="loadTheirs">Load their version</button>`);
    }
    bar.style.display = parts.length ? "" : "none";
    bar.className = "presencebar" + (alert ? " alert" : "");
    bar.innerHTML = parts.join(" &nbsp;·&nbsp; ");
    const b = $("loadTheirs");
    if (b) b.onclick = () => {
      if (S.dirty && !confirm("Discard your unsaved edits and load the newer version?")) return;
      S.dirty = false; location.reload();
    };
  }

  function showConflict(action) {
    if (document.querySelector(".modal-bg.conflict")) return;
    const c = S.conflict || {};
    const bg = document.createElement("div");
    bg.className = "modal-bg conflict";
    bg.innerHTML = `<div class="modal" style="width:420px"><h2>Someone else saved this image</h2>
      <p><b>${esc(c.updated_by || "Another user")}</b> saved it at ${esc(fmtTime(c.updated_at))}, after you opened it.
      Your changes have <b>not</b> been saved.</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="theirs primary">Load their version (discard my changes)</button>
        <button class="mine">Keep mine (overwrite their save)</button>
        <button class="later">Decide later</button></div></div>`;
    document.body.appendChild(bg);
    bg.querySelector(".theirs").onclick = () => { S.dirty = false; location.reload(); };
    bg.querySelector(".mine").onclick = async () => {
      bg.remove();
      if (await save(action === "autosave" ? "save" : action, true)) toast("Saved your version");
    };
    bg.querySelector(".later").onclick = () => { bg.remove(); renderPresence(); };
  }

  setInterval(presencePing, 15000);
  window.addEventListener("pagehide", () => {
    try {
      navigator.sendBeacon("/api/presence/leave", new Blob([JSON.stringify({ id: S.id, session: SESSION })], { type: "text/plain" }));
    } catch (e) { /* ignore */ }
  });

  async function submit() {
    const d = S.data, problems = [];
    if (!d.fish) { toast("Draw the fish box first (tab 1).", true); return; }
    if (d.chart.present && !d.chart.corners) problems.push("Color chart not placed (tick 'No color chart' if there isn't one).");
    if (d.ruler.present && !(d.ruler.p1 && d.ruler.p2)) problems.push("Ruler not placed (tick 'No ruler' if there isn't one).");
    const unchecked = [["chart", d.chart.present ? d.chart : null], ["ruler", d.ruler.present ? d.ruler : null], ["fish box", d.fish]]
      .filter(([, o]) => o && o.auto && !o.auto.reviewed && !o.auto.edited).map(([n]) => n);
    if (unchecked.length) problems.push(`Auto-detected ${unchecked.join(", ")} not yet checked (click "Looks right" or adjust).`);
    const unmoved = S.lmDefs.filter(l => { const p = d.landmarks[l.id]; return !p || (!p.moved && !p.absent); }).map(l => l.id);
    if (unmoved.length) problems.push(`${unmoved.length} landmark(s) still at the starting guess: ${unmoved.join(", ")}`);
    if (problems.length && !confirm("Before marking as annotated:\n\n• " + problems.join("\n• ") + "\n\nMark as annotated anyway?")) return;
    await save("submit");
  }

  async function approve() {
    if (S.dirty && !confirm("There are unsaved edits. Approving will save them first under your initials. Continue?")) return;
    const user = getUser() || await askUser("Enter the approver's initials.");
    if (!user) return;
    if (S.rec && (S.rec.annotator || "").toUpperCase() === user) { toast(`The approver must be someone other than the annotator (${S.rec.annotator}).`, true); return; }
    if (!confirm(`Approve this annotation as ${user}? It will be locked.`)) return;
    if (S.dirty && !(await save("save"))) return;
    try {
      const r = await api("/api/approve", { id: S.id, user });
      S.rec = r.annotation; S.status = r.annotation.status; S.history = r.history; S.locked = true;
      renderAll(); toast("Approved");
    } catch (e) { toast(e.message, true); }
  }

  async function reopen() {
    const user = getUser() || await askUser();
    if (!user) return;
    if (!confirm("Reopen this approved annotation for editing? The approval will be removed (it stays in the history).")) return;
    try {
      const r = await api("/api/reopen", { id: S.id, user });
      S.rec = r.annotation; S.status = r.annotation.status; S.history = r.history; S.locked = false;
      renderAll(); toast("Reopened");
    } catch (e) { toast(e.message, true); }
  }

  // Previous / next in the landing-page order (grouped by Species), regardless of status
  async function stepImage(delta) {
    if (S.dirty && getUser()) await save("autosave");
    const { images } = await api("/api/images");
    const i = images.findIndex(r => r.id === S.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= images.length) { toast(delta < 0 ? "This is the first image." : "This is the last image."); return; }
    location.href = "/annotate?id=" + encodeURIComponent(images[j].id) + (S.tab === 2 ? "&tab=2" : "");
  }

  async function nextImage() {
    if (S.dirty && getUser()) await save("autosave");
    const { images } = await api("/api/images");
    const same = images.filter(r => r.group === S.group);
    const i = same.findIndex(r => r.id === S.id);
    const order = same.slice(i + 1).concat(same.slice(0, i));
    const nx = order.find(r => r.status === "not_started" || r.status === "in_progress");
    if (!nx) { toast("Everything in this group is annotated."); return; }
    location.href = "/annotate?id=" + encodeURIComponent(nx.id);
  }

  // =====================================================================
  // Tabs & controls
  // =====================================================================
  let lastFitKey = null;
  function setTab(t) {
    S.tab = t;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", +b.dataset.tab === t));
    $("stage1").style.display = t === 1 ? "" : "none";
    $("side1").style.display = t === 1 ? "" : "none";
    $("stage2").style.display = t === 2 ? "" : "none";
    $("side2").style.display = t === 2 ? "" : "none";
    if (t === 2) {
      endMode();
      const f = S.data.fish;
      $("prompt2").style.display = f ? "none" : "";
      $("prompt2").textContent = "Draw the fish box on tab 1 first.";
      if (f && !S.locked && ensureLandmarks(false)) changed();
      const key = f ? JSON.stringify(f) : null;
      requestAnimationFrame(() => {
        if (key && key !== lastFitKey) { fit2(); lastFitKey = key; }
        if (!S.selected && S.lmDefs.length) select(S.lmDefs[0].id, false);
        renderLmList(); drawRef();
      });
    }
  }
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => setTab(+b.dataset.tab));
  $("toTab2").onclick = () => setTab(2);

  $("placeChart").onclick = () => startMode("chart");
  $("placeRuler").onclick = () => startMode("ruler");
  $("placeFish").onclick = () => startMode("fish");
  $("resetNudges").onclick = () => { S.data.chart.offsets = {}; scheduleSample(); changed(); v1.render(); };
  $("noChart").onchange = e => { S.data.chart.present = !e.target.checked; if (S.data.chart.present) scheduleSample(); changed(); v1.render(); };
  $("noRuler").onchange = e => { S.data.ruler.present = !e.target.checked; changed(); v1.render(); };
  $("rulerMM").onchange = e => { const v = parseFloat(e.target.value); if (v > 0) { S.data.ruler.mm = v; touch("ruler"); changed(); v1.render(); } };
  $("flipHT").onclick = () => { const f = S.data.fish; if (!f) return; f.angle = (f.angle + 180) % 360; f.mirror = !f.mirror; touch("fish"); changed(); v1.render(); };
  $("flipDV").onclick = () => { const f = S.data.fish; if (!f) return; f.mirror = !f.mirror; touch("fish"); changed(); v1.render(); };
  $("redetect").onclick = () => {
    if (S.locked) return;
    if ((S.data.chart.corners || S.data.ruler.p1 || S.data.fish) &&
      !confirm("Replace the current color chart, ruler and fish box with fresh automatic guesses?\n(Landmarks you have moved stay where they are.)")) return;
    autoDetect(true);
  };
  $("reguess").onclick = () => { const n = ensureLandmarks(true); if (n) changed(); v2.render(); renderLmList(); toast(n + " point(s) re-guessed"); };
  $("resetAll").onclick = () => {
    if (!confirm("Reset ALL landmarks to the starting guess? Your adjustments will be lost.")) return;
    S.data.landmarks = {}; ensureLandmarks(false); changed(); v2.render(); renderLmList();
  };
  $("saveBtn").onclick = () => save("save");
  $("submitBtn").onclick = submit;
  $("approveBtn").onclick = approve;
  $("reopenBtn").onclick = reopen;
  $("nextBtn").onclick = () => nextImage().catch(e => toast(e.message, true));
  $("prevBtn").onclick = () => stepImage(-1).catch(e => toast(e.message, true));
  $("nextPlainBtn").onclick = () => stepImage(1).catch(e => toast(e.message, true));
  $("notes").addEventListener("input", () => { S.data.notes = $("notes").value; changed(); });

  document.addEventListener("keydown", e => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save("save"); return; }
    if (e.key === "Escape") { endMode(); v1.render(); return; }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault(); stepImage(e.key === "ArrowLeft" ? -1 : 1).catch(err => toast(err.message, true)); return;
    }
    if (S.tab !== 2) return;
    const i = S.lmDefs.findIndex(l => l.id === S.selected);
    if (e.key === "Tab") {
      e.preventDefault();
      const n = S.lmDefs.length;
      select(S.lmDefs[((i < 0 ? -1 : i) + (e.shiftKey ? n - 1 : 1)) % n].id, true);
      return;
    }
    if (e.key === "f" || e.key === "F") { fit2(); return; }
    if (S.locked || !S.selected) return;
    if (e.key === "x" || e.key === "X") { const p = S.data.landmarks[S.selected]; setAbsent(S.selected, !(p && p.absent)); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      const uv = lmUV(S.selected); if (!uv) return;
      const k = e.shiftKey ? 10 : 1;
      const [x, y] = Fish.fromUV(S.data.fish, uv[0] + arrows[e.key][0] * k, uv[1] + arrows[e.key][1] * k);
      Object.assign(S.data.landmarks[S.selected], { x, y, moved: true });
      afterPointMoved(S.selected);
      changed(); renderLmList(); v2.render();
    }
  });

  window.addEventListener("beforeunload", e => {
    if (S.dirty && !S.locked) { e.preventDefault(); e.returnValue = ""; }
  });

  init().catch(e => { console.error(e); toast(e.message, true); });
})();
