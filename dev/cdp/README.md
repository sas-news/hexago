# dev/cdp — 依存ゼロのブラウザ検証ハーネス

HEXAGO（`index.html` + `js/` + `css/`）を **headless Chrome + Chrome DevTools Protocol (CDP)** で
実際に起動して検証するためのツール一式です。npm パッケージは一切使いません。

- Node の組込み `WebSocket` / `fetch` と標準モジュールだけに依存（`package.json` 不要）
- 既存の `dev/e2e*.js` は Playwright 前提ですが、こちらは **Playwright 不要**
- リファクタ前後で **同じスナップショット JSON を比較** できることを主目的にしています

## 前提

| 項目 | 内容 |
|---|---|
| Node | v22 以上（組込み `WebSocket` が必要）。このリポジトリでは v26.12.1 で確認 |
| Chrome | `chrome-headless-shell`（既定パスは下記）。`HEXAGO_CHROME=/path/to/chrome` で上書き可 |
| ポート | 空きポートを自動取得（`--remote-debugging-port=0` / HTTP サーバも port 0） |

既定の Chrome:

```text
/home/sasnews/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell
```

`HEXAGO_CHROME` → `CHROME_PATH` → 既定パス → `google-chrome` / `chromium` の順に探索します。

## なぜ Playwright を使わないか

- Playwright は未インストールで、追加 npm 依存を増やしたくない（このリポジトリは
  `index.html` を開くだけで動く静的アプリで、開発ツールも依存ゼロを保ちたい）。
- 必要な機能は「ページを開く・JS を評価する・スクショを撮る・ログを拾う」だけ。
  これは CDP の `Target` / `Page` / `Runtime` / `Log` / `Emulation` で十分に足りる。
- ブラウザ本体（chrome-headless-shell）は既にローカルにあるため、CDP を直接叩く方が
  起動も速く、失敗時の原因（Chrome の stderr、CDP コマンド名）も追いやすい。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `driver.js` | CDP ドライバ（ライブラリ）。`Browser` / `Page` を提供 |
| `serve.js` | 静的配信ヘルパ。`startStaticServer(root)` |
| `regress.js` | アプリ回帰テスト本体。検証結果＋決定的スナップショットを JSON 出力 |
| `baseline.json` | リファクタ検証用のベースライン（`regress.js --compare` の入力） |
| `README.md` | このファイル |
| `dev/photo/test/run.js` | 写真→盤面パイプライン用の汎用テストランナー（`window.__photoTest.run()` を呼ぶ） |

生成物（`.gitignore` 済み）:

- `dev/cdp/.tmp/` … Chrome の一時プロファイル（終了時に削除。クラッシュ時は2時間後に自動掃除）
- `dev/cdp/shots/` … スクリーンショット
- `dev/cdp/current.json` … 既定の出力先

## 使い方

### 1. アプリ回帰テスト

```bash
node dev/cdp/regress.js
# == node dev/cdp/regress.js --out dev/cdp/current.json --shots dev/cdp/shots
```

自前の Node 静的サーバでリポジトリを配信し、`/index.html` を開いて検証します。
既存サーバを使う場合:

```bash
python3 -m http.server 8123 --bind 127.0.0.1 &
node dev/cdp/regress.js --url http://127.0.0.1:8123/index.html
```

主なオプション:

```text
--url <url>           既存の URL を使う（省略時は自前サーバ）
--out <file>          結果 JSON の保存先 (default: dev/cdp/current.json)
--shots <dir>         スクリーンショット保存先 (default: dev/cdp/shots)
--compare <file>      このスナップショットと比較し、差分があれば exit 1
--timeout <ms>        CDP コマンドのタイムアウト (default: 30000)
--total-timeout <ms>  全体のタイムアウト (default: 180000)
--verbose             進捗ログを stderr に出す
```

終了コードは **0 = 全 PASS / 1 = FAIL**。PASS/FAIL は1行ずつ標準出力に出るので、
失敗した項目名と detail を見れば原因が分かります。

### 2. リファクタ前後で比較する（推奨フロー）

```bash
# リファクタ前（または現状の正しい状態）でベースラインを保存
node dev/cdp/regress.js --out dev/cdp/baseline.json

# リファクタ後に同じコマンドで比較（snapshot が完全一致すれば PASS）
node dev/cdp/regress.js --out dev/cdp/current.json --compare dev/cdp/baseline.json
```

`--compare` は `snapshot` だけを比較し、差分の JSON パス・ベースライン値・現在値を表示します。
出力 JSON の `compare` フィールドにも結果が残ります。

> UI を意図的に変更したときは、内容を確認したうえで `baseline.json` を更新してください
> （`node dev/cdp/regress.js --out dev/cdp/baseline.json`）。

### 3. 写真パイプラインテストランナー

```bash
node dev/photo/test/run.js                          # /dev/photo/test/index.html を開く
node dev/photo/test/run.js --case basic             # window.__photoTest.run('basic')
node dev/photo/test/run.js --url http://127.0.0.1:8000/dev/photo/test/index.html --case label
node dev/photo/test/run.js --case basic --json | jq .   # stdout は常に純粋な JSON
```

ページ側の契約:

```js
window.__photoTest = {
  run: async (caseName) => ({ /* JSON 化できる結果 */ })
};
```

`dev/photo/test/index.html` は写真パイプライン担当（Lead）が作成します。未作成の場合は
分かりやすいエラーを出して exit 1 になります（`--url` で任意ページを指定可能）。

## 検証項目（`regress.js`）

| # | 検証 | 内容 |
|---|---|---|
| a | 起動・無エラー | `Page.loadEventFired` 後に JS 例外 / `console.error` が 0 件 |
| b | デバッグ API | `window.__hexagoDebug` が存在し `state()` が盤面・手番を返す |
| c | AI 合法手 | `think(300)` の返した手が `sim()` で合法、`think()` が盤面を書き換えない、3手で盤面が進む |
| d | undo / pass / 投了 | undo で盤面・石数・手番が1手前に戻る、pass で手番が進み保存される、投了は2回タップで確定し OUT が保存される |
| e | 盤サイズ | 9 / 13 / 19 で `newGame()` → 盤長 61 / 127 / 271、AI が合法手を返す |
| f | 保存・復元 | `sessionStorage['hexago-save-v1']` に保存され、リロードで盤面・手番・サイズが復元される |
| g | UI | 設定/ルール/結果モーダルの開閉（✕・Esc・背景クリック）、テーマ切替が CSS 変数と保存に反映 |
| h | レイアウト | 390x844（DPR 2）と 1280x800（DPR 1）で canvas が 0 サイズでない・正方形・横はみ出しなし・スクショ保存 |

AI の着手や訪問数は実行ごとに揺れるため検証ログにのみ出し、**スナップショットには入れません**。

## 出力 JSON の構造

```jsonc
{
  "tool": "hexago-cdp-regress",
  "schema": 1,
  "ok": true,
  "summary": { "pass": 34, "fail": 0, "total": 34 },
  "checks": [ { "name": "...", "ok": true, "detail": "..." } ],
  "snapshot": {          // ← 決定的。--compare はここだけを比較する
    "initial": { "size": 9, "phase": "setup", "turn": 1, "boardHash": "017c253b", ... },
    "undo": { ... },
    "pass": { ... },
    "resign": { ... },
    "sizes": [ { "size": 13, "boardLength": 127, "legal": true } ],
    "save": { "present": true, "rawHash": "...", "fields": { ... }, "boardHash": "..." },
    "restore": { "matches": true, ... },
    "modals": { ... },
    "theme": { "before": { "bg": "#ffffff", "saveTheme": "default" }, ... },
    "layout": {
      "mobile":  { "viewport": { "width": 390, "height": 844, "dpr": 2 }, "canvas": { "cssW": 366, "pxW": 732 }, ... },
      "desktop": { ... }
    },
    "errors": { "consoleErrors": [], "exceptions": [], "resourceWarnings": [] }
  },
  "observations": {      // ← 実行ごとに揺れてよい値（AI の着手・訪問数・スクショ名など）
    "engine": { ... },
    "ai": { "moves": [ ... ] }
  },
  "logs": { ... },
  "meta": { "node": "v26.12.1", "chrome": "Google Chrome for Testing ...", "url": "http://<server>/index.html" }
}
```

- 自己配信時の URL は `http://<server>/index.html` に丸めてあり、実行ごとに変わるポートは入りません。
- `checks` は PASS/FAIL の記録、`snapshot` は状態の指紋です。`--compare` は `snapshot` のみ比較します
  （検証項目の追加・文言変更で diff が騒がしくならないように）。
- 外部 CDN（tailwind / peerjs）が遮断された環境では network resource error が
  `snapshot.errors.resourceWarnings` に残りますが、JS エラーではないため FAIL にしません。
  その場合レイアウトの見た目は CDN に依存する点に注意。

## driver.js の API（要約）

```js
const { Browser, sleep } = require('./driver');

const browser = await Browser.launch({ timeoutMs: 30000 });       // Chrome 起動
const page = await browser.newPage({
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
});
await page.goto('http://127.0.0.1:8123/index.html');
await page.waitForFunction('typeof window.__hexagoDebug === "object"');
const state = await page.evaluate(() => window.__hexagoDebug.state()); // 関数＋引数 OK
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await page.screenshot('dev/cdp/shots/desktop.png');
const logs = page.logs; // { console, exceptions, resourceErrors, ... }
await page.reload();
await page.close();
await browser.close();                                            // Chrome を kill・プロファイル削除
```

- `page.evaluate(fn, ...args)` … 関数を文字列化して実行（クロージャ不可、引数は JSON 化できるもの）
- `page.evaluate('expression')` … 文字列式も可。`awaitPromise` / `returnByValue` 常時有効
- `page.waitForFunction(expr, { timeoutMs, pollMs })` … truthy になるまでポーリング
- `page.setViewport({width, height, deviceScaleFactor, mobile})` … `Emulation.setDeviceMetricsOverride`
- `page.screenshot(path)` … viewport の PNG（`Page.captureScreenshot`）
- `page.on(event, fn)` / `page.waitForEvent(event)` … CDP イベント
- `browser.version` / `browser.chromePath` / `browser.wsUrl` … デバッグ情報

### 仕組み

1. `chrome-headless-shell --headless --no-sandbox --disable-gpu --remote-debugging-port=0
   --user-data-dir=<dev/cdp/.tmp/...>` を起動（ポート 0 で衝突回避）。
2. Chrome が `<user-data-dir>/DevToolsActivePort` に「実ポート / browser WebSocket パス」を書くので読む。
3. ブラウザ WebSocket に接続し、`Target.createTarget` → `Target.attachToTarget({flatten:true})` で
   ページセッションを取得。CDP メッセージに `sessionId` を付けてページを操作。
4. `Page.navigate` → `Page.loadEventFired` 待ち、`Runtime.evaluate` で JS 評価、
   `Page.captureScreenshot` で PNG、`Runtime` / `Log` イベントで例外・コンソール・
   リソースエラーを収集。
5. `Browser.close` → プロセス終了を待ち、必要なら SIGKILL → 一時プロファイル削除。

## 既知の制限

- **ヘッドレスシェルのみ**。headed モードは非対応（CI/自動実行向け）。
- ビューポートは `Emulation.setDeviceMetricsOverride` による再現。実機スマホの
  タッチ・DPR・フォントとは完全一致しない。タップ操作はテストでは `element.click()`
  相当を使っている（実タッチイベントの検証はしない）。
- スクリーンショットは **viewport のみ**（`captureBeyondViewport: false`）。全ページ撮影はしない。
- `sessionStorage` はタブ単位。保存→復元テストは同一ページ（同一タブ）のリロードで行う。
- 外部 CDN（`cdn.tailwindcss.com` / `unpkg.com/peerjs`）に依存。オフラインでは
  レイアウト/見た目が変わり、network resource error が記録される（JS エラーにはしない）。
  オンライン対戦の PeerJS 接続そのものはこのハーネスではテストしない。
- AI は MCTS + Worker 並列 + 時間予算のため着手は非決定的。**合法手であること**を検証し、
  具体的な手は `observations` に記録する（スナップショットには入れない）。
- レイアウトの CSS ピクセル値はフォント・Chrome バージョンに依存する。ベースラインは
  同じ Chrome で比較すること（`meta.chrome` を参照）。
- 検出できるのは「JS 例外」「console.error」「リソース読込失敗」まで。見た目の画素差分は
  比較しない（スクショは目視確認用）。

## トラブルシューティング

- **Chrome が起動しない**:
  ```bash
  /home/sasnews/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell \
    --headless --no-sandbox --dump-dom about:blank
  ```
  が動くか確認。エラー時は `regress.js` が Chrome の stderr 末尾を表示します。
- **`window.__hexagoDebug` が出ない**: ページの JS が 404/構文エローで止まっている可能性。
  `--url` で配信元を確認し、ブラウザ側の console/exception ログ（出力 JSON の `logs`）を見る。
- **`--compare` が落ちる**: 表示された `DIFF <path>` の baseline / current を比較。
  意図した変更なら `baseline.json` を再生成する。
- **`.tmp/` が残る**: プロファイルは終了時に消えますが、強制 kill 時などに残った場合は
  2時間後に自動掃除されます。手動削除も安全です。
