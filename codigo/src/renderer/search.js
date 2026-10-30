// Search page: one search bar for text in the files of every microservice of the list, or for their file names, with
// the lines grouped by microservice and file. Ctrl+P (Cmd+P on macOS) opens the quick search popup from any page: file
// names as you type, # and a text to search for it. The searching itself is in search.js of the main process (git grep).
// Relies on helpers from app.js ($, $$, toast, repos, repoGroups, displayName, currentMode, activateMode, updateCrumb,
// ACTION_ICONS, IS_MAC, CARD_ID) and tools.js (tEl, toolSegment, toolButton, toolCopy, debounce).
const SEARCH_STATE_KEY = 'searchState';
const SEARCH_RECENT_KEY = 'searchRecent';
const SEARCH_RECENT_FILES_KEY = 'searchRecentFiles';
const SEARCH_AUTO_CHARS = 3;
const NAMES_SHOWN = 300;
const QS_SHOWN = 50;
const NAMES_STALE_MS = 30 * 1000;
const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>';
const CHEVRON_ICON = '<svg class="sr-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/></svg>';

const searchState = { text: '', kind: 'text', scope: 'all', where: 'local', matchCase: false, word: false, regex: false, files: '' };
let searchUi = null;
let searchRun = null;
let searchSeq = 0;
let searchTimer = null;
let nameIndex = null;
let nameLoad = null;

function loadSearchState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_STATE_KEY)) || {};
    for (const k of Object.keys(searchState)) if (typeof saved[k] === typeof searchState[k]) searchState[k] = saved[k];
  } catch {
    // the defaults
  }
  if (!['text', 'names'].includes(searchState.kind)) searchState.kind = 'text';
  if (!['local', 'origin'].includes(searchState.where)) searchState.where = 'local';
}

function saveSearchState() {
  try {
    localStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(searchState));
  } catch {
    // only for this session
  }
}

function recentList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rememberRecent(key, item, same) {
  try {
    localStorage.setItem(key, JSON.stringify([item, ...recentList(key).filter((x) => !same(x))].slice(0, 8)));
  } catch {
    // not remembered
  }
}

const srPlural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const splitRel = (rel) => {
  const i = rel.lastIndexOf('/');
  return { dir: i === -1 ? '' : rel.slice(0, i + 1), base: rel.slice(i + 1) };
};
const repoLabel = (p, fallback) => {
  const r = repos.find((x) => x.path === p);
  return r ? displayName(r) : fallback || p;
};

// the microservices the chips let through
function searchRepos() {
  const ids = new Set(repoGroups.map((g) => g.id));
  if (searchState.scope !== 'all' && searchState.scope !== 'none' && !ids.has(searchState.scope)) searchState.scope = 'all';
  if (searchState.scope === 'all') return repos;
  if (searchState.scope === 'none') return repos.filter((r) => !ids.has(r.group));
  return repos.filter((r) => r.group === searchState.scope);
}

async function searchOpenFile(repoPath, rel) {
  const r = await window.search.open(repoPath, rel);
  if (r.error) toast(r.error, 'error', { plain: true });
  else rememberRecent(SEARCH_RECENT_FILES_KEY, { repo: repoPath, rel }, (x) => x.repo === repoPath && x.rel === rel);
}

async function searchRevealFile(repoPath, rel) {
  const r = await window.search.reveal(repoPath, rel);
  if (r.error) toast(r.error, 'error', { plain: true });
}

function iconButton(icon, label, onClick) {
  const b = tEl('button', 'sr-icon-btn');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[icon] || ''}</svg>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function fileActions(repoPath, rel) {
  const box = tEl('span', 'sr-actions');
  box.append(
    iconButton('copy', 'Copy the path', () => toolCopy(rel, 'Path')),
    iconButton('folder', IS_MAC ? 'Show in Finder' : 'Show in Explorer', () => searchRevealFile(repoPath, rel))
  );
  return box;
}

// -- what is highlighted: the same search as git grep's, in JavaScript --
function searchRegExp(text, o) {
  let source = o.regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.word) source = `(?<![\\w])(?:${source})(?![\\w])`;
  try {
    return new RegExp(source, o.matchCase ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function markInto(el, text, re) {
  if (!re) {
    el.textContent = text;
    return;
  }
  re.lastIndex = 0;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(text)) && n++ < 50) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    el.append(text.slice(last, m.index), tEl('mark', 'sr-hl', m[0]));
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

// the words typed, each one marked where it is in a file name or path
function markTerms(el, text, terms) {
  const re = terms.length ? new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') : null;
  markInto(el, text, re);
}

// -- the page --
function buildSearchPage() {
  const panel = $('#searchPanel');
  const bar = tEl('div', 'search-bar');
  const box = tEl('label', 'search-box');
  box.innerHTML = SEARCH_ICON;
  const input = tEl('input', 'search-input');
  input.id = 'searchInput';
  input.type = 'search';
  input.spellcheck = false;
  input.setAttribute('autocomplete', 'off');
  input.value = searchState.text;
  box.appendChild(input);
  const kind = toolSegment([['text', 'Text'], ['names', 'File names']], searchState.kind, (v) => {
    searchState.kind = v;
    saveSearchState();
    applySearchKind();
    input.focus();
  }, 'What to search');
  kind.classList.add('search-kind');
  bar.append(box, kind);

  const options = tEl('div', 'search-options');
  const chips = tEl('div', 'search-scope');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Which microservices');
  const right = tEl('div', 'search-opts');
  const files = tEl('input', 'input search-files');
  files.type = 'search';
  files.placeholder = 'In files: *.java, pom.xml, !*Test.java';
  files.title = 'Only these files: a name matches in any folder, a word without a dot is a folder, ! leaves out. Separated by commas.';
  files.setAttribute('aria-label', 'Only in these files');
  files.spellcheck = false;
  files.value = searchState.files;
  const where = tEl('select', 'input search-where');
  where.setAttribute('aria-label', 'Where to search');
  where.append(new Option('Working copy', 'local'), new Option('Main branch on origin', 'origin'));
  where.value = searchState.where;
  where.title = 'Working copy: the files as they are on this PC. Main branch on origin: as they were at the last fetch, whatever branch you are on.';
  const toggles = [
    ['matchCase', 'Aa', 'Match case'],
    ['word', 'ab', 'Whole word'],
    ['regex', '.*', 'Regular expression'],
  ].map(([key, text, label]) => {
    const b = tEl('button', `search-toggle search-toggle-${key}`, text);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.key = key;
    b.setAttribute('aria-pressed', String(searchState[key]));
    b.addEventListener('click', () => {
      searchState[key] = !searchState[key];
      b.setAttribute('aria-pressed', String(searchState[key]));
      saveSearchState();
      runSearch();
    });
    return b;
  });
  const toggleBox = tEl('span', 'search-toggles');
  toggleBox.append(...toggles);
  right.append(files, where, toggleBox);
  options.append(chips, right);

  const progress = tEl('div', 'search-progress');
  const fill = tEl('div', 'search-progress-fill');
  progress.appendChild(fill);
  const statusRow = tEl('div', 'search-status-row');
  const status = tEl('span', 'search-status');
  status.setAttribute('role', 'status');
  const fold = toolButton('Collapse all', () => {
    const blocks = [...results.querySelectorAll('.sr-service')];
    const collapse = blocks.some((b) => !b.classList.contains('collapsed'));
    blocks.forEach((b) => setCollapsed(b, collapse));
    fold.textContent = collapse ? 'Expand all' : 'Collapse all';
  });
  const stop = toolButton('Stop', () => window.search.stop());
  statusRow.append(status, fold, stop);
  const results = tEl('div', 'search-results');
  results.id = 'searchResults';
  panel.append(bar, options, progress, statusRow, results);
  searchUi = { input, kind, chips, files, where, toggles: toggleBox, progress, fill, status, fold, stop, results };

  // after a pause in typing; not again when Enter already searched for the same
  const autoRun = debounce(() => {
    if (searchState.kind === 'text' && input.value.trim().length >= SEARCH_AUTO_CHARS) runSearchIfChanged();
  }, 500);
  input.addEventListener('input', () => {
    searchState.text = input.value;
    saveSearchState();
    if (currentMode === 'search') updateCrumb();
    if (searchState.kind === 'names') renderNameResults();
    else if (!input.value.trim()) runSearch();
    else autoRun();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchState.kind === 'text') runSearch();
      else {
        const first = results.querySelector('.sr-name');
        if (first) first.click();
      }
    } else if (e.key === 'Escape' && searchRun && !searchRun.finished) {
      e.preventDefault();
      window.search.stop();
    }
  });
  const filesRun = debounce(runSearchIfChanged, 600);
  files.addEventListener('input', () => {
    searchState.files = files.value;
    saveSearchState();
    if (searchState.kind === 'text' && input.value.trim()) filesRun();
  });
  files.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  where.addEventListener('change', () => {
    searchState.where = where.value;
    saveSearchState();
    runSearch();
  });
  window.search.onProgress(onSearchProgress);
  renderScopeChips();
  applySearchKind(false);
}

function renderScopeChips() {
  if (!searchUi) return;
  const box = searchUi.chips;
  box.textContent = '';
  searchRepos(); // drops a group that is gone
  const ids = new Set(repoGroups.map((g) => g.id));
  const loose = repos.filter((r) => !ids.has(r.group)).length;
  const chips = [['all', 'All', repos.length], ...repoGroups.map((g) => [g.id, g.name, repos.filter((r) => r.group === g.id).length])];
  if (repoGroups.length && loose) chips.push(['none', 'Not in a group', loose]);
  for (const [id, name, n] of chips) {
    const b = tEl('button', `search-chip${searchState.scope === id ? ' active' : ''}`);
    b.type = 'button';
    b.dataset.scope = id;
    b.setAttribute('aria-pressed', String(searchState.scope === id));
    b.append(tEl('span', '', name), tEl('span', 'search-chip-n', String(n)));
    b.addEventListener('click', () => {
      searchState.scope = id;
      saveSearchState();
      renderScopeChips();
      if (searchState.kind === 'names') renderNameResults();
      else runSearch();
    });
    box.appendChild(b);
  }
}

// Text or file names; run says whether a text left in the box is searched (not when the page is first built).
function applySearchKind(run = true) {
  const ui = searchUi;
  const text = searchState.kind === 'text';
  ui.kind.setValue(searchState.kind);
  ui.input.placeholder = text ? 'Text in the files of every microservice (Enter)' : 'File name, or part of its path';
  ui.input.setAttribute('aria-label', text ? 'Text to search for' : 'File name to look for');
  [ui.files, ui.where, ui.toggles].forEach((el) => el.classList.toggle('hidden', !text));
  if (currentMode === 'search') updateCrumb();
  if (text) {
    ui.results.textContent = '';
    if (searchRun && searchRun.text === ui.input.value && searchRun.blocks) {
      for (const b of searchRun.blocks) ui.results.appendChild(b);
      if (searchRun.errorBox) ui.results.appendChild(searchRun.errorBox);
      renderSearchStatus();
    } else {
      setSearchStatus(ui.input.value.trim() && !run ? 'Enter searches again' : '');
      if (run && ui.input.value.trim()) runSearch();
    }
  } else {
    if (searchRun && !searchRun.finished) window.search.stop();
    renderNameResults();
  }
}

function setSearchStatus(text, cls = '') {
  const ui = searchUi;
  ui.status.textContent = text;
  ui.status.className = `search-status${cls ? ` ${cls}` : ''}`;
  ui.progress.classList.remove('running');
  ui.fill.style.width = '0';
  ui.stop.classList.add('hidden');
  ui.fold.classList.add('hidden');
}

// -- text --
// what a search depends on: the same key is the same search
function searchKey() {
  const { text, scope, where, matchCase, word, regex, files } = searchState;
  return JSON.stringify([text, scope, where, matchCase, word, regex, files, repos.length]);
}

function runSearchIfChanged() {
  if (!searchRun || searchRun.key !== searchKey()) runSearch();
}

async function runSearch() {
  const ui = searchUi;
  if (!ui) return;
  const text = ui.input.value;
  searchState.text = text;
  saveSearchState();
  if (searchState.kind !== 'text') {
    renderNameResults();
    return;
  }
  if (!text.trim()) {
    if (searchRun && !searchRun.finished) window.search.stop();
    searchRun = null;
    ui.results.textContent = '';
    setSearchStatus('');
    return;
  }
  if (searchState.regex) {
    try {
      new RegExp(text);
    } catch (e) {
      ui.results.textContent = '';
      setSearchStatus(`Not a valid expression: ${e.message.replace(/^Invalid regular expression: /, '')}`, 'tool-error');
      return;
    }
  }
  const list = searchRepos();
  if (!list.length) {
    ui.results.textContent = '';
    setSearchStatus(repos.length ? 'No microservices in this group.' : 'No microservices yet: add them in Git (Add ▾).');
    return;
  }
  const id = ++searchSeq;
  searchRun = {
    id,
    key: searchKey(),
    text,
    total: list.length,
    done: 0,
    lines: 0,
    files: 0,
    found: 0,
    truncated: false,
    errors: [],
    skipped: [],
    blocks: [],
    errorBox: null,
    started: Date.now(),
    finished: null,
    re: searchRegExp(text, searchState),
  };
  ui.results.textContent = '';
  ui.fold.textContent = 'Collapse all';
  rememberRecent(SEARCH_RECENT_KEY, text, (x) => x === text);
  clearInterval(searchTimer);
  searchTimer = setInterval(renderSearchStatus, 200);
  renderSearchStatus();
  const r = await window.search.text({
    id,
    text,
    mode: searchState.regex ? 'regex' : 'text',
    matchCase: searchState.matchCase,
    word: searchState.word,
    where: searchState.where,
    files: searchState.files,
    repos: list.map((x) => x.path),
  });
  if (!searchRun || searchRun.id !== id) return;
  clearInterval(searchTimer);
  searchRun.finished = r;
  if (r.error) {
    setSearchStatus(r.error, 'tool-error');
    return;
  }
  renderSearchErrors();
  renderSearchStatus();
}

function onSearchProgress(p) {
  const run = searchRun;
  if (!run || p.id !== run.id || !searchUi) return;
  run.done = p.done;
  const repo = p.repo;
  if (repo.error) run.errors.push(repo);
  else if (repo.skipped) run.skipped.push(repo);
  if (repo.matches.length) {
    run.found++;
    run.lines += repo.matches.length;
    run.files += new Set(repo.matches.map((m) => m.file)).size;
    if (repo.truncated) run.truncated = true;
    addRepoBlock(run, repo);
  }
  renderSearchStatus();
}

function setCollapsed(block, collapsed) {
  block.classList.toggle('collapsed', collapsed);
  block.querySelector('.sr-service-head').setAttribute('aria-expanded', String(!collapsed));
}

function addRepoBlock(run, repo) {
  const label = repoLabel(repo.path, repo.name);
  const byFile = new Map();
  for (const m of repo.matches) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const block = tEl('section', 'sr-service');
  block.dataset.name = label.toLowerCase();
  block.dataset.path = repo.path;
  const head = tEl('button', 'sr-service-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  head.innerHTML = CHEVRON_ICON;
  head.appendChild(tEl('span', 'sr-service-name', label));
  if (repo.rev) head.appendChild(tEl('span', 'an-chip info', repo.rev));
  head.appendChild(tEl('span', 'sr-count', `${srPlural(repo.matches.length, 'line')}${repo.truncated ? '+' : ''} in ${srPlural(byFile.size, 'file')}`));
  head.addEventListener('click', () => setCollapsed(block, !block.classList.contains('collapsed')));
  const body = tEl('div', 'sr-files');
  const fromOrigin = Boolean(repo.rev);
  for (const [rel, lines] of byFile) {
    const { dir, base } = splitRel(rel);
    const file = tEl('div', 'sr-file');
    const fileHead = tEl('div', 'sr-file-head');
    const name = tEl('button', 'sr-file-name');
    name.type = 'button';
    name.title = fromOrigin ? `Open ${rel} (your working copy of it)` : `Open ${rel}`;
    name.innerHTML = FILE_ICON;
    name.append(tEl('span', 'sr-base', base), tEl('span', 'sr-dir', dir));
    name.addEventListener('click', () => searchOpenFile(repo.path, rel));
    fileHead.append(name, fileActions(repo.path, rel));
    file.appendChild(fileHead);
    for (const m of lines) {
      const line = tEl('button', 'sr-line');
      line.type = 'button';
      line.title = `Open ${base} (line ${m.line})`;
      const text = tEl('span', 'sr-text');
      markInto(text, m.text.replace(/^\s+/, ''), run.re);
      line.append(tEl('span', 'sr-ln', String(m.line)), text);
      line.addEventListener('click', () => searchOpenFile(repo.path, rel));
      file.appendChild(line);
    }
    body.appendChild(file);
  }
  block.append(head, body);
  run.blocks.push(block);
  run.blocks.sort((a, b) => a.dataset.name.localeCompare(b.dataset.name));
  if (searchState.kind !== 'text' || searchUi.input.value !== run.text) return;
  // in name order, whatever order they finish in
  const after = [...searchUi.results.querySelectorAll('.sr-service')].find((b) => b.dataset.name.localeCompare(block.dataset.name) > 0);
  searchUi.results.insertBefore(block, after || null);
}

function renderSearchErrors() {
  const run = searchRun;
  const problems = [...run.errors, ...run.skipped];
  if (!problems.length) return;
  const box = tEl('div', 'sr-problems');
  box.appendChild(tEl('div', 'sr-problems-head', `${srPlural(problems.length, 'microservice')} not searched`));
  for (const r of problems) {
    const row = tEl('div', 'sr-problem');
    row.append(tEl('span', 'sr-problem-name', repoLabel(r.path, r.name)), tEl('span', r.error ? 'tool-error' : 'tool-hint', r.error || r.skipped));
    box.appendChild(row);
  }
  run.errorBox = box;
  if (searchState.kind === 'text') searchUi.results.appendChild(box);
}

function renderSearchStatus() {
  const run = searchRun;
  const ui = searchUi;
  if (!run || !ui || searchState.kind !== 'text') return;
  const fin = run.finished;
  const ms = fin && typeof fin.took === 'number' ? fin.took : Date.now() - run.started;
  const secs = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  const lines = `${srPlural(run.lines, 'line')}${run.truncated ? '+' : ''} in ${srPlural(run.files, 'file')}`;
  ui.progress.classList.toggle('running', !fin);
  ui.fill.style.width = `${run.total ? Math.round((run.done / run.total) * 100) : 0}%`;
  ui.stop.classList.toggle('hidden', Boolean(fin));
  ui.fold.classList.toggle('hidden', !run.found);
  ui.status.className = 'search-status';
  if (!fin) {
    ui.status.textContent = `Searching ${run.done} of ${run.total} · ${secs}${run.lines ? ` · ${lines} so far` : ''}`;
    return;
  }
  const notSearched = run.errors.length + run.skipped.length;
  let text = run.lines ? `${lines}, in ${run.found} of ${srPlural(run.total, 'microservice')} · ${secs}` : `Nothing found in ${srPlural(run.total, 'microservice')} · ${secs}`;
  if (fin.capped) text = `The first ${fin.maxLines.toLocaleString('en-US')} lines: narrow the search (a group, In files, Whole word). ${text}`;
  else if (fin.stopped) text = `Stopped. ${text}`;
  if (notSearched) text += ` · ${notSearched} not searched`;
  ui.status.textContent = text;
}

// -- file names --
// Every file of every microservice, read once and again when it is older than NAMES_STALE_MS or the list changed.
function loadNames(force = false) {
  const key = repos.map((r) => r.path).join('\n');
  const fresh = nameIndex && nameIndex.key === key && Date.now() - nameIndex.at < NAMES_STALE_MS;
  if (!force && fresh) return Promise.resolve(nameIndex);
  if (!nameLoad) {
    nameLoad = window.search.names(null).then((r) => {
      const list = [];
      const services = [];
      for (const repo of r.repos || []) {
        const s = services.push({ path: repo.path, name: repoLabel(repo.path, repo.name) }) - 1;
        const prefix = `${services[s].name.toLowerCase()}/`;
        for (const rel of repo.files) list.push({ s, rel, lower: prefix + rel.toLowerCase(), cut: prefix.length + rel.lastIndexOf('/') + 1 });
      }
      nameIndex = { key, at: Date.now(), list, services, took: r.took || 0 };
      nameLoad = null;
      return nameIndex;
    });
  }
  return nameLoad;
}

// The files whose path (with the microservice's name in front) has every word typed; the ones whose name starts
// with the last word first, then those whose name has it, then the rest.
function findNames(query, paths, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !nameIndex) return { items: [], total: 0, terms };
  const keep = paths ? new Set(paths) : null;
  const lastTerm = terms[terms.length - 1];
  const buckets = [[], [], []];
  let total = 0;
  for (const f of nameIndex.list) {
    if (keep && !keep.has(nameIndex.services[f.s].path)) continue;
    if (!terms.every((t) => f.lower.includes(t))) continue;
    total++;
    const at = f.lower.indexOf(lastTerm, f.cut);
    const b = at === f.cut ? 0 : at > -1 ? 1 : 2;
    if (buckets[b].length < 5000) buckets[b].push(f);
  }
  const items = [];
  for (const b of buckets) {
    b.sort((x, y) => x.lower.length - x.cut - (y.lower.length - y.cut) || x.lower.length - y.lower.length);
    for (const f of b) {
      if (items.length >= limit) break;
      items.push({ repo: nameIndex.services[f.s].path, service: nameIndex.services[f.s].name, rel: f.rel });
    }
  }
  return { items, total, terms };
}

function nameRow(item, terms, cls = 'sr-name') {
  const { dir, base } = splitRel(item.rel);
  const row = tEl('button', cls);
  row.type = 'button';
  row.title = `Open ${item.rel}`;
  row.innerHTML = FILE_ICON;
  const baseEl = tEl('span', 'sr-base');
  markTerms(baseEl, base, terms);
  const dirEl = tEl('span', 'sr-dir');
  markTerms(dirEl, dir, terms);
  row.append(baseEl, dirEl, tEl('span', 'sr-service-tag', item.service));
  return row;
}

async function renderNameResults() {
  const ui = searchUi;
  if (!ui || searchState.kind !== 'names') return;
  const query = ui.input.value;
  if (!nameIndex || nameIndex.key !== repos.map((r) => r.path).join('\n')) {
    ui.results.textContent = '';
    setSearchStatus(`Reading the file lists of ${srPlural(repos.length, 'microservice')}...`);
  }
  const index = await loadNames();
  if (searchState.kind !== 'names' || ui.input.value !== query) return;
  const list = searchRepos().map((r) => r.path);
  const inScope = new Set(list);
  const all = index.list.filter((f) => inScope.has(index.services[f.s].path)).length;
  ui.results.textContent = '';
  if (!query.trim()) {
    setSearchStatus(`${srPlural(all, 'file')} in ${srPlural(list.length, 'microservice')}: type part of a name`);
    return;
  }
  const { items, total, terms } = findNames(query, list, NAMES_SHOWN);
  setSearchStatus(total ? `${total > items.length ? `The first ${items.length} of ` : ''}${srPlural(total, 'file')} of ${all.toLocaleString('en-US')}` : `No file name has that, in ${srPlural(all, 'file')}`);
  const box = tEl('div', 'sr-names');
  for (const item of items) {
    const row = tEl('div', 'sr-name-row');
    const open = nameRow(item, terms);
    open.addEventListener('click', () => searchOpenFile(item.repo, item.rel));
    row.append(open, fileActions(item.repo, item.rel));
    box.appendChild(row);
  }
  ui.results.appendChild(box);
}

// -- the page as a mode --
function showSearch(focus = true) {
  if (!searchUi) buildSearchPage();
  renderScopeChips();
  if (searchState.kind === 'names') renderNameResults();
  if (focus) {
    searchUi.input.focus();
    searchUi.input.select();
  }
  updateCrumb();
}

function searchCrumb() {
  if (searchState.kind === 'names') return 'File names';
  const t = searchState.text.trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

// the Search page with this text searched
function searchTextNow(text) {
  if (!searchUi) buildSearchPage();
  searchUi.input.value = text;
  searchState.text = text;
  searchState.kind = 'text';
  saveSearchState();
  if (currentMode !== 'search') activateMode('search');
  applySearchKind(false);
  runSearch();
}

// -- the quick search popup --
let qsItems = [];
let qsSel = 0;

function openQuickSearch() {
  const overlay = $('#quickSearch');
  overlay.classList.remove('hidden');
  const input = $('#qsInput');
  input.focus();
  input.select();
  renderQuickSearch();
  const before = nameIndex;
  loadNames().then(() => {
    if (!overlay.classList.contains('hidden') && nameIndex !== before) renderQuickSearch();
  });
}

function closeQuickSearch() {
  $('#quickSearch').classList.add('hidden');
}

function renderQuickSearch() {
  const input = $('#qsInput');
  const list = $('#qsList');
  const q = input.value;
  qsItems = [];
  let terms = [];
  if (q.startsWith('#')) {
    const text = q.slice(1).trim();
    if (text) qsItems.push({ kind: 'text', text });
    for (const t of recentList(SEARCH_RECENT_KEY)) if (typeof t === 'string' && t !== text && t.toLowerCase().includes(text.toLowerCase())) qsItems.push({ kind: 'text', text: t, recent: true });
    qsItems = qsItems.slice(0, 8);
    $('#qsCount').textContent = `text in ${srPlural(repos.length, 'microservice')}`;
  } else if (!q.trim()) {
    for (const t of recentList(SEARCH_RECENT_KEY).slice(0, 4)) if (typeof t === 'string') qsItems.push({ kind: 'text', text: t, recent: true });
    for (const f of recentList(SEARCH_RECENT_FILES_KEY).slice(0, 6)) {
      if (f && typeof f.rel === 'string' && repos.some((r) => r.path === f.repo)) qsItems.push({ kind: 'file', repo: f.repo, rel: f.rel, service: repoLabel(f.repo), recent: true });
    }
    $('#qsCount').textContent = nameIndex ? srPlural(nameIndex.list.length, 'file') : 'Reading the file lists...';
  } else {
    const found = findNames(q, null, QS_SHOWN);
    terms = found.terms;
    qsItems = found.items.map((f) => ({ kind: 'file', ...f }));
    $('#qsCount').textContent = nameIndex ? `${found.total.toLocaleString('en-US')} of ${srPlural(nameIndex.list.length, 'file')}` : 'Reading the file lists...';
  }
  qsSel = 0;
  list.textContent = '';
  if (!q.trim() && qsItems.length) list.appendChild(tEl('div', 'qs-group', 'Recent'));
  qsItems.forEach((item, i) => {
    let row;
    if (item.kind === 'file') row = nameRow(item, terms, 'qs-item');
    else {
      row = tEl('button', 'qs-item qs-text');
      row.type = 'button';
      row.innerHTML = SEARCH_ICON;
      row.append(tEl('span', 'sr-base', item.recent ? item.text : `Search “${item.text}”`), tEl('span', 'sr-service-tag', item.recent ? 'text searched before' : `in ${srPlural(repos.length, 'microservice')}`));
    }
    row.setAttribute('role', 'option');
    row.dataset.i = String(i);
    row.addEventListener('mousemove', () => selectQuickItem(i));
    row.addEventListener('click', (e) => chooseQuickItem(i, e.ctrlKey || e.metaKey));
    list.appendChild(row);
  });
  if (!qsItems.length && q.trim()) list.appendChild(tEl('div', 'qs-empty', nameIndex ? 'No file name has that. # and a text searches inside the files.' : 'Reading the file lists...'));
  selectQuickItem(0);
}

function selectQuickItem(i) {
  qsSel = Math.max(0, Math.min(qsItems.length - 1, i));
  $$('#qsList .qs-item').forEach((el) => {
    const on = Number(el.dataset.i) === qsSel;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

function chooseQuickItem(i, reveal = false) {
  const item = qsItems[i];
  if (!item) return;
  closeQuickSearch();
  if (item.kind === 'text') searchTextNow(item.text);
  else if (reveal) searchRevealFile(item.repo, item.rel);
  else searchOpenFile(item.repo, item.rel);
}

function setupQuickSearch() {
  const overlay = $('#quickSearch');
  const input = $('#qsInput');
  const mod = IS_MAC ? 'Cmd' : 'Ctrl';
  $('#qsHint').textContent = `↑↓ choose · Enter opens · ${mod}+Enter shows it in its folder · # searches the text · ${mod}+Shift+F the Search page`;
  input.addEventListener('input', renderQuickSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectQuickItem(qsSel + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseQuickItem(qsSel, e.ctrlKey || e.metaKey);
    }
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeQuickSearch();
    }
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeQuickSearch();
  });
  // Ctrl+P (Cmd+P) from any page; Ctrl+Shift+F (Cmd+Shift+F) goes to the Search page
  document.addEventListener('keydown', (e) => {
    if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'p' && !e.shiftKey) {
      e.preventDefault();
      openQuickSearch();
    } else if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      closeQuickSearch();
      if (currentMode !== 'search') activateMode('search');
      else showSearch();
    }
  });
}

function setupSearch() {
  loadSearchState();
  setupQuickSearch();
}

if (!CARD_ID) setupSearch();
