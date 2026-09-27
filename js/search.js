/* 地名・駅名検索（入力中の候補表示つき）
 *
 * - Photon（OpenStreetMap ベース、入力中の検索に対応）と国土地理院の住所検索を並行して引く
 * - 候補ごとに「都道府県・市区町村」と種類（駅・市・地区・住所…）を表示して取り違えを防ぐ
 * - 候補を選ぶと、その場所の範囲（なければ種類に応じた縮尺）へ地図を移動し、印を付ける
 * - Nominatim は利用規約上、入力中の検索に使えないため、Enter で候補が0件のときだけ使う
 */
(function () {
  'use strict';
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const JAPAN_BBOX = '122.9,24.0,154.0,45.6';
  const R = 111320;
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * R, (a[1] - b[1]) * R * Math.cos(a[0] * Math.PI / 180));

  // 国土地理院の市区町村コード表（GSI.MUNI_ARRAY）を必要になった時点で読み込む
  let muniPromise = null;
  function loadMuni(url) {
    if (muniPromise) return muniPromise;
    muniPromise = new Promise(res => {
      window.GSI = window.GSI || {};
      const s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = () => res(window.GSI.MUNI_ARRAY || {});
      s.onerror = () => res({});
      document.head.appendChild(s);
    });
    return muniPromise;
  }
  function muniName(muni, code) {
    if (!code) return '';
    const v = muni[String(parseInt(code, 10))];
    if (!v) return '';
    const p = v.split(','); return (p[1] || '') + ' ' + (p[3] || '');
  }

  function kindOf(p) {
    const k = p.osm_key, v = p.osm_value || '';
    if (k === 'railway' && v === 'tram_stop') return '停留場';
    if ((k === 'railway' && /^(station|halt)$/.test(v)) || (k === 'public_transport' && v === 'station')) return '駅';
    if (k === 'place') return ({ city: '市', town: '町', village: '村', suburb: '地区', quarter: '地区', neighbourhood: '地区', hamlet: '集落', locality: '地名', island: '島', state: '都道府県', province: '都道府県' })[v] || '地名';
    if (k === 'boundary') return '行政区域';
    if (k === 'highway') return v === 'bus_stop' ? 'バス停' : '道路';
    if (k === 'aeroway') return '空港';
    if (k === 'amenity') return ({ university: '大学', college: '学校', school: '学校', hospital: '病院', townhall: '役所', library: '図書館' })[v] || '施設';
    if (k === 'shop') return '店舗';
    if (k === 'building') return '建物';
    if (k === 'leisure' || k === 'tourism' || k === 'historic') return '施設';
    if (k === 'natural' || k === 'waterway' || k === 'landuse') return '地形';
    return '場所';
  }
  const ZOOM = { '駅': 16, '停留場': 16, '市': 12, '町': 13, '村': 13, '地区': 15, '集落': 15, '地名': 15, '行政区域': 12, '都道府県': 9, '住所': 17, '島': 12, '空港': 14, '道路': 16 };
  const uniq = arr => arr.filter((x, i) => x && arr.indexOf(x) === i);

  function init({ map, input, list, geocoder, onUseView, onPick, move = true, popup = true }) {
    const pre = (list.id || 'q') + '-opt-';
    let diag = { osm: '', gsi: '' }, items = [], itemsFor = '', active = -1, seq = 0, timer = null, ctrl = null, marker = null;

    const setExpanded = on => { list.hidden = !on; input.setAttribute('aria-expanded', String(on)); if (!on) { active = -1; input.removeAttribute('aria-activedescendant'); } };

    async function fetchPhoton(q, signal) {
      const c = map.getCenter();
      // lang=default: 現地の表記（日本なら漢字）で返させる。指定しないとブラウザの言語設定から英語が選ばれ、ローマ字になる
      const base = `${geocoder.photon}?q=${encodeURIComponent(q)}&limit=8&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}&bbox=${JAPAN_BBOX}`;
      let r = await fetch(base + '&lang=default', { signal });
      if (r.status === 400) r = await fetch(base, { signal });   // lang=default を受け付けないサーバーの場合
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return (j.features || []).filter(f => (f.properties.countrycode || 'JP').toUpperCase() === 'JP').map(f => {
        const p = f.properties, kind = kindOf(p);
        const sub = uniq([p.state, p.city || p.county, p.district || p.locality, p.street]).filter(s => s !== p.name).join(' ');
        const ex = p.extent;   // [minLon, maxLat, maxLon, minLat]
        let name = p.name || p.street || '(名称なし)';
        if (kind === '駅' && !/(駅|停留場|停留所)$/.test(name)) name += '駅';   // 「宇都宮」→「宇都宮駅」
        return { name, sub, kind, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
          bounds: ex && ex.length === 4 ? [[ex[3], ex[0]], [ex[1], ex[2]]] : null, src: 'OSM' };
      });
    }
    async function fetchGsi(q, signal) {
      const [r, muni] = await Promise.all([fetch(geocoder.gsi + encodeURIComponent(q), { signal }), loadMuni(geocoder.muni)]);
      if (!r.ok) throw new Error('gsi ' + r.status);
      const j = await r.json();
      return (j || []).slice(0, 8).map(f => {
        const t = f.properties.title || '', m = muniName(muni, f.properties.addressCode);
        const isAddr = /^(北海道|東京都|大阪府|京都府|.{2,3}県)/.test(t);
        return { name: t, sub: isAddr ? '' : m, kind: isAddr ? '住所' : '地名', lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], bounds: null, src: '地理院' };
      });
    }

    async function suggest(q, { pickFirst = false } = {}) {
      const my = ++seq;
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      diag = { osm: '', gsi: '' };
      const looksAddr = /[0-9０-９]|丁目|番地|[都道府県].+[市区町村]/.test(q);
      renderLoading();
      const [ph, gs] = await Promise.all([
        fetchPhoton(q, ctrl.signal).catch(e => { diag.osm = e.name === 'AbortError' ? '' : '接続エラー'; return []; }),
        fetchGsi(q, ctrl.signal).catch(e => { diag.gsi = e.name === 'AbortError' ? '' : '接続エラー'; return []; })
      ]);
      if (ph.length) diag.osm = ph.length + '件'; else if (!diag.osm) diag.osm = '0件';
      if (gs.length) diag.gsi = gs.length + '件'; else if (!diag.gsi) diag.gsi = '0件';
      if (my !== seq) return;
      // 近い位置の重複を除く（Photon を優先）
      const norm = t => t.replace(/(駅|停留場)$/, '');
      const gsiUniq = gs.filter(g => !ph.some(p => distM([p.lat, p.lon], [g.lat, g.lon]) < 150 && norm(p.name) === norm(g.name)));   // 同じ名前・同じ場所だけ除く
      // 日本語で入力したのにローマ字しかない候補は後ろへ回す
      const cjk = /[\u3040-\u30ff\u3400-\u9fff]/;
      const latinOnly = it => cjk.test(q) && !cjk.test(it.name);
      const merged = looksAddr ? [...gsiUniq, ...ph] : [...ph, ...gsiUniq];
      items = [...merged.filter(it => !latinOnly(it)), ...merged.filter(latinOnly)].slice(0, 10);
      if (!items.length && pickFirst) {
        try {
          const r = await fetch(geocoder.nominatim + encodeURIComponent(q)); const j = await r.json();
          items = j.map(h => ({ name: (h.display_name || '').split(',')[0], sub: (h.display_name || '').split(',').slice(1, 4).map(s => s.trim()).reverse().join(' '),
            kind: h.type === 'station' ? '駅' : '場所', lat: +h.lat, lon: +h.lon,
            bounds: h.boundingbox ? [[+h.boundingbox[0], +h.boundingbox[2]], [+h.boundingbox[1], +h.boundingbox[3]]] : null, src: 'OSM' }));
        } catch (e) { /* 無視 */ }
      }
      if (my !== seq) return;
      itemsFor = q; active = -1;
      render();
      if (pickFirst && items.length) pick(0);
    }

    function renderLoading() {
      if (!items.length) { list.innerHTML = '<li class="qmsg" role="presentation">検索中…</li>'; setExpanded(true); }
    }
    function render() {
      if (!items.length) {
        const bad = /エラー/.test(diag.osm + diag.gsi);
        list.innerHTML = `<li class="qmsg" role="presentation">${bad ? '検索サービスに接続できませんでした。時間をおいて試すか、ページを再読み込みしてください。' : '見つかりませんでした。市区町村名を足すと見つかりやすくなります（例：宇都宮市 陽南）。'}
          <br><span style="font-size:11px">OSM: ${esc(diag.osm || '—')} ／ 地理院: ${esc(diag.gsi || '—')}</span></li>`;
        setExpanded(true); return;
      }
      list.innerHTML = items.map((it, k) => `<li role="option" id="${pre}${k}" data-k="${k}" aria-selected="${k === active}">
          <span class="qname">${esc(it.name)}</span><span class="qkind">${esc(it.kind)}</span>
          <span class="qsub">${esc(it.sub || '')}</span></li>`).join('');
      setExpanded(true);
      if (active >= 0) highlight(active);
    }
    function highlight(k) {
      active = k;
      list.querySelectorAll('[role=option]').forEach((li, i) => li.setAttribute('aria-selected', String(i === k)));
      const el = $opt(k); if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
    }
    const $opt = k => document.getElementById(pre + k);

    function pick(k) {
      const it = items[k]; if (!it) return;
      setExpanded(false);
      input.value = it.name;
      const ll = L.latLng(it.lat, it.lon);
      if (move) {
        if (it.bounds && !['駅', '停留場', '住所'].includes(it.kind)) map.flyToBounds(it.bounds, { maxZoom: ZOOM[it.kind] || 15, duration: 0.8, padding: [20, 20] });
        else map.flyTo(ll, ZOOM[it.kind] || 16, { duration: 0.8 });
      }
      if (onPick) onPick(it);
      if (marker) marker.remove();
      marker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="place-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false, title: it.name }).addTo(map);
      if (!popup) return;
      const html = `<div class="place-pop"><b>${esc(it.name)}</b><span class="dim">${esc([it.kind, it.sub].filter(Boolean).join(' · '))}</span>
        <button class="btn small" type="button" data-use-view>この表示範囲を対象にする</button></div>`;
      marker.bindPopup(html, { offset: [0, -6], autoPan: false });
      const openPop = () => { if (marker && !marker.isPopupOpen()) marker.openPopup(); };
      map.once('moveend', openPop); setTimeout(openPop, 1300);   // 移動が発生しない場合にも開く
    }
    map.on('popupopen', e => {
      const b = e.popup.getElement().querySelector('[data-use-view]');
      if (b) b.addEventListener('click', () => { onUseView && onUseView(); map.closePopup(); });
    });

    input.addEventListener('input', () => {
      clearTimeout(timer); const v = input.value.trim(); active = -1;
      if (v.length < 2) { items = []; setExpanded(false); seq++; return; }
      timer = setTimeout(() => suggest(v), 250);
    });
    input.addEventListener('focus', () => { loadMuni(geocoder.muni); if (items.length && itemsFor === input.value.trim()) render(); });
    input.addEventListener('keydown', e => {
      const open = !list.hidden && items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (open) highlight((active + 1) % items.length); else if (items.length) render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) highlight((active - 1 + items.length) % items.length); }
      else if (e.key === 'Enter') {
        e.preventDefault(); clearTimeout(timer);
        const v = input.value.trim(); if (!v) return;
        if (open && itemsFor === v) pick(active >= 0 ? active : 0);
        else suggest(v, { pickFirst: true });   // 候補がまだ来ていない／古いときは検索して先頭へ
      }
      else if (e.key === 'Escape') setExpanded(false);
    });
    list.addEventListener('mousedown', e => e.preventDefault());   // 入力欄のフォーカスを保つ
    list.addEventListener('click', e => { const li = e.target.closest('[role=option]'); if (li) pick(+li.dataset.k); });
    list.addEventListener('mousemove', e => { const li = e.target.closest('[role=option]'); if (li && +li.dataset.k !== active) highlight(+li.dataset.k); });
    const wrap = input.parentElement;
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) setExpanded(false); });
    input.addEventListener('blur', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) setExpanded(false); }, 150));
  }

  window.PM_Search = { init };
})();
