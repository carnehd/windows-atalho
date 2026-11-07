// -- View API (Tools): an OpenAPI or Swagger spec made easy to read. The main process turns it into endpoints and models
// (src/api-view.js); here, the endpoints by group on the left, and for the one chosen what you send and what you get back:
// fields as a tree with their rules in words, an example of each body, the curl to try it. The spec comes from a
// microservice of the list, a file, an address or a paste. Read here in the app: nothing is sent anywhere. --
const AV_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
const AV_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/></svg>';
const AV_CARET = '<svg class="av-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
const AV_IN = { path: 'In the path', query: 'In the query', header: 'In the headers', cookie: 'In the cookies' };

function avMethod(method) {
  return tEl('span', `av-m ${method.toLowerCase()}`, method);
}

// A path with its {parameters} in their own colour
function avPath(path, cls = 'av-path') {
  const el = tEl('span', cls);
  for (const part of String(path).split(/(\{[^}]*\})/)) {
    if (part) el.appendChild(part.startsWith('{') ? tEl('span', 'av-param', part) : document.createTextNode(part));
  }
  return el;
}

const avStatusKind = (status) => (/^2/.test(status) ? 'ok' : /^3/.test(status) ? 'move' : /^4/.test(status) ? 'client' : /^5/.test(status) ? 'server' : 'other');

function buildApiViewTool() {
  const box = tEl('div', 'tool av-tool');
  let spec = null;
  let tab = 'endpoints';
  let chosen = null; // the endpoint on show, by its id
  let chosenModel = null;
  let query = '';
  let server = 0;
  let seq = 0;
  let scanned = null;
  const methodsOff = new Set();
  const groupsClosed = new Set();
  const answerChosen = new Map(); // endpoint -> the answer on show
  const fieldsToggled = new Set();

  // -- where the spec comes from --
  const msSel = tEl('select', 'input av-ms');
  msSel.setAttribute('aria-label', 'Microservice');
  const fileSel = tEl('select', 'input av-file');
  fileSel.setAttribute('aria-label', 'Spec');
  const openBtn = toolButton('Open file', async () => {
    const r = await window.tools.apiOpen();
    if (r.canceled) return;
    if (r.error) {
      status(r.error, true);
      return;
    }
    clearPick();
    take(r.text, r.name);
  }, 'av-open');
  const urlBtn = toolButton('From URL', () => toggleRow(urlRow, urlInput), 'av-from-url');
  const pasteBtn = toolButton('Paste', () => toggleRow(pasteRow, pasteArea), 'av-paste');
  const source = tEl('div', 'tool-row av-source');
  source.append(msSel, fileSel, openBtn, urlBtn, pasteBtn);
  const urlRow = tEl('div', 'tool-row av-url hidden');
  const urlInput = toolInput('http://localhost:8080/v3/api-docs');
  urlInput.setAttribute('aria-label', 'The address of the spec');
  const getBtn = toolButton('Get', async () => {
    getBtn.disabled = true;
    status(`Getting ${urlInput.value.trim()}...`);
    const r = await window.tools.apiFetch(urlInput.value);
    getBtn.disabled = false;
    if (r.error) {
      status(r.error, true);
      return;
    }
    urlRow.classList.add('hidden');
    clearPick();
    take(r.text, r.name);
  }, 'av-get');
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') getBtn.click();
  });
  urlRow.append(urlInput, getBtn);
  const pasteRow = tEl('div', 'av-pasted hidden');
  const pasteArea = toolArea('The spec: JSON or YAML', 7);
  pasteArea.setAttribute('aria-label', 'The spec, pasted');
  pasteRow.append(pasteArea, toolButton('View', () => {
    pasteRow.classList.add('hidden');
    clearPick();
    take(pasteArea.value, 'Pasted');
  }, 'btn-primary av-paste-view'));
  const line = tEl('div', 'tool-hint av-status');
  const main = tEl('div', 'av-main');
  box.append(
    toolHead('View API', 'An OpenAPI or Swagger spec made easy to read: what each endpoint takes and answers, with examples. Read here in the app: nothing is sent anywhere.'),
    source, urlRow, pasteRow, line, main
  );
  selectionCopyMenu(box);

  function status(text, bad = false) {
    line.textContent = text;
    line.classList.toggle('tool-error', bad);
  }
  function toggleRow(row, input) {
    const on = row.classList.contains('hidden');
    urlRow.classList.add('hidden');
    pasteRow.classList.add('hidden');
    row.classList.toggle('hidden', !on);
    if (on) input.focus();
  }
  function clearPick() {
    msSel.value = '';
    fillFiles();
  }

  async function take(text, from) {
    const mine = ++seq;
    const r = await window.tools.apiView(text);
    if (mine !== seq) return;
    if (r.error) {
      spec = null;
      main.textContent = '';
      status(r.error, true);
      return;
    }
    spec = r;
    server = 0;
    chosen = null;
    chosenModel = null;
    query = '';
    tab = 'endpoints';
    methodsOff.clear();
    groupsClosed.clear();
    answerChosen.clear();
    fieldsToggled.clear();
    status(from);
    drawMain();
  }

  // -- the specs of the microservices --
  const readable = (s) => (s.files || []).filter((f) => !f.error && !f.part);
  function fillFiles() {
    const s = (scanned || []).find((x) => x.path === msSel.value);
    fileSel.textContent = '';
    fileSel.appendChild(new Option(s ? 'Choose a spec' : 'Spec', ''));
    for (const f of s ? readable(s) : []) fileSel.appendChild(new Option([f.title || f.name, f.version, f.rel].filter(Boolean).join(' · '), f.rel));
    fileSel.disabled = !s;
  }
  async function scan() {
    status('Looking for specs in your microservices...');
    const r = await swaggerScan(await swaggerScanStale());
    if (r.error) {
      status(r.error, true);
      return;
    }
    scanned = r.services;
    const had = msSel.value;
    msSel.textContent = '';
    msSel.appendChild(new Option('Microservice', ''));
    for (const s of scanned) if (readable(s).length) msSel.appendChild(new Option(`${s.name} (${readable(s).length})`, s.path));
    msSel.value = had;
    if (!msSel.value && scanned.some((s) => s.path === currentRepo && readable(s).length)) msSel.value = currentRepo;
    fillFiles();
    if (!spec) status(msSel.options.length > 1 ? 'Choose a spec of a microservice, open a file, or get one from an address.' : 'No specs found in your microservices: open a file, or get one from an address.');
  }
  async function readPicked(rel) {
    const s = (scanned || []).find((x) => x.path === msSel.value);
    if (!s || !rel) return;
    status(`Reading ${rel}...`);
    const r = await window.analysis.read(s.path, rel);
    if (r.error) {
      status(r.error, true);
      return;
    }
    take(r.text, ''); // the two dropdowns say where it is from
  }
  msSel.addEventListener('change', () => {
    fillFiles();
    const s = (scanned || []).find((x) => x.path === msSel.value);
    // only one: there is nothing to choose
    if (s && readable(s).length === 1) {
      fileSel.value = readable(s)[0].rel;
      readPicked(fileSel.value);
    }
  });
  fileSel.addEventListener('change', () => readPicked(fileSel.value));

  // -- the page --
  const endpointsOf = (ids) => ids.map((id) => spec.endpoints.find((e) => e.id === id)).filter(Boolean);
  const visible = (e) => !methodsOff.has(e.method) && (!query || query.split(/\s+/).every((w) => e.words.includes(w)));
  const visibleModel = (m) => !query || query.split(/\s+/).every((w) => m.words.includes(w));
  let listEl = null;
  let detailEl = null;
  let tabs = null;

  function drawMain() {
    main.textContent = '';
    if (!spec) return;
    main.appendChild(infoEl());
    if (spec.external.length) main.appendChild(tEl('div', 'tool-hint av-external', `Parts of this spec are in other files, and are not read here: ${spec.external.join(', ')}. Their fields do not show.`));
    main.appendChild(barEl());
    const split = tEl('div', 'av-split');
    listEl = tEl('div', 'av-list');
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', 'Endpoints');
    listEl.addEventListener('keydown', listKey);
    detailEl = tEl('div', 'av-detail');
    split.append(listEl, detailEl);
    main.appendChild(split);
    drawList();
    drawDetail();
  }

  function infoEl() {
    const el = tEl('div', 'av-info');
    const top = tEl('div', 'av-info-top');
    top.appendChild(tEl('h3', 'av-title', spec.title));
    if (spec.version) top.appendChild(tEl('span', 'tool-badge', spec.version));
    top.appendChild(tEl('span', 'tool-badge av-kind', spec.kind));
    top.appendChild(tEl('span', 'av-counts', `${plural(spec.endpoints.length, 'endpoint')} · ${plural(spec.models.length, 'model')}`));
    el.appendChild(top);
    if (spec.description) {
      const about = tEl('div', 'av-about', spec.description);
      const line2 = tEl('div', 'av-about-row');
      line2.appendChild(about);
      el.appendChild(line2);
      if (spec.description.length > 220 || spec.description.includes('\n')) {
        about.classList.add('short');
        const more = toolButton('More', () => {
          const on = about.classList.toggle('short');
          more.textContent = on ? 'More' : 'Less';
        }, 'av-more');
        line2.appendChild(more);
      }
    }
    if (spec.servers.length) {
      const row = tEl('div', 'av-servers');
      row.appendChild(tEl('span', 'av-label', spec.servers.length > 1 ? 'Servers' : 'Server'));
      if (spec.servers.length > 1) {
        const sel = tEl('select', 'input av-server');
        sel.setAttribute('aria-label', 'Server');
        spec.servers.forEach((s, i) => sel.appendChild(new Option(`${s.url}${s.description ? ` · ${s.description}` : ''}`, String(i))));
        sel.value = String(server);
        sel.addEventListener('change', () => {
          server = Number(sel.value);
        });
        row.appendChild(sel);
      } else {
        row.appendChild(tEl('span', 'av-server-url', `${spec.servers[0].url}${spec.servers[0].description ? ` · ${spec.servers[0].description}` : ''}`));
      }
      row.appendChild(toolButton('Copy', () => toolCopy(spec.servers[server].url, 'Address'), 'av-server-copy'));
      el.appendChild(row);
    }
    return el;
  }

  function barEl() {
    const bar = tEl('div', 'av-bar');
    const search = tEl('input', 'input av-search');
    search.type = 'search';
    search.placeholder = 'Search paths, descriptions, fields...';
    search.setAttribute('aria-label', 'Search the spec');
    search.spellcheck = false;
    const typed = debounce(() => {
      query = search.value.trim().toLowerCase();
      drawList();
      drawDetail();
    }, 120);
    search.addEventListener('input', typed);
    bar.appendChild(search);
    const present = AV_METHODS.filter((m) => spec.endpoints.some((e) => e.method === m));
    const chips = tEl('div', 'av-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Show these methods');
    for (const m of present) {
      const chip = tEl('button', `av-chip ${m.toLowerCase()}`, `${m} ${spec.endpoints.filter((e) => e.method === m).length}`);
      chip.type = 'button';
      chip.dataset.method = m;
      chip.setAttribute('aria-pressed', 'true');
      chip.title = `Show or hide the ${m} endpoints`;
      chip.addEventListener('click', () => {
        if (methodsOff.has(m)) methodsOff.delete(m);
        else methodsOff.add(m);
        chip.setAttribute('aria-pressed', String(!methodsOff.has(m)));
        drawList();
        drawDetail();
      });
      chips.appendChild(chip);
    }
    bar.appendChild(chips);
    tabs = tEl('div', 'seg av-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'What to list');
    for (const [id, label] of [['endpoints', `Endpoints ${spec.endpoints.length}`], ['models', `Models ${spec.models.length}`]]) {
      const b = tEl('button', 'seg-btn', label);
      b.type = 'button';
      b.dataset.tab = id;
      b.setAttribute('aria-pressed', String(tab === id));
      b.addEventListener('click', () => setTab(id));
      tabs.appendChild(b);
    }
    bar.appendChild(tabs);
    return bar;
  }

  function setTab(id) {
    tab = id;
    tabs.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === id)));
    box.querySelector('.av-chips').classList.toggle('hidden', id !== 'endpoints');
    drawList();
    drawDetail();
  }

  function goEndpoint(id) {
    chosen = id;
    setTab('endpoints');
    const row = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function goModel(name) {
    chosenModel = name;
    setTab('models');
    const row = listEl.querySelector(`[data-model="${CSS.escape(name)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // -- the list --
  function drawList() {
    const top = listEl.scrollTop;
    listEl.textContent = '';
    if (tab === 'models') drawModelList();
    else drawEndpointList();
    listEl.scrollTop = top;
  }

  function drawEndpointList() {
    let shown = 0;
    for (const g of spec.groups) {
      const list = endpointsOf(g.ids).filter(visible);
      if (!list.length) continue;
      shown += list.length;
      // while searching, a closed group opens: what was looked for must show
      const closed = groupsClosed.has(g.name) && !query;
      const head = tEl('button', `av-group${closed ? ' closed' : ''}`);
      head.type = 'button';
      head.setAttribute('aria-expanded', String(!closed));
      head.innerHTML = AV_CARET;
      head.append(tEl('span', 'av-group-name', g.name), tEl('span', 'cmp-count', String(list.length)));
      if (g.description) head.title = g.description;
      head.addEventListener('click', () => {
        if (groupsClosed.has(g.name)) groupsClosed.delete(g.name);
        else groupsClosed.add(g.name);
        drawList();
      });
      listEl.appendChild(head);
      if (!closed) for (const e of list) listEl.appendChild(endpointRow(e));
    }
    if (!shown) listEl.appendChild(tEl('div', 'av-none', 'No endpoint matches.'));
  }

  function endpointRow(e) {
    const row = tEl('button', `av-row${e.id === chosen ? ' selected' : ''}${e.deprecated ? ' old' : ''}`);
    row.type = 'button';
    row.dataset.id = e.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(e.id === chosen));
    const first = tEl('span', 'av-row-top');
    first.append(avMethod(e.method), avPath(e.path));
    if (e.auth.length) {
      const lock = tEl('span', 'av-lock');
      lock.innerHTML = AV_LOCK;
      lock.title = `Needs: ${e.auth.map((a) => a.label).join(' or ')}`;
      first.appendChild(lock);
    }
    row.appendChild(first);
    if (e.summary) row.appendChild(tEl('span', 'av-row-sub', e.summary));
    row.addEventListener('click', () => {
      chosen = e.id;
      drawList();
      drawDetail();
      const again = listEl.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
      if (again) again.focus();
    });
    return row;
  }

  function drawModelList() {
    const list = spec.models.filter(visibleModel);
    for (const m of list) {
      const row = tEl('button', `av-row${m.name === chosenModel ? ' selected' : ''}`);
      row.type = 'button';
      row.dataset.model = m.name;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(m.name === chosenModel));
      const first = tEl('span', 'av-row-top');
      first.append(tEl('span', 'av-model-name', m.name), tEl('span', 'av-row-count', plural(m.view.children.length, 'field')));
      row.appendChild(first);
      if (m.description) row.appendChild(tEl('span', 'av-row-sub', m.description));
      row.addEventListener('click', () => {
        chosenModel = m.name;
        drawList();
        drawDetail();
        const again = listEl.querySelector(`[data-model="${CSS.escape(m.name)}"]`);
        if (again) again.focus();
      });
      listEl.appendChild(row);
    }
    if (!list.length) listEl.appendChild(tEl('div', 'av-none', spec.models.length ? 'No model matches.' : 'This spec has no models.'));
  }

  // up and down go through the list
  function listKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...listEl.querySelectorAll('.av-row')];
    const at = rows.indexOf(document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.click();
  }

  // -- the detail --
  function drawDetail() {
    detailEl.textContent = '';
    detailEl.scrollTop = 0;
    if (tab === 'models') {
      const list = spec.models.filter(visibleModel);
      if (!list.some((m) => m.name === chosenModel)) chosenModel = list.length ? list[0].name : null;
      const m = spec.models.find((x) => x.name === chosenModel);
      const row = m && listEl.querySelector(`[data-model="${CSS.escape(m.name)}"]`);
      if (row) row.classList.add('selected');
      if (m) detailEl.appendChild(modelEl(m));
      return;
    }
    const list = spec.groups.flatMap((g) => endpointsOf(g.ids)).filter(visible);
    if (!list.some((e) => e.id === chosen)) chosen = list.length ? list[0].id : null;
    const e = spec.endpoints.find((x) => x.id === chosen);
    const row = e && listEl.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
    if (row) row.classList.add('selected');
    if (e) detailEl.appendChild(endpointEl(e));
  }

  function curlOf(e) {
    const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const base = (spec.servers[server] ? spec.servers[server].url : 'http://localhost:8080').replace(/\/$/, '');
    const value = (p) => (p.example !== undefined ? p.example : `<${p.name}>`);
    const path = e.path.replace(/\{([^}]+)\}/g, (all, name) => {
      const p = e.params.find((x) => x.in === 'path' && x.name === name);
      return encodeURIComponent(p && p.example !== undefined ? p.example : `<${name}>`).replace(/%3C/g, '<').replace(/%3E/g, '>');
    });
    const search = e.params.filter((p) => p.in === 'query' && p.required).map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(value(p))}`).join('&');
    const parts = [`curl -X ${e.method} ${quote(`${base}${path}${search ? `?${search}` : ''}`)}`];
    for (const a of e.auth) {
      if (a.kind === 'apiKey' && a.in === 'header') parts.push(`-H ${quote(`${a.field}: <${a.field}>`)}`);
      else if (a.kind === 'bearer') parts.push(`-H ${quote('Authorization: Bearer <token>')}`);
      else if (a.kind === 'basic') parts.push('-u <user>:<password>');
    }
    for (const p of e.params.filter((x) => x.in === 'header' && x.required)) parts.push(`-H ${quote(`${p.name}: ${value(p)}`)}`);
    if (e.body && e.body.contentType) parts.push(`-H ${quote(`Content-Type: ${e.body.contentType}`)}`);
    if (e.body && e.body.example) parts.push(`-d ${quote(e.body.example.text)}`);
    return parts.join(' \\\n  ');
  }

  function endpointEl(e) {
    const el = tEl('div', 'av-endpoint');
    const head = tEl('div', 'av-head');
    head.append(avMethod(e.method), avPath(e.path, 'av-path av-path-big'));
    const acts = tEl('div', 'av-head-acts');
    acts.append(toolButton('Copy path', () => toolCopy(e.path, 'Path'), 'av-copy-path'), toolButton('Copy curl', () => toolCopy(curlOf(e), 'curl'), 'av-copy-curl'));
    head.appendChild(acts);
    el.appendChild(head);
    if (e.summary) el.appendChild(tEl('div', 'av-summary', e.summary));
    if (e.description && e.description !== e.summary) el.appendChild(tEl('div', 'av-text', e.description));
    const facts = tEl('div', 'av-facts');
    if (e.deprecated) facts.appendChild(tEl('span', 'av-fact bad', 'Deprecated'));
    if (e.auth.length) {
      const needs = tEl('span', 'av-fact');
      needs.innerHTML = AV_LOCK;
      needs.append(`Needs: ${e.auth.map((a) => a.label).join(' or ')}`);
      facts.appendChild(needs);
    } else {
      facts.appendChild(tEl('span', 'av-fact', 'No login in the spec'));
    }
    facts.appendChild(tEl('span', 'av-fact', e.tag));
    if (e.operationId) facts.appendChild(tEl('span', 'av-fact mono', e.operationId));
    el.appendChild(facts);

    // -- what you send --
    el.appendChild(tEl('h4', 'av-section', 'What you send'));
    if (!e.params.length && !e.body) el.appendChild(tEl('div', 'av-none-here', 'Nothing: no parameters and no body.'));
    for (const where of ['path', 'query', 'header', 'cookie']) {
      const list = e.params.filter((p) => p.in === where);
      if (!list.length) continue;
      el.appendChild(tEl('div', 'av-sub', AV_IN[where]));
      const tree = treeEl();
      for (const p of list) addField(tree, p, 0, `${e.id}/param/${where}`);
      el.appendChild(tree);
    }
    if (e.body) {
      const sub = tEl('div', 'av-sub');
      sub.append(`The body${e.body.required ? '' : ' (optional)'}`);
      if (e.body.contentType) sub.appendChild(tEl('span', 'av-type-of', e.body.contentType));
      if (e.body.others.length) sub.appendChild(tEl('span', 'av-type-of', `or ${e.body.others.join(', ')}`));
      el.appendChild(sub);
      if (e.body.description) el.appendChild(tEl('div', 'av-text', e.body.description));
      el.appendChild(bodyEl(e.body, `${e.id}/body`));
    }

    // -- what you get back --
    el.appendChild(tEl('h4', 'av-section', 'What you get back'));
    if (!e.answers.length) {
      el.appendChild(tEl('div', 'av-none-here', 'The spec does not say.'));
      return el;
    }
    if (!answerChosen.has(e.id) || !e.answers.some((a) => a.status === answerChosen.get(e.id))) {
      answerChosen.set(e.id, (e.answers.find((a) => /^2/.test(a.status)) || e.answers[0]).status);
    }
    const pills = tEl('div', 'av-answers');
    pills.setAttribute('role', 'group');
    pills.setAttribute('aria-label', 'Answers');
    const holder = tEl('div', 'av-answer');
    const showAnswer = () => {
      const a = e.answers.find((x) => x.status === answerChosen.get(e.id));
      pills.querySelectorAll('.av-answer-pill').forEach((p) => p.setAttribute('aria-pressed', String(p.dataset.status === a.status)));
      holder.textContent = '';
      if (a.description && a.description !== a.meaning) holder.appendChild(tEl('div', 'av-text', a.description));
      if (a.contentType) holder.appendChild(tEl('div', 'av-sub', '')).append(tEl('span', 'av-type-of', a.contentType));
      if (a.view || a.example) holder.appendChild(bodyEl(a, `${e.id}/answer/${a.status}`));
      else holder.appendChild(tEl('div', 'av-none-here', 'No body.'));
    };
    for (const a of e.answers) {
      const pill = tEl('button', `av-answer-pill ${avStatusKind(a.status)}`);
      pill.type = 'button';
      pill.dataset.status = a.status;
      pill.append(tEl('strong', '', a.status));
      if (a.meaning) pill.append(tEl('span', '', a.meaning));
      pill.addEventListener('click', () => {
        answerChosen.set(e.id, a.status);
        showAnswer();
      });
      pills.appendChild(pill);
    }
    el.append(pills, holder);
    showAnswer();
    return el;
  }

  // A body: the tree of its fields and its example
  function bodyEl(part, key) {
    const el = tEl('div', 'av-body');
    const view = part.view;
    if (view) {
      const has = view.children.length > 0;
      const lead = tEl('div', 'av-body-type');
      lead.append(tEl('span', 'av-label', 'Type'), typeEl(view));
      if (view.rules.length) lead.appendChild(tEl('span', 'av-rules', view.rules.join(' · ')));
      if (!has || view.ref || /^list|^map/.test(view.type)) el.appendChild(lead);
      if (view.description && has) el.appendChild(tEl('div', 'av-text', view.description));
      if (has) {
        const tree = treeEl();
        for (const c of view.children) addField(tree, c, 0, key);
        el.appendChild(tree);
      }
    }
    if (part.example) el.appendChild(exampleEl(part.example));
    return el;
  }

  function exampleEl(example) {
    const el = tEl('div', 'av-example');
    const head = tEl('div', 'av-example-head');
    head.append(tEl('span', 'av-label', example.own ? 'Example, from the spec' : 'Example, made from the fields'), toolButton('Copy', () => toolCopy(example.text, 'Example'), 'av-example-copy'));
    el.append(head, tEl('pre', 'av-code', example.text));
    return el;
  }

  function treeEl() {
    return tEl('div', 'av-tree');
  }

  // A type: a model's name opens that model
  function typeEl(f) {
    const name = f.ref && spec.models.some((m) => m.name === f.ref) ? f.ref : '';
    if (!name) return tEl('span', `av-type${f.external ? ' external' : ''}`, f.type);
    const b = tEl('button', 'av-type link', f.type);
    b.type = 'button';
    b.title = `See ${name} in Models`;
    b.addEventListener('click', () => goModel(name));
    return b;
  }

  function addField(tree, f, depth, key) {
    const id = `${key}/${f.name}`;
    const has = f.children && f.children.length > 0;
    // the first level of a field open, the rest closed; a click turns each one the other way
    const open = has && (depth < 1) !== fieldsToggled.has(id);
    const row = tEl('div', `av-field${f.deprecated ? ' old' : ''}`);
    const who = tEl('div', 'av-field-name');
    who.style.paddingLeft = `${depth * 16}px`;
    if (has) {
      const caret = tEl('button', `av-toggle${open ? ' open' : ''}`);
      caret.type = 'button';
      caret.innerHTML = AV_CARET;
      caret.title = open ? 'Close' : `Open: its ${plural(f.children.length, 'field')}`;
      caret.setAttribute('aria-expanded', String(open));
      caret.setAttribute('aria-label', `${f.name}: ${caret.title}`);
      caret.addEventListener('click', () => {
        if (fieldsToggled.has(id)) fieldsToggled.delete(id);
        else fieldsToggled.add(id);
        redrawTree(tree, row);
      });
      who.appendChild(caret);
    } else {
      who.appendChild(tEl('span', 'av-toggle-space'));
    }
    who.appendChild(tEl('span', 'av-name', f.name));
    if (f.required) who.appendChild(tEl('span', 'av-required', 'required'));
    const kind = tEl('div', 'av-field-type');
    kind.appendChild(typeEl(f));
    const about = tEl('div', 'av-field-about');
    if (f.description) about.appendChild(tEl('div', 'av-field-text', f.description));
    const rules = [...(f.rules || [])];
    if (f.again) rules.unshift('holds itself: see it above');
    if (f.cut) rules.unshift('goes on deeper: see it in Models');
    if (f.deprecated) rules.unshift('deprecated');
    if (rules.length) about.appendChild(tEl('div', 'av-rules', rules.join(' · ')));
    if (f.example !== undefined && f.example !== '') about.appendChild(tEl('div', 'av-eg', `e.g. ${f.example}`));
    row.append(who, kind, about);
    row.avField = { f, depth, key };
    tree.appendChild(row);
    if (open) for (const c of f.children) addField(tree, c, depth + 1, id);
  }

  // A field opened or closed: its tree again, as it is, from the fields it was drawn with
  function redrawTree(tree) {
    const top = detailEl.scrollTop;
    const firsts = [...tree.children].map((r) => r.avField).filter((x) => x.depth === 0);
    tree.textContent = '';
    for (const { f, key } of firsts) addField(tree, f, 0, key);
    detailEl.scrollTop = top;
  }

  function modelEl(m) {
    const el = tEl('div', 'av-endpoint');
    const head = tEl('div', 'av-head');
    head.appendChild(tEl('span', 'av-model-big', m.name));
    el.appendChild(head);
    if (m.description) el.appendChild(tEl('div', 'av-text', m.description));
    el.appendChild(tEl('h4', 'av-section', 'Its fields'));
    el.appendChild(bodyEl({ view: m.view, example: m.example }, `model/${m.name}`));
    el.appendChild(tEl('h4', 'av-section', m.usedBy.length ? `Used by ${plural(m.usedBy.length, 'endpoint')}` : 'Used by'));
    if (!m.usedBy.length) el.appendChild(tEl('div', 'av-none-here', 'No endpoint uses it directly.'));
    const list = tEl('div', 'av-used');
    for (const id of m.usedBy) {
      const e = spec.endpoints.find((x) => x.id === id);
      if (!e) continue;
      const b = tEl('button', 'av-used-row');
      b.type = 'button';
      b.append(avMethod(e.method), avPath(e.path));
      b.addEventListener('click', () => goEndpoint(id));
      list.appendChild(b);
    }
    el.appendChild(list);
    return el;
  }

  fileSel.disabled = true;
  fileSel.appendChild(new Option('Spec', ''));
  msSel.appendChild(new Option('Microservice', ''));
  return {
    el: box,
    shown(on) {
      if (on && !scanned) scan();
    },
    // a spec of a microservice, from the Analysis page
    async open(service, rel) {
      if (!scanned) await scan();
      msSel.value = service.path;
      fillFiles();
      fileSel.value = rel;
      readPicked(rel);
    },
  };
}

// Opens View API with a spec of a microservice in it.
function openInApiView(service, rel) {
  setMode('tools');
  showTool('apiview');
  builtTools.get('apiview').open(service, rel);
}
