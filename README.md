# 住環境ポテンシャル地図（Web 版）

避けたい施設（飲み屋・パチンコ店・ライブ会場・幹線道路・線路・滑走路）を正のポテンシャル（山）、便利な施設（スーパー・コンビニ・ドラッグストア・ファストフード店・駅・通勤先）を負のポテンシャル（谷）として重ね合わせ、住みやすい場所を探すための Web アプリです。

- サーバー不要の静的サイトで、HTML・CSS・JavaScript だけで動きます。GitHub Pages にそのまま置けます。
- データはブラウザが OpenStreetMap（Overpass API）から直接取得し、計算もブラウザ内で行います。
- 日本国内なら、どの地域でも使えます（背景は国土地理院の地図）。

```
U(x) = Σ_c s_c · w_c · Φ_c(x)
Φ_c = 1 − Π_i (1 − exp(−|x−p_i|²/r_c²))   点源（同種の施設が何件あっても 0〜1 で飽和）
Φ_c = exp(−d_c(x)²/r_c²)                  線源（道路・鉄道・滑走路）
```

## 使い方

1. 上の検索欄に地名・駅名・住所を入れると候補が出ます（↑↓で選んで Enter、またはクリック）。候補には都道府県・市区町村と種類（駅・市・地区・住所など）が付くので、同名の場所も区別できます。選ぶと地図がその場所へ移動します。
2. 「範囲」タブで **表示中の範囲を対象にする** を押します（目安は 300 km² 以下）。
3. 通勤先があれば **地図をクリックして追加** で登録します（ドラッグで移動、名前は編集可）。
4. **データを取得して計算** を押します。数秒〜数十秒で地図に色が付きます。
5. 「重み」タブで重み w・影響半径 r・プリセットを変えると、その場で再計算されます。
6. 「結果」タブに谷の深い順の候補地が出ます。番号を押すとその場所へ移動します。地図をクリックすると、その地点の内訳が見られます。

- **JSON で保存**：取得したデータと重みを保存します。次回は **JSON を読み込む** で、ネットに接続せずに再現できます。Python 版 `potmap` が出力した JSON も読み込めます。
- **共有リンクをコピー**：範囲・通勤先・重みを URL に入れて共有します。データは開いた人のブラウザが取得し直します。
- 設定（範囲・通勤先・重み）はブラウザに自動保存されます。

## GitHub Pages で公開する（コマンド不要）

1. GitHub で新しいリポジトリを作ります（例：`potential-map-web`）。無料プランの場合、GitHub Pages を使うにはリポジトリを **Public** にする必要があります。
2. リポジトリの画面で **Add file → Upload files** を選び、このフォルダの中身（`index.html`、`css/`、`js/`、`README.md`）をまとめてドラッグして **Commit changes** を押します。
3. **Settings → Pages** を開き、「Build and deployment」の Source を **Deploy from a branch**、Branch を **main** と **/(root)** にして **Save** を押します。
4. 1〜2分後に `https://<ユーザー名>.github.io/potential-map-web/` で公開されます。

コマンドを使う場合は次のとおりです。

```bash
git init && git add . && git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/potential-map-web.git
git push -u origin main
# その後、上の手順3で Pages を有効にする
```

### 手元で動かす

```bash
cd potential-map-web
python -m http.server 8000     # ブラウザで http://localhost:8000 を開く
```

`index.html` をダブルクリックして開いても多くの場合は動きますが、ブラウザによっては外部データの取得が制限されるため、上の方法が確実です。

## カスタマイズ

設定はすべて `js/config.js` にあります。

- **カテゴリの追加・変更**：`categories` に1項目足すだけです。OpenStreetMap のタグ条件（正規表現）を書くと、取得・分類・スライダーまで自動で対応します。

  ```js
  { id: 'cemetery', label: '墓地', sign: +1, weight: 1, radius: 150, radius_max: 500, kind: 'point',
    osm: [{ type: 'nwr', tags: { landuse: '^cemetery$' } }] },
  ```
- **初回に表示する地域と通勤先**：`initial`
- **計算の細かさ**：`grid.targetCells`（初期値 16万セル。多いほど細かく、重くなります）
- **範囲の上限**：`area.maxKm2`
- **プリセット**：`presets`

## データと利用上の注意

- 施設・道路・線路：© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）
- 背景地図：[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（国土地理院）
- 地名検索：[Photon](https://photon.komoot.io/)（OpenStreetMap ベース、入力中の候補）と国土地理院の住所検索 API（番地まで）を併用し、市区町村名は国土地理院の市区町村コード表から付けています。どちらでも見つからないときだけ [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) を使います。
- 画面右下に出典が表示されます。改変して公開する場合も、出典の表示は残してください。
- Overpass API は有志が運営する無料のサービスです。同じ範囲を何度も取得せず、一度取得したら **JSON で保存** して使い回してください。混雑しているときは自動で別のサーバーを試します。

## 限界

- OpenStreetMap の登録状況は地域によって差があります。特にドラッグストアとパチンコ店は少なめで、件数が少ないカテゴリは実際より弱く表示されます。
- 騒音は距離だけで近似しています（交通量・遮音・時間帯・ヘリコプターの飛行経路は考慮していません）。
- 距離は直線距離です。線路や川で分断された場所では、実際の歩行距離とずれます。
- U は相対値です。重みを変えたときに谷がどう動くかを見るためのもので、絶対的な住みやすさを表すものではありません。

## ファイル構成

```
index.html        画面
css/style.css     見た目（ライト／ダーク対応）
js/config.js      カテゴリ・重み・地図タイル・API の設定
js/osm.js         Overpass クエリの生成・取得・分類
js/search.js      地名・駅名・住所の検索（候補表示・地図の移動）
js/engine.js      ポテンシャル場の計算（地図ライブラリに依存しない）
js/app.js         地図と画面の制御（Leaflet 1.9.4 を cdnjs から読み込み）
```
