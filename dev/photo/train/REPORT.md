# 写真から石を分類する小型ニューラルネット — 学習・評価レポート

担当: ml-trainer（task-3）
仕様: `dev/photo/CONTRACT.md` v2（28次元特徴量 / MLP 28→64→32→8 / 中央値ベースライン正規化）

## 1. 成果物

| パス | 内容 |
|------|------|
| `dev/photo/train/gen_dataset.py` | canonical 盤画像の合成生成器（木目/紙/ダーク/サイバー、三角形格子＋六角セル罫線、8クラス石、照明/映り込み/影/ボケ/ノイズ/JPEG劣化） |
| `dev/photo/train/features.py` | 28次元特徴量リファレンス実装（Python） |
| `js/photo/features.js` | 同 JS 実装（classic script / CommonJS）。`extract(patch, baseline)`、補助 `samplePatch` / `medianBaseline` |
| `dev/photo/train/build_cache.py` | 合成データの並列生成→特徴量キャッシュ（`cache/*.npz`、git-ignore） |
| `dev/photo/train/train.py` | MLP 学習（numpy 実装, Adam）、シナリオ別評価、実写真パッチ評価 |
| `dev/photo/train/finetune_real.py` | 実写真127パッチでの微調整＋5-fold LOO 評価 |
| `dev/photo/train/export.py` | `js/photo/model.json` 書き出し＋Node でのパリティ/速度チェック |
| `js/photo/model.js` | 推論（classic script / CommonJS）。`load()` / `fromJSON()` / `predict()` / `forward()` |
| `js/photo/model.json` | 学習済み重み（float32） |
| `dev/photo/train/parity.py` / `parity_check.js` | パリティフィクスチャ生成 / JS-Python 一致検証 |
| `dev/photo/train/eval_patches.py` | ブラウザ書き出しパッチ JSON の分類・精度出力 |
| `dev/photo/testdata/synth/` | 合成テスト画像（canonical PNG 30枚 + 写真風 JPG 8枚 + GT JSON） |

## 2. パイプライン

1. 写真 → canonical 1024x1024（Lead 実装: 6点 homography）
2. ベースライン `B` = 格子点六角形内部のチャネル毎中央値（Lead/JS 実装）
3. 半径 `(s+0.6)*cell` の六角形の外側を `B` で塗りつぶし
4. 各点の 0.9*cell 四方を 16x16 にバイリニア間引き → 28次元特徴量（§3）
5. MLP 28→64→32→8 → softmax → 8クラス（empty/black/white/red/blue/green/yellow/purple）

## 3. 特徴量（CONTRACT v2 §4 と同一）

（実装は `features.py` 冒頭の docstring に厳密な定義を記載。Python/JS は全フィクスチャで差 0.0。）

## 4. 合成データ生成

- 盤サイズ n ∈ {9, 13, 19}（分布 0.2/0.55/0.25）
- 盤テーマ: 明るい木目 / 濃い茶木目（実写真相当）/ 赤茶木目 / 白紙 / 灰色紙 / ダーク / サイバー
- 罫線: 三角形格子（アプリ印刷）+ 外周六角形 / 六角セル（ハニカム）版
- 石: 光沢プラスチック / 艶なし / セミグロス（satin）の3素材 × 7色、落ち影・スペキュラハイライト付き
- 配置: 実写真に近い「1〜3色/盤」の色構成（45%は黒・白・青の対局風）＋クラスタ配置
- 劣化: 色温度/ホワイトバランス、照明グラデーション（左上明るく右下暗く等）、スポット光の映り込み、手/カメラの影、周辺減光、デフォーカス、信号依存センサーノイズ、JPEG 量子化（quality 45–95）
- 1盤の生成コスト: 約 0.25s（7プロセス並列で約 5–10盤/秒）
- 学習データ: **2,700盤 / 405,096サンプル**、val 220盤 / 33k、test 320盤 / 48k
- train/val/test は **(テーマ × 照明プロファイル × 素材) のシナリオ単位**で分割。
  test は学習に無い組み合わせ（例: wood_red×cool_indoor, paper_gray×harsh_shadow）と
  学習に無い素材 satin を含む「未知シナリオ」。

## 5. 学習

- numpy 実装 MLP 28→64→32→8, ReLU, softmax, Adam
- 特徴量標準化は第1層に畳み込み（model.json は生の特徴量をそのまま入力）
- 学習設定・時間: （記入）

## 6. 精度

### 6.1 合成テスト（未知シナリオ）
（記入: 全体 / クラス別 / シナリオ別 / 混同行列）

### 6.2 実写真 IMG_0252（127点）
- ブラウザ実装（Lead）が書き出した実パッチ127枚での精度: （記入）
- 自前 canonical 化での精度（開発用プロキシ）: （記入）
- 誤分類点の分析: （記入）

### 6.3 JS/Python パリティ
- `parity-fixtures.json`（8パッチ）: max|diff| = 0.0
- 実写真127パッチ: max|diff| = 0.0
- 推論速度（Node, model.predict ×127）: （記入）ms

## 7. 制限と今後

- （記入）
