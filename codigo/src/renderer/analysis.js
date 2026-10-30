// Analysis page: looks across the microservices of the list, one analysis at a time (listed on the left).
// Swagger files: every .yaml in a folder named swagger, per microservice, with name, path, title and version.
// Relies on helpers from app.js ($, $$, toast, repos, repoGroups, updateCrumb, CARD_ID) and tools.js (tEl, toolHead,
// toolButton, toolInput, toolCopy, debounce).
const ANALYSES = [
  { id: 'swagger', title: 'Swagger files', sub: 'The API definitions of each one', build: buildSwaggerAnalysis },
  { id: 'docs', title: 'Compare with documentation', sub: 'Versions next to the published copy', build: buildDocsAnalysis },
];

// One scan of the swagger folders serves both analyses; Scan again in either reads them again, and so does a change
// in the list of repositories.
let anScan = null;
let anScanList = '';
function swaggerScan(force = false) {
  const list = repos.map((r) => r.path).sort().join('\n');
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

// -- Swagger files --
function buildSwaggerAnalysis() {
  const box = tEl('div', 'tool an-tool');
  let data = null;
  let loading = false;
  const query = toolInput('Filter: microservice, file, path, title or version');
  query.type = 'search';
  const group = tEl('select', 'input an-group');
  group.setAttribute('aria-label', 'Which microservices');
  const state = tEl('span', 'tool-hint');
  const result = tEl('div', 'an-result');
  const row = tEl('div', 'tool-row');
  const scan = async () => {
    if (loading) return;
    loading = true;
    rescan.disabled = true;
    state.textContent = `Looking in ${repos.length} microservice${repos.length === 1 ? '' : 's'}...`;
    const r = await swaggerScan(scanned);
    loading = false;
    rescan.disabled = false;
    if (r.error) {
      state.textContent = '';
      result.textContent = '';
      result.appendChild(tEl('div', 'tool-error', r.error));
      return;
    }
    data = r;
    render();
  };
  const rescan = toolButton('Scan again', scan);
  rescan.title = 'Read the swagger folders again';
  const copyTable = toolButton('Copy as table', () => toolCopy(tableText(), 'Table'));
  copyTable.title = 'Copy the files shown, as a table for Excel or a document';
  row.append(query, group, rescan, copyTable, state);

  const fillGroups = () => {
    const keep = group.value || 'all';
    group.textContent = '';
    group.appendChild(new Option('All microservices', 'all'));
    for (const g of repoGroups) group.appendChild(new Option(g.name, g.id));
    if (repoGroups.length) group.appendChild(new Option('Not in a group', 'none'));
    group.value = [...group.options].some((o) => o.value === keep) ? keep : 'all';
  };

  const inGroup = (service) => {
    if (group.value === 'all') return true;
    const r = repos.find((x) => x.path === service.path);
    const ids = new Set(repoGroups.map((g) => g.id));
    if (group.value === 'none') return !r || !ids.has(r.group);
    return Boolean(r) && r.group === group.value;
  };

  // the services and their files, after the group and the filter
  const shown = () => {
    if (!data) return [];
    const q = query.value.trim().toLowerCase();
    return data.services
      .filter(inGroup)
      .map((s) => {
        const named = s.name.toLowerCase().includes(q);
        const files = !q || named ? s.files : s.files.filter((f) => [f.name, f.rel, f.title, f.version].join(' ').toLowerCase().includes(q));
        return { ...s, files };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  function tableText() {
    const lines = [['Microservice', 'Name', 'Path', 'Title', 'Version'].join('\t')];
    for (const s of shown()) for (const f of s.files) lines.push([s.name, f.name, f.rel, f.error ? f.error : f.title, f.version].map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
    return lines.length > 1 ? `${lines.join('\n')}\n` : '';
  }

  function render() {
    result.textContent = '';
    if (!data) return;
    const services = shown();
    const withFiles = services.filter((s) => s.files.length);
    const total = withFiles.reduce((n, s) => n + s.files.length, 0);
    const q = query.value.trim();
    state.textContent = `${total} file${total === 1 ? '' : 's'} in ${withFiles.length} microservice${withFiles.length === 1 ? '' : 's'}${q ? ' match' : ''} · ${(data.took / 1000).toFixed(1)} s`;
    if (!data.services.length) {
      result.appendChild(tEl('div', 'tool-hint', 'No microservices yet: add them in Git (+ Add or Refresh).'));
      return;
    }
    if (!withFiles.length) result.appendChild(tEl('div', 'tool-hint an-empty', q ? 'Nothing matches the filter.' : 'No swagger folder with .yaml files in these microservices.'));
    for (const s of withFiles) {
      const block = tEl('section', 'an-service');
      const head = tEl('div', 'an-service-head');
      head.append(tEl('h3', '', s.name), tEl('span', 'an-count', `${s.files.length} file${s.files.length === 1 ? '' : 's'}`));
      const where = tEl('span', 'an-dirs', s.dirs.join(' · '));
      where.title = s.path;
      head.appendChild(where);
      const grid = tEl('div', 'an-files');
      for (const h of ['Name', 'Path', 'Title', 'Version']) grid.appendChild(tEl('div', 'an-head', h));
      for (const f of s.files) {
        const name = tEl('div', 'an-name', f.name);
        if (f.spec) name.title = f.spec;
        const pathCell = tEl('div', 'an-path');
        const open = tEl('button', 'an-open', f.rel);
        open.type = 'button';
        open.title = `Open ${f.rel}`;
        open.addEventListener('click', async () => {
          const r = await window.analysis.open(s.path, f.rel);
          if (r.error) toast(r.error, 'error');
        });
        pathCell.appendChild(open);
        const title = tEl('div', `an-title${f.error ? ' tool-error' : ''}`, f.error || f.title || '—');
        const version = tEl('div', 'an-version');
        if (f.version) version.appendChild(tEl('span', 'tool-badge', f.version));
        grid.append(name, pathCell, title, version);
      }
      block.append(head, grid);
      result.appendChild(block);
    }
    if (!q) {
      const none = services.filter((s) => !s.files.length && !s.missing).map((s) => s.name);
      const missing = services.filter((s) => s.missing).map((s) => s.name);
      if (none.length) result.appendChild(tEl('div', 'tool-hint an-none', `No swagger files: ${none.join(', ')}`));
      if (missing.length) result.appendChild(tEl('div', 'tool-error an-none', `Folder not found: ${missing.join(', ')}`));
    }
  }

  query.addEventListener('input', debounce(render, 120));
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query.value) {
      e.stopPropagation();
      query.value = '';
      render();
    }
  });
  group.addEventListener('change', render);
  box.append(toolHead('Swagger files', 'Every .yaml in a folder named swagger, in each microservice of your list, with the title and version from its info:. A click on a path opens the file.'), row, result);
  let scanned = false;
  return {
    el: box,
    focus: query,
    shown(on) {
      if (!on) return;
      fillGroups();
      if (!scanned || repos.map((r) => r.path).sort().join('\n') !== anScanList) {
        scan();
        scanned = true;
      } else render();
    },
  };
}

// -- Compare with documentation --
// A technical documentation repository holds a copy of each microservice's swagger files, under a folder named after
// the microservice (swagger/orders-service/orders-api.yaml). Each file is matched with its copy by its place in the
// swagger folder, then by name, then by title; the versions say which side is behind.
const DOC_REPO_KEY = 'analysisDocRepo';
const DOC_STATES = {
  same: ['Same version', 'good'],
  behind: ['Documentation is behind', 'warn'],
  ahead: ['Documentation is ahead', 'info'],
  differ: ['Different versions', 'warn'],
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

function docComparison(data, docPath) {
  const doc = data.services.find((s) => s.path === docPath);
  const services = data.services.filter((s) => s.path !== docPath);
  const byKey = new Map();
  for (const s of services) {
    byKey.set(anKey(s.path.split(/[\\/]/).pop()), s);
    byKey.set(anKey(s.name), s);
  }
  // the documentation's files, by the microservice folder they are in
  const linked = new Map();
  const unlinked = [];
  for (const f of doc ? doc.files : []) {
    const parts = (f.inner || f.rel).split('/');
    let hit = null;
    for (let i = 0; i < parts.length - 1 && !hit; i++) {
      const s = byKey.get(anKey(parts[i]));
      if (s) hit = { service: s, inner: parts.slice(i + 1).join('/') };
    }
    if (!hit) {
      unlinked.push(f);
      continue;
    }
    if (!linked.has(hit.service.path)) linked.set(hit.service.path, []);
    linked.get(hit.service.path).push({ ...f, inner: hit.inner });
  }
  const result = [];
  for (const s of services) {
    const docs = [...(linked.get(s.path) || [])];
    if (!s.files.length && !docs.length) continue;
    const rows = [];
    const take = (pred) => {
      const i = docs.findIndex(pred);
      return i === -1 ? null : docs.splice(i, 1)[0];
    };
    for (const f of s.files) {
      const d = take((x) => x.inner.toLowerCase() === String(f.inner || '').toLowerCase())
        || take((x) => x.name.toLowerCase() === f.name.toLowerCase())
        || (f.title ? take((x) => x.title && x.title === f.title) : null);
      rows.push(docRow(f, d));
    }
    for (const d of docs) rows.push(docRow(null, d));
    result.push({ service: s, rows, hasDocs: linked.has(s.path) });
  }
  return { doc, services: result.sort((a, b) => a.service.name.localeCompare(b.service.name)), unlinked };
}

function docRow(svc, doc) {
  let state;
  if (!doc) state = 'missing';
  else if (!svc) state = 'extra';
  else if (svc.error || doc.error) state = 'broken';
  else {
    const c = compareVersions(svc.version, doc.version);
    state = c === 0 ? 'same' : c === 1 ? 'behind' : c === -1 ? 'ahead' : 'differ';
  }
  return { name: (svc || doc).name, svc, doc, state };
}

function buildDocsAnalysis() {
  const box = tEl('div', 'tool an-tool');
  let data = null;
  let loading = false;
  let onlyDiff = false;
  const docSelect = tEl('select', 'input an-group an-doc');
  docSelect.setAttribute('aria-label', 'The technical documentation repository');
  const query = toolInput('Filter: microservice, file, title or version');
  query.type = 'search';
  const state = tEl('span', 'tool-hint');
  const chips = tEl('div', 'an-chips');
  const result = tEl('div', 'an-result');
  const scan = async (force) => {
    if (loading) return;
    loading = true;
    rescan.disabled = true;
    state.textContent = 'Reading the swagger folders...';
    const r = await swaggerScan(force);
    loading = false;
    rescan.disabled = false;
    if (r.error) {
      state.textContent = '';
      result.textContent = '';
      result.appendChild(tEl('div', 'tool-error', r.error));
      return;
    }
    data = r;
    render();
  };
  const rescan = toolButton('Scan again', () => scan(true));
  const only = toolCheck('Only differences', false, (v) => {
    onlyDiff = v;
    render();
  });
  const copyTable = toolButton('Copy as table', () => toolCopy(tableText(), 'Table'));
  const row1 = tEl('div', 'tool-row');
  row1.append(tEl('span', 'tool-label', 'Documentation'), docSelect, rescan, copyTable, state);
  const row2 = tEl('div', 'tool-row');
  row2.append(query, only);

  const fillRepos = () => {
    let saved = '';
    try {
      saved = localStorage.getItem(DOC_REPO_KEY) || '';
    } catch {
      // none kept
    }
    const keep = docSelect.value || saved;
    docSelect.textContent = '';
    docSelect.appendChild(new Option('Choose the documentation repository...', ''));
    for (const r of [...repos].sort((a, b) => displayName(a).localeCompare(displayName(b)))) docSelect.appendChild(new Option(displayName(r), r.path));
    const guess = repos.find((r) => /document/i.test(anKey(displayName(r))) || /document/i.test(anKey(r.path.split(/[\\/]/).pop())));
    docSelect.value = [...docSelect.options].some((o) => o.value === keep && keep) ? keep : guess ? guess.path : '';
  };

  const visible = () => {
    if (!data || !docSelect.value) return null;
    const cmp = docComparison(data, docSelect.value);
    const q = query.value.trim().toLowerCase();
    cmp.services = cmp.services.map((g) => {
      const named = g.service.name.toLowerCase().includes(q);
      const rows = g.rows.filter((r) => (!onlyDiff || r.state !== 'same')
        && (!q || named || [r.name, r.svc && r.svc.title, r.doc && r.doc.title, r.svc && r.svc.version, r.doc && r.doc.version, DOC_STATES[r.state][0]].join(' ').toLowerCase().includes(q)));
      return { ...g, rows };
    }).filter((g) => g.rows.length);
    return cmp;
  };

  function tableText() {
    const cmp = visible();
    if (!cmp) return '';
    const lines = [['Microservice', 'File', 'Microservice version', 'Documentation version', 'State'].join('\t')];
    for (const g of cmp.services) {
      for (const r of g.rows) lines.push([g.service.name, r.name, r.svc ? r.svc.version : '', r.doc ? r.doc.version : '', DOC_STATES[r.state][0]].join('\t'));
    }
    return lines.length > 1 ? `${lines.join('\n')}\n` : '';
  }

  const compareFiles = async (g, r) => {
    const doc = data.services.find((s) => s.path === docSelect.value);
    const [a, b] = await Promise.all([window.analysis.read(doc.path, r.doc.rel), window.analysis.read(g.service.path, r.svc.rel)]);
    if (a.error || b.error) {
      toast(a.error || b.error, 'error');
      return;
    }
    openInCompare(a.text, b.text, `Left: ${doc.name} / ${r.doc.rel}   ·   Right: ${g.service.name} / ${r.svc.rel}`);
  };

  const versionCell = (f, cls) => {
    const cell = tEl('div', cls);
    if (!f) cell.appendChild(tEl('span', 'an-absent', '—'));
    else if (f.error) cell.appendChild(tEl('span', 'tool-error', f.error));
    else {
      cell.appendChild(tEl('span', 'tool-badge', f.version || '?'));
      cell.title = `${f.title}\n${f.rel}`;
    }
    return cell;
  };

  function render() {
    result.textContent = '';
    chips.textContent = '';
    if (!data) return;
    if (!docSelect.value) {
      state.textContent = '';
      result.appendChild(tEl('div', 'tool-hint', 'Choose the repository that holds the technical documentation: its swagger/<microservice>/ folders are compared with each microservice.'));
      return;
    }
    const all = docComparison(data, docSelect.value);
    const counts = {};
    for (const g of all.services) for (const r of g.rows) counts[r.state] = (counts[r.state] || 0) + 1;
    for (const [k, [label, tone]] of Object.entries(DOC_STATES)) {
      if (counts[k]) chips.appendChild(tEl('span', `an-chip ${tone}`, `${counts[k]} ${label.toLowerCase()}`));
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    state.textContent = `${total} file${total === 1 ? '' : 's'} in ${all.services.length} microservice${all.services.length === 1 ? '' : 's'}`;
    if (all.doc && !all.doc.files.length) result.appendChild(tEl('div', 'tool-hint', `${all.doc.name} has no swagger folder with .yaml files.`));
    const cmp = visible();
    if (!cmp.services.length && total) result.appendChild(tEl('div', 'tool-hint an-empty', onlyDiff ? '✓ No differences: every file has the same version in the documentation.' : 'Nothing matches the filter.'));
    for (const g of cmp.services) {
      const block = tEl('section', 'an-service');
      const head = tEl('div', 'an-service-head');
      head.append(tEl('h3', '', g.service.name));
      const diffs = g.rows.filter((r) => r.state !== 'same').length;
      head.appendChild(tEl('span', 'an-count', diffs ? `${diffs} difference${diffs === 1 ? '' : 's'}` : 'all the same'));
      if (!g.hasDocs) head.appendChild(tEl('span', 'tool-error an-count', `no ${g.service.path.split(/[\\/]/).pop()} folder in the documentation`));
      const grid = tEl('div', 'an-files an-docs');
      for (const h of ['File', 'Microservice', 'Documentation', 'State', '']) grid.appendChild(tEl('div', 'an-head', h));
      for (const r of g.rows) {
        const name = tEl('div', 'an-name', r.name);
        name.title = [r.svc && r.svc.rel, r.doc && r.doc.rel].filter(Boolean).join('\n');
        const [label, tone] = DOC_STATES[r.state];
        const st = tEl('div', 'an-state');
        st.appendChild(tEl('span', `an-chip ${tone}`, label));
        if (r.svc && r.doc && r.svc.title && r.doc.title && r.svc.title !== r.doc.title) st.appendChild(tEl('span', 'tool-hint', ` · title: ${r.doc.title}`));
        const act = tEl('div', 'an-act');
        if (r.svc && r.doc && !r.svc.error && !r.doc.error) {
          const b = toolButton('Compare', () => compareFiles(g, r));
          b.title = 'See the two files side by side, in Tools > Compare texts';
          act.appendChild(b);
        }
        grid.append(name, versionCell(r.svc, 'an-ver'), versionCell(r.doc, 'an-ver'), st, act);
      }
      block.append(head, grid);
      result.appendChild(block);
    }
    if (all.unlinked.length && !query.value.trim()) {
      result.appendChild(tEl('div', 'tool-hint an-none', `In the documentation but not under a microservice of your list: ${all.unlinked.map((f) => f.rel).join(', ')}`));
    }
  }

  docSelect.addEventListener('change', () => {
    try {
      localStorage.setItem(DOC_REPO_KEY, docSelect.value);
    } catch {
      // only for this session
    }
    render();
  });
  query.addEventListener('input', debounce(render, 120));
  box.append(toolHead('Compare with documentation', 'Each microservice\'s swagger files next to their copy in the technical documentation (swagger/<microservice>/ in that repository): which side is behind, and what is missing on either side.'), row1, chips, row2, result);
  let scanned = false;
  return {
    el: box,
    focus: query,
    shown(on) {
      if (!on) return;
      fillRepos();
      if (!scanned || repos.map((r) => r.path).sort().join('\n') !== anScanList) {
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
