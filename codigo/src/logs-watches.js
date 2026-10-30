// Watches: saved searches (for example "username123") that the app checks in the background for new logs,
// also while the window is hidden in the tray. Each watch counts the new logs since its tab was last opened.
// The "keep adding test logs" switch lives here too, because it runs on the same timer.
const crypto = require('crypto');

const WATCHES_KEY = 'logWatches';
const LIVE_KEY = 'logsLiveTestLogs';
const MAX_WATCHES = 20;

function registerLogWatches({ logs, store, notify, onChange }) {
  let timer = null;
  let intervalMs = 0;
  let checking = false;

  const list = () => store.get(WATCHES_KEY, []);
  const save = (watches) => {
    store.set(WATCHES_KEY, watches);
    onChange();
  };

  function state() {
    return { watches: list(), live: store.get(LIVE_KEY, false) };
  }

  // env and origin: the environment ('' for all) and the origin (openshift, gcp or both) chosen when it was made.
  function add(query, env = '', origin = 'openshift') {
    const q = String(query || '').trim().slice(0, 500);
    const e = String(env || '').slice(0, 100);
    const o = ['openshift', 'gcp', 'both'].includes(origin) ? origin : 'openshift';
    if (!q) throw new Error('Type the text to watch, for example username123.');
    const watches = list();
    const same = watches.find((w) => w.query === q && (w.env || '') === e && (w.origin || 'openshift') === o);
    if (same) return same;
    if (watches.length >= MAX_WATCHES) throw new Error(`You can have up to ${MAX_WATCHES} watches. Remove one first.`);
    const now = Date.now();
    const watch = { id: crypto.randomBytes(6).toString('hex'), query: q, env: e, origin: o, createdAt: now, checkedTo: now, newCount: 0, lastNewAt: null, error: null };
    save([...watches, watch]);
    schedule();
    return watch;
  }

  function remove(id) {
    save(list().filter((w) => w.id !== id));
    schedule(); // the timer stops when nothing is left to check
    return { success: true };
  }

  // A name for the watch's tab ('' goes back to the watched text).
  function rename(id, label) {
    const watches = list();
    const w = watches.find((x) => x.id === id);
    if (!w) throw new Error('That watch does not exist any more.');
    const l = String(label || '').trim().slice(0, 60);
    if (l) w.label = l;
    else delete w.label;
    // no onChange: the page already shows the new name, and a redraw now could swallow a click on another tab
    store.set(WATCHES_KEY, watches);
    return w;
  }

  function seen(id) {
    const watches = list();
    const w = watches.find((x) => x.id === id);
    if (w && w.newCount) {
      w.newCount = 0;
      save(watches);
    }
    return { success: true };
  }

  function setLive(on) {
    store.set(LIVE_KEY, Boolean(on));
    onChange();
    schedule();
    if (on) check();
    return state();
  }

  async function check() {
    if (checking) return;
    checking = true;
    try {
      let settings;
      try {
        settings = logs.settings();
      } catch {
        return; // a broken config file: the Logs page explains it
      }
      if (settings.watchIntervalMs !== intervalMs) schedule(settings.watchIntervalMs);
      let liveAdded = 0;
      if (store.get(LIVE_KEY, false) && settings.source === 'local') {
        try {
          liveAdded = logs.appendLiveTestLogs().added;
        } catch {
          // no test logs yet
        }
      }
      const watches = list();
      const now = Date.now();
      const results = new Map();
      for (const w of watches) {
        try {
          const r = await logs.count({ query: w.query, env: w.env || '', origin: w.origin || 'openshift', from: w.checkedTo + 1, to: now });
          results.set(w.id, { checkedTo: now, found: r.total, newest: r.newest, error: null });
        } catch (e) {
          results.set(w.id, { checkedTo: w.checkedTo, found: 0, newest: null, error: e.message });
        }
      }
      // The list may have changed while counting (a tab opened, a watch removed): merge into the current one.
      let changed = liveAdded > 0;
      const merged = list().map((w) => {
        const r = results.get(w.id);
        if (!r) return w;
        if (r.found || r.error !== w.error) changed = true;
        const next = { ...w, checkedTo: r.checkedTo, error: r.error, newCount: w.newCount + r.found, lastNewAt: r.found ? r.newest : w.lastNewAt };
        if (r.found && settings.watchNotifications) notify(next, r.found);
        return next;
      });
      store.set(WATCHES_KEY, merged);
      if (changed) onChange();
    } finally {
      checking = false;
    }
  }

  function schedule(ms) {
    let next = ms;
    if (!next) {
      try {
        next = logs.settings().watchIntervalMs;
      } catch {
        next = 30000;
      }
    }
    intervalMs = next;
    clearInterval(timer);
    timer = null;
    if (list().length || store.get(LIVE_KEY, false)) timer = setInterval(check, intervalMs);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { state, add, remove, rename, seen, setLive, check, start: () => schedule(), stop };
}

module.exports = { registerLogWatches };
