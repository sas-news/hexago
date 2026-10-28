# HEXAGO

六角形の盤で打つ囲碁風ゲーム。`index.html` 1枚だけで動く静的アプリです（ローカル対戦・PeerJS によるオンライン対戦）。

## 遊び方

HTTP で配信して開きます。

```bash
python3 -m http.server 8000
# http://localhost:8000/index.html
```

GitHub Pages などに `index.html` を置けばそのまま公開できます。PC は交点をホバーしてクリック、スマホは同じ交点を2タップで着手します。オンライン対戦は PeerJS の公開シグナリングサーバーを使います。

## AI

MCTS（モンテカルロ木探索）。AIは常に最強設定で動きます。思考中は読んだ局面数を表示します。

## 開発

エンジンは `dev/ai-engine.js` がソースで、`dev/inline-engine.js` で `index.html` に埋め込みます。

```bash
node dev/engine-selftest.js
node dev/inline-engine.js --check
node bench/bench.js --old-vs-new --games 10 --size 9 --players 2 --time 200
```

E2E（任意・Playwright が必要）: `dev/e2e.js`、`dev/e2e-online.js`、`dev/e2e-reconnect.js`、`dev/e2e-deadstone.js`。

構成: `dev/` エンジンとテスト、`bench/` 対戦ベンチ。

## 注意

- オンライン対戦は PeerJS の公開シグナリングサーバー依存です。
- `file://` で直接開いた場合、Web Worker が使えないため簡易探索になります。
