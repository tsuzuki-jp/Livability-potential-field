/*
 * 住環境ポテンシャル地図 — 設定
 *
 * カテゴリを追加・変更するときはこのファイルだけを編集してください。
 *   sign   : +1 = 避けたい（ポテンシャルの山）、-1 = 便利（谷）
 *   kind   : 'point' = 点源（way/relation は中心点）、'line' = 線源、'anchor' = 通勤先（地図上で指定）
 *   weight : 初期の重み (0〜10)
 *   radius : 影響半径 r [m]、radius_max はスライダーの上限
 *   repel  : true で「近すぎると逆効果」の斥力補正（半径 50 m）を加える
 *   labels : true の点は名前を「最寄り駅」に使う
 *   osm    : OpenStreetMap のタグ条件。tags は正規表現（すべて満たす）、not は該当したら除外
 *            type は 'nwr'（点・面・関係すべて）または 'way'
 */
window.PM_CONFIG = {
  categories: [
    { id: 'night', label: '居酒屋・バー・クラブ', sign: +1, weight: 8, radius: 300, radius_max: 800, kind: 'point',
      osm: [{ type: 'nwr', tags: { amenity: '^(bar|pub|nightclub|biergarten|stripclub)$' } },
            { type: 'nwr', tags: { amenity: '^restaurant$', cuisine: 'izakaya' } },       // 日本の居酒屋はこの登録が標準
            { type: 'nwr', tags: { amenity: '^(karaoke_box|love_hotel)$' } }] },
    { id: 'gambling', label: 'パチンコ・ゲームセンター', sign: +1, weight: 4, radius: 200, radius_max: 600, kind: 'point',
      osm: [{ type: 'nwr', tags: { amenity: '^(gambling|casino)$' } },
            { type: 'nwr', tags: { leisure: '^(adult_gaming_centre|amusement_arcade)$' } },
            { type: 'nwr', tags: { gambling: 'pachinko|slot' } },                          // amenity が無くても gambling= だけの登録がある
            { type: 'nwr', tags: { shop: '^(pachinko|lottery)$' } }] },
    { id: 'venue', label: 'ライブ会場・ホール・スタジアム', sign: +1, weight: 4, radius: 250, radius_max: 800, kind: 'point',
      osm: [{ type: 'nwr', tags: { amenity: '^(music_venue|theatre|events_venue|concert_hall|arts_centre)$' } },
            { type: 'nwr', tags: { leisure: '^stadium$' } }] },
    { id: 'air', label: '航空機騒音（滑走路）', sign: +1, weight: 6, radius: 900, radius_max: 2500, kind: 'line', extend_m: 1200,
      osm: [{ type: 'way', tags: { aeroway: '^runway$' } }] },
    { id: 'road', label: '幹線道路の騒音', sign: +1, weight: 3, radius: 100, radius_max: 400, kind: 'line',
      osm: [{ type: 'way', tags: { highway: '^(motorway|trunk|primary)$' } }] },
    { id: 'rail', label: '鉄道沿線', sign: +1, weight: 2, radius: 100, radius_max: 400, kind: 'line',
      osm: [{ type: 'way', tags: { railway: '^(rail|light_rail|tram|subway)$' }, not: { tunnel: '^yes$', service: '.' } }] },

    { id: 'super', label: 'スーパー', sign: -1, weight: 6, radius: 600, radius_max: 1500, kind: 'point', repel: true,
      osm: [{ type: 'nwr', tags: { shop: '^(supermarket|department_store)$' } }] },
    { id: 'conv', label: 'コンビニ', sign: -1, weight: 3, radius: 300, radius_max: 1000, kind: 'point', repel: true,
      osm: [{ type: 'nwr', tags: { shop: '^convenience$' } }] },
    { id: 'drug', label: 'ドラッグストア・薬局', sign: -1, weight: 3, radius: 600, radius_max: 1500, kind: 'point',
      osm: [{ type: 'nwr', tags: { shop: '^(chemist|drugstore)$' } },
            { type: 'nwr', tags: { amenity: '^pharmacy$' } }] },                           // 日本のドラッグストアは pharmacy 登録も多い
    { id: 'fastfood', label: 'ファストフード', sign: -1, weight: 2, radius: 400, radius_max: 1000, kind: 'point',
      osm: [{ type: 'nwr', tags: { amenity: '^fast_food$' } }] },
    { id: 'bus', label: 'バス停', sign: -1, weight: 3, radius: 400, radius_max: 1000, kind: 'point',
      mergeSameNameM: 80,      // 上り・下りで道路の両側にある同名のバス停を1つにまとめる
      routeWeighted: true,     // 経由する系統数で重み付けできる（路線データから数える）
      osm: [{ type: 'node', tags: { highway: '^bus_stop$' } },
            { type: 'nwr', tags: { public_transport: '^platform$', bus: '^yes$' } }] },
    { id: 'station', label: '駅・停留場', sign: -1, weight: 4, radius: 800, radius_max: 2000, kind: 'point', repel: true, labels: true,
      osm: [{ type: 'nwr', tags: { railway: '^(station|halt|tram_stop)$' } }] },
    { id: 'work', label: '通勤先への近さ', sign: -1, weight: 5, radius: 3000, radius_max: 10000, kind: 'anchor' }
  ],

  // 路線図（OpenStreetMap の route リレーション）。表示と、バス停の系統数の数え上げに使う
  routes: {
    rail: ['train', 'subway', 'light_rail', 'tram', 'monorail'],
    bus: ['bus']
  },

  // プリセット: 正側（nuisance）と負側（amenity）の重みの倍率、anchor は通勤先の重み
  presets: {
    '標準': { nuisance: 1.0, amenity: 1.0 },
    '静けさ優先': { nuisance: 1.4, amenity: 0.7 },
    '利便性優先': { nuisance: 0.7, amenity: 1.4 },
    '通勤最優先': { nuisance: 0.8, amenity: 0.6, anchor: 10 }
  },

  // 初回表示（例: 宇都宮。自分の地域に書き換えてかまいません）
  initial: {
    name: '宇都宮',
    bbox: [36.470, 139.800, 36.630, 139.980],   // [south, west, north, east]
    anchors: [
      { name: 'SUBARU 本工場（陽南）', lat: 36.538639, lon: 139.874671 },
      { name: 'SUBARU 南工場（上横田町）', lat: 36.522883, lon: 139.875739 }
    ]
  },

  grid: { targetCells: 160000 },           // 計算格子のセル数（多いほど細かく、重い）
  area: { warnKm2: 300, maxKm2: 900 },     // これを超えると警告／取得しない
  fetchPadM: 800,                           // 範囲の外側もこの距離まで取得（境界付近の値を正しくするため）

  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ],
  geocoder: {
    photon: 'https://photon.komoot.io/api/',                                   // 入力中の候補（OpenStreetMap ベース）
    gsi: 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=',          // 住所（番地まで）
    muni: 'https://maps.gsi.go.jp/js/muni.js',                                  // 市区町村コード表（候補の地域名表示に使用）
    nominatim: 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=jp&limit=6&q='
  },
  tiles: {
    '淡色地図': { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxZoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' },
    '標準地図': { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxZoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' },
    '写真': { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxZoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' }
  }
};
