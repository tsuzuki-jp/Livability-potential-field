/* ポテンシャル場の計算（地図ライブラリに依存しない）
 *
 *   U(x) = Σ_c s_c · w_c · Φ_c(x)
 *   点源: Φ_c = 1 − Π_i (1 − exp(−|x−p_i|²/r²))   （同種の施設が何件あっても 0〜1 で飽和）
 *   線源: Φ_c = exp(−d(x)²/r²)                      （d は最寄りの線までの距離）
 *   通勤先: Φ = exp(−|x−a|²/r²)
 *   斥力補正: +0.4 · w_c · Φ_c(r = 50 m)            （repel 指定のカテゴリ）
 */
(function () {
  'use strict';
  const R_LAT = 111320;

  class Engine {
    constructor(data, { targetCells = 160000 } = {}) {
      const [S, W, N, E] = data.region.bbox;
      this.S = S; this.W = W; this.N = N; this.E = E;
      this.MLAT = R_LAT; this.MLON = R_LAT * Math.cos((S + N) / 2 * Math.PI / 180);
      this.WM = (E - W) * this.MLON; this.HM = (N - S) * this.MLAT;
      this.CELL = Math.max(15, Math.round(Math.sqrt(this.WM * this.HM / targetCells) / 5) * 5);
      this.NX = Math.ceil(this.WM / this.CELL) + 1; this.NY = Math.ceil(this.HM / this.CELL) + 1; this.NC = this.NX * this.NY;
      this.cats = data.categories.map(c => {
        const o = { ...c };
        if (c.points) {
          o.xy = new Float64Array(c.points.length * 2); c.points.forEach((p, k) => { const [x, y] = this.toXY(p[0], p[1]); o.xy[2 * k] = x; o.xy[2 * k + 1] = y; });
          if (c.routeWeighted) o.m = Float32Array.from(c.points, p => p[3] != null ? p[3] : 1);   // 点ごとの強さ（バス停の系統数）
        }
        if (c.lines) { const s = []; for (const l of c.lines) for (let k = 0; k + 1 < l.length; k++) { const a = this.toXY(l[k][0], l[k][1]), b = this.toXY(l[k + 1][0], l[k + 1][1]); s.push(a[0], a[1], b[0], b[1]); } o.segs = new Float64Array(s); }
        return o;
      });
      this.anchors = data.anchors || [];
      this.stations = [];
      for (const c of this.cats) if (c.labels && c.points) for (const p of c.points) if (p[2]) this.stations.push({ n: p[2], la: p[0], lo: p[1], xy: this.toXY(p[0], p[1]) });
      this.cache = new Map();
      this.U = new Float32Array(this.NC);
      this.sNeg = 1; this.sPos = 1;
    }
    toXY(la, lo) { return [(lo - this.W) * this.MLON, (this.N - la) * this.MLAT]; }
    toLL(x, y) { return [this.N - y / this.MLAT, this.W + x / this.MLON]; }
    /* 画像の四隅（セル中心 i*CELL の外側に半セル） */
    imageBounds() { const h = this.CELL / 2; const a = this.toLL(-h, -h), b = this.toLL((this.NX - 1) * this.CELL + h, (this.NY - 1) * this.CELL + h); return [[b[0], a[1]], [a[0], b[1]]]; }

    ptsField(xy, r, m) {
      const { NX, NY, NC, CELL } = this, L = new Float32Array(NC), R = Math.ceil(3 * r / CELL), r2 = r * r;
      for (let k = 0; k < xy.length; k += 2) {
        const px = xy[k], py = xy[k + 1], ci = Math.round(px / CELL), cj = Math.round(py / CELL), mk = m ? m[k >> 1] : 1;
        const j0 = Math.max(0, cj - R), j1 = Math.min(NY - 1, cj + R), i0 = Math.max(0, ci - R), i1 = Math.min(NX - 1, ci + R);
        for (let j = j0; j <= j1; j++) {
          const dy = j * CELL - py, dy2 = dy * dy, row = j * NX;
          for (let i = i0; i <= i1; i++) { const dx = i * CELL - px, q = (dx * dx + dy2) / r2; if (q > 9) continue; L[row + i] += Math.log(1 - Math.min(0.999, mk * Math.exp(-q))); }
        }
      }
      for (let q = 0; q < NC; q++) L[q] = 1 - Math.exp(L[q]);
      return L;
    }
    lineField(segs, r) {
      const { NX, NY, NC, CELL } = this, D2 = new Float32Array(NC).fill(Infinity), lim = 3 * r;
      for (let k = 0; k < segs.length; k += 4) {
        const ax = segs[k], ay = segs[k + 1], bx = segs[k + 2], by = segs[k + 3], vx = bx - ax, vy = by - ay, vv = vx * vx + vy * vy || 1e-9;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - lim) / CELL)), i1 = Math.min(NX - 1, Math.ceil((Math.max(ax, bx) + lim) / CELL));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - lim) / CELL)), j1 = Math.min(NY - 1, Math.ceil((Math.max(ay, by) + lim) / CELL));
        for (let j = j0; j <= j1; j++) {
          const y = j * CELL, row = j * NX;
          for (let i = i0; i <= i1; i++) {
            const x = i * CELL; let t = ((x - ax) * vx + (y - ay) * vy) / vv; t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dx = x - ax - t * vx, dy = y - ay - t * vy, d2 = dx * dx + dy * dy; if (d2 < D2[row + i]) D2[row + i] = d2;
          }
        }
      }
      const f = new Float32Array(NC), r2 = r * r;
      for (let q = 0; q < NC; q++) f[q] = D2[q] === Infinity ? 0 : Math.exp(-D2[q] / r2);
      return f;
    }
    field(c, r, anchorIdx) {
      const weighted = !!(c.m && this.routeWeighting);
      const key = c.id + ':' + r + (c.kind === 'anchor' ? ':' + anchorIdx : '') + (weighted ? ':m' : '');
      if (this.cache.has(key)) return this.cache.get(key);
      let f;
      if (c.kind === 'anchor') {
        const a = this.anchors[anchorIdx];
        f = a ? this.ptsField(new Float64Array(this.toXY(a.lat, a.lon)), r) : new Float32Array(this.NC);
      } else if (c.kind === 'line') f = this.lineField(c.segs || new Float64Array(0), r);
      else f = this.ptsField(c.xy || new Float64Array(0), r, weighted ? c.m : null);
      this.cache.set(key, f); return f;
    }
    repField(c) { const k = 'rep:' + c.id; if (!this.cache.has(k)) this.cache.set(k, this.ptsField(c.xy || new Float64Array(0), 50)); return this.cache.get(k); }
    /* 通勤先を変えたときは該当キャッシュを捨てる */
    resetAnchors(anchors) { this.anchors = anchors; for (const k of [...this.cache.keys()]) if (/^[^:]+:\d+(\.\d+)?:\d+$/.test(k)) this.cache.delete(k); }

    /* state = { w:{id:重み}, r:{id:半径}, rep:bool, work:通勤先index } */
    compute(state) {
      this.routeWeighting = state.routeWeight !== false;
      const { NC } = this, U = this.U; U.fill(0);
      for (const c of this.cats) {
        const w = state.w[c.id]; if (!w) continue;
        const f = this.field(c, state.r[c.id], state.work), s = c.sign * w;
        for (let q = 0; q < NC; q++) U[q] += s * f[q];
        if (state.rep && c.repel && c.xy) { const g = this.repField(c), a = 0.4 * w; for (let q = 0; q < NC; q++) U[q] += a * g[q]; }
      }
      const neg = [], pos = [];
      for (let q = 0; q < NC; q += 3) { const v = U[q]; (v < 0 ? neg : pos).push(Math.abs(v)); }
      const pct = (a, p) => { if (!a.length) return 1; a.sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]; };
      this.sNeg = Math.max(0.5, pct(neg, 0.98)); this.sPos = Math.max(0.5, pct(pos, 0.99));
      return U;
    }
    contributions(state, x, y) {
      this.routeWeighting = state.routeWeight !== false;
      const q = this.cellIndex(x, y);
      return this.cats.map(c => {
        const w = state.w[c.id]; let v = w ? c.sign * w * this.field(c, state.r[c.id], state.work)[q] : 0;
        if (w && state.rep && c.repel && c.xy) v += 0.4 * w * this.repField(c)[q];
        return { c, v };
      });
    }
    cellIndex(x, y) { const i = Math.max(0, Math.min(this.NX - 1, Math.round(x / this.CELL))), j = Math.max(0, Math.min(this.NY - 1, Math.round(y / this.CELL))); return j * this.NX + i; }
    valueAt(x, y) { return this.U[this.cellIndex(x, y)]; }

    /* RGBA 画像（中立は透明、谷は good 色、山は bad 色） */
    paint(canvas, good, bad, maxAlpha = 0.85) {
      const { NX, NY, NC, U, sNeg, sPos } = this; canvas.width = NX; canvas.height = NY;
      const ctx = canvas.getContext('2d'), img = ctx.createImageData(NX, NY), d = img.data;
      for (let q = 0; q < NC; q++) {
        const v = U[q], t = Math.min(1, Math.abs(v) / (v < 0 ? sNeg : sPos)), c = v < 0 ? good : bad;
        d[4 * q] = c[0]; d[4 * q + 1] = c[1]; d[4 * q + 2] = c[2]; d[4 * q + 3] = Math.round(255 * maxAlpha * Math.pow(t, 0.8));
      }
      ctx.putImageData(img, 0, 0);
    }

    /* 等ポテンシャル線（緯度経度の線分の配列、レベルごと） */
    isolines(n = 5) {
      const { NX, NY, CELL, U } = this, out = [];
      const levels = []; for (let k = 1; k <= n; k++) { levels.push(-k * this.sNeg / n); levels.push(k * this.sPos / n); }
      for (const L of levels) {
        const segs = [];
        for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
          const a = U[j * NX + i], b = U[j * NX + i + 1], c = U[(j + 1) * NX + i + 1], d = U[(j + 1) * NX + i];
          const A = a > L, B = b > L, C = c > L, Dd = d > L; if (A === B && B === C && C === Dd) continue;
          const x = i * CELL, y = j * CELL, e = [], it = (v0, v1) => (L - v0) / (v1 - v0);
          if (A !== B) e.push([x + it(a, b) * CELL, y]);
          if (B !== C) e.push([x + CELL, y + it(b, c) * CELL]);
          if (Dd !== C) e.push([x + it(d, c) * CELL, y + CELL]);
          if (A !== Dd) e.push([x, y + it(a, d) * CELL]);
          for (let k = 0; k + 1 < e.length; k += 2) segs.push([this.toLL(...e[k]), this.toLL(...e[k + 1])]);
        }
        out.push({ level: L, segs });
      }
      return out;
    }

    /* 局所最小（谷）を深い順に */
    candidates({ windowM = 400, separationM = 700, count = 6, marginM = 150 } = {}) {
      const { NX, NY, CELL, U } = this, R = Math.max(1, Math.round(windowM / CELL)), m = Math.max(2, Math.round(marginM / CELL)), out = [];
      for (let j = m; j < NY - m; j++) for (let i = m; i < NX - m; i++) {
        const q = j * NX + i, v = U[q]; if (v >= 0) continue;
        if (v > U[q - 1] || v > U[q + 1] || v > U[q - NX] || v > U[q + NX]) continue;
        let ok = true;
        for (let jj = Math.max(0, j - R); jj <= Math.min(NY - 1, j + R) && ok; jj++) for (let ii = Math.max(0, i - R); ii <= Math.min(NX - 1, i + R); ii++) if (U[jj * NX + ii] < v) { ok = false; break; }
        if (ok) out.push({ x: i * CELL, y: j * CELL, v });
      }
      out.sort((a, b) => a.v - b.v);
      const pick = [];
      for (const c of out) { if (pick.every(p => Math.hypot(p.x - c.x, p.y - c.y) > separationM)) pick.push(c); if (pick.length >= count) break; }
      return pick.map(c => ({ ...c, ll: this.toLL(c.x, c.y) }));
    }
    nearestStation(x, y) { let b = null, bd = Infinity; for (const s of this.stations) { const d = Math.hypot(s.xy[0] - x, s.xy[1] - y); if (d < bd) { bd = d; b = s; } } return [b, bd]; }
    nearestIn(id, x, y) { const c = this.cats.find(k => k.id === id); if (!c || !c.xy) return Infinity; let bd = Infinity; for (let k = 0; k < c.xy.length; k += 2) { const d = Math.hypot(c.xy[k] - x, c.xy[k + 1] - y); if (d < bd) bd = d; } return bd; }
  }
  window.PM_Engine = Engine;
})();
