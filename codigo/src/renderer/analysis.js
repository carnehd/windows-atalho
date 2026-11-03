// Analysis page: looks across the microservices of the list, one analysis at a time (listed on the left).
// Swagger files: every .yaml (and spec .json) in the folders to look in (swagger and openapi, unless others are chosen
// with Folders), and the specs elsewhere, per microservice, with name, path, title and version; or, compared with a
// repository of the list (the technical documentation), whether each one is up to date there.
// Relies on helpers from app.js ($, $$, toast, repos, repoGroups, updateCrumb, CARD_ID) and tools.js (tEl, toolHead,
// toolButton, toolInput, toolCopy, debounce).
const ANALYSES = [
  { id: 'swagger', title: 'Swagger files', sub: 'Find them, compare them', build: buildSwaggerAnalysis },
];

// One scan of the folders serves the page; Scan again reads them again, and so does a change in the list of
// repositories or in the folders to look in.
let anScan = null;
let anScanList = '';
const anReposKey = () => repos.map((r) => r.path).sort().join('\n');
function swaggerScan(force = false) {
  const list = anReposKey();
  if (!anScan || force || list !== anScanList) {
    anScanList = list;
    anScan = window.analysis.swagger().then((r) => {
      if (r.error) anScan = null;
      return r;
    });
  }
  return anScan;
}
const ANALYSIS_KEY = 'analysisCurrent';
let currentAnalysis = 'swagger';
const builtAnalyses = new Map();

function analysisTitle(id) {
  const a = ANALYSES.find((x) => x.id === id);
  return a ? a.title : '';
}

// -- The folders to look in: names (swagger), found at any depth, and paths from the root of each repository (docs/api);
// and whether the specs outside them are found too (by their openapi: or swagger: line). Saved in the app's data; a
// change scans again. --
let anFolders = null; // as last read from the app
const anFoldersText = (list) => (list && list.length ? list.join(', ') : 'none');

function anFoldersModal() {
  let modal = $('#anFoldersModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'anFoldersModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card af-card" role="dialog" aria-modal="true" aria-labelledby="afTitle">
      <h3 id="afTitle">Where to look for swagger files</h3>
      <p class="mv-sub">Every .yaml, .yml and .json spec inside these folders, at any depth, in each microservice of your list. A name (swagger) is looked for anywhere in a repository, with or without a final s (swaggers); a path (docs/api) is taken from the root of each one.</p>
      <ul id="afList" class="af-list" aria-label="Folders to look in"></ul>
      <div class="af-add">
        <input id="afInput" class="input af-input" maxlength="200" placeholder="swagger, or docs/api" autocomplete="off" spellcheck="false" aria-label="Folder name or path" />
        <button id="afAddBtn" class="btn btn-sm" type="button">Add</button>
        <button id="afPickBtn" class="btn btn-sm" type="button" title="Choose a folder inside one of your microservices: its path from the root is added">Choose a folder...</button>
      </div>
      <p id="afNote" class="me-note" aria-live="polite"></p>
      <div class="action-row settings-actions"><span class="mv-gap"></span><button id="afDoneBtn" class="btn btn-primary" type="button">Done</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeAnFolders();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeAnFolders();
    }
  });
  $('#afDoneBtn').addEventListener('click', closeAnFolders);
  $('#afAddBtn').addEventListener('click', () => addAnFolder($('#afInput').value));
  $('#afInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addAnFolder($('#afInput').value);
    }
  });
  $('#afInput').addEventListener('input', () => anFoldersNote(''));
  $('#afPickBtn').addEventListener('click', async () => {
    const r = await window.analysis.pickFolder();
    if (r.canceled) return;
    if (r.error) return anFoldersNote(r.error, true);
    addAnFolder(r.folder, `${r.folder} (from ${r.repo})`);
  });
  return modal;
}

function anFoldersNote(text, error = false) {
  const note = $('#afNote');
  note.textContent = text;
  note.classList.toggle('error', error);
}

function renderAnFolders() {
  const list = $('#afList');
  list.replaceChildren(
    ...anFolders.map((f) => {
      const li = tEl('li', 'af-item');
      li.append(tEl('span', 'af-name', f), tEl('span', 'af-kind', f.includes('/') ? 'path from the root' : 'name, at any depth'));
      const x = tEl('button', 'af-remove', '\u2715');
      x.type = 'button';
      x.title = `Stop looking in ${f}`;
      x.setAttribute('aria-label', `Remove ${f}`);
      x.addEventListener('click', async () => {
        await saveAnFolders(anFolders.filter((o) => o !== f), `${f} removed`);
        // its button is gone: the focus stays in the dialog (Esc still closes it)
        $('#afInput').focus();
      });
      li.appendChild(x);
      return li;
    })
  );
  if (!anFolders.length) list.appendChild(tEl('li', 'af-empty', 'No folders: nothing is looked for. Add one below.'));
}

let anFoldersChanged = false;
async function saveAnFolders(next, said) {
  const r = await window.analysis.setFolders(next);
  if (r.error) return anFoldersNote(r.error, true);
  anFolders = r.folders;
  anFoldersChanged = true;
  renderAnFolders();
  anFoldersNote(said);
}

function addAnFolder(text, said) {
  const t = String(text || '').trim();
  if (!t) return anFoldersNote('Type a folder name, like swagger, or a path, like docs/api', true);
  if (anFolders.some((f) => f.toLowerCase() === t.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase())) return anFoldersNote(`${t} is in the list already`, true);
  $('#afInput').value = '';
  saveAnFolders([...anFolders, t], `${said || t} added`);
}

async function openAnFolders() {
  const modal = anFoldersModal();
  const r = await window.analysis.folders();
  anFolders = r.folders || [];
  anFoldersChanged = false;
  renderAnFolders();
  anFoldersNote('');
  modal.classList.remove('hidden');
  $('#afInput').focus();
}

// Closed: with the folders changed, the analysis on show reads them again (the other one when it is shown).
function closeAnFolders() {
  const modal = $('#anFoldersModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  if (!anFoldersChanged) return;
  anScan = null;
  anScanList = '';
  const built = builtAnalyses.get(currentAnalysis);
  if (built && built.shown) built.shown(true);
}

// a .yaml without openapi: nor info: in a swagger folder: the models a spec points to with $ref
const AN_PART = 'A part of a spec (no openapi: nor info:)';

// -- Compare with documentation --
// A technical documentation repository holds a copy of each microservice's swagger files: by the same file name, in
// any of its folders (docs/technical/swaggers/catalog-api.yaml), or in a folder named after the microservice
// (swagger/orders-service/orders-api.yaml). Each file is matched with its copy by its place in that folder, then by
// name (.yaml, .yml and .json alike), then by title, then by the microservice's name (orders-service.yaml). The
// content says whether the copy is the same (whatever the order of its keys or its format), the versions which side
// is behind, and Compare APIs which endpoints and models differ.
const DOC_STATES = {
  same: ['Up to date', 'good'],
  msBehind: ['Microservice is behind', 'warn'],
  content: ['Same version, other content', 'warn'],
  other: ['Other content', 'warn'],
  differ: ['Different versions', 'warn'],
  docBehind: ['Documentation is behind', 'info'],
  missing: ['Not in the documentation', 'bad'],
  extra: ['Only in the documentation', 'muted'],
  broken: ['Cannot compare', 'bad'],
};

// 1.10.0 > 1.9.4; 2.0.0 > 2.0.0-RC1 > 2.0.0-RC0. null when either is not a version.
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:[-+.]?(.*))?$/i.exec(String(v || '').trim());
    return m ? { nums: m[1].split('.').map(Number), pre: m[2] || '' } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return String(a) === String(b) ? 0 : null;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return Math.sign(x.pre.localeCompare(y.pre, undefined, { numeric: true, sensitivity: 'base' }));
}

const anKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
// catalog-api.yaml, catalog-api.yml and catalog-api.json: the same file
const specBase = (name) => String(name || '').toLowerCase().replace(/\.(ya?ml|json)$/, '');
const folderOf = (s) => s.path.split(/[\\/]/).pop();

function docComparison(data, docPath) {
  const doc = data.services.find((s) => s.path === docPath);
  const services = data.services.filter((s) => s.path !== docPath);
  const byKey = new Map();
  for (const s of services) {
    byKey.set(anKey(folderOf(s)), s);
    byKey.set(anKey(s.name), s);
  }
  // the documentation's files, each with the microservice whose folder it is in (when it is in one)
  const left = (doc ? doc.files : []).map((d) => {
    const parts = (d.inner || d.rel).split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const s = byKey.get(anKey(parts[i]));
      if (s) return { d, scope: s, inner: parts.slice(i + 1).join('/') };
    }
    return { d, scope: null, inner: d.inner || d.rel };
  });
  const free = services.flatMap((s) => s.files.map((f) => ({ s, f })));
  const copyOf = new Map(); // a microservice's file -> its copy in the documentation
  const why = new Map(); // a file of the documentation -> why no microservice's file is matched with it
  // one way of matching: a file of the documentation takes the one file of a microservice it fits (narrow: of
  // several, those that fit better)
  const pass = (fits, narrow) => {
    for (const x of [...left]) {
      let found = free.filter((p) => (!x.scope || p.s === x.scope) && fits(p, x));
      if (found.length > 1 && narrow) {
        const fewer = found.filter((p) => narrow(p, x));
        if (fewer.length) found = fewer;
      }
      if (found.length === 1) {
        copyOf.set(found[0].f, x.d);
        free.splice(free.indexOf(found[0]), 1);
        left.splice(left.indexOf(x), 1);
      } else if (found.length > 1 && !why.has(x.d)) {
        why.set(x.d, `it could be the copy of ${found.map((p) => `${p.s.name} / ${p.f.rel}`).join(', ')}`);
      }
    }
  };
  const sameTitle = (p, x) => Boolean(p.f.title) && p.f.title === x.d.title;
  pass((p, x) => Boolean(x.scope) && String(p.f.inner || '').toLowerCase() === x.inner.toLowerCase());
  pass((p, x) => specBase(p.f.name) === specBase(x.d.name), sameTitle);
  pass(sameTitle);
  const onlySpec = (s) => free.filter((o) => o.s === s && !o.f.part).length === 1;
  pass((p, x) => !p.f.part && !x.d.part && [anKey(p.s.name), anKey(folderOf(p.s))].includes(anKey(specBase(x.d.name))) && onlySpec(p.s));
  const result = [];
  for (const s of services) {
    const rows = s.files.map((f) => docRow(f, copyOf.get(f) || null));
    for (const x of left) if (x.scope === s) rows.push(docRow(null, x.d));
    if (rows.length) result.push({ service: s, rows });
  }
  const unlinked = left.filter((x) => !x.scope).map((x) => ({ ...docRow(null, x.d), why: why.get(x.d) || '' }));
  return { doc, services: result.sort((a, b) => a.service.name.localeCompare(b.service.name)), unlinked };
}

function docRow(svc, doc) {
  let state;
  if (!doc) state = 'missing';
  else if (!svc) state = 'extra';
  else if (svc.error || doc.error) state = 'broken';
  else if (svc.hash && svc.hash === doc.hash) state = 'same';
  else if (!svc.version && !doc.version) state = 'other';
  else {
    const c = compareVersions(svc.version, doc.version);
    state = c === 0 ? 'content' : c === 1 ? 'docBehind' : c === -1 ? 'msBehind' : 'differ';
  }
  return { name: (svc || doc).name, svc, doc, state };
}

// What Compare APIs says of a microservice's file and its copy, by their paths and fingerprints: asked once, again
// when either file changes. Shown on the state's tag (hover) and in Copy as table.
const anDiffs = new Map();
const anDiffKey = (docPath, svcPath, r) => [docPath, r.doc.rel, r.doc.hash, svcPath, r.svc.rel, r.svc.hash].join('\n');
const anWantsDiff = (r) => r.svc && r.doc && r.state !== 'same' && r.state !== 'broken' && !r.svc.part && !r.doc.part;
const AN_DIFF_TAG = { added: 'only in the microservice', removed: 'only in the documentation', changed: 'changed' };

function anDiffText(d) {
  if (!d) return 'Comparing the endpoints...';
  if (d.error) return `Endpoints not compared: ${d.error}`;
  const s = d.summary;
  const list = (x) => [x.added && `${x.added} ${AN_DIFF_TAG.added}`, x.removed && `${x.removed} ${AN_DIFF_TAG.removed}`, x.changed && `${x.changed} ${AN_DIFF_TAG.changed}`].filter(Boolean).join(', ');
  const parts = [];
  if (s.added || s.removed || s.changed) parts.push(`Endpoints: ${list(s)}`);
  if (s.models.added || s.models.removed || s.models.changed) parts.push(`Models: ${list(s.models)}`);
  return parts.length ? parts.join(' · ') : 'Same endpoints and models: only the version, descriptions or other details differ';
}

// -- Filters as tags, on the name of the file and of the microservice: a row is shown when it passes every one of them
// (one and the other). Doesn't contain: neither name has the text; the others: one of the names. --
const AN_FILTER_KINDS = {
  starts: ['starts with', (name, t) => name.startsWith(t)],
  ends: ['ends with', (name, t) => name.endsWith(t)],
  has: ['contains', (name, t) => name.includes(t)],
  not: ["doesn't contain", (name, t) => !name.includes(t)],
};

function anPassesFilters(filters, names) {
  return filters.every((f) => {
    const test = AN_FILTER_KINDS[f.kind][1];
    return f.kind === 'not' ? names.every((n) => test(n, f.low)) : names.some((n) => test(n, f.low));
  });
}

// The filters as tags in a row under the bar, "and" between them; + Filter adds one, its kind and its text in a small
// popover (Enter or Add adds it, Esc or Cancel closes it, Backspace in its empty text takes the last one away). ✕ takes
// one away, Clear all every one. onChange() after each change.
function anFilters(onChange) {
  const filters = [];
  const row = tEl('div', 'an-filter-row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Filters on the file or microservice name, all of them must match');
  const tags = tEl('span', 'an-ftags');
  const none = tEl('span', 'an-filter-none', 'none');
  const clear = tEl('button', 'an-link an-filter-clear', 'Clear all');
  clear.type = 'button';
  row.append(tEl('span', 'an-filter-key', 'Filters:'), tags, none, clear);

  const add = tEl('div', 'an-addf');
  const open = tEl('button', 'btn btn-sm btn-primary an-add-filter', '+ Filter');
  open.type = 'button';
  open.title = 'Add a filter on the file or microservice name: starts with, ends with, contains, doesn\'t contain';
  open.setAttribute('aria-haspopup', 'dialog');
  open.setAttribute('aria-expanded', 'false');
  const pop = tEl('div', 'an-fpop hidden');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Add a filter');
  const kind = tEl('select', 'input an-fkind');
  kind.setAttribute('aria-label', 'Kind of filter');
  for (const [k, [label]] of Object.entries(AN_FILTER_KINDS)) kind.appendChild(new Option(label, k));
  const input = tEl('input', 'input an-finput');
  input.type = 'text';
  input.placeholder = 'text';
  input.spellcheck = false;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-label', 'Text of the filter (Enter adds it)');
  const fields = tEl('div', 'an-fpop-fields');
  fields.append(kind, input);
  const cancel = tEl('button', 'btn btn-sm', 'Cancel');
  cancel.type = 'button';
  const ok = tEl('button', 'btn btn-sm btn-primary', 'Add');
  ok.type = 'button';
  const buttons = tEl('div', 'an-fpop-actions');
  buttons.append(cancel, ok);
  pop.append(tEl('div', 'an-fpop-title', 'Add a filter on the file or microservice name'), fields, buttons);
  add.append(open, pop);

  const changed = () => {
    draw();
    onChange();
  };
  const draw = () => {
    tags.replaceChildren();
    filters.forEach((f, i) => {
      if (i) tags.appendChild(tEl('span', 'an-fand', 'and'));
      const label = AN_FILTER_KINDS[f.kind][0];
      const t = tEl('span', `an-ftag ${f.kind}`);
      t.append(tEl('span', 'an-ftag-kind', label), tEl('span', 'an-ftag-text', f.text));
      const x = tEl('button', 'an-ftag-x', '✕');
      x.type = 'button';
      x.title = 'Remove this filter';
      x.setAttribute('aria-label', `Remove the filter ${label} ${f.text}`);
      x.addEventListener('click', () => {
        filters.splice(i, 1);
        changed();
        open.focus();
      });
      t.appendChild(x);
      tags.appendChild(t);
    });
    none.classList.toggle('hidden', filters.length > 0);
    clear.classList.toggle('hidden', !filters.length);
  };
  const outside = (e) => {
    if (!add.contains(e.target) && !e.target.closest('.sel-menu')) close(false);
  };
  const close = (refocus = true) => {
    if (pop.classList.contains('hidden')) return;
    pop.classList.add('hidden');
    open.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    if (refocus) open.focus();
  };
  const show = () => {
    pop.classList.remove('hidden');
    open.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    input.focus();
  };
  const put = () => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const f = { kind: kind.value, text, low: text.toLowerCase() };
    if (!filters.some((o) => o.kind === f.kind && o.low === f.low)) filters.push(f);
    input.value = '';
    close();
    changed();
  };
  open.addEventListener('click', () => (pop.classList.contains('hidden') ? show() : close()));
  cancel.addEventListener('click', () => close());
  ok.addEventListener('click', put);
  clear.addEventListener('click', () => {
    filters.length = 0;
    changed();
    open.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      put();
    } else if (e.key === 'Backspace' && !input.value && filters.length) {
      filters.pop();
      changed();
    }
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  draw();
  return { row, button: add, filters, input, kind, open: show };
}

const AN_REFRESH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>';

// -- Swagger files: one page. Up top, where to look (the folders, and the specs outside them). One bar: which
// microservices, which file; Compare with nothing (the list, with title and version) or a repository of the list (the
// technical documentation: each file next to its copy there, as above); the search and + Filter. Under it the filters,
// Only differences and how many; then the states as tags in a row (a click picks some) and one table, a row a file. --
const AN_COMPARE_KEY = 'analysisCompareWith';
const AN_MS_COLOURS = 8; // .an-ms-tag.ms0 to .ms7 in the styles

// A microservice's name in a colour, by its place in the list of repositories in alphabetical order: the ones next to
// each other in a table never share one, and each keeps its colour from one look to the next (Compare APIs too).
function anMsTag(s) {
  const sorted = [...repos].sort((x, y) => displayName(x).localeCompare(displayName(y)));
  const at = Math.max(0, sorted.findIndex((r) => r.path === s.path));
  const tag = tEl('span', `an-ms-tag ms${at % AN_MS_COLOURS}`, s.name);
  tag.title = s.path;
  return tag;
}
const AN_KIND = (f) => (f.spec.startsWith('Swagger') ? 'Swagger 2.0' : f.spec.startsWith('OpenAPI') ? 'OpenAPI 3' : '');

function buildSwaggerAnalysis() {
  const box = tEl('div', 'tool an-tool an-docs-tool');
  let data = null;
  let loading = false;
  let diffing = false;
  let onlyDiff = false;
  let seen = null; // the scan shown
  const picked = new Set(); // the states chosen in the legend (none: every one)
  // the title, and what acts on the whole page
  const title = tEl('h2', '', 'Swagger files');
  const rescan = tEl('button', 'btn btn-sm btn-icon an-icon-btn');
  rescan.type = 'button';
  rescan.innerHTML = AN_REFRESH_SVG;
  rescan.title = 'Scan again: read the folders again';
  rescan.setAttribute('aria-label', 'Scan again');
  rescan.addEventListener('click', () => scan(true));
  const copyTable = toolButton('Copy as table', () => toolCopy(tableText(), 'Table'));
  copyTable.title = 'Copy the files shown, as a table for Excel or a document';
  const foldersBtn = tEl('button', 'btn btn-sm an-folders-btn', 'Folders');
  foldersBtn.type = 'button';
  foldersBtn.title = 'Where to look for the swagger files: the folders';
  foldersBtn.addEventListener('click', openAnFolders);
  const anywhere = toolCheck('and outside them', true, async (on) => {
    await window.analysis.setAnywhere(on);
    scan(true);
  });
  anywhere.title = 'Also the OpenAPI and Swagger files outside the folders, found by their openapi: or swagger: line at the top';
  const anywhereBox = anywhere.querySelector('input');
  const top = tEl('div', 'an-top');
  const actions = tEl('div', 'an-top-actions');
  actions.append(foldersBtn, anywhere, rescan, copyTable);
  top.append(title, actions);

  // one bar: Microservices and File, Compare with, the search and + Filter
  const scope = tEl('select', 'input an-group an-scope');
  scope.id = 'anScope';
  scope.dataset.search = '';
  scope.setAttribute('aria-label', 'Which microservices');
  const fileSel = tEl('select', 'input an-group an-file');
  fileSel.id = 'anFile';
  fileSel.dataset.search = '';
  fileSel.setAttribute('aria-label', 'Which swagger file');
  const cmpSel = tEl('select', 'input an-group an-doc');
  cmpSel.id = 'anCompare';
  cmpSel.dataset.search = '';
  const cmpKey = tEl('label', 'an-bar-key', 'Compare with');
  cmpKey.htmlFor = 'anCompare';
  const search = toolInput('Search');
  search.type = 'search';
  search.classList.add('an-search');
  search.title = 'Search the microservice, file, path, title, version and state';
  search.setAttribute('aria-label', 'Search');
  const filters = anFilters(() => render());
  const fieldBar = tEl('div', 'an-fieldbar');
  fieldBar.append(scope, fileSel, tEl('span', 'an-sep'), cmpKey, cmpSel, tEl('span', 'an-sep'), search, filters.button);

  // under it: the filters, Only differences and how many
  const only = toolCheck('Only differences', false, (v) => {
    onlyDiff = v;
    render();
  });
  const state = tEl('span', 'an-status');
  const stateMore = tEl('span', 'an-status-more');
  const under = tEl('div', 'an-under');
  under.append(filters.row, tEl('span', 'an-gap'), only, state, stateMore);

  // the states as tags in a row (the list: what was found), then the table
  const legend = tEl('div', 'an-legend');
  const result = tEl('div', 'an-result');

  const scan = async (force) => {
    if (loading) return;
    loading = true;
    rescan.disabled = true;
    rescan.classList.add('busy');
    state.textContent = `Looking in ${repos.length} microservice${repos.length === 1 ? '' : 's'}...`;
    stateMore.textContent = '';
    const scanning = swaggerScan(force);
    seen = scanning;
    const r = await scanning;
    loading = false;
    rescan.disabled = false;
    rescan.classList.remove('busy');
    if (r.error) {
      state.textContent = '';
      legend.textContent = '';
      result.textContent = '';
      result.appendChild(tEl('div', 'tool-error', r.error));
      return;
    }
    data = r;
    anywhereBox.checked = r.anywhere !== false;
    foldersBtn.textContent = `Folders: ${anFoldersText(r.folders)}`;
    fillFiles();
    render();
  };

  const repoOf = (p) => repos.find((r) => r.path === p);
  const source = () => (cmpSel.value ? repoOf(cmpSel.value) : null);
  const fillScope = () => {
    const keep = scope.value || 'all';
    scope.textContent = '';
    scope.appendChild(new Option(`All microservices (${repos.length})`, 'all'));
    if (repoGroups.length) {
      const og = document.createElement('optgroup');
      og.label = 'Groups';
      for (const g of repoGroups) og.appendChild(new Option(g.name, `g:${g.id}`));
      og.appendChild(new Option('Not in a group', 'none'));
      scope.appendChild(og);
    }
    const og = document.createElement('optgroup');
    og.label = 'One microservice';
    for (const r of [...repos].sort((a, b) => displayName(a).localeCompare(displayName(b)))) og.appendChild(new Option(displayName(r), `r:${r.path}`));
    scope.appendChild(og);
    scope.value = [...scope.options].some((o) => o.value === keep) ? keep : 'all';
  };
  // every file name found (catalog-api.yaml and catalog-api.yml are one)
  const fillFiles = () => {
    const keep = fileSel.value;
    const names = new Map();
    for (const s of data ? data.services : []) for (const f of s.files) if (!names.has(specBase(f.name))) names.set(specBase(f.name), f.name);
    fileSel.textContent = '';
    fileSel.appendChild(new Option('Every swagger file', ''));
    for (const [base, name] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) fileSel.appendChild(new Option(name, base));
    fileSel.value = [...fileSel.options].some((o) => o.value === keep) ? keep : '';
  };
  // nothing, or a repository of the list: the documentation (by its name) first
  const fillCompare = () => {
    let saved = '';
    try {
      saved = localStorage.getItem(AN_COMPARE_KEY) || '';
    } catch {
      // none kept
    }
    const keep = cmpSel.value || saved;
    cmpSel.textContent = '';
    cmpSel.appendChild(new Option('Nothing: just list them', ''));
    const og = document.createElement('optgroup');
    og.label = 'A repository of your list';
    const isDoc = (r) => /document|docs/.test(anKey(displayName(r))) || /document|docs/.test(anKey(r.path.split(/[\\/]/).pop()));
    const sorted = [...repos].sort((a, b) => Number(isDoc(b)) - Number(isDoc(a)) || displayName(a).localeCompare(displayName(b)));
    for (const r of sorted) og.appendChild(new Option(displayName(r), r.path));
    cmpSel.appendChild(og);
    cmpSel.value = keep && [...cmpSel.options].some((o) => o.value === keep) ? keep : '';
  };

  const inScope = (service) => {
    const v = scope.value || 'all';
    if (v === 'all') return true;
    if (v.startsWith('r:')) return service.path === v.slice(2);
    const r = repoOf(service.path);
    const ids = new Set(repoGroups.map((g) => g.id));
    if (v === 'none') return !r || !ids.has(r.group);
    return Boolean(r) && r.group === v.slice(2);
  };
  const ofFile = (name) => !fileSel.value || specBase(name) === fileSel.value;
  const query = () => search.value.trim().toLowerCase();
  const passes = (fileName, serviceName) => anPassesFilters(filters.filters, serviceName ? [fileName.toLowerCase(), serviceName.toLowerCase()] : [fileName.toLowerCase()]);

  // one table, a row a file: the column names, then the rows
  const table = (heads) => {
    const t = tEl('table', 'an-table');
    const tr = t.createTHead().insertRow();
    for (const [text, cls] of heads) tr.appendChild(tEl('th', cls || '', text));
    result.appendChild(t);
    return t.createTBody();
  };
  const cell = (tr, cls, ...children) => {
    const td = tr.insertCell();
    if (cls) td.className = cls;
    td.append(...children);
    return td;
  };
  const msTag = anMsTag;

  // -- the list --
  const listed = () => {
    const q = query();
    return data.services
      .filter(inScope)
      .map((s) => {
        const named = q && s.name.toLowerCase().includes(q);
        const files = s.files.filter((f) => ofFile(f.name) && passes(f.name, s.name) && (!q || named || [f.name, f.rel, f.title, f.version].join(' ').toLowerCase().includes(q)));
        return { ...s, files };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const renderList = () => {
    const services = listed();
    const withFiles = services.filter((s) => s.files.length);
    const files = withFiles.flatMap((s) => s.files);
    const narrowed = query() || filters.filters.length || fileSel.value;
    state.textContent = `${files.length} file${files.length === 1 ? '' : 's'} in ${withFiles.length} microservice${withFiles.length === 1 ? '' : 's'}${narrowed ? ' match' : ''}`;
    stateMore.textContent = `\u00b7 ${(data.took / 1000).toFixed(1)} s`;
    const looked = data.folders || [];
    if (!withFiles.length) {
      const why = narrowed ? 'Nothing matches the search and the filters.' : looked.length || data.anywhere ? `No swagger files in these microservices${looked.length ? ` (looked in ${anFoldersText(looked)}${data.anywhere ? ', and for specs elsewhere' : ''})` : ''}. Folders chooses where to look.` : 'No folders to look in: add one with Folders.';
      result.appendChild(tEl('div', 'tool-hint an-empty', why));
    } else {
      const rows = table([['Microservice', 'an-col-ms'], ['Name'], ['Path'], ['Title'], ['Version', 'an-col-ver']]);
      for (const s of withFiles) {
        for (const f of s.files) {
          const tr = rows.insertRow();
          const ms = cell(tr, 'an-ms', msTag(s));
          ms.title = `${s.path}\nIn: ${s.dirs.join(', ') || 'no folder to look in'}`;
          const fname = cell(tr, 'an-name', f.name);
          fname.title = [f.spec, f.found === 'content' ? `Found by its ${f.spec.startsWith('Swagger') ? 'swagger:' : 'openapi:'} line, outside the folders to look in` : ''].filter(Boolean).join('\n');
          const open = tEl('button', 'an-open', f.rel);
          open.type = 'button';
          open.title = `Open ${f.rel}`;
          open.addEventListener('click', async () => {
            const r = await window.analysis.open(s.path, f.rel);
            if (r.error) toast(r.error, 'error');
          });
          cell(tr, 'an-path', open);
          cell(tr, `an-title${f.error ? ' tool-error' : f.part ? ' an-part' : ''}`, f.error || (f.part ? AN_PART : f.title || '—'));
          cell(tr, 'an-version', ...(f.version ? [tEl('span', 'tool-badge', f.version)] : []));
        }
      }
    }
    if (!narrowed) {
      const none = services.filter((s) => !s.files.length && !s.missing).map((s) => s.name);
      const missing = services.filter((s) => s.missing).map((s) => s.name);
      if (none.length) result.appendChild(tEl('div', 'tool-hint an-none', `No swagger files: ${none.join(', ')}`));
      if (missing.length) result.appendChild(tEl('div', 'tool-error an-none', `Folder not found: ${missing.join(', ')}`));
    }
    // over the table, in a row: what was found
    const note = (text, tone = 'muted') => legend.appendChild(tEl('span', `an-chip an-note ${tone}`, text));
    const kinds = ['OpenAPI 3', 'Swagger 2.0'].map((k) => [k, files.filter((f) => !f.error && AN_KIND(f) === k).length]).filter(([, n]) => n);
    if (kinds.length) note(kinds.map(([k, n]) => `${n} ${k}`).join(' · '));
    const parts = files.filter((f) => f.part).length;
    if (parts) note(`${parts} part${parts === 1 ? '' : 's'} of a spec ($ref)`);
    const outside = files.filter((f) => f.found === 'content').length;
    if (outside) note(`${outside} found outside the folders`);
    const broken = files.filter((f) => f.error).length;
    if (broken) note(`${broken} not readable`, 'bad');
  };

  // -- the comparison --
  const diffOf = (g, r) => (anWantsDiff(r) ? anDiffs.get(anDiffKey(cmpSel.value, g.service.path, r)) : null);
  const searched = (q, g, r) => !q || [g ? g.service.name : '', r.name, r.svc && r.svc.title, r.doc && r.doc.title, r.svc && r.svc.version, r.doc && r.doc.version, DOC_STATES[r.state][0]].join(' ').toLowerCase().includes(q);
  // the rows in what is looked at, after the search, the filters and Only differences; and the states chosen on the
  // right, unless not asked
  const narrow = (all, byState) => {
    const q = query();
    const keep = (g, r) => ofFile(r.name)
      && (!onlyDiff || r.state !== 'same')
      && searched(q, g, r)
      && passes(r.name, g && g.service.name)
      && (!byState || !picked.size || picked.has(r.state));
    return {
      services: all.services.filter((g) => inScope(g.service)).map((g) => ({ ...g, rows: g.rows.filter((r) => keep(g, r)) })).filter((g) => g.rows.length),
      // the source's files no microservice has: when every microservice is looked at
      unlinked: (scope.value || 'all') === 'all' ? all.unlinked.filter((r) => keep(null, r)) : [],
    };
  };

  // Compare APIs with the source's copy as the old one (Compare texts for a part of a spec)
  const compareFiles = async (g, r) => {
    const doc = data.services.find((s) => s.path === cmpSel.value);
    const [a, b] = await Promise.all([window.analysis.read(doc.path, r.doc.rel), window.analysis.read(g.service.path, r.svc.rel)]);
    if (a.error || b.error) {
      toast(a.error || b.error, 'error');
      return;
    }
    const left = `${doc.name} / ${r.doc.rel}`;
    const right = `${g.service.name} / ${r.svc.rel}`;
    if (r.svc.part || r.doc.part) openInCompare(a.text, b.text, `Left: ${left}   ·   Right: ${right}`);
    else openInApiCompare(a.text, b.text, { ms: doc.name, path: doc.path, file: r.doc.rel }, { ms: g.service.name, path: g.service.path, file: r.svc.rel });
  };

  // the pairs not compared yet, all at once; shown when done
  const askDiffs = async (all) => {
    if (diffing) return;
    const pending = [];
    for (const g of all.services) {
      for (const r of g.rows) {
        if (anWantsDiff(r) && !anDiffs.has(anDiffKey(cmpSel.value, g.service.path, r))) pending.push({ g, r });
      }
    }
    if (!pending.length) return;
    diffing = true;
    const docPath = cmpSel.value;
    const res = await window.analysis.diff(pending.map(({ g, r }) => ({ docRepo: docPath, docRel: r.doc.rel, svcRepo: g.service.path, svcRel: r.svc.rel })));
    diffing = false;
    pending.forEach(({ g, r }, i) => anDiffs.set(anDiffKey(docPath, g.service.path, r), res.error ? { error: res.error } : res.results[i] || { error: 'No answer' }));
    if (docPath === cmpSel.value) render();
  };

  // a version in the colour of the row's state
  const versionCell = (tr, f, tone) => {
    const td = cell(tr, 'an-ver');
    if (!f) td.appendChild(tEl('span', 'an-absent', '—'));
    else if (f.error) td.appendChild(tEl('span', 'tool-error', f.error));
    else if (f.part) {
      td.appendChild(tEl('span', `tool-badge ${tone}`, 'part'));
      td.title = `${AN_PART}\n${f.rel}`;
    } else {
      td.appendChild(tEl('span', `tool-badge ${tone}`, f.version || '?'));
      td.title = `${f.title}\n${f.rel}`;
    }
  };

  // a row: the microservice (none for a file only the source has), the file, the two versions, the state's tag, Compare
  // or Open
  const fileRow = (rows, g, r) => {
    const [label, tone] = DOC_STATES[r.state];
    const tr = rows.insertRow();
    tr.dataset.state = r.state;
    if (g) cell(tr, 'an-ms', msTag(g.service));
    else cell(tr, 'an-ms', tEl('span', 'an-absent', '—')).title = 'No microservice of your list has it';
    const name = cell(tr, 'an-name', r.name);
    name.title = [r.svc && `Microservice: ${r.svc.rel}`, r.doc && `${source() ? displayName(source()) : 'Source'}: ${r.doc.rel}`].filter(Boolean).join('\n');
    versionCell(tr, r.svc, tone);
    versionCell(tr, r.doc, tone);
    const st = tEl('span', `an-chip ${tone}`, g ? label : 'No microservice has it');
    // what differs, on hover
    st.title = [
      g && anWantsDiff(r) ? anDiffText(diffOf(g, r)) : '',
      r.svc && r.doc && r.svc.title && r.doc.title && r.svc.title !== r.doc.title ? `Title in the documentation: ${r.doc.title}` : '',
      r.why ? `Not matched: ${r.why}` : '',
    ].filter(Boolean).join('\n');
    cell(tr, 'an-state', st);
    const act = cell(tr, 'an-act');
    if (g && r.svc && r.doc && !r.svc.error && !r.doc.error) {
      const b = toolButton('Compare', () => compareFiles(g, r));
      b.title = r.svc.part || r.doc.part ? 'The two files line by line, in Tools > Compare texts' : 'The endpoints and models that differ, in Tools > Compare APIs (the documentation as Before)';
      act.appendChild(b);
    } else if (r.doc && !g) {
      const o = toolButton('Open', async () => {
        const res = await window.analysis.open(cmpSel.value, r.doc.rel);
        if (res.error) toast(res.error, 'error');
      });
      o.title = `Open ${r.doc.rel}`;
      act.appendChild(o);
    }
  };

  // over the table, in a row, one tag a state with how many: a click shows only those (more than one: any of them)
  const renderStates = (all) => {
    const counted = narrow(all, false);
    const counts = {};
    for (const r of [...counted.services.flatMap((g) => g.rows), ...counted.unlinked]) counts[r.state] = (counts[r.state] || 0) + 1;
    for (const [k, [label, tone]] of Object.entries(DOC_STATES)) {
      if (!counts[k] && !picked.has(k)) continue;
      const b = tEl('button', `an-chip an-leg ${tone}`, `${counts[k] || 0} ${label.toLowerCase()}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(picked.has(k)));
      b.title = picked.has(k) ? 'Click again to show the others too' : 'Show only these';
      b.addEventListener('click', () => {
        if (picked.has(k)) picked.delete(k);
        else picked.add(k);
        render();
      });
      legend.appendChild(b);
    }
    if (picked.size) {
      const every = tEl('button', 'an-sum-all', 'Show every state');
      every.type = 'button';
      every.addEventListener('click', () => {
        picked.clear();
        render();
      });
      legend.appendChild(every);
    }
  };

  const renderCompare = () => {
    const src = source();
    const all = docComparison(data, src.path);
    const cmp = narrow(all, true);
    const inView = narrow(all, false);
    const total = inView.services.reduce((n, g) => n + g.rows.length, 0) + inView.unlinked.length;
    state.textContent = `${total} file${total === 1 ? '' : 's'} in ${inView.services.length} microservice${inView.services.length === 1 ? '' : 's'}`;
    stateMore.textContent = '';
    renderStates(all);
    if (all.doc && !all.doc.files.length) result.appendChild(tEl('div', 'tool-hint', `${all.doc.name} has no swagger files: Folders chooses where to look.`));
    const narrowed = query() || filters.filters.length || picked.size || fileSel.value || (scope.value || 'all') !== 'all';
    if (!cmp.services.length && !cmp.unlinked.length && all.doc && all.doc.files.length) result.appendChild(tEl('div', 'tool-hint an-empty', onlyDiff && !narrowed ? `✓ No differences: every file is the same in ${displayName(src)}.` : 'Nothing matches the search and the filters.'));
    if (cmp.services.length || cmp.unlinked.length) {
      const rows = table([['Microservice', 'an-col-ms'], ['File'], ['Microservice', 'an-col-ver'], [displayName(src), 'an-col-ver'], ['State', 'an-col-state'], ['', 'an-col-act']]);
      for (const g of cmp.services) for (const r of g.rows) fileRow(rows, g, r);
      for (const r of cmp.unlinked) fileRow(rows, null, r);
    }
    askDiffs(all);
  };

  function tableText() {
    if (!data) return '';
    const clean = (v) => String(v || '').replace(/[\t\n]/g, ' ');
    if (!source()) {
      const lines = [['Microservice', 'Name', 'Path', 'Title', 'Version'].join('\t')];
      for (const s of listed()) for (const f of s.files) lines.push([s.name, f.name, f.rel, f.error || (f.part ? AN_PART : f.title), f.version].map(clean).join('\t'));
      return lines.length > 1 ? `${lines.join('\n')}\n` : '';
    }
    const src = displayName(source());
    const cmp = narrow(docComparison(data, cmpSel.value), true);
    const lines = [['Microservice', 'File', 'Microservice version', `${src} version`, 'State', 'Differences', 'Microservice path', `${src} path`].join('\t')];
    const line = (name, g, r) => {
      const d = g ? diffOf(g, r) : null;
      lines.push([name, r.name, r.svc ? r.svc.version : '', r.doc ? r.doc.version : '', DOC_STATES[r.state][0], d ? anDiffText(d) : r.why, r.svc ? r.svc.rel : '', r.doc ? r.doc.rel : ''].map(clean).join('\t'));
    };
    for (const g of cmp.services) for (const r of g.rows) line(g.service.name, g, r);
    for (const r of cmp.unlinked) line('', null, r);
    return lines.length > 1 ? `${lines.join('\n')}\n` : '';
  }

  function render() {
    const src = source();
    title.textContent = src ? `Swagger files compared with ${displayName(src)}` : 'Swagger files';
    cmpSel.title = src ? `Each file next to its copy in ${displayName(src)}, by file name` : 'A repository (the documentation): which files are up to date';
    only.classList.toggle('hidden', !src);
    result.textContent = '';
    legend.textContent = '';
    if (!data) return;
    if (!data.services.length) {
      state.textContent = '';
      stateMore.textContent = '';
      result.appendChild(tEl('div', 'tool-hint', 'No microservices yet: add them in Git (+ Add or Refresh).'));
      return;
    }
    if (src) renderCompare();
    else renderList();
  }

  scope.addEventListener('change', render);
  fileSel.addEventListener('change', render);
  cmpSel.addEventListener('change', () => {
    try {
      localStorage.setItem(AN_COMPARE_KEY, cmpSel.value);
    } catch {
      // only for this session
    }
    picked.clear();
    render();
  });
  search.addEventListener('input', debounce(render, 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      render();
    }
  });
  box.append(top, fieldBar, under, legend, result);
  let scanned = false;
  return {
    el: box,
    focus: search,
    shown(on) {
      if (!on) return;
      fillScope();
      fillCompare();
      if (!scanned || anReposKey() !== anScanList || seen !== anScan) {
        scanned = true;
        scan(false);
      } else render();
    },
  };
}

// -- the page --
function renderAnalysisList() {
  const list = $('#analysisList');
  list.textContent = '';
  for (const a of ANALYSES) {
    const item = tEl('div', `repo-item tool-item${a.id === currentAnalysis ? ' active' : ''}`);
    item.dataset.analysis = a.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(a.id === currentAnalysis));
    const text = tEl('div', 'repo-item-text');
    text.append(tEl('div', 'repo-item-name', a.title), tEl('div', 'tool-item-sub', a.sub));
    item.appendChild(text);
    item.addEventListener('click', () => showAnalysis(a.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showAnalysis(a.id, true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...list.querySelectorAll('.tool-item')];
        const next = items[items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
      }
    });
    list.appendChild(item);
  }
}

function showAnalysis(id, focus = false) {
  const a = ANALYSES.find((x) => x.id === id) || ANALYSES[0];
  currentAnalysis = a.id;
  try {
    localStorage.setItem(ANALYSIS_KEY, currentAnalysis);
  } catch {
    // only for this session
  }
  const panel = $('#analysisPanel');
  if (!builtAnalyses.has(a.id)) {
    const built = a.build();
    built.el.dataset.analysis = a.id;
    builtAnalyses.set(a.id, built);
    panel.appendChild(built.el);
  }
  for (const [aid, b] of builtAnalyses) {
    b.el.classList.toggle('hidden', aid !== a.id);
    if (b.shown) b.shown(aid === a.id && currentMode === 'analysis');
  }
  $$('#analysisList .tool-item').forEach((el) => {
    const on = el.dataset.analysis === a.id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  if (focus && builtAnalyses.get(a.id).focus) builtAnalyses.get(a.id).focus.focus();
  if (currentMode === 'analysis') updateCrumb();
}

function setupAnalysis() {
  try {
    const saved = localStorage.getItem(ANALYSIS_KEY);
    if (ANALYSES.some((a) => a.id === saved)) currentAnalysis = saved;
  } catch {
    // the first one
  }
  renderAnalysisList();
  // built when the page is first opened (the scan runs then)
  new MutationObserver(() => {
    if (!$('#analysisView').classList.contains('hidden')) showAnalysis(currentAnalysis);
  }).observe($('#analysisView'), { attributes: true, attributeFilter: ['class'] });
}

if (!CARD_ID) setupAnalysis();
