// Logs > Bruno tests: the requests of the logs on screen, each with its response, made into Bruno tests (main:
// log-tests.js). From the logs: the requests found, in the order they came (the order the tests run: one that uses
// the id another made comes after it). Not in the logs (log-variations.js, code-answers.js): those requests with one
// change, actions in another order and the endpoints the logs never had, with what the code can answer; Try sends
// them and keeps their answers, the right ones ticked become tests too. On the right what the one chosen sends and
// checks, as its .bru file; Create; then Open in Bruno, or Run them there.
let lt = null; // { token, found, chosen: Set, previewId, plan, created, seq, tab, more, moreChosen: Set, moreSeq }
let ltTimer = null;

const ltStatusClass = (s) => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : 'ok');
const LT_CAUSE = {
  dependency: 'needs what it calls to fail: not made',
  there: 'depends on what another service has: no variation got there',
  state: 'depends on what exists: no variation got there',
  input: 'no variation got there',
  ok: 'no variation got there',
};

async function openLogTests() {
  if (!logsResult || !logsResult.hits.length) {
    toast('Search for the logs first: the tests are made from the logs on screen', 'error');
    return;
  }
  const env = logsResult.env;
  const params = { query: logsResult.query, from: logsResult.from, to: logsResult.to, origin: logsResult.origin, ...(env && { env }), ...logsTabParams() };
  const btn = $('#logsTestsBtn');
  btn.disabled = true;
  let r;
  try {
    r = await window.logTests.find(params);
  } catch (e) {
    r = { error: e.message };
  } finally {
    btn.disabled = false;
  }
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  const ok = r.cases.filter((c) => c.payload !== 'missing' || !/^(POST|PUT|PATCH)$/.test(c.method));
  lt = {
    token: r.token, found: r, chosen: new Set(ok.map((c) => c.id)), previewId: (ok[0] || r.cases[0] || {}).id || null, plan: null, created: null, seq: 0,
    tab: 'logs', more: null, moreChosen: new Set(), moreSeq: 0,
  };
  const col = r.collections.find((c) => c.dir === r.suggested) || (r.collections.length === 1 ? r.collections[0] : null);
  renderLogTestsSetup(col);
  $('#ltModal').classList.remove('hidden');
  await planLogTests();
  $('#ltClose').focus();
}

function closeLogTests() {
  $('#ltModal').classList.add('hidden');
  clearTimeout(ltTimer);
}

function ltCollection() {
  return lt && lt.found.collections.find((c) => c.dir === $('#ltCollection').value);
}

// The parts that do not change while the panel is open: what was found, the collections and their addresses.
function renderLogTestsSetup(col) {
  const f = lt.found;
  const svc = f.services.length === 1 ? ` answered by ${f.services[0]}` : f.services.length ? ` answered by ${f.services.length} services` : '';
  const intro = $('#ltIntro');
  intro.textContent = '';
  intro.appendChild(vEl('div', '', f.cases.length
    ? `${logsPlural(f.cases.length, 'request')}${svc}, each with its response, in ${logsPlural(f.read, 'log')}${f.truncated ? ` (the newest ${f.maxLogs.toLocaleString()} of the search)` : ''}.`
    : `No request with its response in ${logsPlural(f.read, 'log')}.`));
  intro.appendChild(vEl('div', 'lt-intro-sub', f.cases.length
    ? 'Each one becomes a Bruno test: it sends the same request again and checks that the status and the answer are still the ones in the logs. Ids a request made are taken by the ones after it. Not in the logs: what nobody tried yet.'
    : 'The tests come from a REQUEST line (method, uri and payload in corpoPedido) and its RESPONSE line (status and corpoResposta) with the same traceId, or a line with both. Search for the logs of a service in a time range with requests.'));
  const sel = $('#ltCollection');
  sel.textContent = '';
  if (!f.collections.length) sel.appendChild(new Option('No repository has a Bruno collection', ''));
  else if (!col) sel.appendChild(new Option('Choose a collection', ''));
  for (const c of f.collections) sel.appendChild(new Option(`${c.repoName}${c.rel ? ` · ${c.rel}` : ''}${c.name && c.name !== c.repoName ? ` (${c.name})` : ''}`, c.dir));
  sel.value = col ? col.dir : '';
  $('#ltFolder').value = 'From the logs';
  renderLogTestsBases(true);
  const left = [];
  if (f.left.noResponse) left.push(`${logsPlural(f.left.noResponse, 'request')} without its response`);
  if (f.left.noRequest) left.push(`${logsPlural(f.left.noRequest, 'response')} without its request`);
  if (f.left.notTested) left.push(`${f.left.notTested.toLocaleString()} health checks, API docs or OPTIONS`);
  if (f.left.outbound) left.push(`${logsPlural(f.left.outbound, 'call')} to other services`);
  if (f.more) left.push(`${f.more.toLocaleString()} more past the first 200`);
  $('#ltLeft').textContent = left.length ? `Left out: ${left.join(' · ')}` : '';
  $('#ltDone').classList.add('hidden');
  $('#ltOpen').classList.add('hidden');
  $('#ltRun').classList.add('hidden');
  $('#ltCreate').classList.remove('hidden');
  renderLogTestsTabs();
}

// The address before the path: the collection's variable for it ({{baseUrl}}), else the host the logs saw. The
// others are offered under the field as plain buttons, not a <datalist>: its native popup can crash Electron on macOS.
function renderLogTestsBases(reset) {
  const col = ltCollection();
  const list = $('#ltBases');
  list.textContent = '';
  const bases = col ? col.bases : [];
  if (reset || !$('#ltBase').value.trim()) $('#ltBase').value = bases.length ? bases[0].value : 'http://localhost:8080';
  if (bases.length < 2) return;
  for (const b of bases.slice(0, 4)) {
    const chip = vEl('button', 'logs-form-chip', b.value);
    chip.type = 'button';
    chip.title = b.label;
    chip.addEventListener('click', () => {
      $('#ltBase').value = b.value;
      $('#ltBase').dispatchEvent(new Event('input'));
    });
    list.appendChild(chip);
  }
}

function ltOptions() {
  const col = ltCollection();
  return {
    repo: col ? col.repo : '', dir: col ? col.dir : '', folder: $('#ltFolder').value, base: $('#ltBase').value.trim(),
    ids: lt.found.cases.filter((c) => lt.chosen.has(c.id)).map((c) => c.id),
    more: [...lt.moreChosen],
  };
}

// Asks the main process what the tests will be with the choices on screen, and draws the list and the preview.
async function planLogTests() {
  if (!lt) return;
  const seq = ++lt.seq;
  const col = ltCollection();
  if (!col) {
    lt.plan = null;
    renderLogTestsList();
    renderLogTestsPreview('Choose the collection the tests go to.');
    return;
  }
  const r = await window.logTests.plan(lt.token, ltOptions(), lt.previewId);
  if (!lt || seq !== lt.seq) return;
  if (r.error) {
    lt.plan = null;
    renderLogTestsList();
    renderLogTestsPreview(r.error);
    return;
  }
  lt.plan = r;
  renderLogTestsList();
  renderLogTestsPreview(r.previewError);
}

function planLogTestsSoon() {
  clearTimeout(ltTimer);
  ltTimer = setTimeout(() => {
    if (lt && lt.tab === 'more') loadLogTestsMore();
    planLogTests();
  }, 250);
}

function renderLogTestsTabs() {
  $('#ltTabLogs').classList.toggle('on', lt.tab === 'logs');
  $('#ltTabMore').classList.toggle('on', lt.tab === 'more');
  $('#ltTabLogs').setAttribute('aria-selected', String(lt.tab === 'logs'));
  $('#ltTabMore').setAttribute('aria-selected', String(lt.tab === 'more'));
  $('#ltTabLogsCount').textContent = String(lt.found.cases.length);
  $('#ltTabMoreCount').textContent = lt.more && lt.more.scenarios ? String(lt.more.scenarios.length) : '';
  $('#ltListHead').classList.toggle('hidden', lt.tab !== 'logs');
  $('#ltMoreHead').classList.toggle('hidden', lt.tab !== 'more');
}

function renderLogTestsList() {
  renderLogTestsTabs();
  if (lt.tab === 'more') renderLogTestsMore();
  else renderLogTestsLogs();
  const n = lt.chosen.size + lt.moreChosen.size;
  const create = $('#ltCreate');
  create.disabled = !n || !lt.plan;
  create.textContent = n ? `Create ${logsPlural(n, 'test')}` : 'Create tests';
}

function ltCheckbox(on, label, onChange) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = on;
  box.setAttribute('aria-label', label);
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => onChange(box.checked));
  return box;
}

function ltRowLine(method, text, status, cls) {
  const line = vEl('div', 'lt-row-line');
  line.appendChild(vEl('span', `bru-method m-${method.toLowerCase()}`, method === 'DELETE' ? 'DEL' : method));
  const what = vEl('span', 'lt-path', text);
  what.title = text;
  line.appendChild(what);
  line.appendChild(vEl('span', `lt-status ${cls}`, status));
  return line;
}

function ltSelect(id) {
  lt.previewId = id;
  $$('#ltList .lt-row').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
  planLogTests();
}

function renderLogTestsLogs() {
  const box = $('#ltList');
  box.textContent = '';
  const items = new Map(((lt.plan && lt.plan.items) || []).map((it) => [it.id, it]));
  for (const c of lt.found.cases) {
    const it = items.get(c.id);
    const on = lt.chosen.has(c.id);
    const row = vEl('div', `lt-row${c.id === lt.previewId ? ' active' : ''}${on ? '' : ' off'}`);
    row.dataset.id = c.id;
    row.appendChild(ltCheckbox(on, `Make a test of ${c.method} ${c.path}`, (checked) => {
      if (checked) lt.chosen.add(c.id);
      else lt.chosen.delete(c.id);
      lt.previewId = c.id;
      lt.created = null;
      renderLogTestsDone();
      planLogTests();
    }));
    const main = vEl('div', 'lt-row-main');
    main.appendChild(ltRowLine(c.method, `${c.path}${c.query ? `?${c.query}` : ''}`, String(c.status), ltStatusClass(c.status)));
    const notes = [];
    if (c.count > 1) notes.push(`${c.count}×`);
    notes.push(logsShortTime(c.last));
    if (c.payload === 'missing' && /^(POST|PUT|PATCH)$/.test(c.method)) notes.push('no payload in the logs');
    if (it && on) {
      if (it.uses.length) notes.push(`uses ${it.uses.map((v) => `{{${v}}}`).join(', ')}`);
      if (it.sets.length) notes.push(`sets ${it.sets.map((v) => `{{${v}}}`).join(', ')}`);
      notes.push(it.kind === 'json' ? `${it.values} values, ${it.fields} fields` : it.kind === 'text' ? 'its text' : 'status only');
      if (it.exists) notes.push('there already: written over');
    }
    main.appendChild(vEl('div', `lt-row-sub${it && on && it.exists ? ' warn' : ''}`, notes.join(' · ')));
    row.appendChild(main);
    row.addEventListener('click', () => ltSelect(c.id));
    box.appendChild(row);
  }
  const n = lt.chosen.size;
  const all = $('#ltAll');
  all.checked = n > 0 && n === lt.found.cases.length;
  all.indeterminate = n > 0 && n < lt.found.cases.length;
  all.disabled = !lt.found.cases.length;
  $('#ltCount').textContent = `${n} of ${lt.found.cases.length} chosen`;
}

// -- Not in the logs --
async function loadLogTestsMore() {
  if (!lt || !ltCollection()) return;
  const seq = ++lt.moreSeq;
  const r = await window.logTests.more(lt.token, ltOptions());
  if (!lt || seq !== lt.moreSeq) return;
  lt.more = r;
  if (lt.tab === 'more') renderLogTestsList();
}

async function showLogTestsTab(tab) {
  if (!lt || lt.tab === tab) return;
  lt.tab = tab;
  renderLogTestsList();
  if (tab === 'more' && !lt.more) {
    $('#ltMoreHead').textContent = 'Reading the code and making the variations...';
    await loadLogTestsMore();
  }
}

async function tryLogTestsMore() {
  const m = lt && lt.more;
  if (!m || !m.scenarios) return;
  if (m.where.error) {
    toast(m.where.error, 'error');
    return;
  }
  const n = m.scenarios.reduce((a, s) => a + s.steps, 0);
  if (!m.where.local && !(await askConfirm(`Send ${logsPlural(n, 'request')} to ${m.where.address}?\nIt is not this computer: they make, change and cancel things there.`, { confirm: 'Send them' }))) return;
  const btn = $('#ltTry');
  if (btn) {
    btn.disabled = true;
    btn.textContent = `Sending ${logsPlural(n, 'request')}...`;
  }
  const r = await window.logTests.tryThem(lt.token, ltOptions(), null);
  if (!lt) return;
  if (r.error) {
    toast(r.error, 'error');
    renderLogTestsList();
    return;
  }
  lt.more = r;
  lt.moreChosen = new Set(r.scenarios.filter((s) => s.suggest).map((s) => s.id));
  lt.created = null;
  renderLogTestsDone();
  const failed = r.scenarios.filter((s) => s.tried && s.tried.error).length;
  toast(`${logsPlural(r.scenarios.length - failed, 'answer')} kept${failed ? `, ${failed} without one` : ''}: ${lt.moreChosen.size} ticked, of a kind the logs do not have`, failed ? 'error' : 'success');
  await planLogTests();
}

function renderLogTestsMoreHead() {
  const head = $('#ltMoreHead');
  head.textContent = '';
  const m = lt.more;
  if (!m) {
    head.textContent = ltCollection() ? 'Reading the code and making the variations...' : 'Choose the collection the tests go to.';
    return;
  }
  if (m.error) {
    head.appendChild(vEl('div', 'lt-more-note bad', m.error));
    return;
  }
  const note = vEl('div', 'lt-more-note');
  if (m.code && m.code.controllers.length) {
    note.append('Read from the code: ', vEl('b', '', m.code.controllers.join(', ')), ` (${logsPlural(m.code.answers, 'answer')}). `);
  } else note.append('No Spring controller in the code of this repository: only the variations. ');
  note.append('Each one is a request of the logs with one change, actions in another order, or an endpoint the logs never had. ');
  note.append(m.tried ? 'The ones ticked got an answer the logs do not have: check it, then Create.' : 'Try sends them and keeps what they answer.');
  head.appendChild(note);
  const bar = vEl('div', 'lt-more-bar');
  const btn = vEl('button', `btn btn-sm${m.tried ? '' : ' btn-primary'}`, m.where.error ? 'Try them' : `${m.tried ? 'Try them again on' : 'Try them on'} ${m.where.address}`);
  btn.type = 'button';
  btn.id = 'ltTry';
  btn.disabled = Boolean(m.where.error) || !m.scenarios.length;
  btn.title = m.where.error || `Sends them to ${m.where.address}${m.where.env ? ` (the ${m.where.env} environment)` : ''}: each with what it needs made first, so they make invoices, orders... there.`;
  btn.addEventListener('click', tryLogTestsMore);
  bar.appendChild(btn);
  if (m.where.error) bar.appendChild(vEl('span', 'lt-more-warn', m.where.error));
  else if (!m.where.local) bar.appendChild(vEl('span', 'lt-more-warn', 'Not this computer: they make and change things there'));
  head.appendChild(bar);
}

function renderLogTestsMore() {
  renderLogTestsMoreHead();
  const box = $('#ltList');
  box.textContent = '';
  const m = lt.more;
  if (!m || m.error) return;
  const items = new Map(((lt.plan && lt.plan.more) || []).map((it) => [it.id, it]));
  const unreached = m.unreached || [];
  const groups = m.groups.filter((g) => m.scenarios.some((s) => s.group === g) || unreached.some((u) => u.group === g));
  if (!groups.length) box.appendChild(vEl('div', 'list-note', 'Nothing to vary: the logs have no request that went well.'));
  for (const g of groups) {
    const head = vEl('div', 'lt-group');
    head.appendChild(vEl('span', 'lt-group-name', g));
    const seen = m.logs[g];
    head.appendChild(vEl('span', 'lt-group-seen', seen ? `in the logs: ${seen.join(' ')}` : 'never in the logs'));
    box.appendChild(head);
    for (const s of m.scenarios.filter((x) => x.group === g)) {
      const r = s.result;
      const failed = s.tried && s.tried.error;
      const on = lt.moreChosen.has(s.id);
      const row = vEl('div', `lt-row${s.id === lt.previewId ? ' active' : ''}${on ? '' : ' off'}`);
      row.dataset.id = s.id;
      if (r) {
        row.appendChild(ltCheckbox(on, `Make a test of ${s.label}`, (checked) => {
          if (checked) lt.moreChosen.add(s.id);
          else lt.moreChosen.delete(s.id);
          lt.previewId = s.id;
          lt.created = null;
          renderLogTestsDone();
          planLogTests();
        }));
      } else row.appendChild(vEl('span', 'lt-row-gap'));
      const main = vEl('div', 'lt-row-main');
      main.appendChild(ltRowLine(s.method, s.label, r ? String(r.status) : failed ? 'none' : '?', r ? ltStatusClass(r.status) : 'unknown'));
      // under it: its steps or the id it uses (the others say it all in their name), then what it answered
      const parts = [];
      if (s.kind === 'sequence' || s.kind === 'id') parts.push(vEl('span', 'lt-change', s.change));
      if (failed) parts.push(vEl('span', 'lt-bad', s.tried.error));
      else if (r) {
        if (r.message) parts.push(vEl('span', 'lt-said', `"${r.message.length > 90 ? `${r.message.slice(0, 90)}…` : r.message}"`));
        if (r.code && r.code.cause !== 'ok') parts.push(vEl('span', 'lt-code', `${r.code.file}:${r.code.line}`));
        else if (!r.code && m.code && m.code.controllers.length && r.status >= 400) parts.push('not in the code (the framework\'s)');
        if (r.same) parts.push('same answer as the logs');
        if (r.status >= 500) parts.push(vEl('span', 'lt-bad', 'the service failed: a case the code does not handle?'));
        const it = items.get(s.id);
        if (it && on && it.exists) parts.push(vEl('span', 'lt-warn', 'there already: written over'));
      } else parts.push('not tried yet');
      const sub = vEl('div', 'lt-row-sub');
      parts.forEach((part, i) => sub.append(...(i ? [' · ', part] : [part])));
      main.appendChild(sub);
      row.appendChild(main);
      row.addEventListener('click', () => ltSelect(s.id));
      box.appendChild(row);
    }
    // what the code answers and nobody got to
    for (const u of unreached.filter((x) => x.group === g)) {
      const row = vEl('div', 'lt-row lt-row-out');
      row.appendChild(vEl('span', 'lt-row-gap'));
      const main = vEl('div', 'lt-row-main');
      main.appendChild(ltRowLine(u.method, u.message ? `"${u.message}"` : u.cause === 'ok' ? 'goes well' : `answers ${u.status}`, String(u.status), `${ltStatusClass(u.status)} expected`));
      main.appendChild(vEl('div', 'lt-row-sub', `${u.file}:${u.line} · ${u.never ? 'never in the logs: call it once, then make the tests again' : LT_CAUSE[u.cause] || LT_CAUSE.input}${u.condition && u.cause !== 'ok' ? ` (${u.condition.length > 70 ? `${u.condition.slice(0, 70)}…` : u.condition})` : ''}`));
      row.appendChild(main);
      row.title = 'The code answers this, and nothing in the logs or tried got to it';
      box.appendChild(row);
    }
  }
}

function renderLogTestsPreview(error) {
  const head = $('#ltPreviewHead');
  const pre = $('#ltPreview');
  head.textContent = '';
  head.classList.remove('bad');
  pre.textContent = '';
  const it = lt.plan && (lt.plan.items.find((x) => x.id === lt.previewId) || lt.plan.more.find((x) => x.id === lt.previewId));
  const s = !it && lt.more && lt.more.scenarios && lt.more.scenarios.find((x) => x.id === lt.previewId);
  if (s) {
    head.appendChild(vEl('div', 'lt-preview-name', `${s.method} ${s.template} · ${s.label}`));
    head.appendChild(vEl('div', 'lt-preview-file', s.change));
    pre.textContent = s.tried && s.tried.error ? `It got no answer: ${s.tried.error}` : 'Not tried yet: Try sends it, and the test checks what it answers.';
    return;
  }
  if (error || !it) {
    head.textContent = error || (lt.found.cases.length ? 'Choose a request to see its test.' : '');
    head.classList.toggle('bad', Boolean(error));
    return;
  }
  head.appendChild(vEl('div', 'lt-preview-name', it.name));
  head.appendChild(vEl('div', 'lt-preview-file', `${lt.plan.folder}/${it.file}${it.multi ? `/ (${it.steps} steps)` : ''}${it.exists ? ' (there already: written over)' : ''}`));
  if (lt.plan.previewSteps) head.appendChild(vEl('div', 'lt-preview-steps', lt.plan.previewSteps.join('  →  ')));
  if (it.secrets && it.secrets.length) head.appendChild(vEl('div', 'lt-preview-file warn', `${it.secrets.map((x) => `{{${x}}}`).join(', ')}: not in the logs, set it in the environment`));
  pre.textContent = lt.plan.preview || '';
}

function renderLogTestsDone() {
  const done = lt && lt.created;
  $('#ltDone').classList.toggle('hidden', !done);
  $('#ltOpen').classList.toggle('hidden', !done);
  $('#ltRun').classList.toggle('hidden', !done);
  $('#ltCreate').classList.toggle('hidden', Boolean(done));
  if (!done) return;
  const col = ltCollection();
  $('#ltDone').textContent = `${logsPlural(done.tests, 'test')} in ${col ? col.repoName : ''} › ${done.folder}${done.replaced ? ` (${done.replaced} written over)` : ''}`;
}

async function createLogTests() {
  if (!lt || !lt.plan) return;
  const btn = $('#ltCreate');
  btn.disabled = true;
  const r = await window.logTests.create(lt.token, ltOptions());
  btn.disabled = false;
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  lt.created = r;
  renderLogTestsDone();
  await planLogTests(); // they are there now
  toast(`${logsPlural(r.tests, 'Bruno test')} written`, 'success');
}

// The repository's Bruno page with the new folder open and its first test chosen; run: the folder runs there.
async function showLogTestsInBruno(run) {
  const col = ltCollection();
  const done = lt && lt.created;
  if (!col || !done) return;
  closeLogTests();
  bruSave(BRU_DIR_KEY, col.repo, col.dir);
  const st = bruState(col.dir);
  st.selected = done.written[0] || st.selected;
  st.closed.delete(done.folder);
  gitViewChoice = 'bruno';
  currentRepo = col.repo;
  setMode('git');
  renderSidebar();
  await refresh();
  applyGitView();
  if (!run) return;
  if (bru.dir !== col.dir || !bruRequests(bru.tree, done.folder).length) {
    toast('The tests are written, but the Bruno page does not show them yet: run the folder from there', 'error');
    return;
  }
  bruRun(done.folder, done.folder.split('/').pop());
}

function setupLogTests() {
  $('#logsTestsBtn').addEventListener('click', openLogTests);
  $('#ltClose').addEventListener('click', closeLogTests);
  $('#ltModal').addEventListener('mousedown', (e) => {
    if (e.target.id === 'ltModal') closeLogTests();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#ltModal').classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeLogTests();
    }
  }, true);
  $('#ltTabLogs').addEventListener('click', () => showLogTestsTab('logs'));
  $('#ltTabMore').addEventListener('click', () => showLogTestsTab('more'));
  $('#ltCollection').addEventListener('change', () => {
    renderLogTestsBases(true);
    lt.created = null;
    lt.more = null;
    lt.moreChosen = new Set();
    renderLogTestsDone();
    if (lt.tab === 'more') loadLogTestsMore();
    planLogTests();
  });
  for (const id of ['#ltFolder', '#ltBase']) {
    $(id).addEventListener('input', () => {
      if (lt) lt.created = null;
      renderLogTestsDone();
      planLogTestsSoon();
    });
  }
  $('#ltAll').addEventListener('change', () => {
    lt.chosen = $('#ltAll').checked ? new Set(lt.found.cases.map((c) => c.id)) : new Set();
    lt.created = null;
    renderLogTestsDone();
    planLogTests();
  });
  $('#ltCreate').addEventListener('click', createLogTests);
  $('#ltOpen').addEventListener('click', () => showLogTestsInBruno(false));
  $('#ltRun').addEventListener('click', () => showLogTestsInBruno(true));
}
