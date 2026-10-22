// Generic pan/zoom canvas with draggable handles and a magnifier loupe.
// World coordinates are arbitrary; `draw(ctx, v)` is called with the world transform applied,
// `overlay(ctx, v)` is called in screen (CSS pixel) space.
class CanvasViewer {
  constructor(canvas, opts) {
    opts = opts || {};
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.draw = opts.draw || (() => {});
    this.overlay = opts.overlay || (() => {});
    this.handles = opts.handles || (() => []);
    this.onClick = opts.onClick || null;
    this.onViewChange = opts.onViewChange || null;
    this.minScale = 0.005; this.maxScale = 60;
    this.loupeEnabled = opts.loupe !== false;
    this.loupeFactor = 4;
    this.drag = null;
    this.mouse = null;
    this.w = 1; this.h = 1;
    this._fitBox = null;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this._bind();
    this.resize();
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const firstReal = this.w <= 1;
    const oldW = this.w, oldH = this.h;
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * this.dpr);
    this.c.height = Math.round(r.height * this.dpr);
    if (firstReal && this._fitBox) this.fit.apply(this, this._fitBox);
    else if (!firstReal) { // keep the centre fixed
      this.tx += (this.w - oldW) / 2; this.ty += (this.h - oldH) / 2;
    }
    this.render();
  }

  toWorld(sx, sy) { return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale]; }
  toScreen(wx, wy) { return [wx * this.scale + this.tx, wy * this.scale + this.ty]; }

  fit(x0, y0, x1, y1, pad) {
    this._fitBox = [x0, y0, x1, y1, pad];
    if (this.w <= 1) return;
    pad = pad == null ? 0.04 : pad;
    const bw = x1 - x0, bh = y1 - y0;
    const s = Math.min(this.w / (bw * (1 + 2 * pad)), this.h / (bh * (1 + 2 * pad)));
    this.scale = s;
    this.tx = this.w / 2 - (x0 + bw / 2) * s;
    this.ty = this.h / 2 - (y0 + bh / 2) * s;
    this.render();
    if (this.onViewChange) this.onViewChange(this);
  }
  refit() { if (this._fitBox) this.fit.apply(this, this._fitBox); }

  centerOn(wx, wy, scale) {
    if (scale) this.scale = Math.max(this.minScale, Math.min(this.maxScale, scale));
    this.tx = this.w / 2 - wx * this.scale;
    this.ty = this.h / 2 - wy * this.scale;
    this.render();
  }

  zoomAt(sx, sy, f) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * f));
    this.tx = sx - wx * this.scale;
    this.ty = sy - wy * this.scale;
    this.render();
    if (this.onViewChange) this.onViewChange(this);
  }
  zoomCenter(f) { this.zoomAt(this.w / 2, this.h / 2, f); }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._paint(); });
  }

  _paint() {
    const ctx = this.ctx, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.c.width, this.c.height);
    ctx.save();
    ctx.setTransform(d * this.scale, 0, 0, d * this.scale, d * this.tx, d * this.ty);
    ctx.imageSmoothingEnabled = this.scale < 1.5;
    this.draw(ctx, this);
    ctx.restore();
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    this.overlay(ctx, this);
    ctx.restore();
    if (this.drag && this.drag.handle && this.loupeEnabled && this.drag.handle.loupe !== false) this._paintLoupe();
  }

  _paintLoupe() {
    const ctx = this.ctx, d = this.dpr;
    const h = this.drag.handle;
    const wx = this.drag.wx, wy = this.drag.wy;
    const R = Math.min(110, Math.min(this.w, this.h) * 0.22);
    const [sx, sy] = this.toScreen(wx, wy);
    // put loupe in the corner farthest from the cursor
    const lx = sx > this.w / 2 ? R + 14 : this.w - R - 14;
    const ly = sy > this.h / 2 ? R + 14 : this.h - R - 14;
    const ls = Math.min(this.scale * this.loupeFactor, this.maxScale);
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.fillStyle = "#111"; ctx.fill();
    ctx.clip();
    ctx.setTransform(d * ls, 0, 0, d * ls, d * (lx - wx * ls), d * (ly - wy * ls));
    ctx.imageSmoothingEnabled = ls < 1.5;
    this.draw(ctx, { scale: ls, loupe: true });
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.strokeStyle = h.color || "#ff0"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx - R, ly); ctx.lineTo(lx - 5, ly); ctx.moveTo(lx + 5, ly); ctx.lineTo(lx + R, ly);
    ctx.moveTo(lx, ly - R); ctx.lineTo(lx, ly - 5); ctx.moveTo(lx, ly + 5); ctx.lineTo(lx, ly + R);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText((h.label ? h.label + "  " : "") + "×" + (ls / this.scale).toFixed(0), lx, ly + R - 8);
    ctx.restore();
  }

  _local(e) {
    const r = this.c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _hit(sx, sy) {
    const hs = this.handles(this) || [];
    let best = null, bd = Infinity;
    for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i];
      const [hx, hy] = this.toScreen(h.x, h.y);
      const dd = Math.hypot(hx - sx, hy - sy);
      const r = h.r || 9;
      if (dd <= r && dd < bd - 0.01 * (h.priority || 0)) { best = h; bd = dd; }
    }
    return best;
  }

  _bind() {
    const c = this.c;
    c.addEventListener("pointerdown", e => {
      if (e.button === 2) return;
      c.setPointerCapture(e.pointerId);
      const [sx, sy] = this._local(e);
      const h = (e.button === 0 && !e.altKey) ? this._hit(sx, sy) : null;
      if (h) {
        const [wx, wy] = this.toWorld(sx, sy);
        this.drag = { handle: h, ox: h.x - wx, oy: h.y - wy, wx: h.x, wy: h.y, moved: false };
        if (h.onDown) h.onDown(e);
      } else {
        this.drag = { pan: true, sx, sy, tx0: this.tx, ty0: this.ty, moved: false };
        c.style.cursor = "grabbing";
      }
      this.render();
    });
    c.addEventListener("pointermove", e => {
      const [sx, sy] = this._local(e);
      this.mouse = [sx, sy];
      const dr = this.drag;
      if (dr && dr.handle) {
        const [wx, wy] = this.toWorld(sx, sy);
        const nx = wx + dr.ox, ny = wy + dr.oy;
        if (!dr.moved && Math.hypot(nx - dr.handle.x, ny - dr.handle.y) * this.scale < 1) return;
        dr.moved = true;
        dr.wx = nx; dr.wy = ny;
        if (dr.handle.onDrag) dr.handle.onDrag(nx, ny, e);
        this.render();
      } else if (dr && dr.pan) {
        const dx = sx - dr.sx, dy = sy - dr.sy;
        if (Math.hypot(dx, dy) > 3) dr.moved = true;
        if (dr.moved) { this.tx = dr.tx0 + dx; this.ty = dr.ty0 + dy; this.render(); }
      } else {
        const h = this._hit(sx, sy);
        c.style.cursor = h ? (h.cursor || "grab") : (this.onClick && this.clickCursor ? this.clickCursor : "default");
        if (this.hoverRender) this.render();
      }
    });
    const end = e => {
      const dr = this.drag;
      this.drag = null;
      c.style.cursor = "default";
      if (!dr) return;
      if (dr.handle) {
        if (dr.handle.onEnd) dr.handle.onEnd(dr.moved);
      } else if (dr.pan) {
        if (!dr.moved && this.onClick && e.type === "pointerup") {
          const [sx, sy] = this._local(e);
          const [wx, wy] = this.toWorld(sx, sy);
          this.onClick(wx, wy, e);
        } else if (dr.moved && this.onViewChange) this.onViewChange(this);
      }
      this.render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", e => {
      e.preventDefault();
      const [sx, sy] = this._local(e);
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      const k = e.ctrlKey ? 0.01 : 0.0022;
      this.zoomAt(sx, sy, Math.exp(-dy * k));
    }, { passive: false });
    c.addEventListener("contextmenu", e => e.preventDefault());
  }
}

// ---------- geometry helpers ----------
function solveLinear(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length;
  const M = A.map((r, i) => r.concat([b[i]]));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

// Homography mapping src[i] -> dst[i] (4 point pairs). Returns function (x,y)->[X,Y]
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return (x, y) => {
    const w = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  };
}

// Fish box: {cx, cy, w, h, angle (deg, direction head->tail), mirror}
// local frame: xl along head->tail, yl perpendicular. Fish frame (u,v): u from head edge, v from dorsal edge.
const Fish = {
  toLocal(f, x, y) {
    const a = f.angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = x - f.cx, dy = y - f.cy;
    return [dx * c + dy * s, -dx * s + dy * c];
  },
  fromLocal(f, xl, yl) {
    const a = f.angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [f.cx + xl * c - yl * s, f.cy + xl * s + yl * c];
  },
  toUV(f, x, y) {
    const [xl, yl] = Fish.toLocal(f, x, y);
    return [xl + f.w / 2, f.mirror ? f.h / 2 - yl : yl + f.h / 2];
  },
  fromUV(f, u, v) {
    const xl = u - f.w / 2;
    const yl = f.mirror ? f.h / 2 - v : v - f.h / 2;
    return Fish.fromLocal(f, xl, yl);
  },
  // canvas transform (a,b,c,d,e,f) mapping image coords -> fish (u,v) coords
  matrix(f) {
    const a = f.angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const m = f.mirror ? -1 : 1;
    return [c, -m * s, s, m * c,
      -(c * f.cx + s * f.cy) + f.w / 2,
      m * (s * f.cx - c * f.cy) + f.h / 2];
  },
  corners(f) {
    const w = f.w / 2, h = f.h / 2;
    return [[-w, -h], [w, -h], [w, h], [-w, h]].map(p => Fish.fromLocal(f, p[0], p[1]));
  }
};

if (typeof module !== "undefined") module.exports = { homography, Fish, solveLinear };
