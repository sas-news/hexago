# HEXAGO

六角形の盤で打つ囲碁風ゲームです。ビルド不要の静的アプリで、`index.html` を HTTP で配信するだけで動きます（ローカル対戦・PeerJS によるオンライン対戦・写真からの盤面復元）。

**公開URL:** https://sas-news.github.io/hexago/

## 遊び方

```bash
python3 -m http.server 8000
# http://localhost:8000/index.html
```

GitHub Pages にリポジトリを置けばそのまま公開できます（リポジトリ直下がそのまま配信物です）。
PC は交点をホバーしてクリック、スマホは同じ交点を2タップで着手します。
オンライン対戦は PeerJS の公開シグナリングサーバーを使います。

## AI

MCTS（モンテカルロ木探索）。AIは常に最強設定で動きます。思考中は読んだ局面数を表示します。
エンジンは `js/ai/engine.js`（Node の自己テスト・ベンチが直接 require する `dev/ai-engine.js` の同期コピー）で、Web Worker プールで並列に探索します。

## 写真から盤面を復元（画像認識AI）

実物の六角盤をスマートフォンで撮影すると、石の配置を読み取って局面として保存できます。
**画像は端末内だけで処理され、外部に送信されません**（APIキー・サーバー不要）。

使い方:

1. ヘッダの 📷 ボタンを押す
2. 盤全体が写った写真を選ぶ（その場で撮影も可）
3. 自動検出された6隅を確認し、必要なら丸をドラッグして合わせる（盤面サイズは撮影画像から自動判定。違う場合は選び直す）
4. 「この状態で読み取る」→ 交点の石が色付きで表示される
5. 自信が低い点（琥珀色の枠）をタップして修正（空→黒→白→赤→青→緑→黄→紫）
6. 「保存」で局面ライブラリへ、「この局面から対局」でそのまま続きから対局

仕組み:

- 盤の外枠を色差＋六角形フィットで自動検出し、6点の homography で正面から見た盤画像（canonical 1024px）に変換
- 交点ごとに 16x16 のパッチを抽出し、28次元の色・形状特徴量を計算
- 小型ニューラルネット（`js/photo/model.json` が学習済みのとき）またはヒューリスティック分類器で「空/黒/白/赤/青/緑/黄/紫」を判定
- 迷った点は琥珀色で示し、タップで必ず正しい状態に直せる（最終的な正解は人が保証する設計）

実写真（13路盤・黒28/白28/青27/空44）での実測:

| 条件 | 交点正解率 | 処理時間 |
|---|---|---|
| 6隅を手動で合わせた場合 | 127/127 (100%) | 約0.1秒 |
| 外枠を自動検出した場合 | 126/127 (99.2%) | 約0.2秒 |

認識モデル:

- 学習データ: 合成盤 2,700枚 / 405,096交点（木目・紙・ダーク・サイバー、三角形格子/六角セル、光沢/艶なし/セミグロス、照明・映り込み・影・ボケ・ノイズ・JPEG劣化をランダム化）
- モデル: 28次元特徴量 → MLP 28-64-32-8（約4,200パラメータ / 83KB / 推論は127点で約7ms）
- 未知シナリオ（学習に無い素材×照明の組み合わせ）での精度: **99.05%**
- 実写真ではヒューリスティック分類器が強い（色かぶり・木目の暖色に頑健）ため、
  「ヒューリスティックが自信を持てた点はそれを使い、迷った点だけモデルと併用する」
  カスケード方式で両方の強みを取っています

対応: 盤面サイズ 9/13/19/25路。読み込み時に **サイズと余白（外枠と格子のすき間）を自動調整**します
（候補を走査して「一致度」が最大になる組み合わせを採用）。実物の盤や印刷の具合でズレるときは、
**余白スライダー**で緑のプレビュー点を石の中心に合わせてください。一致度（%）は常に表示され、
スライダー操作にも追従するので、合っているかどうかがその場で分かります。
スマートフォン・iPad（縦横）でもモーダル全体が画面内に収まるよう、盤画像は画面サイズに合わせて自動縮小します。
保存した局面は JSON で書き出し・読み込みできます（`localStorage` の `hexago-photo-lib-v1`）。

## 構成

```
index.html            アプリ本体（マークアップのみ / 約300行）
css/app.css           スタイル
js/main.js            起動
js/core/              theme / sound / geometry / state / rules
js/ai/                engine.js(MCTS) / worker.js / pool.js / heuristic.js
js/ui/                input / render / ui / modals / settings / online / debug
js/photo/             写真復元（geom / features / model(.json) / rectify / detect / recognize / store / ui）
dev/                  開発ツール（自己テスト・ブラウザE2E・写真学習パイプライン）
bench/                AI強さベンチマーク
```

`index.html` は classic script を順に読み込むだけの構成で、ビルド工程はありません。相対パスで読み込むため GitHub Pages のサブパス配信でもそのまま動きます。

## 開発

```bash
# エンジン自己テスト（ページ側の実装と突き合わせ）
node dev/engine-selftest.js

# エンジンのコピーが古くなっていないか
node dev/sync-engine.js --check

# 強さベンチ（例）
node bench/bench.js --old-vs-random --games 2 --size 9

# ブラウザ回帰テスト（依存ゼロCDP / Playwright不要）
node dev/cdp/regress.js
node dev/cdp/regress.js --out dev/cdp/current.json --compare dev/cdp/baseline.json

# 写真パイプラインの精度テスト
node dev/photo/test/run.js --case real
node dev/photo/test/run.js --case detect,align,store,synthetic

# 写真復元UIのブラウザE2E（スクリーンショットも撮る）
node dev/photo/test/ui-e2e.js
```

写真の学習パイプライン（Python / numpy + OpenCV）は `dev/photo/train/` にあります。合成データの生成、特徴量、学習、書き出し、評価、実写真パッチの評価までスクリプト化されています（決定的シードで再現可能）。

```bash
python dev/photo/train/gen_dataset.py      # 合成盤の生成（例）
python dev/photo/train/build_cache.py      # 特徴量キャッシュの作成
python dev/photo/train/train.py            # MLP 学習
python dev/photo/train/export.py           # js/photo/model.json へ書き出し
node dev/photo/train/parity_check.js       # Python/JS の特徴量一致検証
```

仕様と精度レポート: [`dev/photo/CONTRACT.md`](dev/photo/CONTRACT.md) / [`dev/photo/train/REPORT.md`](dev/photo/train/REPORT.md)

## 注意

- オンライン対戦は PeerJS の公開シグナリングサーバー依存です。
- `file://` で直接開いた場合、Web Worker が使えないため簡易探索になります。
- 写真復元は端末内で完結しますが、写真の撮り方（照明・映り込み・斜め撮影）によって精度が変わります。その場合は6隅のドラッグとタップ修正で必ず正しい局面にできます。
