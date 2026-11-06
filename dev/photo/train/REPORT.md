# 写真から石を分類する小型ニューラルネット — 学習・評価レポート

担当: ml-trainer（task-3） / 仕様: `dev/photo/CONTRACT.md` v2
（28次元特徴量 / MLP 28→64→32→8 / 中央値ベースライン正規化）

## 1. 成果物

| パス | 内容 |
|------|------|
| `dev/photo/train/gen_dataset.py` | canonical 盤画像の合成生成器（テーマ7種・罫線2系統・石3素材×7色・照明/映り込み/影/ボケ/ノイズ/JPEG劣化・盤の外側をベースライン色で塗る処理） |
| `dev/photo/train/features.py` | 28次元特徴量リファレンス実装（Python, batched版つき） |
| `js/photo/features.js` | 同 JS 実装（classic script / CommonJS, 依存なし）。`extract(patch, baseline)`、補助 `samplePatch` / `medianBaseline` |
| `dev/photo/train/build_cache.py` | 合成データの並列生成 → 特徴量キャッシュ（`cache/*.npz`、git-ignore） |
| `dev/photo/train/train.py` | MLP 学習（numpy 実装, Adam）、シナリオ別評価、実写真パッチ評価 |
| `dev/photo/train/finetune_real.py` | 実写真パッチ微調整の実験用（**最終モデルには不採用**、§7 参照） |
| `dev/photo/train/export.py` | `js/photo/model.json` 書き出し＋往復検証（`--check` で Node パリティ/速度） |
| `js/photo/model.js` | 推論（classic script / CommonJS）。`load()` / `fromJSON()` / `predict()` / `forward()` / `isLoaded()` / `classes` |
| `js/photo/model.json` | 学習済み重み（83,520 bytes, `"trained": true`, 4,200 パラメータ, float32） |
| `dev/photo/train/parity.py` / `parity_check.js` | パリティフィクスチャ生成 / JS-Python 一致・速度検証 |
| `dev/photo/train/eval_patches.py` | ブラウザ書き出しパッチ JSON の分類・精度出力 |
| `dev/photo/train/geometry.py` | canonical 幾何・DLT homography・canonical 化（開発/評価用 Python 実装） |
| `dev/photo/testdata/synth/` | リポジトリ同梱の合成テストセット: **10枚 / 468KB**（512px JPEG q85 + GT JSON + `manifest.json`）。1024 PNG は .gitignore |

### 生成したテスト画像の代表例（目視確認用）
- `dev/photo/testdata/synth/photo_00.jpg` — 濃茶の木目盤 + 三角形罫線 + 光沢石（実写真 IMG_0252 に最も近い構図・照明）
- `dev/photo/testdata/synth/photo_03.jpg` — ダーク盤 + スポット光 + セミグロス石（別テーマの写真風）
- `dev/photo/testdata/synth/canon_03_n19.jpg` — 19路・木目盤・ハニカム（六角セル）罫線の canonical 画像
- 実写真相当（canonical 1024）: `dev/photo/train/cache/gen2_0_wood_brown.png`（git-ignore だがローカルに残っている場合）

## 2. パイプライン（CONTRACT v2）

1. 写真 → canonical 1024x1024（Lead 実装: 格子6隅の対応点から homography）
2. ベースライン `B` = 格子点六角形内部の全画素のチャネル毎中央値（0..255）
3. 半径 `(s + 0.6)*cell` の六角形の外側を `B` で塗りつぶし（Lead の JS 実装と同一）
4. 各点の 0.9*cell 四方を 16x16 にバイリニア間引き（RGB 0..255）
5. 28次元特徴量（`features.py` 冒頭 docstring に厳密定義、CONTRACT §4 と同一）
6. MLP 28→64→32→8 → softmax → `empty/black/white/red/blue/green/yellow/purple`

## 3. 合成データ生成（`gen_dataset.py`）

- **盤サイズ**: n ∈ {9, 13, 19}（0.2 / 0.55 / 0.25）。25路は未対応（§7）。
- **テーマ（7種）**: 明るい木目 / 濃茶木目（実写真相当）/ 赤茶木目 / 白紙 / 灰色紙 / ダーク / サイバー。
- **罫線**: 三角形格子（アプリ印刷風、外周六角形つき）と、六角セル（ハニカム）版。
- **石**: 3素材（光沢プラスチック / 艶なし / セミグロス satin）× 7色。
  光沢は楕円スペキュラ（実写真の白飛びハイライト相当）+ 縁の暗転 + 落ち影。
- **配置**: 実写真に近づけるため「1〜3色/盤」（45% は黒・白・青の対局風）＋ 一部クラスタ配置、占有率 0.35〜0.80。
- **劣化**: 色温度/ホワイトバランス、照明グラデーション（左上明るく右下暗く等の方向性つき）、
  スポット光・窓映り込み（加算）、手/カメラの影（乗算ソフトエッジ）、周辺減光、デフォーカス、
  信号依存センサーノイズ、JPEG 量子化（quality 45–95）。
  さらに、合成画像でも canonical の六角形外（盤の外側）をベースライン色で塗ってからパッチを取る。
- **生成コスト**: 約 90–250 ms/盤（ホスト負荷依存）。7プロセス並列で 10 盤/秒前後。
- **学習データ**: 2,500盤 / **375,190サンプル**（train）。val 260盤 / 38,846、test 360盤 / **54,954**。
- 学習キャッシュは `dev/photo/train/cache/*.npz`（git-ignore、決定的シードで再生成可能）。

### シナリオ分割（未知シナリオ評価）
`(テーマ, 照明プロファイル, 素材)` の組み合わせ単位で分割。
- train: 18 組み合わせ（全テーマ・全照明プロファイルを含むが、組み合わせは限定）
- val: 6 組み合わせ（train に無い組み合わせ）＋ 学習に無い素材 **satin**
- test: 8 組み合わせ（train に無い組み合わせ）＋ satin

## 4. 学習

- MLP **28→64→32→8, ReLU, softmax, 4,200 パラメータ**（CONTRACT §6 どおり）
- numpy 実装（PyTorch 不使用）、Adam、batch 256、lr 1e-3、40 epochs
- 特徴量標準化は**第1層に畳み込み**（model.json は生の28次元特徴量をそのまま入力できる）
- val 精度でベスト epoch を選択（best epoch 21）
- 学習時間: **約 30 秒**（0.7 s/epoch、8コア共有ホスト、numpy。データ生成は別途 約4分）

## 5. 精度

### 5.1 合成データ（自前分割）

| split | accuracy | 備考 |
|-------|----------|------|
| train | **99.803%** (374,452/375,190) | |
| val   | **99.030%** (38,469/38,846) | 未知シナリオ＋未知素材 satin |
| test  | **99.052%** (54,433/54,954) | 未知シナリオ（下記） |

#### test クラス別精度

| class | acc | n |
|-------|-----|---|
| empty | 99.2% | 20,376 |
| black | 98.0% | 9,508 |
| white | 99.2% | 9,473 |
| red | 98.5% | 1,652 |
| blue | 99.6% | 9,719 |
| green | 99.9% | 1,366 |
| yellow | 99.7% | 1,473 |
| purple | 98.1% | 1,387 |

#### test 混同行列（行=正解, 列=予測）

```
          empty   black   white     red    blue   green  yellow  purple
empty     20223     132      13       2       2       0       0       4
black       151    9315      14       0       1      12       0      15
white        54       7    9396       0       9       2       0       5
red          24       0       0    1628       0       0       0       0
blue         18       3      19       0    9678       1       0       0
green         1       0       0       0       1    1364       0       0
yellow        4       0       0       0       0       0    1469       0
purple       10       0      13       4       0       0       0    1360
```
誤りの 54% は **black ↔ empty**（132+151件）。暗い盤（ダーク/サイバー/強影）で
黒石と盤面のコントラストが小さいケースが主。次いで white→blue/empty、red→empty。

#### test シナリオ別精度（未知のテーマ×照明×素材の組み合わせ）

| scenario (lighting/material/theme) | acc | n |
|---|---|---|
| cool_indoor/glossy/paper_dark | 100.00% | 2,752 |
| cool_indoor/glossy/wood_red | 100.00% | 2,852 |
| cool_indoor/matte/paper_dark | 99.94% | 1,758 |
| cool_indoor/matte/wood_red | 100.00% | 3,365 |
| cool_indoor/satin/paper_dark | 98.99% | 2,471 |
| cool_indoor/satin/wood_red | 99.86% | 2,134 |
| harsh_shadow/glossy/paper_gray | 97.12% | 2,051 |
| harsh_shadow/glossy/paper_white | 99.65% | 2,266 |
| harsh_shadow/matte/paper_gray | 98.54% | 2,886 |
| harsh_shadow/matte/paper_white | 99.53% | 2,957 |
| harsh_shadow/satin/paper_gray | 97.79% | 2,720 |
| harsh_shadow/satin/paper_white | 99.23% | 2,869 |
| low_warm/glossy/cyber | 100.00% | 1,299 |
| low_warm/glossy/wood_tan | 100.00% | 3,272 |
| low_warm/matte/cyber | 100.00% | 2,222 |
| low_warm/matte/wood_tan | 100.00% | 1,763 |
| low_warm/satin/cyber | 98.91% | 1,377 |
| low_warm/satin/wood_tan | 100.00% | 1,631 |
| overexposed/glossy/wood_brown | 97.29% | 2,620 |
| overexposed/matte/wood_brown | 95.58% | 1,719 |
| overexposed/satin/wood_brown | 93.24% | 1,465 |
| window_right/glossy/paper_gray | 99.56% | 2,520 |
| window_right/matte/paper_gray | 99.61% | 1,553 |
| window_right/satin/paper_gray | 99.63% | 2,432 |

weak なのは **overexposed × 濃茶木目** と **harsh_shadow × 灰色紙**。
どちらも白飛び/深い影で石のコントラストが物理的に潰れる極端シナリオで、
未知シナリオの汎化限界（目標 99.5% には 0.45pt 届かず）。

### 5.2 実写真 IMG_0252（13路, 127点）

Lead のブラウザパイプラインが書き出した実パッチ `dev/photo/testdata/IMG_0252.patches.json` を使用。

| 指標 | 結果 |
|------|------|
| **実写真127点（ブラウザ抽出パッチ）** | **89.76% (114/127, 13誤り)** |
| うち empty | 84.1% (37/44) |
| うち black | 96.4% (27/28) |
| うち white | 82.1% (23/28) |
| うち blue | 100.0% (27/27) |
| 自前 canonical 化（GT 6隅 → warp、FILL_MARGIN=0.6） | 90.55% (115/127, 12誤り) |

再現コマンド:
```bash
cd hexago
python dev/photo/train/eval_patches.py dev/photo/testdata/IMG_0252.patches.json
```

#### 誤分類の傾向（実写真）

13誤りの内訳: **white→blue 5**、**empty→red 6**、black→blue 1、white→black 1（表記ゆれあり計13）。

- **white→blue**: 実写真の白石は、暖色に転んだ盤面色 `B=[103,91,82]` に対して
  青白く写る（実測 patch 平均 RGB ≈ (176,189,196)、f15/16 = H の cos/sin ≈ (-0.89,-0.45)）。
  比率特徴量 f24-26 ≈ (1.0, 1.25, 1.7) が「青系」のパターンに一致し、
  絶対輝度 V≈0.74（白）より色相・比率が勝って blue に倒れる。
- **empty→red**: 照明の当たった木目（暖色）の空点は f24 ≈ 0.1〜0.27 と赤寄りになり、
  合成データの「赤石」境界に近づく。実際の画像は V≈0.4 と暗いが、比率特徴が支配的。
- **black→blue**: 実写真の黒石は青みがかった黒（RGB≈(35,37,42)）で、
  ハイライトの青成分が比率を blue 側へ動かす。

原因は **合成データと実写真の色かぶり（ホワイトバランス）・素材の分光特性の差**。
モデル単体ではこのドメインギャップを吸収しきれないため、
Lead 実装の **モデル + 色ヒューリスティックのアンサンブル（0.5 : 0.5）**で救う想定。
ヒューリスティックは実写真で 127/127 の実績があり、
モデルは合成 8クラス（赤/緑/黄/紫を含む）を高精度でカバーするので、
アンサンブルは両者の弱点を補完する。

### 5.3 JS / Python 一致・速度

| 検証 | 結果 |
|------|------|
| `parity-fixtures.json`（8パッチ, 生データ0..255 + baseline） | **max abs diff = 0.0** |
| 実写真127パッチ（Python特徴量 vs `js/photo/features.js`） | **max abs diff = 0.0** |
| JS 推論エンドツーエンド（features.js → model.js） on 実127パッチ | Python と **ラベル一致 127/127**、GT 正解 114/127 |
| `model.predict` 127回（Node） | **6.5 ms**（目標 < 30 ms） |
| 参考: `features.extract` 127回（Node） | 11.1 ms（ホスト負荷依存。最混雑時 20.8 ms） |
| `js/photo/model.json` | 83,520 bytes（< 400KB）、`"trained": true` |

検証コマンド:
```bash
node dev/photo/train/parity_check.js     # パリティ + model.js スモーク + 速度
```

## 6. 制限と今後

- **実写真の色かぶりへの弱さ**（§5.2）が最大の課題。改善案:
  1. 合成時に「暖色の盤 + 寒色の石」のような**混合色温度**を明示的に生成する（素材ごとの分光差）。
  2. 実写真パッチでの微調整は試したが、patch 空間の明るさ/色温度増強が強すぎると
     ラベル衝突を起こし LOO が大きく悪化（最良でも LOO 97.6%、増強ありは 48〜76%）。
     最終モデルには**不採用**。採用するなら増強なしの少量微調整＋十分な LOO 検証が必要。
  3. 実運用では Lead のアンサンブル（モデル + ヒューリスティック）が有効。
- **合成 unknown シナリオ 99.05%** は目標 99.5% に 0.45pt 未達。
  原因は overexposed / harsh_shadow の極端照明（白飛び・深い影）で、
  物理的に判別困難なケース（石が完全に白飛び/黒潰れ）を含むため。
  照明レンジを現実的な範囲に狭めれば 99.5% 超えは可能だが、
  未知照明への頑健性を測るというテストの趣旨を優先して、極端レンジを維持した。
- **black ↔ empty** が誤りの大半（暗い盤での低コントラスト）。暗色テーマのコントラストを
  上げる（黒石のスペキュラを強める・盤の明度を上げる）か、より多くの暗色データで改善余地。
- **n=25 は未対応**（学習は 9/13/19 のみ）。cell が小さいためパッチの情報量が減るが、
  同一特徴量・同一モデルで動作はする（精度未検証）。
- baseline の塗りつぶし半径は Lead の JS 実装に合わせ **0.6 cell** 固定。
  実装が変わった場合は合成側も `FILL_MARGIN` を合わせる必要がある。
- `cache/*.npz`（学習キャッシュ）は git-ignore。REPORT の数値は決定的シードでの再生成で再現可能:
  ```bash
  cd hexago/dev/photo/train
  python build_cache.py --split train --boards 2500 --workers 7
  python build_cache.py --split val   --boards 260  --workers 7
  python build_cache.py --split test  --boards 360  --workers 7
  python train.py --epochs 40
  python export.py --check
  ```
