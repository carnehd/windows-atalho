// Grafana login through a browser window, the way a log-explorer.exe does it with Edge:
//  - interactive login: a small window opens <grafana>/login/generic_oauth (straight to Keycloak); the login is
//    done when the window is back on Grafana outside /login and /api/user answers;
//  - background renewal: the same in a hidden window, for a few seconds, which works while the Keycloak
//    session is still valid;
//  - requests: made with fetch() inside a hidden page on the Grafana site, so the session cookies and Grafana's
//    own checks work as in the browser;
//  - the cookies (Grafana and Keycloak) are saved in data/grafana-session.json and put back at the next start,
//    so closing the app does not ask for a new login. That file holds the session: do not share it.
// It runs in the main process and uses its own Electron session, apart from the app's pages.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:grafana-login';
const LOGIN_PATHS = ['/login/generic_oauth', '/login'];

class GrafanaLoginNeeded extends Error {
  constructor(message = 'You are not logged in to Grafana, or the session expired. Press "Log in to Grafana".') {
    super(message);
    this.code = 'GRAFANA_LOGIN';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const originOf = (base) => new URL(base).origin;
const isBackOnGrafana = (url, base) => {
  try {
    const u = new URL(url);
    return u.origin === originOf(base) && !u.pathname.startsWith('/login');
  } catch {
    return false;
  }
};

function createGrafanaBrowser({ dataDir, onStatus = () => {} }) {
  const cookieFile = path.join(dataDir, 'grafana-session.json');
  let ses = null;
  let apiWin = null; // hidden page on the Grafana site, where the requests run
  let apiBase = null;
  let apiReady = null; // the load of that page, shared by the requests that arrive while it loads
  let restoring = null;
  let loggingIn = null; // { promise, interactive }
  let restored = false;
  let lastSave = 0;
  let renewFailedAt = 0; // after a failed background renewal, wait before the next one (watches check often)
  const RENEW_PAUSE_MS = 5 * 60e3;

  function getSession() {
    if (!ses) {
      ses = session.fromPartition(PARTITION);
      // the login pages get nothing beyond showing themselves: no camera, notifications, etc.
      ses.setPermissionRequestHandler((wc, permission, cb) => cb(false));
    }
    return ses;
  }

  function secureWindow(win) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      // a link that opens a new window (some login pages do that) stays in the same window
      if (/^https?:/i.test(url)) win.loadURL(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault();
    });
  }

  function newWindow(show) {
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      show,
      title: 'Grafana login · Git Quick',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    secureWindow(win);
    // keep the app's title, so it is clear the window belongs to Git Quick
    win.on('page-title-updated', (e) => e.preventDefault());
    return win;
  }

  async function saveCookies() {
    try {
      const now = Date.now() / 1000;
      const cookies = (await getSession().cookies.get({})).filter((c) => c.session || !c.expirationDate || c.expirationDate > now);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${cookieFile}.tmp`, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1));
      fs.renameSync(`${cookieFile}.tmp`, cookieFile);
      lastSave = Date.now();
    } catch {
      // the session still works for now; it is saved again on the next request
    }
  }

  // Session cookies are not kept by Electron between runs, so they come back from the file (as the log-explorer does).
  // Once, and every request waits for it.
  function restoreCookies() {
    if (!restoring) restoring = doRestoreCookies();
    return restoring;
  }

  async function doRestoreCookies() {
    if (restored) return;
    restored = true;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(cookieFile, 'utf8')).cookies || [];
    } catch {
      return;
    }
    const now = Date.now() / 1000;
    for (const c of saved) {
      if (!c.session && c.expirationDate && c.expirationDate <= now) continue;
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      try {
        await getSession().cookies.set({
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          ...(c.domain && c.domain.startsWith('.') && { domain: c.domain }),
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          ...(c.sameSite && c.sameSite !== 'unspecified' && { sameSite: c.sameSite }),
          ...(!c.session && c.expirationDate && { expirationDate: c.expirationDate }),
        });
      } catch {
        // a cookie the session does not take back is skipped
      }
    }
  }

  function closeApiWindow() {
    if (apiWin && !apiWin.isDestroyed()) apiWin.destroy();
    apiWin = null;
    apiBase = null;
    apiReady = null;
  }

  const onGrafana = (win, base) => {
    try {
      return new URL(win.webContents.getURL()).origin === originOf(base);
    } catch {
      return false;
    }
  };

  // The hidden page the requests run in: /api/health is public and on the Grafana site. Requests that arrive
  // while it loads wait for the same load (two loads at once would close each other's page).
  async function apiWindow(base) {
    await restoreCookies();
    if (apiReady && apiBase === base) {
      const win = await apiReady.catch(() => null);
      if (win && !win.isDestroyed() && onGrafana(win, base)) return win;
      if (apiReady && apiBase === base && apiWin === win) closeApiWindow(); // a failed or moved page is opened again
    }
    if (apiReady && apiBase === base) return apiReady; // another request already opened it again
    closeApiWindow();
    const win = newWindow(false);
    apiWin = win;
    apiBase = base;
    apiReady = (async () => {
      try {
        await win.loadURL(`${base}/api/health`);
      } catch (e) {
        const msg = String(e.message || e);
        if (/ERR_NAME_NOT_RESOLVED/.test(msg)) throw new Error('Grafana: the host name does not resolve (VPN on?)');
        if (/ERR_CONNECTION_REFUSED/.test(msg)) throw new Error('Grafana: connection refused (service down or wrong port?)');
        if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(msg)) throw new Error('Grafana: no answer in time (VPN on? right address?)');
        throw new Error(`Grafana: ${msg.slice(0, 200)}`);
      }
      // an authentication proxy in front of Grafana sends the page elsewhere: that is a login to do
      if (!onGrafana(win, base)) throw new GrafanaLoginNeeded();
      return win;
    })();
    apiReady.catch(() => {
      if (apiWin === win) closeApiWindow();
    });
    return apiReady;
  }

  // fetch() inside the Grafana page; resolves to { status, url, text, contentType }.
  async function pageFetch(base, url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
    const win = await apiWindow(base);
    const code = `(async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ${Number(timeoutMs) || 15000});
      try {
        const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)}, ${body != null ? `body: ${JSON.stringify(body)},` : ''} credentials: 'include', signal: ctl.signal });
        return { status: r.status, url: r.url, text: await r.text(), contentType: r.headers.get('content-type') || '' };
      } catch (e) {
        return { error: e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
      } finally {
        clearTimeout(timer);
      }
    })()`;
    const r = await win.webContents.executeJavaScript(code, true);
    if (r.error === 'timeout') throw new Error('Grafana: no answer in time (VPN on? right address?)');
    // a request sent off the Grafana site (an authentication proxy redirecting to its login) fails like this
    if (/Failed to fetch/i.test(r.error || '')) throw new GrafanaLoginNeeded();
    if (r.error) throw new Error(`Grafana: ${r.error}`);
    if (Date.now() - lastSave > 10000) saveCookies();
    return r;
  }

  async function whoami(base) {
    const r = await pageFetch(base, `${base}/api/user`, { timeoutMs: 10000 });
    let path = '';
    try { path = new URL(r.url).pathname; } catch { /* keep empty */ }
    if (r.status === 401 || r.status === 403 || path.startsWith('/login') || !/json/i.test(r.contentType)) throw new GrafanaLoginNeeded();
    if (r.status >= 400) throw new Error(`Grafana /api/user answered ${r.status}`);
    const u = JSON.parse(r.text);
    return { login: u.login, name: u.name, email: u.email };
  }

  // interactive: a window to log in (5 minutes); otherwise a hidden window that only works with a live SSO session.
  async function login(base, { interactive = true } = {}) {
    if (loggingIn) {
      if (loggingIn.interactive || !interactive) return loggingIn.promise;
      await loggingIn.promise.catch(() => {}); // a background renewal first, then the window
      if (loggingIn) return loggingIn.promise;
    }
    const promise = doLogin(base, interactive).then((user) => {
      renewFailedAt = 0;
      return user;
    }).finally(() => { loggingIn = null; });
    loggingIn = { promise, interactive };
    return promise;
  }

  async function doLogin(base, interactive) {
    await restoreCookies();
    onStatus(interactive ? 'opening the login window' : 'trying to renew the session in the background');
    const win = newWindow(interactive);
    let closed = false;
    win.on('closed', () => { closed = true; });
    const deadline = Date.now() + (interactive ? 300000 : 12000);
    try {
      // Grafana with Keycloak (generic OAuth) goes straight to the Keycloak page; plain Grafana has /login only.
      let loaded = false;
      for (const p of LOGIN_PATHS) {
        const status = await new Promise((resolve) => {
          const done = (code) => { win.webContents.removeListener('did-navigate', onNav); resolve(code); };
          const onNav = (e, url, code) => done(code || 200);
          win.webContents.on('did-navigate', onNav);
          win.loadURL(`${base}${p}`).catch((e) => done(String(e.message || e)));
        });
        if (typeof status === 'number' && status < 400) { loaded = true; break; }
        if (typeof status === 'string' && !/ERR_ABORTED/.test(status)) throw new Error(`Grafana: ${status.slice(0, 200)}`);
        if (typeof status === 'string') { loaded = true; break; } // aborted by a redirect: the login page is on its way
      }
      if (!loaded) throw new Error('Grafana has no login page at /login/generic_oauth or /login.');
      if (interactive) win.focus();
      while (Date.now() < deadline) {
        if (closed) throw new GrafanaLoginNeeded('The login window was closed before the login ended.');
        if (isBackOnGrafana(win.webContents.getURL(), base) && !win.webContents.isLoading()) {
          try {
            // the hidden page shares this session, so its next requests already carry the new cookies
            const user = await whoami(base);
            await saveCookies();
            onStatus(`logged in as ${user.login}`);
            return user;
          } catch (e) {
            if (e.code !== 'GRAFANA_LOGIN') throw e;
          }
        }
        await sleep(500);
      }
      throw new GrafanaLoginNeeded(interactive ? 'The login took too long; try again.' : 'The SSO session expired: an interactive login is needed.');
    } finally {
      if (!closed && !win.isDestroyed()) win.destroy();
    }
  }

  // Like the log-explorer: a request that finds no session first tries a background renewal, then asks for a login.
  async function request(base, url, options) {
    let r = await pageFetch(base, url, options).catch(async (e) => {
      if (e.code !== 'GRAFANA_LOGIN') throw e;
      return null;
    });
    const needsLogin = (x) => !x || x.status === 401 || (() => { try { return new URL(x.url).pathname.startsWith('/login'); } catch { return false; } })();
    if (needsLogin(r)) {
      if (Date.now() - renewFailedAt < RENEW_PAUSE_MS) throw new GrafanaLoginNeeded();
      try {
        await login(base, { interactive: false });
      } catch {
        renewFailedAt = Date.now();
        throw new GrafanaLoginNeeded();
      }
      r = await pageFetch(base, url, options);
      if (needsLogin(r)) throw new GrafanaLoginNeeded();
    }
    return r;
  }

  async function status(base) {
    try {
      return { loggedIn: true, user: await whoami(base) };
    } catch (e) {
      if (e.code === 'GRAFANA_LOGIN') return { loggedIn: false };
      return { loggedIn: false, error: e.message };
    }
  }

  async function logout() {
    closeApiWindow();
    await getSession().clearStorageData();
    fs.rmSync(cookieFile, { force: true });
    onStatus('logged out');
    return { success: true };
  }

  function close() {
    closeApiWindow();
  }

  return { request, login, logout, status, whoami, close, cookieFile };
}

module.exports = { createGrafanaBrowser, GrafanaLoginNeeded };
