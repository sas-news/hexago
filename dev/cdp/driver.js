#!/usr/bin/env node
'use strict';
/**
 * dev/cdp/driver.js — 依存ゼロの Chrome DevTools Protocol ドライバ（ライブラリ）
 *
 * Playwright / puppeteer / npm パッケージを一切使わず、Node 標準の
 *   - child_process（chrome-headless-shell 起動）
 *   - 組込み WebSocket（Node >= 22 のグローバル WebSocket）
 *   - fs / path
 * だけで動く最小限の CDP クライアント。
 *
 * 使い方:
 *   const { Browser } = require('./driver');
 *   const browser = await Browser.launch();                // chrome-headless-shell を起動
 *   const page = await browser.newPage({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } });
 *   await page.goto('http://127.0.0.1:8000/index.html');
 *   await page.waitForFunction('window.__hexagoDebug');
 *   const state = await page.evaluate(() => window.__hexagoDebug.state());
 *   await page.screenshot('shot.png');
 *   await browser.close();
 *
 * 設計メモ:
 *  - ポートは 0 固定で起動し、Chrome が user-data-dir/DevToolsActivePort に書く
 *    実ポート＋browser WebSocket パスを読む（固定ポート衝突を避ける）。
 *  - ページは Target.createTarget → Target.attachToTarget(flatten:true) で
 *    "フラットセッション" として操作する。CDP メッセージに sessionId を付けるだけ。
 *  - ヘッドレスシェルなのでウィンドウサイズ指定は効かない。ビューポートは
 *    Emulation.setDeviceMetricsOverride で再現する。
 *  - 依存ゼロ。外部パッケージを追加しないこと。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const DEFAULT_CHROME =
  '/home/sasnews/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const TMP_ROOT = path.join(__dirname, '.tmp');
const DEFAULT_TIMEOUT = 30000;

/* ========================================================================== */
/* エラー                                                                     */
/* ========================================================================== */

class CDPError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'CDPError';
    if (extra) Object.assign(this, extra);
  }
}

/* ========================================================================== */
/* Chrome 実行ファイルの探索                                                   */
/* ========================================================================== */

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** chrome-headless-shell / Chrome の実パスを返す。見つからなければ例外。 */
function findChrome() {
  const candidates = [];
  if (process.env.HEXAGO_CHROME) candidates.push(process.env.HEXAGO_CHROME);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  candidates.push(DEFAULT_CHROME);
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  );
  // PATH 上の名前も一応探す
  for (const name of ['chrome-headless-shell', 'google-chrome', 'chromium', 'chromium-browser']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, name));
    }
  }
  for (const c of candidates) {
    if (c && isExecutable(c)) return c;
  }
  throw new CDPError(
    'Chrome / chrome-headless-shell が見つかりません。HEXAGO_CHROME 環境変数で実行ファイルを指定してください。\n' +
      '  既定の探索先: ' +
      DEFAULT_CHROME
  );
}

function chromeVersion(chromePath) {
  try {
    const r = spawnSync(chromePath, ['--version'], { encoding: 'utf8', timeout: 10000 });
    return (r.stdout || r.stderr || '').trim() || '(unknown)';
  } catch (e) {
    return '(unknown)';
  }
}

/* ========================================================================== */
/* CDP 接続（WebSocket 1本 = browser セッション）                              */
/* ========================================================================== */

class Connection {
  constructor(ws, url) {
    this.ws = ws;
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(
            new CDPError(`${entry.method} failed: ${msg.error.message || 'unknown CDP error'}`, {
              method: entry.method,
              code: msg.error.code,
              data: msg.error.data,
            })
          );
        } else {
          entry.resolve(msg.result);
        }
        return;
      }
      if (msg.method) this._emit(msg);
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      const err = new CDPError('CDP connection closed');
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
      this._emit({ method: '__closed' });
    });

    ws.addEventListener('error', () => {
      // close イベントで後始末するのでここでは握る
    });
  }

  static open(url, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new CDPError(`CDP WebSocket を作れません: ${url} (${err.message})`));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (e) {}
        reject(new CDPError(`CDP WebSocket 接続がタイムアウトしました: ${url}`));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new Connection(ws, url));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new CDPError(`CDP WebSocket 接続に失敗しました: ${url}`));
        },
        { once: true }
      );
    });
  }

  _emit(msg) {
    for (const fn of [...this.listeners]) {
      try {
        fn(msg);
      } catch (e) {
        /* リスナの例外は無視 */
      }
    }
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(method, params = {}, sessionId = undefined, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (this.closed) return Promise.reject(new CDPError(`CDP 接続は閉じています (${method})`));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CDPError(`CDP コマンドがタイムアウトしました (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CDPError(`CDP 送信に失敗しました (${method}): ${err.message}`));
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

/* ========================================================================== */
/* リモートオブジェクト / 例外の整形                                          */
/* ========================================================================== */

function formatRemoteObject(o) {
  if (!o) return '';
  if ('value' in o) {
    if (typeof o.value === 'string') return o.value;
    try {
      return JSON.stringify(o.value);
    } catch (e) {
      return String(o.value);
    }
  }
  if (o.unserializableValue) return o.unserializableValue;
  if (o.description) return o.description;
  if (o.preview) {
    const parts = (o.preview.properties || []).map((p) => `${p.name}: ${p.value}`);
    return `${o.preview.description || o.type}{${parts.join(', ')}}`;
  }
  return o.type || '';
}

function formatExceptionDetails(details) {
  if (!details) return 'unknown exception';
  const ex = details.exception;
  const text = (ex && (ex.description || ex.value)) || details.text || 'unknown exception';
  const loc = details.url ? ` (${details.url}:${(details.lineNumber || 0) + 1}:${(details.columnNumber || 0) + 1})` : '';
  return String(text) + loc;
}

/* ========================================================================== */
/* Browser                                                                    */
/* ========================================================================== */

class Browser {
  /**
   * @param {object} opts
   * @param {string} [opts.chromePath]  実行ファイルパス
   * @param {string} [opts.userDataDir] プロファイル置き場（省略時 dev/cdp/.tmp 以下に自動生成）
   * @param {boolean} [opts.keepProfile] 終了時にプロファイルを消さない
   * @param {string[]} [opts.args]       追加の Chrome 引数
   * @param {number} [opts.launchTimeoutMs=20000]
   * @param {number} [opts.timeoutMs=30000] 既定の CDP コマンドタイムアウト
   */
  static async launch(opts = {}) {
    const {
      chromePath = findChrome(),
      userDataDir,
      keepProfile = false,
      args = [],
      launchTimeoutMs = 20000,
      timeoutMs = DEFAULT_TIMEOUT,
    } = opts;

    cleanupStaleProfiles();

    const profile = userDataDir || path.join(TMP_ROOT, `chrome-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(profile, { recursive: true });

    const chromeArgs = [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--disable-sync',
      '--disable-background-networking',
      '--mute-audio',
      '--hide-scrollbars',
      '--window-size=1280,800',
      ...args,
      'about:blank',
    ];

    const proc = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrLines = [];
    const remember = (chunk) => {
      const text = String(chunk);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (stderrLines.length > 200) stderrLines.shift();
      }
    };
    proc.stderr.on('data', remember);
    proc.stdout.on('data', remember);

    let exited = false;
    let exitInfo = null;
    proc.once('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
    });

    const portFile = path.join(profile, 'DevToolsActivePort');
    const started = Date.now();
    let portInfo = null;
    while (Date.now() - started < launchTimeoutMs) {
      if (exited) break;
      try {
        const raw = fs.readFileSync(portFile, 'utf8').trim();
        if (raw) {
          const [portLine, wsPath] = raw.split('\n');
          portInfo = { port: Number(portLine), wsPath: (wsPath || '').trim() };
          if (portInfo.port && portInfo.wsPath) break;
        }
      } catch (e) {
        /* まだ書かれていない */
      }
      await sleep(50);
    }

    if (!portInfo) {
      try {
        proc.kill('SIGKILL');
      } catch (e) {}
      if (!keepProfile) await rmrf(profile);
      const detail = stderrLines.slice(-12).join('\n');
      throw new CDPError(
        `chrome-headless-shell を起動できませんでした` +
          (exitInfo ? ` (exit=${exitInfo.code} signal=${exitInfo.signal})` : ' (DevToolsActivePort が出ません)') +
          (detail ? '\n--- chrome stderr (tail) ---\n' + detail : '')
      );
    }

    const wsUrl = `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath}`;
    let conn;
    try {
      conn = await Connection.open(wsUrl, { timeoutMs: launchTimeoutMs });
    } catch (err) {
      try {
        proc.kill('SIGKILL');
      } catch (e) {}
      if (!keepProfile) await rmrf(profile);
      throw new CDPError(
        `CDP WebSocket に接続できませんでした: ${wsUrl}\n` + err.message +
          (stderrLines.length ? '\n--- chrome stderr (tail) ---\n' + stderrLines.slice(-8).join('\n') : '')
      );
    }

    const browser = new Browser({
      proc,
      conn,
      chromePath,
      userDataDir: profile,
      keepProfile,
      port: portInfo.port,
      wsUrl,
      timeoutMs,
    });
    browser.stderr = () => stderrLines.slice(-40).join('\n');
    browser.version = chromeVersion(chromePath);
    return browser;
  }

  constructor({ proc, conn, chromePath, userDataDir, keepProfile, port, wsUrl, timeoutMs }) {
    this.proc = proc;
    this.conn = conn;
    this.chromePath = chromePath;
    this.userDataDir = userDataDir;
    this.keepProfile = keepProfile;
    this.port = port;
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.pages = new Set();
    this._closed = false;
    this.version = '(unknown)';
  }

  /** 新しいページ（タブ）を開いて CDP セッションを張る。 */
  async newPage(opts = {}) {
    const { viewport, timeoutMs = this.timeoutMs } = opts;
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' }, undefined, { timeoutMs });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true }, undefined, { timeoutMs });
    const page = new Page(this, targetId, sessionId, { timeoutMs });
    await page._init();
    if (viewport) await page.setViewport(viewport);
    this.pages.add(page);
    return page;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const page of this.pages) {
      try {
        page._closed = true;
      } catch (e) {}
    }
    this.pages.clear();
    if (!this.proc || this.proc.exitCode !== null) {
      try {
        this.conn.close();
      } catch (e) {}
      if (!this.keepProfile) await rmrf(this.userDataDir);
      return;
    }
    try {
      await this.conn.send('Browser.close', {}, undefined, { timeoutMs: 3000 });
    } catch (e) {
      /* ws が先に閉じるのが正常 */
    }
    await new Promise((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      const timer = setTimeout(async () => {
        try {
          this.proc.kill('SIGKILL');
        } catch (e) {}
        resolve();
      }, 5000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      this.conn.close();
    } catch (e) {}
    if (!this.keepProfile) await rmrf(this.userDataDir);
  }
}

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

class Page {
  constructor(browser, targetId, sessionId, { timeoutMs }) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
    this.viewport = null;
    this._closed = false;
    this._waiters = new Set();
    this.logs = {
      console: [], // {type, text, at}
      consoleErrors: [],
      consoleWarnings: [],
      exceptions: [], // {text, url, line, column, stack}
      logEntries: [], // Log.entryAdded
      resourceErrors: [], // Log.entryAdded source=network level=error
    };
    this._unsubscribe = null;
  }

  async _init() {
    this._unsubscribe = this.browser.conn.onEvent((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      this._onEvent(msg);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    try {
      await this.send('Log.enable');
    } catch (e) {
      /* 古い Chrome では無いこともある */
    }
    // JS ダイアログで固まらないように自動で閉じる（E2E 用）
    this.on('Page.javascriptDialogOpening', () => {
      this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });
  }

  send(method, params = {}, opts = {}) {
    return this.browser.conn.send(method, params, this.sessionId, { timeoutMs: this.timeoutMs, ...opts });
  }

  _onEvent(msg) {
    const { method, params } = msg;
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map(formatRemoteObject).join(' ');
      const entry = {
        type: params.type,
        text,
        at: new Date().toISOString(),
      };
      this.logs.console.push(entry);
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      const ex = d.exception || {};
      const entry = {
        text: formatExceptionDetails(d),
        url: d.url || '',
        line: (d.lineNumber || 0) + 1,
        column: (d.columnNumber || 0) + 1,
        stack: (ex && ex.preview && ex.preview.description) || '',
        at: new Date().toISOString(),
      };
      this.logs.exceptions.push(entry);
    } else if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      const entry = {
        level: e.level,
        source: e.source,
        text: e.text,
        url: e.url || '',
        line: e.lineNumber,
        at: new Date().toISOString(),
      };
      this.logs.logEntries.push(entry);
      if (e.level === 'error' && e.source === 'network') this.logs.resourceErrors.push(entry);
    } else if (method === 'Runtime.exceptionRevoked') {
      /* ignore */
    }
    // 待っているイベントを解決
    for (const waiter of [...this._waiters]) {
      if (waiter.name === method) {
        this._waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(params);
      }
    }
  }

  /* ---- イベント待ち ------------------------------------------------------ */

  on(name, fn) {
    return this.browser.conn.onEvent((msg) => {
      if (msg.sessionId === this.sessionId && msg.method === name) fn(msg.params, msg);
    });
  }

  waitForEvent(name, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        name,
        resolve: (params) => {
          this._waiters.delete(waiter);
          resolve(params);
        },
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this._waiters.delete(waiter);
        reject(new CDPError(`イベント待ちタイムアウト (${timeoutMs}ms): ${name}`));
      }, timeoutMs);
      this._waiters.add(waiter);
    });
  }

  /* ---- ナビゲーション ---------------------------------------------------- */

  async goto(url, { timeoutMs = this.timeoutMs } = {}) {
    const load = this.waitForEvent('Page.loadEventFired', { timeoutMs });
    const nav = await this.send('Page.navigate', { url }, { timeoutMs: Math.min(timeoutMs, 15000) });
    if (nav && nav.errorText) {
      this._waiters.clear();
      throw new CDPError(`ページ遷移に失敗しました (${nav.errorText}): ${url}`);
    }
    try {
      await load;
    } catch (e) {
      // load イベントが来なくても readyState で判定する
    }
    await this.waitForFunction('document.readyState === "complete"', {
      timeoutMs: Math.min(timeoutMs, 10000),
      label: 'document.readyState === "complete"',
    });
  }

  async reload({ timeoutMs = this.timeoutMs } = {}) {
    const load = this.waitForEvent('Page.loadEventFired', { timeoutMs });
    await this.send('Page.reload', { ignoreCache: true }, { timeoutMs: Math.min(timeoutMs, 15000) });
    try {
      await load;
    } catch (e) {
      /* fallback below */
    }
    await this.waitForFunction('document.readyState === "complete"', {
      timeoutMs: Math.min(timeoutMs, 10000),
      label: 'document.readyState === "complete"',
    });
  }

  /**
   * 式を評価する。関数を渡した場合は引数と一緒にシリアライズして実行する
   * （クロージャは使えない。引数は JSON 化できるものだけ）。
   */
  async evaluate(fnOrExpression, ...args) {
    if (this._closed) throw new CDPError('ページは閉じています');
    let expression;
    if (typeof fnOrExpression === 'function') {
      const serialized = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ');
      expression = `(${fnOrExpression.toString()})(${serialized})`;
    } else {
      if (args.length) throw new CDPError('文字列式に引数は渡せません（関数を渡してください）');
      expression = String(fnOrExpression);
    }
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: false,
    });
    if (res.exceptionDetails) {
      throw new CDPError(`ページ内で例外が発生しました: ${formatExceptionDetails(res.exceptionDetails)}`, {
        exceptionDetails: res.exceptionDetails,
      });
    }
    const r = res.result || {};
    if (r.type === 'undefined') return undefined;
    return r.value;
  }

  /** JS 式が truthy になるまでポーリング。式は毎回文字列として評価する。 */
  async waitForFunction(expression, { timeoutMs = this.timeoutMs, pollMs = 100, label } = {}) {
    const started = Date.now();
    const src = `!!(${expression})`;
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(src)) return true;
      } catch (err) {
        // 遷移中は execution context が消えることがある。ポーリング継続。
        lastError = err;
      }
      await sleep(pollMs);
    }
    throw new CDPError(
      `条件が満たされませんでした (${timeoutMs}ms): ${label || expression}` + (lastError ? `\n  最後のエラー: ${lastError.message}` : '')
    );
  }

  /* ---- ビューポート / 画面 ------------------------------------------------- */

  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false,
    });
    try {
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: 5 });
    } catch (e) {
      /* 未対応でも続行 */
    }
    this.viewport = { width, height, deviceScaleFactor, mobile };
    // リサイズイベントと再描画を待つ
    await this.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)))));
    return this.viewport;
  }

  /** viewport（未指定なら現在のビューポート）の PNG を保存。 */
  async screenshot(filePath, { format = 'png' } = {}) {
    const res = await this.send('Page.captureScreenshot', {
      format,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fsp.writeFile(filePath, Buffer.from(res.data, 'base64'));
    return filePath;
  }

  /* ---- 後始末 ------------------------------------------------------------ */

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._unsubscribe) this._unsubscribe();
    for (const waiter of this._waiters) clearTimeout(waiter.timer);
    this._waiters.clear();
    try {
      await this.browser.conn.send('Target.closeTarget', { targetId: this.targetId }, undefined, { timeoutMs: 3000 });
    } catch (e) {}
    this.browser.pages.delete(this);
  }
}

/* ========================================================================== */
/* ユーティリティ                                                             */
/* ========================================================================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rmrf(dir) {
  if (!dir) return;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (e) {}
}

/** クラッシュ等で残った古いプロファイルを掃除する（2時間より古いもの）。 */
function cleanupStaleProfiles() {
  try {
    if (!fs.existsSync(TMP_ROOT)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(TMP_ROOT)) {
      if (!name.startsWith('chrome-')) continue;
      const p = path.join(TMP_ROOT, name);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > 2 * 60 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = {
  Browser,
  Page,
  Connection,
  CDPError,
  findChrome,
  chromeVersion,
  sleep,
  DEFAULT_CHROME,
  DEFAULT_TIMEOUT,
};
