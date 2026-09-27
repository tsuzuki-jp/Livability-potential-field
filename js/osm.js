/* OpenStreetMap（Overpass API）からの取得と、カテゴリへの振り分け */
(function () {
  'use strict';
  const R_LAT = 111320;
  const mPerLon = lat => R_LAT * Math.cos(lat * Math.PI / 180);
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * R_LAT, (a[1] - b[1]) * mPerLon((a[0] + b[0]) / 2));

  const qlEsc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  function filterQL(f) {
    let s = f.type || 'nwr';
    for (const [k, v] of Object.entries(f.tags || {})) s += `["${qlEsc(k)}"~"${qlEsc(v)}"]`;
    for (const [k, v] of Object.entries(f.not || {})) s += `["${qlEsc(k)}"!~"${qlEsc(v)}"]`;
    return s;
  }
  function matcher(f) {
    const tags = Object.entries(f.tags || {}).map(([k, v]) => [k, new RegExp(v)]);
    const not = Object.entries(f.not || {}).map(([k, v]) => [k, new RegExp(v)]);
    return t => tags.every(([k, re]) => t[k] != null && re.test(t[k])) && !not.some(([k, re]) => t[k] != null && re.test(t[k]));
  }

  function buildQuery(categories, bbox) {
    const [s, w, n, e] = bbox.map(v => +v.toFixed(6));
    const pts = [], lines = [];
    for (const c of categories) for (const f of c.osm || []) (c.kind === 'line' ? lines : pts).push(filterQL(f) + ';');
    let q = `[out:json][timeout:180][bbox:${s},${w},${n},${e}];\n`;
    if (pts.length) q += `(\n  ${pts.join('\n  ')}\n);\nout tags center qt;\n`;
    if (lines.length) q += `(\n  ${lines.join('\n  ')}\n);\nout tags geom qt;\n`;
    return q;
  }

  async function fetchOverpass(query, endpoints, { signal, onStatus } = {}) {
    let lastErr;
    for (let round = 0; round < 2; round++) {
      for (const url of endpoints) {
        if (signal && signal.aborted) throw new DOMException('中止しました', 'AbortError');
        const host = new URL(url).host;
        onStatus && onStatus(`${host} に問い合わせ中…`);
        try {
          const t = new AbortController();
          const timer = setTimeout(() => t.abort(), 200000);
          if (signal) signal.addEventListener('abort', () => t.abort(), { once: true });
          const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: t.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`${host}: HTTP ${res.status}${res.status === 429 ? '（混雑）' : res.status === 504 ? '（タイムアウト）' : ''}`);
          onStatus && onStatus(`${host} から受信中…`);
          const data = await res.json();
          if (data.remark && /error/i.test(data.remark)) throw new Error(`${host}: ${data.remark}`);
          return data;
        } catch (e) {
          if (signal && signal.aborted) throw new DOMException('中止しました', 'AbortError');
          lastErr = e;
          onStatus && onStatus(`${host} に失敗しました（${e.message}）。別のサーバーを試します…`);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
    throw new Error('Overpass API に接続できませんでした。時間をおいて再試行するか、範囲を狭めてください。' + (lastErr ? `（${lastErr.message}）` : ''));
  }

  function extendLine(l, ext) {
    if (!ext || l.length < 2) return l;
    const f = (p, q) => { const L = distM(p, q) || 1, k = ext / L; return [p[0] + (p[0] - q[0]) * k, p[1] + (p[1] - q[1]) * k]; };
    return [f(l[0], l[1]), ...l, f(l[l.length - 1], l[l.length - 2])];
  }

  function dedupe(points, minM, sameNameM) {
    const out = [], grid = new Map(), cell = Math.max(minM, sameNameM || 0);
    for (const p of points) {
      const gx = Math.floor(p[1] * mPerLon(p[0]) / cell), gy = Math.floor(p[0] * R_LAT / cell);
      let dup = false;
      for (let dx = -1; dx <= 1 && !dup; dx++) for (let dy = -1; dy <= 1 && !dup; dy++) {
        for (const q of grid.get(gx + dx + ',' + (gy + dy)) || []) {
          const d = distM(p, q);
          if (d < minM || (sameNameM && p[2] && p[2] === q[2] && d < sameNameM)) { dup = true; break; }
        }
      }
      if (!dup) { out.push(p); const k = gx + ',' + gy; (grid.get(k) || grid.set(k, []).get(k)).push(p); }
    }
    return out;
  }

  /* Overpass の応答 → potmap 互換のデータ構造 */
  function toDataset(osm, categories, { bbox, name, anchors }) {
    const pc = categories.filter(c => c.kind === 'point').map(c => ({ c, m: (c.osm || []).map(matcher), pts: [] }));
    const lc = categories.filter(c => c.kind === 'line').map(c => ({ c, m: (c.osm || []).map(matcher), lines: [] }));
    for (const el of osm.elements || []) {
      const t = el.tags || {};
      let pt = null, line = null;
      if (el.type === 'node' && el.lat != null) pt = [el.lat, el.lon];
      else if (el.center) pt = [el.center.lat, el.center.lon];
      else if (el.type === 'way' && el.geometry) line = el.geometry.filter(Boolean).map(g => [g.lat, g.lon]);
      if (pt) for (const x of pc) if (x.m.some(f => f(t))) x.pts.push([+pt[0].toFixed(6), +pt[1].toFixed(6), (t.name || '').slice(0, 40)]);
      if (line && line.length >= 2) for (const x of lc) if (x.m.some(f => f(t))) x.lines.push(line);
    }
    const counts = {};
    const cats = categories.map(c => {
      const o = { id: c.id, label: c.label, sign: c.sign, weight: c.weight, radius: c.radius, radius_max: c.radius_max,
        kind: c.kind, repel: !!c.repel, labels: !!c.labels };
      const p = pc.find(x => x.c === c), l = lc.find(x => x.c === c);
      if (p) { o.points = dedupe(p.pts, 15, c.labels ? 300 : null); counts[c.id] = o.points.length; }
      if (l) { o.lines = l.lines.map(x => extendLine(x, c.extend_m || 0).map(q => [+q[0].toFixed(6), +q[1].toFixed(6)])); counts[c.id] = o.lines.length; }
      return o;
    });
    return {
      version: 1, generated: new Date().toISOString().slice(0, 10), source: 'potential-map-web',
      region: { name: name || '', bbox }, categories: cats, anchors: anchors || [], counts,
      attribution: ['地図データ: © OpenStreetMap contributors (ODbL)']
    };
  }

  window.PM_OSM = { buildQuery, fetchOverpass, toDataset, distM, mPerLon };
})();
