/* 住環境ポテンシャル地図 — 画面と地図の制御 */
(function () {
  'use strict';
  const C = window.PM_CONFIG, OSM = window.PM_OSM, Engine = window.PM_Engine;
  const $ = id => document.getElementById(id);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const hex = h => { h = h.replace('#', ''); return [0, 2, 4].map(k => parseInt(h.slice(k, k + 2), 16)); };
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmtM = d => !isFinite(d) ? '—' : d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d / 10) * 10 + ' m';
  const fmtR = r => r >= 1000 ? (r / 1000).toFixed(r % 1000 ? 2 : 0).replace(/(\.\d)0$/, '$1') + ' km' : r + ' m';
  const STORE_KEY = 'potential-map-web:v1';

  // ------------------------------------------------------------ 状態
  const S = {
    region: { name: C.initial.name, bbox: C.initial.bbox.slice() },
    anchors: C.initial.anchors.map(a => ({ ...a })),
    w: {}, r: {}, rep: true, pts: true, iso: true, alpha: 0.85, work: 0,
    dataset: null, stale: false, pin: null, addMode: false
  };
  let E = null;   // Engine
  const uiCats = () => (S.dataset ? S.dataset.categories : C.categories);
  const defaultsFor = id => (C.categories.find(c => c.id === id) || (S.dataset && S.dataset.categories.find(c => c.id === id)) || {});
  function ensureWeights() { for (const c of uiCats()) { if (S.w[c.id] == null) S.w[c.id] = c.weight; if (S.r[c.id] == null) S.r[c.id] = c.radius; } }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sizeKm: S.sizeKm, region: S.region, anchors: S.anchors, w: S.w, r: S.r, rep: S.rep, pts: S.pts, iso: S.iso, alpha: S.alpha, work: S.work }));
    } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  function loadState() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (o && o.region && Array.isArray(o.region.bbox)) Object.assign(S, { region: o.region, anchors: o.anchors || [], w: o.w || {}, r: o.r || {},
        sizeKm: o.sizeKm || 8, rep: o.rep !== false, pts: o.pts !== false, iso: o.iso !== false, alpha: o.alpha || 0.85, work: o.work || 0 });
    } catch (e) { /* 無視 */ }
    const m = location.hash.match(/^#s=(.+)$/);
    if (m) {
      try {
        const o = JSON.parse(decodeURIComponent(m[1]));
        if (Array.isArray(o.b) && o.b.length === 4) S.region = { name: o.n || '', bbox: o.b.map(Number) };
        if (Array.isArray(o.a)) S.anchors = o.a.map(a => ({ lat: +a[0], lon: +a[1], name: String(a[2] || '通勤先') }));
        if (o.w) Object.assign(S.w, o.w);
        if (o.r) Object.assign(S.r, o.r);
        S.work = 0;
        return true;
      } catch (e) { /* 壊れたリンクは無視 */ }
    }
    return false;
  }

  // ------------------------------------------------------------ 地図
  const map = L.map('map', { preferCanvas: true, zoomSnap: 0.5 });
  const bases = {};
  for (const [name, t] of Object.entries(C.tiles)) bases[name] = L.tileLayer(t.url, { maxZoom: t.maxZoom, attribution: t.attribution });
  bases[Object.keys(bases)[0]].addTo(map);
  L.control.layers(bases, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('施設: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');

  const Legend = L.Control.extend({ onAdd() { const d = L.DomUtil.create('div', 'map-legend'); d.innerHTML = '<div class="bar"></div><div class="ends"><span>住みやすい（U&lt;0）</span><span>避けたい（U&gt;0）</span></div>'; return d; } });
  new Legend({ position: 'bottomright' }).addTo(map);
  const Readout = L.Control.extend({ onAdd() { const d = L.DomUtil.create('div', 'map-readout'); d.id = 'readout'; d.hidden = true; return d; } });
  new Readout({ position: 'bottomleft' }).addTo(map);

  const canvasR = L.canvas({ padding: 0.5 });
  const layers = { iso: L.layerGroup().addTo(map), pts: L.layerGroup().addTo(map), cand: L.layerGroup().addTo(map), anchor: L.layerGroup().addTo(map) };
  let heat = null, regionRect = null, pin = null;
  const bboxBounds = b => L.latLngBounds([b[0], b[1]], [b[2], b[3]]);
  const areaKm2 = b => (b[2] - b[0]) * 111.32 * (b[3] - b[1]) * 111.32 * Math.cos((b[0] + b[2]) / 2 * Math.PI / 180);

  // ------------------------------------------------------------ 範囲
  function drawRegion() {
    const b = S.region.bbox;
    if (regionRect) regionRect.setBounds(bboxBounds(b));
    else regionRect = L.rectangle(bboxBounds(b), { color: css('--ink'), weight: 1.5, dashArray: '6 4', fill: false, interactive: false }).addTo(map);
    $('rname').value = S.region.name || '';
    $('rbbox').textContent = b.map(v => v.toFixed(3)).join(', ');
    const a = areaKm2(b);
    $('rarea').innerHTML = `${a.toFixed(0)} km²` + (a > C.area.maxKm2 ? ' <span class="warn">広すぎます</span>' : a > C.area.warnKm2 ? ' <span class="warn">広め（取得に時間がかかります）</span>' : '');
  }
  function setRegion(bbox, name) {
    const changed = S.region.bbox.some((v, k) => Math.abs(v - bbox[k]) > 1e-6);
    S.region = { name: name != null ? name : S.region.name, bbox };
    drawRegion(); saveState();
    if (changed && S.dataset) { S.stale = true; setStatus('対象範囲が変わりました。「データを取得して計算」で地図を更新してください。'); }
  }
  $('useView').addEventListener('click', () => {
    const b = map.getBounds();
    setRegion([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(v => +v.toFixed(5)));
  });
  $('showRegion').addEventListener('click', () => map.fitBounds(bboxBounds(S.region.bbox)));
  $('rname').addEventListener('input', e => { S.region.name = e.target.value; saveState(); });
  // 場所を選ぶ → その周りの「広さ」四方を対象範囲にして地図を合わせる
  function squareAround(lat, lon, km) {
    const h = km * 500, dLat = h / 111320, dLon = h / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => +v.toFixed(5));
  }
  const sizeKm = () => +$('rsize').value || 8;
  $('rsize').addEventListener('change', () => {
    S.sizeKm = sizeKm();
    const b = S.region.bbox, c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    setRegion(squareAround(c[0], c[1], S.sizeKm)); map.fitBounds(bboxBounds(S.region.bbox));
  });

  // ------------------------------------------------------------ 通勤先
  function anchorIcon() { return L.divIcon({ className: '', html: '<div class="anchor-icon"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }); }
  function renderAnchors() {
    layers.anchor.clearLayers();
    S.anchors.forEach((a, k) => {
      const m = L.marker([a.lat, a.lon], { icon: anchorIcon(), draggable: true, keyboard: false, title: a.name }).addTo(layers.anchor);
      m.bindTooltip(esc(a.name), { direction: 'right', offset: [8, 0], permanent: S.anchors.length <= 4, className: 'anchor-tip' });
      m.on('dragend', () => { const p = m.getLatLng(); a.lat = +p.lat.toFixed(6); a.lon = +p.lng.toFixed(6); anchorsChanged(); });
    });
    $('anchors').innerHTML = S.anchors.map((a, k) => `<li><span class="dia" aria-hidden="true"></span>
      <input type="text" value="${esc(a.name)}" data-k="${k}" aria-label="通勤先${k + 1}の名前">
      <button class="btn small" type="button" data-del="${k}" aria-label="${esc(a.name)}を削除">削除</button></li>`).join('')
      || '<li class="dim" style="display:block">通勤先はまだありません。</li>';
    const sel = $('optWork');
    sel.innerHTML = S.anchors.map((a, k) => `<option value="${k}">${esc(a.name)}</option>`).join('');
    if (S.work >= S.anchors.length) S.work = 0;
    sel.value = String(S.work);
    $('workRow').hidden = S.anchors.length === 0;
  }
  function anchorsChanged() {
    renderAnchors(); saveState();
    if (E) { E.resetAnchors(S.anchors.map(a => ({ ...a }))); schedule(); }
  }
  $('anchors').addEventListener('input', e => { const k = e.target.dataset.k; if (k == null) return; S.anchors[+k].name = e.target.value; saveState();
    const sel = $('optWork'); if (sel.options[+k]) sel.options[+k].textContent = e.target.value; });
  $('anchors').addEventListener('change', e => { if (e.target.dataset.k != null) renderAnchors(); });
  $('anchors').addEventListener('click', e => { const k = e.target.dataset.del; if (k == null) return; S.anchors.splice(+k, 1); anchorsChanged(); });
  function setAddMode(on) { S.addMode = on; $('addAnchor').setAttribute('aria-pressed', String(on)); $('addAnchor').textContent = on ? '追加する地点をクリック…（取消）' : '地図をクリックして追加';
    map.getContainer().classList.toggle('adding', on); }
  $('addAnchor').addEventListener('click', () => setAddMode(!S.addMode));
  $('optWork').addEventListener('change', e => { S.work = +e.target.value; saveState(); schedule(); });

  // ------------------------------------------------------------ 取得
  let controller = null;
  function setStatus(html, isErr) { const s = $('status'); s.innerHTML = html; s.classList.toggle('err', !!isErr); }
  function padBbox(b, m) { const dLat = m / 111320, dLon = m / (111320 * Math.cos((b[0] + b[2]) / 2 * Math.PI / 180)); return [b[0] - dLat, b[1] - dLon, b[2] + dLat, b[3] + dLon]; }
  $('fetchBtn').addEventListener('click', doFetch);
  $('cancelBtn').addEventListener('click', () => controller && controller.abort());
  async function doFetch() {
    const b = S.region.bbox, a = areaKm2(b);
    if (a > C.area.maxKm2) { setStatus(`範囲が ${a.toFixed(0)} km² あり、上限（${C.area.maxKm2} km²）を超えています。地図を拡大してから「表示中の範囲を対象にする」を押してください。`, true); return; }
    const q = OSM.buildQuery(C.categories.filter(c => c.kind !== 'anchor'), padBbox(b, C.fetchPadM));
    controller = new AbortController();
    $('fetchBtn').disabled = true; $('cancelBtn').hidden = false;
    const t0 = performance.now();
    try {
      const osm = await OSM.fetchOverpass(q, C.overpass, { signal: controller.signal, onStatus: m => setStatus(esc(m)) });
      setStatus('取得したデータを分類しています…');
      const ds = OSM.toDataset(osm, C.categories, { bbox: b.slice(), name: S.region.name, anchors: S.anchors });
      useDataset(ds, false);
      const n = Object.values(ds.counts).reduce((x, y) => x + y, 0);
      setStatus(`取得しました（${n.toLocaleString()} 件、${((performance.now() - t0) / 1000).toFixed(1)} 秒）。「結果」タブに候補地が出ています。`);
    } catch (e) {
      setStatus(e.name === 'AbortError' ? '取得を中止しました。' : esc(e.message), e.name !== 'AbortError');
    } finally {
      $('fetchBtn').disabled = false; $('cancelBtn').hidden = true; controller = null;
    }
  }

  function useDataset(ds, fromFile) {
    if (!ds || !ds.region || !Array.isArray(ds.region.bbox) || !Array.isArray(ds.categories)) throw new Error('データの形式が正しくありません。');
    S.dataset = ds; S.stale = false;
    if (fromFile) {
      if (Array.isArray(ds.anchors) && ds.anchors.length) S.anchors = ds.anchors.map(a => ({ name: a.name, lat: +a.lat, lon: +a.lon }));
      if (ds.ui) { Object.assign(S.w, ds.ui.w || {}); Object.assign(S.r, ds.ui.r || {}); }
    }
    S.region = { name: ds.region.name || S.region.name, bbox: ds.region.bbox.slice() };
    drawRegion(); renderAnchors(); ensureWeights(); buildSliders();
    E = new Engine(ds, { targetCells: C.grid.targetCells });
    E.resetAnchors(S.anchors.map(a => ({ ...a })));
    drawPoints(); renderNotes(); saveState();
    $('saveJson').disabled = false;
    schedule(() => selectTab('result'));
  }

  // ------------------------------------------------------------ 計算と描画
  let pending = false, afterRun = [];
  function schedule(after) {
    syncSliders(); if (after) afterRun.push(after);
    if (!E || pending) return; pending = true;
    const veil = document.createElement('div'); veil.className = 'busy-veil'; veil.innerHTML = '<span>計算中…</span>';
    map.getContainer().appendChild(veil);
    setTimeout(() => requestAnimationFrame(() => {
      try { recompute(); } finally { veil.remove(); pending = false; const f = afterRun; afterRun = []; f.forEach(fn => fn()); }
    }), 0);
  }
  function engineState() { return { w: S.w, r: S.r, rep: S.rep, work: S.work }; }
  function recompute() {
    E.compute(engineState());
    paintHeat(); drawIso(); updateCandidates();
    if (S.pin) inspect(S.pin, false);
  }
  const off = document.createElement('canvas');
  function paintHeat() {
    if (!E) return;
    E.paint(off, hex(css('--good')), hex(css('--bad')), 1);
    const url = off.toDataURL('image/png'), bounds = E.imageBounds();
    if (heat) { heat.setUrl(url); heat.setBounds(L.latLngBounds(bounds)); }
    else heat = L.imageOverlay(url, bounds, { opacity: S.alpha, interactive: false, className: 'heat' }).addTo(map);
    heat.setOpacity(S.alpha);
    heat.bringToBack();
  }
  function drawIso() {
    layers.iso.clearLayers();
    if (!E || !S.iso) return;
    const ink = css('--ink');
    for (const { level, segs } of E.isolines(5)) {
      if (!segs.length) continue;
      L.polyline(segs, { renderer: canvasR, color: ink, weight: 0.8, opacity: level < 0 ? 0.4 : 0.3, dashArray: level < 0 ? null : '3 3', interactive: false, smoothFactor: 1 }).addTo(layers.iso);
    }
  }
  function drawPoints() {
    layers.pts.clearLayers();
    if (!S.dataset || !S.pts) return;
    const good = css('--good'), bad = css('--bad'), muted = css('--muted'), ink = css('--ink'), panel = css('--panel');
    for (const c of S.dataset.categories) {
      if (!c.points) continue;
      for (const p of c.points) {
        const st = c.labels;
        const m = L.circleMarker([p[0], p[1]], st
          ? { renderer: canvasR, radius: 4, color: ink, weight: 1.5, fillColor: panel, fillOpacity: 1 }
          : { renderer: canvasR, radius: c.id === 'super' ? 3.6 : 2.6, stroke: false, fillOpacity: 0.9,
              fillColor: c.sign > 0 ? bad : (c.id === 'conv' || c.id === 'fastfood') ? muted : good });
        m.bindTooltip(esc((p[2] ? p[2] + '（' : '') + c.label + (p[2] ? '）' : '')), { direction: 'top', offset: [0, -4] });
        m.addTo(layers.pts);
      }
    }
  }

  // ------------------------------------------------------------ 候補地
  function candIcon(k) { return L.divIcon({ className: '', html: `<div class="cand-icon">${k + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }); }
  let cands = [];
  function updateCandidates() {
    cands = E.candidates({ windowM: 400, separationM: 700, count: 6 });
    layers.cand.clearLayers();
    const a = S.anchors[S.work], axy = a ? E.toXY(a.lat, a.lon) : null;
    cands.forEach((c, k) => {
      L.marker(c.ll, { icon: candIcon(k), keyboard: false, title: `候補 ${k + 1}` }).on('click', () => inspect(L.latLng(c.ll), true)).addTo(layers.cand);
    });
    $('cands').innerHTML = cands.map((c, k) => {
      const [s, sd] = E.nearestStation(c.x, c.y), md = E.nearestIn('super', c.x, c.y);
      return `<tr><td><button class="rank" type="button" data-k="${k}" aria-label="候補${k + 1}へ移動">${k + 1}</button></td>
        <td>${s ? esc(s.n) : '—'}<br><span class="dim">${s ? fmtM(sd) : ''}</span></td>
        <td class="num">${c.v.toFixed(2)}</td><td class="num">${fmtM(md)}</td>
        <td class="num">${axy ? (Math.hypot(c.x - axy[0], c.y - axy[1]) / 1000).toFixed(1) + ' km' : '—'}</td>
        <td><a href="https://www.google.com/maps/search/?api=1&query=${c.ll[0].toFixed(5)},${c.ll[1].toFixed(5)}" target="_blank" rel="noopener">地図</a></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="dim">負のポテンシャルの谷が見つかりません。便利側の重みを上げてください。</td></tr>';
    const bd = $('candBadge'); bd.hidden = !cands.length; bd.textContent = cands.length;
  }
  $('cands').addEventListener('click', e => {
    const b = e.target.closest('.rank'); if (!b) return; const c = cands[+b.dataset.k];
    map.flyTo(c.ll, Math.max(map.getZoom(), 15), { duration: 0.6 }); inspect(L.latLng(c.ll), true);
  });

  // ------------------------------------------------------------ 地点の内訳
  function inspect(ll, withPopup) {
    if (!E) return;
    const [x, y] = E.toXY(ll.lat, ll.lng);
    if (x < 0 || y < 0 || x > E.WM || y > E.HM) { setInspectOutside(); return; }
    S.pin = ll;
    const parts = E.contributions(engineState(), x, y), U = E.valueAt(x, y);
    const mx = Math.max(1, ...parts.map(p => Math.abs(p.v)));
    const [s, sd] = E.nearestStation(x, y);
    $('inspEmpty').hidden = true; const b = $('inspBody'); b.hidden = false;
    b.innerHTML = `<div class="total"><span class="dim">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}${s ? '　' + esc(s.n) + 'まで ' + fmtM(sd) : ''}</span>
      <b style="color:${U < 0 ? 'var(--good)' : 'var(--bad)'}">${U.toFixed(2)}</b></div>
      <div class="bars">${parts.map(p => { const w = Math.abs(p.v) / mx * 50; return `<div class="bar-row"><span>${esc(p.c.label)}</span><div class="bar-track"><div class="bar-fill" style="${p.v < 0 ? 'right:50%' : 'left:50%'};width:${w}%;background:${p.v < 0 ? 'var(--good)' : 'var(--bad)'}"></div></div><span class="v">${p.v >= 0 ? '+' : ''}${p.v.toFixed(2)}</span></div>`; }).join('')}</div>
      <p style="margin:10px 0 0;font-size:12px"><a href="https://www.google.com/maps/search/?api=1&query=${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}" target="_blank" rel="noopener">この地点を Google マップで開く</a></p>`;
    if (pin) pin.setLatLng(ll); else pin = L.circleMarker(ll, { radius: 7, color: css('--ink'), weight: 2, fill: false, interactive: false }).addTo(map);
    if (withPopup) {
      const top = parts.filter(p => Math.abs(p.v) >= 0.05).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 3);
      L.popup({ maxWidth: 260 }).setLatLng(ll).setContent(
        `<div><b style="font-family:var(--mono)">U = ${U.toFixed(2)}</b></div>` +
        top.map(p => `<div>${esc(p.c.label)} <span style="font-family:var(--mono);color:${p.v < 0 ? 'var(--good)' : 'var(--bad)'}">${p.v >= 0 ? '+' : ''}${p.v.toFixed(2)}</span></div>`).join('') +
        `<div style="margin-top:4px"><a href="#" class="to-result">内訳をすべて見る</a></div>`).openOn(map);
    }
  }
  function setInspectOutside() { $('inspEmpty').hidden = false; $('inspEmpty').textContent = 'その地点は計算範囲の外です。'; $('inspBody').hidden = true; }
  map.on('popupopen', e => { const a = e.popup.getElement().querySelector('.to-result'); if (a) a.addEventListener('click', ev => { ev.preventDefault(); selectTab('result'); $('inspBody').scrollIntoView({ block: 'nearest' }); }); });

  map.on('click', e => {
    if (S.addMode) {
      S.anchors.push({ name: `通勤先${S.anchors.length + 1}`, lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) });
      S.work = S.anchors.length - 1; setAddMode(false); anchorsChanged(); return;
    }
    inspect(e.latlng, true);
  });
  map.on('mousemove', e => {
    const r = $('readout'); r.hidden = false; let t = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
    if (E) { const [x, y] = E.toXY(e.latlng.lat, e.latlng.lng); if (x >= 0 && y >= 0 && x <= E.WM && y <= E.HM) t += `   U = ${E.valueAt(x, y).toFixed(2)}`; }
    r.textContent = t;
  });

  // ------------------------------------------------------------ 重み
  function buildSliders() {
    ensureWeights();
    const cnt = (S.dataset && S.dataset.counts) || {};
    let html = '', last = 0;
    [...uiCats()].sort((a, b) => b.sign - a.sign).forEach(c => {
      if (c.sign !== last) { html += `<div class="group"><span class="sw" style="background:var(${c.sign > 0 ? '--bad' : '--good'})"></span>${c.sign > 0 ? '＋ 避けたい（山）' : '− 便利（谷）'}</div>`; last = c.sign; }
      const n = cnt[c.id] != null ? `<span class="cnt">${cnt[c.id]}${c.kind === 'line' ? '本' : '件'}</span>` : '';
      const rmax = c.radius_max || Math.max(3 * c.radius, 500), step = rmax >= 4000 ? 250 : rmax >= 1500 ? 50 : 25, rmin = c.kind === 'anchor' ? 500 : 25;
      html += `<div class="wrow"><label for="w-${c.id}">${esc(c.label)}${n}</label><span class="val" id="wv-${c.id}"></span>
        <input type="range" id="w-${c.id}" min="0" max="10" step="0.5" value="${S.w[c.id]}">
        <div class="rr"><span>r</span><input type="range" id="r-${c.id}" min="${rmin}" max="${rmax}" step="${step}" value="${S.r[c.id]}" aria-label="${esc(c.label)}の影響半径"><span id="rv-${c.id}"></span></div></div>`;
    });
    $('sliders').innerHTML = html;
    syncSliders();
  }
  $('sliders').addEventListener('input', e => {
    const m = e.target.id.match(/^([wr])-(.+)$/); if (!m) return;
    S[m[1]][m[2]] = +e.target.value; clearPreset(); saveStateSoon(); schedule();
  });
  function syncSliders() {
    for (const c of uiCats()) {
      const w = $('w-' + c.id), r = $('r-' + c.id); if (!w) continue;
      w.value = S.w[c.id]; r.value = S.r[c.id];
      $('wv-' + c.id).textContent = (c.sign > 0 ? '+' : '−') + (+S.w[c.id]).toFixed(1);
      $('rv-' + c.id).textContent = fmtR(S.r[c.id]);
    }
  }
  let saveTimer = null; function saveStateSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400); }
  function buildPresets() {
    $('presets').innerHTML = Object.keys(C.presets).map((k, i) => `<button class="pill" type="button" data-p="${esc(k)}" aria-pressed="false">${esc(k)}</button>`).join('');
  }
  $('presets').addEventListener('click', e => {
    const k = e.target.dataset && e.target.dataset.p; if (!k) return; const p = C.presets[k];
    for (const c of uiCats()) {
      const d = defaultsFor(c.id); let w = (d.weight != null ? d.weight : c.weight) * (c.kind === 'anchor' ? 1 : c.sign > 0 ? (p.nuisance || 1) : (p.amenity || 1));
      if (c.kind === 'anchor' && p.anchor != null) w = p.anchor;
      S.w[c.id] = Math.max(0, Math.min(10, Math.round(w * 2) / 2)); S.r[c.id] = d.radius != null ? d.radius : c.radius;
    }
    $('presets').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === k)));
    saveState(); schedule();
  });
  function clearPreset() { $('presets').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false')); }
  $('optRep').addEventListener('change', e => { S.rep = e.target.checked; saveState(); schedule(); });
  $('optPts').addEventListener('change', e => { S.pts = e.target.checked; saveState(); drawPoints(); });
  $('optIso').addEventListener('change', e => { S.iso = e.target.checked; saveState(); drawIso(); });
  $('optAlpha').addEventListener('input', e => { S.alpha = +e.target.value; if (heat) heat.setOpacity(S.alpha); saveStateSoon(); });

  // ------------------------------------------------------------ データ保存・読み込み・共有
  $('saveJson').addEventListener('click', () => {
    if (!S.dataset) return;
    const out = { ...S.dataset, anchors: S.anchors, region: { ...S.dataset.region, name: S.region.name }, ui: { w: S.w, r: S.r } };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `potential-${(S.region.name || 'map').replace(/[\\/:*?"<>|\s]+/g, '_')}-${S.dataset.generated || 'data'}.json`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $('loadBtn').addEventListener('click', () => $('loadJson').click());
  $('loadJson').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { useDataset(JSON.parse(rd.result), true); map.fitBounds(bboxBounds(S.region.bbox)); setStatus(`「${esc(f.name)}」を読み込みました。`); }
      catch (err) { setStatus('読み込めませんでした: ' + esc(err.message), true); }
      e.target.value = '';
    };
    rd.readAsText(f);
  });
  $('shareBtn').addEventListener('click', async () => {
    const o = { n: S.region.name, b: S.region.bbox.map(v => +v.toFixed(5)), a: S.anchors.map(a => [a.lat, a.lon, a.name]), w: S.w, r: S.r };
    const url = location.href.split('#')[0] + '#s=' + encodeURIComponent(JSON.stringify(o));
    try { await navigator.clipboard.writeText(url); setStatus('共有リンクをコピーしました。開いた人が「データを取得して計算」を押すと同じ条件で表示されます。'); }
    catch (e) { setStatus(`共有リンク（選択してコピーしてください）:<br><input type="text" readonly value="${esc(url)}" style="width:100%" onfocus="this.select()">`); }
  });

  // ------------------------------------------------------------ 説明
  function renderNotes() {
    const d = S.dataset; if (!d) return;
    const cnt = d.counts || {};
    const list = d.categories.filter(c => c.kind !== 'anchor').map(c => `${esc(c.label)} ${cnt[c.id] ?? 0}${c.kind === 'line' ? '本' : '件'}`).join('、');
    $('notes').innerHTML = [
      `<li>取得日 ${esc(d.generated || '—')}：${list}</li>`,
      E ? `<li>計算格子は ${E.CELL} m 間隔（${E.NX}×${E.NY} セル）です。</li>` : '',
      '<li>OpenStreetMap の登録状況は地域によって差があります。件数が少ないカテゴリは、実際より弱く表示されます。ドラッグストアとパチンコ店は特に少なめです。</li>',
      '<li>騒音は距離だけで近似しています（交通量・遮音・時間帯は考慮していません）。</li>',
      '<li>U は相対値です。重みを変えたときに谷がどう動くかを見るためのものです。</li>',
      ...(d.attribution || []).map(a => `<li>${esc(a)}</li>`)
    ].join('');
  }

  // ------------------------------------------------------------ タブ
  function selectTab(name) {
    for (const t of ['area', 'weight', 'result']) {
      $('tab-' + t).setAttribute('aria-selected', String(t === name));
      $('p-' + t).hidden = t !== name;
    }
  }
  ['area', 'weight', 'result'].forEach(t => $('tab-' + t).addEventListener('click', () => selectTab(t)));
  document.querySelector('.tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ts = ['area', 'weight', 'result'], cur = ts.findIndex(t => $('tab-' + t).getAttribute('aria-selected') === 'true');
    const nx = ts[(cur + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; selectTab(nx); $('tab-' + nx).focus();
  });

  // ------------------------------------------------------------ 検索（js/search.js）
  try {
    window.PM_Search.init({ map, input: $('q'), list: $('qres'), geocoder: C.geocoder, onUseView: () => { $('useView').click(); selectTab('area'); } });
    window.PM_Search.init({ map, input: $('rname'), list: $('rres'), geocoder: C.geocoder, move: false, popup: false,
      onPick: it => {
        const bbox = squareAround(it.lat, it.lon, sizeKm());
        setRegion(bbox, it.name);
        map.flyToBounds(bboxBounds(bbox), { duration: 0.8 });
        setStatus(`「${esc(it.name)}」${it.sub ? '（' + esc(it.sub) + '）' : ''}を中心に ${sizeKm()} km 四方を対象範囲にしました。「データを取得して計算」を押してください。`);
      } });
  } catch (e) { console.error('検索の初期化に失敗しました', e); }   // 検索が壊れても地図と計算は動かす

  // ------------------------------------------------------------ テーマ
  function retheme() { if (regionRect) regionRect.setStyle({ color: css('--ink') }); if (E) { paintHeat(); drawIso(); } drawPoints(); if (pin) pin.setStyle({ color: css('--ink') }); }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ------------------------------------------------------------ 起動
  const fromLink = loadState();
  ensureWeights();
  if (S.sizeKm) $('rsize').value = String(S.sizeKm);
  $('optRep').checked = S.rep; $('optPts').checked = S.pts; $('optIso').checked = S.iso; $('optAlpha').value = S.alpha;
  buildPresets(); buildSliders(); drawRegion(); renderAnchors();
  map.fitBounds(bboxBounds(S.region.bbox));
  if (fromLink) setStatus('共有リンクの条件を読み込みました。「データを取得して計算」を押すと地図を作成します。');
  window.PM_APP = { S, get engine() { return E; }, useDataset, map };   // デバッグ用
})();
