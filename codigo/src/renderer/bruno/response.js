// -- The request chosen: what it sends, Send, and what came back --
// {{name}} in the address: the variable's value as a tooltip (blue when known, orange when not). One that reads
// {{process.env.NAME}} says where NAME comes from, orange when the .env does not have it.
function bruVarValue(name) {
  if (name.startsWith('process.env.')) {
    const own = bruDotEnv(name.slice(12));
    return own ? { value: own.set ? own.value : '(empty)', from: '.env' } : null;
  }
  if (Object.prototype.hasOwnProperty.call(bru.vars || {}, name)) {
    const value = bru.vars[name];
    return bruUnset(value) ? { value: 'undefined', from: 'kept by a script', unset: true } : { value, from: 'kept by a script' };
  }
  const env = bru.envs.find((e) => e.name === bru.env);
  const v = env && env.vars.find((x) => x.key === name && x.enabled);
  if (!v) return null;
  if (v.secret) return { value: '(secret)', from: `secret of ${bru.env}` };
  const refs = bruProcessRefs(v.value);
  return { value: v.value, from: bru.env, note: refs.map(bruProcessNote).join('\n'), missing: refs.some((k) => !bruDotEnv(k)) };
}

function bruUrlNodes(url) {
  const out = [];
  let last = 0;
  for (const m of String(url).matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    if (m.index > last) out.push(document.createTextNode(url.slice(last, m.index)));
    const known = bruVarValue(m[1]);
    const v = bruEl('span', `bru-var${known && !known.unset && !known.missing ? '' : ' unknown'}`, m[0]);
    if (known && known.unset) v.title = `${m[1]} = undefined. ${BRU_UNSET_NOTE}`;
    else if (known) v.title = `${m[1]} = ${typeof known.value === 'string' ? known.value : JSON.stringify(known.value)} (${known.from})${known.note ? `\n${known.note}` : ''}`;
    else if (m[1].startsWith('process.env.')) v.title = bruProcessNote(m[1].slice(12));
    else v.title = `${m[1]} has no value yet${bru.env ? ` in ${bru.env}` : ''}: a script sets it, or the environment`;
    out.push(v);
    last = m.index + m[0].length;
  }
  if (last < url.length) out.push(document.createTextNode(url.slice(last)));
  return out;
}

function renderBrunoDetail() {
  const st = bruState();
  const d = bru.detail;
  $('#bruDetail').classList.toggle('empty', !d);
  renderBrunoRequest();
  if (!d) {
    $('#bruStatusLine').innerHTML = '';
    $('#bruTabs').innerHTML = '';
    $('#bruPane').innerHTML = '';
    $('#bruSendBtn').disabled = true;
    return;
  }
  const sending = bru.run && bru.run.dir === bru.dir && (bru.run.target === d.path || bru.run.queued.has(d.path));
  const own = bru.run && bru.run.dir === bru.dir && bru.run.target === d.path;
  const send = $('#bruSendBtn');
  send.disabled = (Boolean(bru.run) && !own) || (bru.cli && !bru.cli.ok);
  send.classList.toggle('btn-primary', !own);
  send.classList.toggle('btn-danger', Boolean(own));
  send.querySelector('.btn-label').textContent = own ? 'Stop' : 'Send';
  send.title = own ? 'Stop sending it' : `Send it with the Bruno CLI${bru.env ? `, in ${bru.env}` : ''} (Enter in the address, or Ctrl+Enter). Changes not saved are saved first.`;
  renderBrunoStatus(st.results.get(d.path), sending);
  renderBrunoTabs();
}

// what a status code means, for servers that leave it out (HTTP/2, Spring)
const BRU_REASONS = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

function bruStatusClass(code) {
  if (typeof code !== 'number') return 's-err';
  if (code < 300) return 's-2xx';
  if (code < 400) return 's-3xx';
  if (code < 500) return 's-4xx';
  return 's-5xx';
}

function bruChecks(result) {
  const list = [...(result.asserts || []), ...(result.tests || [])];
  return { all: list.length, failed: list.filter((c) => c.status !== 'pass').length };
}

// On the right of the response's tabs: the status, how long it took, its size (none before it is sent; the size, the
// time, then the words after the code left out when the tabs need the room). When it was sent is in its tooltip; a
// check that failed shows on the tabs (a red dot), an error in the pane.
function renderBrunoStatus(result, sending) {
  const line = $('#bruStatusLine');
  line.innerHTML = '';
  line.title = '';
  if (sending) {
    line.append(bruEl('span', 'bru-spin'), bruEl('span', 'bru-dim', 'Sending...'));
    return;
  }
  if (!result) return;
  const res = result.response || {};
  const code = typeof res.status === 'number' ? res.status : null;
  const reason = res.statusText || BRU_REASONS[code] || '';
  const skipped = result.status === 'skipped';
  const pill = line.appendChild(bruEl('span', `bru-pill ${skipped ? 's-skip' : bruStatusClass(code)}`, skipped ? 'Skipped' : code ? String(code) : 'No answer'));
  if (!skipped && code && reason) pill.appendChild(bruEl('span', 'bru-reason', ` ${reason}`));
  if (code && typeof res.time === 'number') line.appendChild(bruEl('span', 'bru-dim bru-meta', `${res.time} ms`));
  if (typeof res.size === 'number' && res.size) line.appendChild(bruEl('span', 'bru-dim bru-meta', formatSize(res.size)));
  line.title = `${skipped ? 'Skipped by a script. ' : ''}Sent ${formatDate(result.at)} (${new Date(result.at).toLocaleString()})`;
}

function bruErrorText(error) {
  const base = bru.envs.find((e) => e.name === bru.env);
  const url = base && (base.vars.find((v) => v.key === 'baseUrl') || {}).value;
  if (/ECONNREFUSED/.test(error)) return `Nothing answers${url ? ` at ${url}` : ''}: is the service started? (Maven, Start)`;
  return error;
}

function bruTab(tab) {
  bruState().tab = tab;
  renderBrunoTabs();
}

function renderBrunoTabs() {
  const st = bruState();
  const tabs = $('#bruTabs');
  tabs.innerHTML = '';
  const result = bru.detail ? st.results.get(bru.detail.path) : null;
  const checks = result ? bruChecks(result) : { all: 0, failed: 0 };
  const count = (key) => {
    if (key === 'checks' && checks.all) return checks.failed ? `${checks.failed}/${checks.all}` : String(checks.all);
    if (key === 'headers' && result && result.response && result.response.headers) return String(Object.keys(result.response.headers).length);
    return '';
  };
  for (const [key, label] of BRU_TABS.slice(0, BRU_TABS_SHOWN)) {
    const b = bruEl('button', `bru-tab${st.tab === key ? ' active' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(st.tab === key));
    if (count(key)) b.appendChild(bruEl('span', `bru-tab-count${key === 'checks' && checks.failed ? ' fail' : ''}`, count(key)));
    b.addEventListener('click', () => bruTab(key));
    tabs.appendChild(b);
  }
  const more = BRU_TABS.slice(BRU_TABS_SHOWN).map(([key, label]) => [key, label, count(key), key === 'checks' && checks.failed ? 'fail' : '']);
  bruMoreTab(tabs, more, st.tab, bruTab, { alert: checks.failed > 0 });
  bruFitStatus();
  renderBrunoPane(result);
}

function bruPairsTable(pairs) {
  const table = bruEl('div', 'bru-kv');
  for (const [k, v, off] of pairs) {
    const key = bruEl('span', `bru-k${off ? ' off' : ''}`, k);
    const val = bruEl('span', `bru-v${off ? ' off' : ''}${bruUnset(v) ? ' unset' : ''}`);
    if (bruUnset(v)) {
      val.textContent = 'undefined';
      val.title = BRU_UNSET_NOTE;
    } else val.append(...bruUrlNodes(typeof v === 'string' ? v : JSON.stringify(v)));
    table.append(key, val);
  }
  return table;
}

function bruSection(title, ...nodes) {
  const s = bruEl('section', 'bru-section');
  s.append(bruEl('h4', '', title), ...nodes);
  return s;
}

// A body: JSON drawn in colours, text as it is, a file as its size. pick: each key and value of the JSON knows its
// place in the body, for a click on it (bruno/pick.js).
function bruBody(data, contentType, { pick = false } = {}) {
  if (data === undefined || data === null || data === '') return bruEl('div', 'bru-dim bru-empty', 'No body.');
  if (typeof data === 'object' && typeof data.binary === 'number') return bruEl('div', 'bru-dim bru-empty', `A file, ${formatSize(data.binary)}${contentType ? ` (${contentType})` : ''}.`);
  let value = data;
  let json = typeof data === 'object';
  if (typeof data === 'string' && /^\s*[[{]/.test(data)) {
    try {
      value = JSON.parse(data);
      json = true;
    } catch {
      // text then
    }
  }
  const pre = bruEl('pre', 'bru-code');
  if (!json) pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  else bruJsonInto(pre, value, pick);
  return pre;
}

// JSON drawn from what it holds, as JSON.stringify(value, null, 2) writes it: a key or a value is a span with its
// colour and, to be picked, its path (the keys and indexes from the top: ['items', 0, 'id']).
function bruJsonInto(pre, value, pick) {
  let text = '';
  const flush = () => {
    if (text) pre.appendChild(document.createTextNode(text));
    text = '';
  };
  const leaf = (cls, t, path) => {
    flush();
    const span = pre.appendChild(bruEl('span', cls, t));
    if (pick) {
      span.classList.add('pick');
      span.bruPath = path;
    }
  };
  const walk = (v, path, indent) => {
    if (v === null || typeof v === 'boolean') return leaf('j-lit', String(v), path);
    if (typeof v === 'number') return leaf('j-num', JSON.stringify(v), path);
    if (typeof v === 'string') return leaf('j-str', JSON.stringify(v), path);
    const list = Array.isArray(v);
    const keys = list ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) {
      text += list ? '[]' : '{}';
      return undefined;
    }
    const inner = `${indent}  `;
    text += list ? '[\n' : '{\n';
    keys.forEach((k, i) => {
      text += inner;
      if (!list) {
        leaf('j-key', JSON.stringify(k), [...path, k]);
        text += ': ';
      }
      walk(v[k], [...path, k], inner);
      text += i < keys.length - 1 ? ',\n' : '\n';
    });
    text += `${indent}${list ? ']' : '}'}`;
    return undefined;
  };
  walk(value, [], '');
  flush();
}

const bruHeader = (headers, name) => {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === name);
  return k ? String(headers[k]) : '';
};

function renderBrunoPane(result) {
  const st = bruState();
  const pane = $('#bruPane');
  closeBrunoPick();
  pane.innerHTML = '';
  pane.classList.toggle('log', st.tab === 'log');
  const d = bru.detail;
  if (st.tab === 'log') {
    const pre = bruEl('pre', 'bru-log', st.log || 'Nothing sent yet. What the Bruno CLI says while it sends shows here.');
    pane.appendChild(pre);
    pane.scrollTop = pane.scrollHeight;
    return;
  }
  if (!d) return;
  const res = result && result.response;
  if (st.tab === 'response') {
    if (!result) {
      pane.appendChild(bruEl('div', 'bru-dim bru-empty', 'Send it to see what comes back.'));
      if (d.docs) pane.appendChild(bruSection('Docs', bruEl('pre', 'bru-code bru-docs', d.docs)));
      return;
    }
    if (result.error && !(res && typeof res.status === 'number')) {
      pane.appendChild(bruEl('div', 'bru-error bru-empty', bruErrorText(result.error)));
      return;
    }
    const top = bruEl('div', 'bru-pane-tools');
    const type = bruHeader(res.headers, 'content-type');
    const body = bruBody(res.data, type, { pick: true });
    top.appendChild(bruEl('span', 'bru-dim', type || ''));
    if (body.querySelector('.pick')) top.firstChild.append(bruEl('span', 'bru-pick-hint', ' \u00b7 click a value to keep it as a variable'));
    if (res.data !== undefined && res.data !== null && !(typeof res.data === 'object' && typeof res.data.binary === 'number')) {
      const copy = bruEl('button', 'btn btn-sm', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2), 'Response'));
      top.appendChild(copy);
    }
    pane.append(top, body);
  } else if (st.tab === 'headers') {
    if (!res || !res.headers) pane.appendChild(bruEl('div', 'bru-dim bru-empty', 'Send it to see the headers that come back.'));
    else pane.appendChild(bruPairsTable(Object.entries(res.headers)));
  } else if (st.tab === 'checks') {
    const list = bruEl('ul', 'bru-checks');
    if (result) {
      for (const [title, items] of [['Assertions', result.asserts || []], ['Tests', result.tests || []]]) {
        if (!items.length) continue;
        list.appendChild(bruEl('li', 'bru-checks-title', title));
        for (const c of items) {
          const li = bruEl('li', `bru-check ${c.status === 'pass' ? 'pass' : 'fail'}`);
          li.append(bruEl('span', 'bru-check-mark', c.status === 'pass' ? '\u2713' : '\u2717'), bruEl('span', 'bru-check-name', c.name));
          if (c.error) li.appendChild(bruEl('span', 'bru-check-error', c.error));
          list.appendChild(li);
        }
      }
    }
    if (list.children.length) pane.appendChild(list);
    else if (result) pane.appendChild(bruEl('div', 'bru-dim bru-empty', 'This request has no checks.'));
    else {
      // not sent yet: the checks its file has
      if (d.asserts.length) pane.appendChild(bruSection('Assertions', bruPairsTable(d.asserts.map((a) => [a.key, a.value, !a.enabled]))));
      if (d.tests) pane.appendChild(bruSection('Tests', bruEl('pre', 'bru-code', d.tests)));
      if (!d.asserts.length && !d.tests) pane.appendChild(bruEl('div', 'bru-dim bru-empty', 'This request has no checks.'));
    }
  } else if (st.tab === 'sent') {
    // what went out: the address and the headers with the variables filled in, the auth added
    if (result && result.request && result.request.url) {
      const req = result.request;
      const head = bruEl('div', 'bru-sent', `${req.method} ${req.url}`);
      pane.append(bruSection('Sent', head));
      if (req.headers && Object.keys(req.headers).length) pane.appendChild(bruSection('Headers', bruPairsTable(Object.entries(req.headers))));
      if (req.data !== undefined && req.data !== null && req.data !== '') pane.appendChild(bruSection('Body', bruBody(req.data, bruHeader(req.headers, 'content-type'))));
    } else pane.appendChild(bruEl('div', 'bru-dim bru-empty', 'Send it to see what went out: the address, headers and body with the variables filled in.'));
  }
}
