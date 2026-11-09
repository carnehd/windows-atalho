// -- Messages (the link in a row of the Containers page; main: container-messages.js): what goes through a Pub/Sub emulator
// or a Redis in a container. It only reads. Pub/Sub: what is published to each topic from when the app started watching it.
// Redis: what it receives, live, and the keys it holds with their values. --
const cm = { kind: '', name: '', timer: 0, error: '', filter: '', pubsub: null, redis: null };
const CM_MAX_LINES = 2000;

const cmEl = (tag, cls = '', text = '') => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};

const cmOpen = () => {
  const modal = $('#cmModal');
  return Boolean(modal && !modal.classList.contains('hidden'));
};

// HH:MM:SS.mmm, as the time of a line
const cmTime = (at) => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const cmPretty = (text) => {
  const t = String(text).trim();
  if (!/^[[{]/.test(t)) return String(text);
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return String(text);
  }
};

// Out of the clipboard history, and cleared in half a minute: a message may hold anything.
async function cmCopy(text, what) {
  const r = await window.tools.copySecret(text);
  toast(r && r.error ? r.error : `${what} copied`, r && r.error ? 'error' : 'success', { plain: true });
}

function containerMessagesModal() {
  let modal = $('#cmModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'cmModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card cm-card" role="dialog" aria-modal="true" aria-labelledby="cmTitle">
      <h3 id="cmTitle"></h3>
      <p id="cmSub" class="mv-sub"></p>
      <div id="cmBar" class="cm-bar"></div>
      <div id="cmError" class="ls-progress error hidden" role="alert"></div>
      <div id="cmBody" class="cm-body"></div>
      <div class="action-row settings-actions mv-actions">
        <span id="cmCount" class="ls-meta"></span>
        <span class="mv-gap"></span>
        <button id="cmClose" class="btn" type="button">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeContainerMessages();
    }
  });
  $('#cmClose').addEventListener('click', closeContainerMessages);
  return modal;
}

function closeContainerMessages() {
  if (!cmOpen()) return;
  clearInterval(cm.timer);
  if (cm.kind === 'redis') window.containerMessages.redisUnwatch(cm.name);
  $('#cmModal').classList.add('hidden');
  Object.assign(cm, { kind: '', pubsub: null, redis: null });
  const back = document.querySelector(`.dk-row[data-id="${CSS.escape(cm.rowId || '')}"] .dk-link`);
  if (back) back.focus();
}

function cmSay(error) {
  cm.error = error || '';
  const box = $('#cmError');
  if (!box) return;
  box.classList.toggle('hidden', !cm.error);
  box.textContent = cm.error;
}

function openContainerMessages(c, kind) {
  containerMessagesModal().classList.remove('hidden');
  clearInterval(cm.timer);
  // the one shown before stops being watched
  if (cm.kind === 'redis' && cm.name) window.containerMessages.redisUnwatch(cm.name);
  Object.assign(cm, { kind, name: c.name, rowId: c.id, filter: '', error: '', pubsub: null, redis: null });
  cmSay('');
  $('#cmTitle').textContent = `Messages of ${c.name}`;
  if (kind === 'pubsub') openPubsubMessages();
  else openRedisMessages();
  $('#cmClose').focus();
}

function cmFilterBox(placeholder, on) {
  const input = cmEl('input', 'input cm-filter');
  input.type = 'search';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.setAttribute('aria-label', placeholder);
  input.value = cm.filter;
  input.addEventListener('input', () => {
    cm.filter = input.value;
    on();
  });
  return input;
}

// -- Pub/Sub --

function openPubsubMessages() {
  cm.pubsub = { project: '', port: 0, topics: [], subscriptions: [], messages: [], seq: 0, topic: '', open: new Set(), loaded: false };
  $('#cmSub').textContent = 'Everything published to its topics, from when QuickDeck started watching this emulator (when Local setup started it, or this page was first opened): it keeps no history of what came before. Your microservice gets its messages as always: this page reads subscriptions of its own, one per topic.';
  const bar = $('#cmBar');
  bar.replaceChildren(cmEl('div', 'cm-chips'), cmFilterBox('Filter the messages', drawPubsubMessages));
  const clear = cmEl('button', 'btn btn-sm', 'Clear');
  clear.type = 'button';
  clear.title = 'Take these off this page: new ones keep coming';
  clear.addEventListener('click', () => {
    cm.pubsub.messages = [];
    cm.pubsub.open.clear();
    drawPubsubMessages();
  });
  bar.append(clear);
  drawPubsubMessages();
  readPubsubMessages();
  cm.timer = setInterval(() => {
    if (cmOpen() && !document.hidden) readPubsubMessages();
  }, 2000);
}

let cmReading = false;
async function readPubsubMessages() {
  const ps = cm.pubsub;
  if (!ps || cmReading) return;
  cmReading = true;
  const r = await window.containerMessages.pubsubRead(cm.name, ps.project, ps.seq).catch((e) => ({ error: e.message }));
  cmReading = false;
  if (ps !== cm.pubsub) return;
  ps.loaded = true;
  if (r.error) {
    cmSay(r.error);
    drawPubsubMessages();
    return;
  }
  cmSay('');
  const fresh = r.messages.length > 0;
  const changed = JSON.stringify([r.topics, r.subscriptions]) !== JSON.stringify([ps.topics, ps.subscriptions]);
  Object.assign(ps, { project: r.project, port: r.port, topics: r.topics, subscriptions: r.subscriptions, seq: r.seq });
  ps.messages.push(...r.messages);
  if (ps.messages.length > CM_MAX_LINES) ps.messages.splice(0, ps.messages.length - CM_MAX_LINES);
  if (fresh || changed || !$('#cmList')) drawPubsubMessages();
}

function drawPubsubMessages() {
  const ps = cm.pubsub;
  if (!ps) return;
  const chips = $('#cmBar .cm-chips');
  const count = (t) => ps.messages.filter((m) => m.topic === t).length;
  const chip = (label, value, title) => {
    const b = cmEl('button', `dk-port cm-chip${ps.topic === value ? ' on' : ''}`, label);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-pressed', String(ps.topic === value));
    b.addEventListener('click', () => {
      ps.topic = value;
      drawPubsubMessages();
    });
    return b;
  };
  chips.replaceChildren(
    chip(`All ${ps.messages.length}`, '', 'Every topic'),
    ...ps.topics.map((t) => {
      const subs = ps.subscriptions.filter((s) => s.topic === t).map((s) => s.name);
      return chip(`${t} ${count(t)}`, t, subs.length ? `Subscribed to by: ${subs.join(', ')}` : 'Nothing of your microservices is subscribed to it');
    }),
  );
  const q = cm.filter.trim().toLowerCase();
  const shown = ps.messages.filter((m) => (!ps.topic || m.topic === ps.topic) && (!q || `${m.topic} ${m.text} ${JSON.stringify(m.attributes)}`.toLowerCase().includes(q))).slice().reverse();
  const body = $('#cmBody');
  const top = body.scrollTop;
  body.replaceChildren();
  const list = cmEl('div', 'cm-list');
  list.id = 'cmList';
  list.setAttribute('role', 'list');
  if (!shown.length) {
    list.append(cmEl('p', 'ls-empty', !ps.loaded ? 'Reading...' : ps.messages.length ? 'None of them has that.' : ps.topics.length ? 'No messages yet: they show here as they are published.' : 'This emulator has no topics yet.'));
  }
  for (const m of shown.slice(0, 500)) list.append(pubsubRow(m));
  body.append(list);
  body.scrollTop = top;
  $('#cmCount').textContent = ps.port ? `Project ${ps.project} · :${ps.port}${shown.length > 500 ? ' · the last 500 shown' : ''}` : '';
}

function pubsubRow(m) {
  const ps = cm.pubsub;
  const row = cmEl('div', 'cm-row');
  row.setAttribute('role', 'listitem');
  const head = cmEl('button', 'cm-line');
  head.type = 'button';
  const isOpen = ps.open.has(m.seq);
  head.setAttribute('aria-expanded', String(isOpen));
  head.append(cmEl('span', 'cm-time', cmTime(m.at)), cmEl('span', 'cm-topic', m.topic), cmEl('span', 'cm-text', m.text.replace(/\s+/g, ' ')));
  head.addEventListener('click', () => {
    if (ps.open.has(m.seq)) ps.open.delete(m.seq);
    else ps.open.add(m.seq);
    row.replaceWith(pubsubRow(m));
  });
  row.append(head);
  if (isOpen) {
    const more = cmEl('div', 'cm-more');
    const pairs = Object.entries(m.attributes);
    more.append(cmEl('div', 'ca-where', `Message ${m.id}${m.at ? ` · ${m.at}` : ''}${m.orderingKey ? ` · key ${m.orderingKey}` : ''}${pairs.length ? ` · ${pairs.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`));
    const text = cmPretty(m.text);
    const pre = cmEl('pre', 'mc-command cm-pre', text);
    const copy = cmEl('button', 'btn btn-sm cm-copy', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => cmCopy(text, 'The message'));
    more.append(copy, pre);
    row.append(more);
  }
  return row;
}

// -- Redis --

function openRedisMessages() {
  cm.redis = { tab: 'live', lines: [], dropped: 0, password: '', needsPassword: false, port: 0, keys: [], dbs: [], db: 0, match: '*', more: false, key: null, value: null, watching: false };
  $('#cmSub').textContent = 'What Redis receives from now on, as it comes, and the keys it holds. This page only reads.';
  drawRedisBar();
  drawRedisBody();
  startRedisWatch();
}

function drawRedisBar() {
  const rd = cm.redis;
  const bar = $('#cmBar');
  const tabs = cmEl('div', 'seg');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'What to show');
  for (const [id, label] of [['live', 'Live'], ['keys', 'Keys']]) {
    const b = cmEl('button', 'seg-btn', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(rd.tab === id));
    b.addEventListener('click', () => {
      rd.tab = id;
      cm.filter = '';
      drawRedisBar();
      drawRedisBody();
      if (id === 'keys') loadRedisKeys();
    });
    tabs.append(b);
  }
  bar.replaceChildren(tabs);
  if (rd.needsPassword) {
    const pass = cmEl('input', 'input cm-filter');
    pass.type = 'password';
    pass.placeholder = 'Its password';
    pass.autocomplete = 'off';
    pass.setAttribute('aria-label', 'The password of this Redis');
    const go = cmEl('button', 'btn btn-sm', 'Connect');
    go.type = 'button';
    const connect = () => {
      rd.password = pass.value;
      rd.needsPassword = false;
      cmSay('');
      drawRedisBar();
      startRedisWatch();
      if (rd.tab === 'keys') loadRedisKeys();
    };
    go.addEventListener('click', connect);
    pass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connect();
    });
    bar.append(pass, go);
    setTimeout(() => pass.focus());
    return;
  }
  if (rd.tab === 'live') {
    bar.append(cmFilterBox('Filter what comes', drawRedisBody));
    const clear = cmEl('button', 'btn btn-sm', 'Clear');
    clear.type = 'button';
    clear.title = 'Take these off this page: new ones keep coming';
    clear.addEventListener('click', () => {
      rd.lines = [];
      rd.dropped = 0;
      drawRedisBody();
    });
    bar.append(clear);
  } else {
    const match = cmEl('input', 'input cm-filter');
    match.type = 'search';
    match.value = rd.match;
    match.placeholder = 'Keys: orders::*';
    match.spellcheck = false;
    match.title = 'A pattern, as Redis takes it: * for anything';
    match.setAttribute('aria-label', 'Which keys');
    match.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        rd.match = match.value.trim() || '*';
        loadRedisKeys();
      }
    });
    bar.append(match);
    if (rd.dbs.length > 1) {
      const db = cmEl('select', 'input cm-db');
      db.setAttribute('aria-label', 'The database');
      db.replaceChildren(...rd.dbs.map((d) => new Option(`db ${d.db} (${d.keys})`, String(d.db))));
      db.value = String(rd.db);
      db.addEventListener('change', () => {
        rd.db = Number(db.value);
        rd.key = null;
        rd.value = null;
        loadRedisKeys();
      });
      bar.append(db);
    }
    const again = cmEl('button', 'btn btn-sm', 'Refresh');
    again.type = 'button';
    again.addEventListener('click', () => {
      rd.match = match.value.trim() || '*';
      loadRedisKeys();
    });
    bar.append(again);
  }
}

async function startRedisWatch() {
  const rd = cm.redis;
  if (!rd) return;
  const r = await window.containerMessages.redisWatch(cm.name, rd.password).catch((e) => ({ error: e.message }));
  if (rd !== cm.redis) {
    window.containerMessages.redisUnwatch(cm.name);
    return;
  }
  if (r.code === 'password') {
    rd.needsPassword = true;
    cmSay(r.error);
    drawRedisBar();
    return;
  }
  if (r.error) {
    cmSay(r.error);
    return;
  }
  rd.watching = true;
  rd.port = r.port;
  cmSay('');
  drawRedisBody();
}

function onContainerMessagesEvent(e) {
  const rd = cm.redis;
  if (!rd || e.name !== cm.name) return;
  if (e.type === 'ended') {
    rd.watching = false;
    cmSay('Redis closed the connection: is it still running?');
    return;
  }
  if (e.type !== 'lines') return;
  rd.lines.push(...e.lines);
  rd.dropped += e.dropped || 0;
  if (rd.lines.length > CM_MAX_LINES) rd.lines.splice(0, rd.lines.length - CM_MAX_LINES);
  if (rd.tab === 'live') drawRedisBody();
}

function drawRedisBody() {
  const rd = cm.redis;
  if (!rd) return;
  const body = $('#cmBody');
  const top = body.scrollTop;
  body.replaceChildren();
  if (rd.tab === 'live') {
    const q = cm.filter.trim().toLowerCase();
    const shown = rd.lines.filter((l) => !q || l.text.toLowerCase().includes(q)).slice().reverse();
    const list = cmEl('div', 'cm-list cm-mono');
    list.id = 'cmList';
    list.setAttribute('role', 'list');
    if (!shown.length) list.append(cmEl('p', 'ls-empty', rd.needsPassword ? 'It asks for a password.' : rd.lines.length ? 'None of them has that.' : rd.watching ? 'Nothing yet: what it receives shows here as it comes. For what it already holds, see Keys.' : 'Connecting...'));
    for (const l of shown.slice(0, 500)) {
      const row = cmEl('div', 'cm-row');
      row.setAttribute('role', 'listitem');
      const line = cmEl('div', 'cm-line cm-static');
      const m = /^"([^"]*)"\s*([\s\S]*)$/.exec(l.text);
      line.append(cmEl('span', 'cm-time', cmTime(l.time)), cmEl('span', 'cm-topic', m ? m[1].toUpperCase() : ''), cmEl('span', 'cm-text', m ? m[2] : l.text));
      line.title = `From ${l.client}, database ${l.db}`;
      row.append(line);
      list.append(row);
    }
    body.append(list);
    body.scrollTop = top;
    $('#cmCount').textContent = `${rd.port ? `:${rd.port} · ` : ''}${plural(rd.lines.length, 'command')}${rd.dropped ? ` · ${rd.dropped} not shown: too many at once` : ''}`;
    return;
  }
  const split = cmEl('div', 'cm-split');
  const list = cmEl('div', 'cm-keys');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Keys');
  if (!rd.keys.length) list.append(cmEl('p', 'ls-empty', rd.loaded ? 'No keys.' : 'Reading...'));
  for (const k of rd.keys) {
    const b = cmEl('button', `cm-key${rd.key && rd.key.raw === k.raw ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(Boolean(rd.key && rd.key.raw === k.raw)));
    b.title = k.key;
    b.append(cmEl('span', 'cm-key-name', k.key), cmEl('span', 'ls-kind', k.type), cmEl('span', 'cm-ttl', cmTtl(k.ttlMs)));
    b.addEventListener('click', () => loadRedisValue(k));
    list.append(b);
  }
  const view = cmEl('div', 'cm-value');
  if (rd.value) {
    const head = cmEl('div', 'ls-sec-row');
    const unit = (n) => (n === 1 ? { bytes: 'byte', fields: 'field', items: 'item', members: 'member', entries: 'entry' }[rd.value.unit] || rd.value.unit : rd.value.unit);
    const said = rd.value.gone ? 'That key is no longer there' : rd.value.shown < rd.value.total ? `The first ${rd.value.shown} of ${rd.value.total} ${unit(rd.value.total)}` : `${rd.value.total} ${unit(rd.value.total)}`;
    head.append(cmEl('span', 'ls-sec-title', said));
    if (!rd.value.gone) {
      const copy = cmEl('button', 'btn btn-sm', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => cmCopy(rd.value.text, 'The value'));
      head.append(copy);
    }
    view.append(head, cmEl('pre', 'mc-command cm-pre cm-pre-tall', rd.value.text));
  } else view.append(cmEl('p', 'ls-empty', 'Choose a key to see what it holds.'));
  split.append(list, view);
  body.append(split);
  list.scrollTop = rd.keysTop || 0;
  list.addEventListener('scroll', () => (rd.keysTop = list.scrollTop));
  $('#cmCount').textContent = `${rd.port ? `:${rd.port} · ` : ''}${plural(rd.keys.length, 'key')}${rd.more ? ' · there are more: narrow the pattern' : ''}`;
}

const cmTtl = (ms) => {
  if (ms === -1 || ms === -2 || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (Math.round(s / 60) < 60) return `${Math.round(s / 60)}m`;
  return Math.round(s / 3600) < 24 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

function redisFailed(rd, r) {
  if (r.code === 'password') {
    rd.needsPassword = true;
    cmSay(r.error);
    drawRedisBar();
  } else cmSay(r.error);
}

async function loadRedisKeys() {
  const rd = cm.redis;
  if (!rd || rd.needsPassword) return;
  const r = await window.containerMessages.redisKeys(cm.name, { password: rd.password, db: rd.db, match: rd.match }).catch((e) => ({ error: e.message }));
  if (rd !== cm.redis) return;
  rd.loaded = true;
  if (r.error) {
    redisFailed(rd, r);
    drawRedisBody();
    return;
  }
  cmSay('');
  Object.assign(rd, { keys: r.keys, dbs: r.dbs, more: r.more, port: r.port });
  drawRedisBar();
  drawRedisBody();
}

async function loadRedisValue(k) {
  const rd = cm.redis;
  rd.key = k;
  const r = await window.containerMessages.redisValue(cm.name, { password: rd.password, db: rd.db, raw: k.raw, type: k.type }).catch((e) => ({ error: e.message }));
  if (rd !== cm.redis) return;
  if (r.error) {
    redisFailed(rd, r);
    return;
  }
  rd.value = r;
  drawRedisBody();
}

function setupContainerMessages() {
  window.containerMessages.onEvent(onContainerMessagesEvent);
}

setupContainerMessages();
