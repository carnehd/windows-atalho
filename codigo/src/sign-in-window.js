// "Open and sign in" from the Vault: the item's page in a browser window of the app, with the item's username and
// password put in the login form when one shows up (also one that comes later, or a second step for the password).
//  - only on the item's own site: a page on another site gets nothing, and the window title says so;
//  - only into empty fields, once per page, and nothing is submitted: the user presses the button;
//  - one window per site: clicking again, or another item of a site that is already open, brings that window to
//    the front as it is (a popup a page opens counts as one of these windows too);
//  - the filling runs in an isolated world, so the page's scripts do not see it happen (they get the values when the
//    form is sent, as with typing).
// The windows share one session of their own (cookies kept), apart from the app and from the Grafana login.
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:vault-sign-in';
const WORLD = 1077;
const TRY_EVERY_MS = 500;
const TRY_FOR_MS = 60000;

// Hosts under these belong to many different owners, so only the exact host counts there.
const SHARED_HOSTS = [
  'github.io', 'gitlab.io', 'herokuapp.com', 'azurewebsites.net', 'cloudapp.net', 'cloudfront.net', 'amazonaws.com',
  'appspot.com', 'run.app', 'web.app', 'firebaseapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'onrender.com', 'ngrok.io', 'ngrok-free.app', 'blogspot.com', 'azurestaticapps.net', 'trycloudflare.com',
];
const SECOND_LEVEL = /^(com|net|org|gov|edu|ac|co|mil|nom|gob|ltd|plc)$/;

// The part of a host name a site owns: example.com for sso.example.com, example.com.pt for www.example.com.pt. An address
// or a one-word name (localhost) is only itself.
function siteOf(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h)) return h;
  if (SHARED_HOSTS.some((s) => h === s || h.endsWith(`.${s}`))) return h;
  const parts = h.split('.');
  return parts.slice(parts.length >= 3 && SECOND_LEVEL.test(parts[parts.length - 2]) ? -3 : -2).join('.');
}

// Whether a page may get the login saved for an address: the same site, over https (or http when the saved address
// itself is http).
function sameSite(pageUrl, savedUrl) {
  let page;
  let saved;
  try {
    page = new URL(pageUrl);
    saved = new URL(savedUrl);
  } catch {
    return false;
  }
  if (page.protocol !== 'https:' && !(page.protocol === 'http:' && saved.protocol === 'http:')) return false;
  return page.hostname === saved.hostname || siteOf(page.hostname) === siteOf(saved.hostname);
}

// Runs in the page (isolated world). Finds the login form: one password field (two or more is a form to set a new
// password, left alone) and the username field before it, or, with no password field yet, the one username field of
// a first step. With values it fills the empty ones; without, it only says what it found.
function pageScript(values) {
  return `(() => {
  const values = ${JSON.stringify(values || null)};
  const filled = (window.__gitQuickFilled = window.__gitQuickFilled || new WeakSet());
  const shown = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const inputs = [...document.querySelectorAll('input')].filter(shown);
  const textLike = (el) => ['text', 'email', 'tel'].includes(el.type);
  const named = (el, re) => re.test([el.autocomplete, el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' '));
  const passwords = inputs.filter((el) => el.type === 'password' && el.autocomplete !== 'new-password');
  let user = null;
  let pass = null;
  if (passwords.length === 1) {
    pass = passwords[0];
    const before = inputs.filter((el) => textLike(el) && (!pass.form || el.form === pass.form)
      && (el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING));
    user = before.find((el) => named(el, /username|email/i)) || before[before.length - 1] || null;
  } else if (passwords.length === 0) {
    const users = inputs.filter((el) => textLike(el) && (el.type === 'email' || named(el, /user|login|e-?mail|account|ident|utilizador/i)));
    if (users.length === 1) user = users[0];
  }
  const found = { user: Boolean(user), pass: Boolean(pass) };
  if (!values) return { found, filled: { user: false, pass: false } };
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const put = (el, value) => {
    if (!el || !value || filled.has(el) || el.value) return false;
    el.focus();
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    filled.add(el);
    return true;
  };
  const result = { found, filled: { user: put(user, values.username), pass: put(pass, values.password) } };
  if (result.filled.pass) pass.focus();
  return result;
})()`;
}

function registerSignInWindows({ stepBack }) {
  // every sign-in window, with the item whose login it fills; a window a page opened (a popup) is one too
  const entries = new Set();
  let ses = null;

  function getSession() {
    if (!ses) {
      ses = session.fromPartition(PARTITION);
      // the pages get nothing beyond showing themselves: no camera, notifications, location, etc.
      ses.setPermissionRequestHandler((wc, permission, cb) => cb(false));
    }
    return ses;
  }

  // The window for an item: the one opened for it, else one already on its site (it is used for this item from now
  // on, as it is, without loading the page again).
  function windowFor(id, url) {
    const live = [...entries].filter((e) => !e.win.isDestroyed());
    return live.find((e) => e.itemId === id) || live.find((e) => sameSite(e.win.webContents.getURL(), url));
  }

  function open(id, login) {
    const host = new URL(login.url).host;
    const entry = windowFor(id, login.url);
    if (entry) {
      entry.itemId = id;
      entry.login = login;
      stepBack();
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.show();
      entry.win.focus();
      entry.lookAgain();
      return { success: true, host, again: true };
    }
    getSession();
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      show: false,
      autoHideMenuBar: true,
      title: `${login.title || host} · Git Quick`,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    manage(win, id, login);
    win.once('ready-to-show', () => {
      stepBack();
      win.show();
      win.focus();
    });
    win.loadURL(login.url).catch(() => {
      // the title says why; the window still opens
      if (win.isDestroyed() || win.isVisible()) return;
      stepBack();
      win.show();
    });
    return { success: true, host };
  }

  // Looks for the login form after every page change, keeps the title telling where the page is, and keeps the
  // window a plain browser window (web pages only, the usual keys).
  function manage(win, itemId, login) {
    const entry = { win, itemId, login, lookAgain: () => {} };
    entries.add(entry);
    const wc = win.webContents;
    let timer = null;
    let note = '';

    // There is no address bar, so the title says where the page is (and what was filled there).
    const showTitle = () => {
      if (win.isDestroyed()) return;
      let host = '';
      try {
        host = new URL(wc.getURL()).host;
      } catch {
        // not loaded yet
      }
      const page = wc.getTitle();
      win.setTitle([host || entry.login.title, page && page !== wc.getURL() ? page : '', note].filter(Boolean).join(' · '));
    };

    const stop = () => {
      clearInterval(timer);
      timer = null;
    };

    // One look at the page: fill on the item's site, only look elsewhere (to say why nothing was filled).
    const attempt = async () => {
      if (win.isDestroyed()) return stop();
      const { login: current } = entry;
      const here = sameSite(wc.getURL(), current.url);
      let r;
      try {
        r = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: pageScript(here ? current : null) }]);
      } catch {
        return undefined; // the page is changing; the next look tries again
      }
      if (!r || win.isDestroyed()) return undefined;
      if (!here) {
        const before = note;
        note = r.found.pass || r.found.user ? 'another site: nothing filled' : '';
        if (note !== before) showTitle();
        return undefined;
      }
      if (r.filled.user || r.filled.pass) {
        const both = r.filled.user && r.filled.pass;
        note = both ? 'username and password filled' : r.filled.pass ? 'password filled' : 'username filled';
        showTitle();
      }
      // done on this page once the password is in (or the username, for an item without a password)
      if (r.filled.pass || (r.filled.user && !current.password)) stop();
      return undefined;
    };

    // After every page change, look for a while: login forms often show up after the page has loaded.
    const startLooking = () => {
      stop();
      note = '';
      showTitle();
      const until = Date.now() + TRY_FOR_MS;
      timer = setInterval(() => {
        if (Date.now() > until) stop();
        else attempt();
      }, TRY_EVERY_MS);
      attempt();
    };
    entry.lookAgain = startLooking;

    wc.on('did-navigate', startLooking);
    wc.on('did-navigate-in-page', (e, url, isMainFrame) => {
      if (isMainFrame) startLooking();
    });
    wc.on('did-finish-load', () => {
      if (!timer) startLooking();
    });
    wc.on('did-fail-load', (e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: stopped for a redirect or another page
      note = `the page did not load (${description})`;
      showTitle();
    });
    win.on('page-title-updated', (e) => {
      e.preventDefault();
      showTitle();
    });

    // links that open a new window stay in this session (and get the same login); nothing but web pages
    wc.setWindowOpenHandler(({ url }) => (/^https?:/i.test(url)
      ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
      : { action: 'deny' }));
    wc.on('did-create-window', (child) => manage(child, null, entry.login));
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault();
    });
    // the usual browser keys: reload, back, forward
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if (input.key === 'F5' || (mod && key === 'r')) wc.reload();
      else if ((input.alt && input.key === 'ArrowLeft') || (mod && input.key === '[')) {
        if (wc.canGoBack()) wc.goBack();
      } else if ((input.alt && input.key === 'ArrowRight') || (mod && input.key === ']')) {
        if (wc.canGoForward()) wc.goForward();
      } else return;
      e.preventDefault();
    });

    win.on('closed', () => {
      stop();
      entries.delete(entry);
    });
    return entry;
  }

  return { open };
}

module.exports = { registerSignInWindows, sameSite, siteOf, pageScript };
