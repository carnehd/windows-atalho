// Logs view: a small log explorer with a search box, a time range, tabs (all logs, one per service, one per
// watch), error types and the list of logs with extra and custom columns.
// Relies on helpers from app.js and vault.js ($, $$, toast, vEl, ICONS, copyText, saveUiState, updateCrumb).
// Everything from the logs is put on the page as text (textContent), never as HTML.
const LOG_RANGES = { '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const LOG_MAX_COLUMNS = 10;
const LOG_COLUMN_WIDTH = 120; // the most an extra column takes for its values (its title can make it wider)
// The standard columns, in their order (the extra columns go between Service and Message). Each one can be removed.
const LOG_BASE_COLUMNS = [
  { key: 'time', title: 'Time', cls: 'logs-col-time', width: 150 },
  { key: 'level', title: 'Level', cls: 'logs-col-level', width: 78 },
  { key: 'service', title: 'Service', cls: 'logs-col-service', width: 180 },
  { key: 'message', title: 'Message', cls: 'logs-col-msg', width: 220 },
];
let logsInfo = null;
let logsResult = null;
let logsOpenId = null;
let logsBusy = false;
let logsPending = false;
let logsSetUp = false;
// Extra columns, between Service and Message: { field } shows a field as it is;
// { field, label, pattern } is a custom column that shows the part of the field the pattern finds.
let logsColumns = [];
let logsColumnsChosen = false; // until the user picks columns, the config's defaultColumns are shown
let logsHidden = []; // keys of the standard columns the user removed
let logsTab = { kind: 'all' }; // or { kind: 'service', name } or { kind: 'watch', id }
let logsServiceTabs = []; // services the user added as tabs with "+ Service" (there are none by default)
let logsTabLabels = {}; // names given to tabs: { all: 'Everything', 'service:payments-service': 'Payments' } (watches keep theirs)
let logsRenaming = false; // while a tab name is being typed, the tab bar is not redrawn
const LOG_MAX_SERVICE_TABS = 20;
let logsServices = { list: [], total: null, sampled: 0 };
let logsWatchState = { watches: [], live: false };
let logsErrorType = '';
let logsEnv = ''; // the chosen environment ('' for all); a watch tab uses its own instead
let logsEnvSaved = null; // from the last session ('' is "all"), applied once the config is loaded
let logsEnvLoaded = false;
let logsOrigin = 'openshift'; // where the logs come from: openshift, gcp or both (a watch tab uses its own)
let logsOriginSaved = null;
let logsOriginLoaded = false;

const logsPad = (n, len = 2) => String(n).padStart(len, '0');
const logsPlural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function logsTime(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${logsPad(d.getDate())}/${logsPad(d.getMonth() + 1)} ${logsPad(d.getHours())}:${logsPad(d.getMinutes())}:${logsPad(d.getSeconds())}.${logsPad(d.getMilliseconds(), 3)}`;
}

function logsShortTime(ts) {
  return new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function logsLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${logsPad(d.getMonth() + 1)}-${logsPad(d.getDate())}T${logsPad(d.getHours())}:${logsPad(d.getMinutes())}:${logsPad(d.getSeconds())}`;
}

function logsCrumb() {
  if (!logsInfo || logsInfo.error) return '';
  const env = logsEnvParam();
  return env ? `${logsInfo.label} · ${env}` : logsInfo.label;
}

function logsColumnFrom(c) {
  if (typeof c === 'string') return c ? { field: c } : null;
  if (!c || typeof c.field !== 'string' || !c.field) return null;
  return { field: c.field, ...(c.label && { label: String(c.label) }), ...(c.pattern && { pattern: String(c.pattern) }) };
}

// Clear is only on when there is something in the search box.
function updateLogsClear() {
  $('#logsClearBtn').disabled = !$('#logsQuery').value.trim();
}

function restoreLogsState(saved) {
  if (typeof saved.logsQuery === 'string') $('#logsQuery').value = saved.logsQuery;
  updateLogsClear();
  // A custom range is not kept between sessions: it falls back to the last hour.
  if (LOG_RANGES[saved.logsRange]) $('#logsRange').value = saved.logsRange;
  if (Array.isArray(saved.logsColumns)) logsColumns = saved.logsColumns.map(logsColumnFrom).filter(Boolean).slice(0, LOG_MAX_COLUMNS);
  logsColumnsChosen = saved.logsColumnsChosen === true || logsColumns.length > 0;
  if (Array.isArray(saved.logsHidden)) logsHidden = saved.logsHidden.filter((k) => LOG_BASE_COLUMNS.some((c) => c.key === k));
  if (typeof saved.logsEnv === 'string') logsEnvSaved = saved.logsEnv;
  if (typeof saved.logsOrigin === 'string') logsOriginSaved = saved.logsOrigin;
  if (saved.logsTabLabels && typeof saved.logsTabLabels === 'object') logsTabLabels = { ...saved.logsTabLabels };
  if (Array.isArray(saved.logsServiceTabs)) logsServiceTabs = saved.logsServiceTabs.filter((n) => typeof n === 'string' && n).slice(0, LOG_MAX_SERVICE_TABS);
  renderLogsHead();
}

// ---------- reading values ----------

// "a.b" is read as a literal key first (Elasticsearch often keeps dotted names flat), then as a nested path.
function logsValue(raw, name) {
  if (!raw || !name) return undefined;
  if (Object.prototype.hasOwnProperty.call(raw, name)) return raw[name];
  let cur = raw;
  for (const part of name.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// A field of a log. json.* fields come from the JSON the application logger writes in the message (the logs service
// reads it into h.json); a log without that JSON shows the same field at the top (GCP and test logs keep it there).
// kc.* fields come from a Keycloak event in the text (type=LOGIN_ERROR, realmId=..., read into h.kc).
function logsField(h, name) {
  const v = logsValue(h.raw, name);
  if (v !== undefined) return v;
  if (name.startsWith('kc.')) return h.kc ? h.kc[name.slice(3)] : undefined;
  if (!name.startsWith('json.')) return v;
  const inJson = h.json ? logsValue(h.json, name.slice(5)) : undefined;
  return inJson !== undefined ? inJson : logsValue(h.raw, name.slice(5));
}

function logsText(value) {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function logsFlatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) logsFlatten(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
}

const logsRegexCache = new Map();
function logsRegex(pattern) {
  if (!logsRegexCache.has(pattern)) {
    let re = null;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      re = null;
    }
    logsRegexCache.set(pattern, re);
  }
  return logsRegexCache.get(pattern);
}

// The text a column shows for one log. With a pattern: its first ( ) group, or the whole match.
function logsColumnValue(col, h) {
  const text = logsText(logsField(h, col.field));
  if (!col.pattern) return text;
  const re = logsRegex(col.pattern);
  const m = re && re.exec(text);
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[0];
}

const logsColumnTitle = (col) => col.label || col.field;
const logsShows = (key) => !logsHidden.includes(key);
// The columns on screen, standard and extra (the detail row spans them all).
const logsColumnCount = () => LOG_BASE_COLUMNS.filter((c) => logsShows(c.key)).length + logsColumns.length;
const logsIsPlain = (col) => !col.pattern && !col.label;
const logsSameColumn = (a, b) => a.field === b.field && (a.label || '') === (b.label || '') && (a.pattern || '') === (b.pattern || '');

// ---------- columns ----------

// Fields found in the logs on screen, the most common first, with one example value each.
function logsAvailableFields({ withStandard = false } = {}) {
  const standard = new Set(Object.values((logsInfo && logsInfo.fields) || {}));
  const found = new Map();
  for (const h of (logsResult && logsResult.hits) || []) {
    const all = { ...logsFlatten(h.raw), ...(h.json ? logsFlatten(h.json, 'json.') : {}), ...(h.kc ? logsFlatten(h.kc, 'kc.') : {}) };
    for (const [name, value] of Object.entries(all)) {
      if (!withStandard && standard.has(name)) continue;
      const f = found.get(name) || { name, count: 0, sample: '' };
      f.count++;
      if (!f.sample && value != null && value !== '') f.sample = logsText(value);
      found.set(name, f);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function renderLogsHead() {
  const row = $('#logsHeadRow');
  row.textContent = '';
  const heads = [];
  const th = (cls, name, onRemove, custom = false) => {
    const cell = vEl('th', cls);
    const wrap = vEl('div', 'logs-col-head');
    if (custom) {
      const mark = vEl('span', 'logs-col-custom', 'f');
      mark.title = 'Custom column';
      wrap.appendChild(mark);
    }
    wrap.appendChild(vEl('span', 'logs-col-name', name));
    const rm = vEl('button', 'logs-col-remove', '✕');
    rm.type = 'button';
    rm.title = `Remove the ${name} column`;
    rm.setAttribute('aria-label', `Remove the ${name} column`);
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
    wrap.appendChild(rm);
    cell.appendChild(wrap);
    row.appendChild(cell);
    heads.push(wrap);
    return cell;
  };
  const base = (key) => {
    const c = LOG_BASE_COLUMNS.find((x) => x.key === key);
    if (logsShows(key)) th(c.cls, c.title, () => setLogsHidden([...logsHidden, key]));
  };
  base('time');
  base('level');
  base('service');
  for (const col of logsColumns) {
    const name = logsColumnTitle(col);
    const cell = th('logs-col-extra', name, () => removeLogsColumn(col), !logsIsPlain(col));
    cell.title = col.pattern ? `${name}: from ${col.field}, pattern ${col.pattern}` : name;
    cell.dataset.column = name;
  }
  base('message');
  // + Column sits in the last header; with every column removed, in a header of its own
  if (!heads.length) {
    const cell = vEl('th', 'logs-col-msg');
    const wrap = vEl('div', 'logs-col-head');
    wrap.appendChild(vEl('span', 'logs-col-name', ''));
    cell.appendChild(wrap);
    row.appendChild(cell);
    heads.push(wrap);
  }
  const wrap = heads[heads.length - 1];
  const add = vEl('button', 'logs-col-add', '+ Column');
  add.id = 'logsAddColumnBtn';
  add.type = 'button';
  add.title = 'Show another field of the logs as a column, or make a custom column';
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#logsColumnMenu')) closeLogsMenus();
    else openLogsColumnMenu(add);
  });
  wrap.appendChild(add);
  fitLogsColumns();
}

const logsTextWidth = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
})();

// Each extra column is as wide as its values, up to LOG_COLUMN_WIDTH, and never narrower than its title: a short
// value (a { } or "dev") does not cut the title, and a long one is cut as before.
function fitLogsColumns() {
  const heads = [...$('#logsHeadRow').querySelectorAll('th.logs-col-extra')];
  const nameEl = heads.length ? heads[0].querySelector('.logs-col-name') : null;
  const headFont = nameEl ? getComputedStyle(nameEl).font : '500 11px sans-serif';
  const sample = $('#logsRows .logs-extra');
  const cellFont = sample ? getComputedStyle(sample).font : '12px monospace';
  const hits = (logsResult && logsResult.hits) || [];
  let extra = 0;
  logsColumns.forEach((col, i) => {
    const th = heads[i];
    if (!th) return;
    // the title, its ✕ (and the f of a custom column, or + Column in the last header) and the padding
    let title = logsTextWidth(logsColumnTitle(col), headFont) + 16 + 20 + (logsIsPlain(col) ? 0 : 16);
    if (th.querySelector('#logsAddColumnBtn')) title += 80;
    let content = 0;
    for (const h of hits) {
      const text = logsColumnValue(col, h);
      if (!text) continue;
      const w = logsJsonOf(text) ? 36 : logsTextWidth(text.slice(0, 40), cellFont) + 16;
      if (w > content) content = w;
      if (content >= LOG_COLUMN_WIDTH) break;
    }
    const width = Math.ceil(Math.max(title, Math.min(content, LOG_COLUMN_WIDTH)));
    th.style.width = `${width}px`;
    extra += width;
  });
  // Room for the columns on screen (and at least 220px of message); past that the table scrolls sideways.
  const fixed = LOG_BASE_COLUMNS.filter((c) => logsShows(c.key)).reduce((sum, c) => sum + c.width, 0);
  $('#logsView .logs-table').style.minWidth = `${fixed + extra}px`;
}

function setLogsHidden(keys) {
  logsHidden = LOG_BASE_COLUMNS.map((c) => c.key).filter((k) => keys.includes(k));
  renderLogsHead();
  if (logsResult) renderLogs();
  saveUiState();
}

function setLogsColumns(columns) {
  logsColumnsChosen = true;
  logsColumns = columns.map(logsColumnFrom).filter(Boolean).slice(0, LOG_MAX_COLUMNS);
  renderLogsHead();
  if (logsResult) renderLogs();
  saveUiState();
}

function addLogsColumn(column) {
  const col = logsColumnFrom(typeof column === 'string' ? column.trim() : column);
  if (!col) return false;
  if (logsColumns.some((c) => logsSameColumn(c, col))) return true;
  if (logsColumns.length >= LOG_MAX_COLUMNS) {
    toast(`You can show up to ${LOG_MAX_COLUMNS} extra columns. Remove one first.`, 'error');
    return false;
  }
  setLogsColumns([...logsColumns, col]);
  return true;
}

function removeLogsColumn(column) {
  const col = logsColumnFrom(column);
  setLogsColumns(logsColumns.filter((c) => !logsSameColumn(c, col)));
}

// ---------- menus (columns, error types, new watch) ----------

function closeLogsMenus() {
  for (const id of ['#logsColumnMenu', '#logsErrorMenu', '#logsWatchMenu', '#logsServiceMenu', '#logsLoginMenu']) {
    const menu = $(id);
    if (menu) menu.remove();
  }
}

function placeLogsMenu(menu, anchor, alignRight) {
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = alignRight ? r.right - width : r.left;
  menu.style.left = `${Math.max(8, Math.min(Math.round(left), window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
}

function logsMenuKeys(input, onEnter, focusBack) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeLogsMenus();
      const back = $(focusBack);
      if (back) back.focus();
    }
  });
}

function openLogsColumnMenu(anchor) {
  closeLogsMenus();
  const menu = vEl('div', 'clip-menu logs-col-menu');
  menu.id = 'logsColumnMenu';
  const input = vEl('input', 'input logs-col-input');
  input.placeholder = 'Field name, e.g. traceId';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Field name');
  menu.appendChild(input);
  const list = vEl('div', 'logs-col-list');
  menu.appendChild(list);
  const custom = vEl('button', 'clip-menu-item logs-col-new', 'Custom column...');
  custom.type = 'button';
  custom.title = 'A column made from a field, for example the number of ms taken out of the message';
  custom.addEventListener('click', () => showCustomColumnForm(menu));
  menu.appendChild(custom);
  const fields = logsAvailableFields();

  const renderList = () => {
    list.textContent = '';
    const q = input.value.trim().toLowerCase();
    // the standard columns first, so a removed one can be put back
    for (const c of LOG_BASE_COLUMNS) {
      if (q && !c.title.toLowerCase().includes(q)) continue;
      const on = logsShows(c.key);
      const item = vEl('button', `clip-menu-item logs-col-item${on ? ' on' : ''}`);
      item.type = 'button';
      item.title = on ? `Remove the ${c.title} column` : `Show the ${c.title} column again`;
      item.appendChild(vEl('span', 'logs-col-check', on ? '✓' : ''));
      item.appendChild(vEl('span', 'logs-col-field', c.title));
      item.appendChild(vEl('span', 'logs-col-sample', 'standard column'));
      item.addEventListener('click', () => {
        setLogsHidden(on ? [...logsHidden, c.key] : logsHidden.filter((k) => k !== c.key));
        renderList();
      });
      list.appendChild(item);
    }
    const shown = fields.filter((f) => !q || f.name.toLowerCase().includes(q));
    // plain columns chosen earlier that the logs on screen do not have still appear, so they can be removed here too
    for (const c of logsColumns) {
      if (logsIsPlain(c) && !fields.some((f) => f.name === c.field) && (!q || c.field.toLowerCase().includes(q))) shown.unshift({ name: c.field, count: 0, sample: '' });
    }
    for (const f of shown) {
      const on = logsColumns.some((c) => logsIsPlain(c) && c.field === f.name);
      const item = vEl('button', `clip-menu-item logs-col-item${on ? ' on' : ''}`);
      item.type = 'button';
      item.title = on ? `Remove the ${f.name} column` : `Show ${f.name} as a column`;
      item.appendChild(vEl('span', 'logs-col-check', on ? '✓' : ''));
      item.appendChild(vEl('span', 'logs-col-field', f.name));
      item.appendChild(vEl('span', 'logs-col-sample', f.sample));
      item.addEventListener('click', () => {
        if (on) removeLogsColumn(f.name);
        else addLogsColumn(f.name);
        renderList();
      });
      list.appendChild(item);
    }
    if (!shown.length && !list.children.length) {
      const hint = q
        ? `Press Enter to add "${input.value.trim()}" as a column.`
        : 'Search first to see the fields of your logs, or type a field name and press Enter.';
      list.appendChild(vEl('div', 'logs-col-hint', hint));
    }
  };
  input.addEventListener('input', renderList);
  logsMenuKeys(input, () => {
    if (addLogsColumn(input.value)) {
      input.value = '';
      renderList();
    }
  }, '#logsAddColumnBtn');
  renderList();
  placeLogsMenu(menu, anchor, true);
  input.focus();
}

// A custom column: a name, the field it reads, and an optional pattern that picks part of the value.
function showCustomColumnForm(menu) {
  menu.textContent = '';
  menu.classList.add('logs-form');
  menu.appendChild(vEl('div', 'logs-form-title', 'Custom column'));
  const field = (label, placeholder, value = '') => {
    const wrap = vEl('label', 'logs-form-field');
    wrap.appendChild(vEl('span', 'logs-form-label', label));
    const input = vEl('input', 'input');
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.value = value;
    wrap.appendChild(input);
    menu.appendChild(wrap);
    return input;
  };
  const name = field('Name', 'e.g. Duration');
  const source = field('From field', 'e.g. message', (logsInfo && logsInfo.fields && logsInfo.fields.message) || 'message');
  // Suggestions as plain buttons, not a <datalist>: its native popup can crash Electron on macOS.
  const suggest = vEl('div', 'logs-form-suggest');
  for (const f of logsAvailableFields({ withStandard: true }).slice(0, 8)) {
    const b = vEl('button', 'logs-form-chip', f.name);
    b.type = 'button';
    b.title = f.sample ? `e.g. ${f.sample.slice(0, 120)}` : f.name;
    b.addEventListener('click', () => {
      source.value = f.name;
      source.dispatchEvent(new Event('input'));
      pattern.focus();
    });
    suggest.appendChild(b);
  }
  if (suggest.children.length) menu.appendChild(suggest);
  const pattern = field('Take', 'optional, e.g. in (\\d+) ms');
  menu.appendChild(vEl('div', 'logs-form-hint', 'Take is a regular expression: the column shows what is inside ( ), or the whole match. Leave it empty to show the field as it is.'));
  const preview = vEl('div', 'logs-form-preview');
  menu.appendChild(preview);
  const actions = vEl('div', 'logs-form-actions');
  const back = vEl('button', 'btn btn-sm', 'Back');
  back.type = 'button';
  const addBtn = vEl('button', 'btn btn-sm btn-primary', 'Add column');
  addBtn.type = 'button';
  actions.append(back, addBtn);
  menu.appendChild(actions);

  const current = () => ({ field: source.value.trim(), label: name.value.trim(), pattern: pattern.value.trim() });
  const problem = (c) => {
    if (!c.field) return 'Choose the field to read.';
    if (c.pattern && !logsRegex(c.pattern)) return 'The pattern is not a valid regular expression.';
    return '';
  };
  const update = () => {
    const c = current();
    const p = problem(c);
    addBtn.disabled = Boolean(p);
    if (p) {
      preview.textContent = p;
      preview.classList.add('bad');
      return;
    }
    preview.classList.remove('bad');
    const hits = ((logsResult && logsResult.hits) || []).slice(0, 40);
    const values = hits.map((h) => logsColumnValue(c, h)).filter((v) => v !== '');
    preview.textContent = hits.length
      ? `In the logs on screen: ${values.length ? [...new Set(values)].slice(0, 4).join(' · ') : 'nothing found yet'}`
      : 'Search first to see a preview.';
  };
  const submit = () => {
    const c = current();
    if (problem(c)) return;
    // without a name the column is called after its field (and the pattern, if there is one)
    const col = { field: c.field, ...(c.pattern && { pattern: c.pattern }), label: c.label || (c.pattern ? `${c.field} ${c.pattern}` : '') };
    if (!col.label) delete col.label;
    if (addLogsColumn(col)) closeLogsMenus();
  };
  for (const input of [name, source, pattern]) {
    input.addEventListener('input', update);
    logsMenuKeys(input, submit, '#logsAddColumnBtn');
  }
  back.addEventListener('click', () => openLogsColumnMenu($('#logsAddColumnBtn')));
  addBtn.addEventListener('click', submit);
  update();
  name.focus();
}

// ---------- error types ----------

async function openLogsErrorMenu(anchor) {
  closeLogsMenus();
  const menu = vEl('div', 'clip-menu logs-err-menu');
  menu.id = 'logsErrorMenu';
  menu.appendChild(vEl('div', 'logs-col-hint', 'Grouping the errors...'));
  placeLogsMenu(menu, anchor, false);
  const { from, to } = logsRange();
  const env = logsEnvParam();
  const r = await window.logs.errorTypes({ query: $('#logsQuery').value.trim(), from, to, origin: logsOriginParam(), ...logsTabParams(), ...(env && { env }) });
  if ($('#logsErrorMenu') !== menu) return; // closed or replaced meanwhile
  menu.textContent = '';
  if (r.error) {
    menu.appendChild(vEl('div', 'logs-col-hint bad', r.error));
    return;
  }
  const head = r.errors
    ? `${logsPlural(r.errors, 'error')} in ${logsPlural(r.types.length, 'kind')}${r.sampled ? ` (the newest ${r.sampled.toLocaleString()} errors)` : ''}`
    : 'No errors in this time range.';
  menu.appendChild(vEl('div', 'logs-err-head', head));
  if (logsErrorType) {
    const all = vEl('button', 'clip-menu-item logs-err-clear', 'Show all logs again');
    all.type = 'button';
    all.addEventListener('click', () => setLogsErrorType(''));
    menu.appendChild(all);
  }
  const list = vEl('div', 'logs-err-list');
  for (const t of r.types) {
    const item = vEl('button', `clip-menu-item logs-err-item${t.type === logsErrorType ? ' on' : ''}`);
    item.type = 'button';
    item.title = `Example:\n${t.sample}`;
    item.appendChild(vEl('span', 'logs-err-count', t.count.toLocaleString()));
    const text = vEl('span', 'logs-err-text');
    text.appendChild(vEl('span', 'logs-err-type', t.type));
    text.appendChild(vEl('span', 'logs-err-where', `${t.services.join(', ')}${t.services.length ? ' · ' : ''}last ${logsShortTime(t.last)}`));
    item.appendChild(text);
    item.addEventListener('click', () => setLogsErrorType(t.type));
    list.appendChild(item);
  }
  menu.appendChild(list);
  placeLogsMenu(menu, anchor, false);
}

function setLogsErrorType(type) {
  closeLogsMenus();
  logsErrorType = type;
  renderLogsErrorChip();
  runLogsSearch();
}

function renderLogsErrorChip() {
  const chip = $('#logsErrorChip');
  chip.textContent = '';
  chip.classList.toggle('hidden', !logsErrorType);
  $('#logsErrorsBtn').classList.toggle('active', Boolean(logsErrorType));
  if (!logsErrorType) return;
  chip.title = logsErrorType;
  chip.appendChild(vEl('span', 'logs-chip-label', 'Error type'));
  chip.appendChild(vEl('span', 'logs-chip-value', logsErrorType));
  const rm = vEl('button', 'logs-chip-remove', '✕');
  rm.type = 'button';
  rm.title = 'Show all logs again';
  rm.setAttribute('aria-label', 'Remove the error type filter');
  rm.addEventListener('click', () => setLogsErrorType(''));
  chip.appendChild(rm);
}

// ---------- tabs: all logs, one per service, one per watch ----------

function logsActiveWatch() {
  return logsTab.kind === 'watch' ? logsWatchState.watches.find((w) => w.id === logsTab.id) : null;
}

function logsTabParams() {
  if (logsTab.kind === 'service') return { service: logsTab.name };
  const w = logsActiveWatch();
  return w ? { watch: w.query } : {};
}

function logsTabButton(cls, label, count, onClick) {
  const b = vEl('button', `logs-tab ${cls}`);
  b.type = 'button';
  b.setAttribute('role', 'tab');
  b.appendChild(vEl('span', 'logs-tab-label', label));
  if (count != null) b.appendChild(vEl('span', 'logs-tab-count', count.toLocaleString()));
  b.addEventListener('click', () => { if (!b.classList.contains('active')) onClick(); });
  return b;
}

function renderLogsTabs() {
  if (logsRenaming) return; // redrawn when the new name is saved or cancelled
  const bar = $('#logsTabs');
  bar.textContent = '';
  const active = (kind, key) => logsTab.kind === kind && (kind === 'all' || logsTab.name === key || logsTab.id === key);
  const all = logsTabButton(active('all') ? 'active' : '', logsTabLabels.all || 'All', logsServices.total, () => selectLogsTab({ kind: 'all' }));
  all.dataset.tab = 'all';
  logsTabRenamable(all, 'all', 'All', 'Every log for the search');
  all.setAttribute('aria-selected', String(active('all')));
  bar.appendChild(all);

  // Service tabs are only the ones added with "+ Service"; their counts follow the search.
  const counts = new Map(logsServices.list.map((s) => [s.name, s.count]));
  const known = logsServices.total != null;
  for (const name of logsServiceTabs) {
    const on = active('service', name);
    const b = logsTabButton(`logs-tab-service${on ? ' active' : ''}`, logsTabLabels[`service:${name}`] || name, known ? counts.get(name) || 0 : null, () => selectLogsTab({ kind: 'service', name }));
    logsTabRenamable(b, `service:${name}`, name, `Only ${name}`);
    b.dataset.service = name;
    b.setAttribute('aria-selected', String(on));
    b.appendChild(logsTabRemove(`Remove the ${name} tab`, () => removeLogsServiceTab(name)));
    bar.appendChild(b);
  }

  if (logsWatchState.watches.length) bar.appendChild(vEl('span', 'logs-tab-sep'));
  for (const w of logsWatchState.watches) {
    const on = active('watch', w.id);
    const b = vEl('button', `logs-tab logs-tab-watch${on ? ' active' : ''}${w.error ? ' failing' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.dataset.watch = w.id;
    const icon = vEl('span', 'logs-tab-icon');
    icon.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS.eye}</svg>`;
    b.appendChild(icon);
    b.appendChild(vEl('span', 'logs-tab-label', w.label || w.query));
    logsTabRenamable(b, `watch:${w.id}`, w.query, w.error
      ? `Watching "${w.query}"${w.env ? ` in ${w.env}` : ''}. The last check failed: ${w.error}`
      : `Watching "${w.query}"${w.env ? ` in ${w.env}` : ''}${w.lastNewAt ? `. Last new log ${logsShortTime(w.lastNewAt)}` : ''}`, w.label);
    if (w.origin && w.origin !== 'openshift') b.appendChild(vEl('span', 'logs-tab-env', w.origin === 'gcp' ? logsOriginName('gcp') : `OS+${logsOriginName('gcp')}`));
    if (w.env) b.appendChild(vEl('span', 'logs-tab-env', w.env));
    if (w.newCount) b.appendChild(vEl('span', 'logs-tab-new', w.newCount > 999 ? '999+' : String(w.newCount)));
    b.appendChild(logsTabRemove(`Stop watching "${w.query}"`, () => removeLogsWatch(w)));
    b.addEventListener('click', () => { if (!on) selectLogsTab({ kind: 'watch', id: w.id }); });
    bar.appendChild(b);
  }
  const addService = vEl('button', 'logs-tab logs-tab-add', '+ Service');
  addService.id = 'logsAddServiceBtn';
  addService.type = 'button';
  addService.title = 'Add a tab that shows only the logs of one service';
  addService.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#logsServiceMenu')) closeLogsMenus();
    else openLogsServiceMenu(addService);
  });
  bar.appendChild(addService);
  const add = vEl('button', 'logs-tab logs-tab-add', '+ Watch');
  add.id = 'logsAddWatchBtn';
  add.type = 'button';
  add.title = 'Watch for logs that contain a text, for example username123. They get their own tab.';
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#logsWatchMenu')) closeLogsMenus();
    else openLogsWatchMenu(add);
  });
  bar.appendChild(add);
}

// Double-click the name (or F2 on the tab) to rename it; an empty name goes back to the original one.
function logsTabRenamable(button, key, original, title, customLabel) {
  const current = key.startsWith('watch:') ? customLabel : logsTabLabels[key];
  button.title = `${title}${current ? ` (renamed from "${original}")` : ''}\nDouble-click the name or press F2 to rename this tab.`;
  button.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startLogsTabRename(button, key, original);
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'F2') {
      e.preventDefault();
      startLogsTabRename(button, key, original);
    }
  });
}

function startLogsTabRename(button, key, original) {
  if (logsRenaming || !button.isConnected) return;
  const label = button.querySelector('.logs-tab-label');
  // An input inside a <button> does not take the keyboard well, so the tab becomes a plain box while editing.
  const box = vEl('span', `${button.className} logs-tab-renaming`);
  const input = vEl('input', 'logs-tab-input');
  input.value = label ? label.textContent : original;
  input.spellcheck = false;
  input.maxLength = 60;
  input.setAttribute('aria-label', `New name for the ${original} tab`);
  const fit = () => { input.size = Math.max(6, Math.min(32, input.value.length + 1)); };
  fit();
  box.appendChild(input);
  button.replaceWith(box);
  logsRenaming = true;
  input.focus();
  input.select();
  let done = false;
  // byKeyboard: Enter or Escape. A blur (a click elsewhere) only swaps this tab back, so the click that
  // caused it still reaches the other tab instead of a tab bar that was redrawn under the pointer.
  const finish = (save, byKeyboard) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    const newLabel = value && value !== original ? value : '';
    if (save && label) label.textContent = newLabel || original;
    box.replaceWith(button);
    logsRenaming = false;
    if (save) setLogsTabLabel(key, newLabel);
    if (!byKeyboard) return;
    renderLogsTabs();
    const again = key === 'all' ? $('#logsTabs [data-tab="all"]')
      : key.startsWith('watch:') ? $(`#logsTabs [data-watch="${CSS.escape(key.slice(6))}"]`)
        : $(`#logsTabs [data-service="${CSS.escape(key.slice(8))}"]`);
    if (again) again.focus();
  };
  input.addEventListener('input', fit);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, true);
    }
  });
  input.addEventListener('blur', () => finish(true, false));
  for (const type of ['click', 'dblclick', 'mousedown']) input.addEventListener(type, (e) => e.stopPropagation());
}

// Saves a tab name; the caller redraws. Watches keep their name in the main process, with the watch.
function setLogsTabLabel(key, label) {
  if (key.startsWith('watch:')) {
    const id = key.slice(6);
    const w = logsWatchState.watches.find((x) => x.id === id);
    if (w) {
      if (label) w.label = label;
      else delete w.label;
    }
    window.logs.renameWatch(id, label).then((r) => { if (r.error) toast(r.error, 'error'); });
    return;
  }
  if (label) logsTabLabels[key] = label;
  else delete logsTabLabels[key];
  saveUiState();
}

function logsTabRemove(title, onRemove) {
  const rm = vEl('span', 'logs-tab-remove', '✕');
  rm.title = title;
  rm.setAttribute('role', 'button');
  rm.setAttribute('aria-label', title);
  rm.addEventListener('click', (e) => {
    e.stopPropagation();
    onRemove();
  });
  return rm;
}

function addLogsServiceTab(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (logsServiceTabs.includes(n)) return true;
  if (logsServiceTabs.length >= LOG_MAX_SERVICE_TABS) {
    toast(`You can have up to ${LOG_MAX_SERVICE_TABS} service tabs. Remove one first.`, 'error');
    return false;
  }
  logsServiceTabs = [...logsServiceTabs, n];
  renderLogsTabs();
  saveUiState();
  return true;
}

function removeLogsServiceTab(name) {
  logsServiceTabs = logsServiceTabs.filter((n) => n !== name);
  delete logsTabLabels[`service:${name}`];
  saveUiState();
  if (logsTab.kind === 'service' && logsTab.name === name) selectLogsTab({ kind: 'all' });
  else renderLogsTabs();
}

function openLogsServiceMenu(anchor) {
  closeLogsMenus();
  const menu = vEl('div', 'clip-menu logs-col-menu');
  menu.id = 'logsServiceMenu';
  menu.appendChild(vEl('div', 'logs-form-title', 'Add a tab for a service'));
  const input = vEl('input', 'input logs-col-input');
  input.placeholder = 'Service name';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Service name');
  menu.appendChild(input);
  const list = vEl('div', 'logs-col-list');
  menu.appendChild(list);
  if (logsServices.sampled) menu.appendChild(vEl('div', 'logs-col-hint', `Counted in the newest ${logsServices.sampled.toLocaleString()} logs.`));

  const renderList = () => {
    list.textContent = '';
    const q = input.value.trim().toLowerCase();
    const services = [...logsServices.list];
    for (const name of logsServiceTabs) if (!services.some((s) => s.name === name)) services.push({ name, count: 0 });
    const shown = services.filter((s) => !q || s.name.toLowerCase().includes(q));
    for (const s of shown) {
      const on = logsServiceTabs.includes(s.name);
      const item = vEl('button', `clip-menu-item logs-col-item${on ? ' on' : ''}`);
      item.type = 'button';
      item.title = on ? `Remove the ${s.name} tab` : `Add a tab for ${s.name}`;
      item.appendChild(vEl('span', 'logs-col-check', on ? '✓' : ''));
      if (s.origin === 'gcp') item.appendChild(logsOriginBadge('gcp'));
      item.appendChild(vEl('span', 'logs-col-field logs-svc-name', s.name));
      item.appendChild(vEl('span', 'logs-col-sample', logsPlural(s.count, 'log')));
      item.addEventListener('click', () => {
        if (on) removeLogsServiceTab(s.name);
        else addLogsServiceTab(s.name);
        renderList();
      });
      list.appendChild(item);
    }
    if (!shown.length) {
      list.appendChild(vEl('div', 'logs-col-hint', q
        ? `Press Enter to add a tab for "${input.value.trim()}".`
        : 'Search first to see the services, or type a name and press Enter.'));
    }
  };
  input.addEventListener('input', renderList);
  // Enter adds the typed name and opens its tab
  logsMenuKeys(input, () => {
    const name = input.value.trim();
    if (name && addLogsServiceTab(name)) {
      closeLogsMenus();
      selectLogsTab({ kind: 'service', name });
    }
  }, '#logsAddServiceBtn');
  renderList();
  placeLogsMenu(menu, anchor, false);
  input.focus();
}

function selectLogsTab(tab) {
  logsTab = tab;
  if (tab.kind === 'watch') markLogsWatchSeen(tab.id);
  renderLogsEnvs();
  updateCrumb();
  renderLogsTabs();
  runLogsSearch();
}

async function loadLogsWatches() {
  const r = await window.logs.watches();
  if (!r.error) logsWatchState = r;
  if (logsTab.kind === 'watch' && !logsActiveWatch()) logsTab = { kind: 'all' };
  renderLogsEnvs();
  const live = $('#logsLiveBtn');
  live.classList.toggle('hidden', !logsInfo || logsInfo.source !== 'local');
  live.classList.toggle('active', Boolean(logsWatchState.live));
  live.textContent = logsWatchState.live ? 'Live test logs: on' : 'Live test logs: off';
  renderLogsTabs();
}

function markLogsWatchSeen(id) {
  const w = logsWatchState.watches.find((x) => x.id === id);
  if (w && w.newCount) {
    w.newCount = 0;
    window.logs.watchSeen(id);
  }
}

function openLogsWatchMenu(anchor) {
  closeLogsMenus();
  const menu = vEl('div', 'clip-menu logs-watch-menu');
  menu.id = 'logsWatchMenu';
  menu.appendChild(vEl('div', 'logs-form-title', 'Watch for logs'));
  const input = vEl('input', 'input logs-col-input');
  input.placeholder = 'Text to watch, e.g. username123';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Text to watch');
  input.value = $('#logsQuery').value.trim();
  menu.appendChild(input);
  const every = logsInfo && logsInfo.watchIntervalSeconds ? logsInfo.watchIntervalSeconds : 30;
  const shownEnv = logsEnvParam();
  const where = ` in ${logsOriginName(logsOriginParam())}, ${shownEnv || 'all environments'}`;
  menu.appendChild(vEl('div', 'logs-form-hint', `The logs that match${where} get their own tab. Every ${every} s the app looks for new ones, also with the window closed, and counts them on the tab. The same search syntax works here.`));
  const actions = vEl('div', 'logs-form-actions');
  const btn = vEl('button', 'btn btn-sm btn-primary', 'Watch');
  btn.type = 'button';
  actions.appendChild(btn);
  menu.appendChild(actions);
  const submit = async () => {
    const r = await window.logs.addWatch(input.value, logsEnvParam(), logsOriginParam());
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    closeLogsMenus();
    await loadLogsWatches();
    selectLogsTab({ kind: 'watch', id: r.id });
  };
  logsMenuKeys(input, submit, '#logsAddWatchBtn');
  btn.addEventListener('click', submit);
  placeLogsMenu(menu, anchor, true);
  input.focus();
  input.select();
}

async function removeLogsWatch(w) {
  const r = await window.logs.removeWatch(w.id);
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  toast(`Stopped watching "${w.query}"`, 'success');
  const wasOpen = logsTab.kind === 'watch' && logsTab.id === w.id;
  await loadLogsWatches();
  if (wasOpen) selectLogsTab({ kind: 'all' });
}

// ---------- origins: OpenShift, GCP or both ----------

const logsGcpOn = () => Boolean(logsInfo && !logsInfo.error && logsInfo.origins && logsInfo.origins.gcp);
function logsOriginName(id) {
  const gcp = (logsInfo && logsInfo.origins && logsInfo.origins.gcp && logsInfo.origins.gcp.label) || 'GCP';
  return id === 'gcp' ? gcp : id === 'both' ? `OpenShift + ${gcp}` : 'OpenShift';
}

function logsOriginParam() {
  const w = logsActiveWatch();
  const o = w ? w.origin || 'openshift' : logsOrigin;
  return logsGcpOn() ? o : 'openshift';
}

function logsOriginBadge(origin) {
  const b = vEl('span', `logs-origin ${origin === 'gcp' ? 'gcp' : 'openshift'}`, logsOriginName(origin === 'gcp' ? 'gcp' : 'openshift'));
  b.title = origin === 'gcp' ? 'From the GCP logs' : 'From the OpenShift logs';
  return b;
}

function renderLogsOrigins() {
  const select = $('#logsOrigin');
  const on = logsGcpOn();
  if (!logsOriginLoaded && logsInfo && !logsInfo.error) {
    logsOrigin = ['openshift', 'gcp', 'both'].includes(logsOriginSaved) ? logsOriginSaved : 'openshift';
    logsOriginLoaded = true;
  }
  select.textContent = '';
  for (const id of ['openshift', 'gcp', 'both']) select.appendChild(new Option(logsOriginName(id), id));
  const w = logsActiveWatch();
  select.value = on ? (w ? w.origin || 'openshift' : logsOrigin) : 'openshift';
  select.disabled = Boolean(w);
  select.title = w
    ? `This watch looks in ${logsOriginName(w.origin || 'openshift')}. Open another tab to change it.`
    : 'Where the logs come from: OpenShift, GCP or both (the GCP part is set in logs-config.json)';
  select.classList.toggle('hidden', !on);
}

// ---------- environments ----------

function logsEnvParam() {
  const w = logsActiveWatch();
  return w ? w.env || '' : logsEnv;
}

function renderLogsEnvs() {
  renderLogsOrigins();
  const select = $('#logsEnv');
  const names = (logsInfo && !logsInfo.error && logsInfo.environments) || [];
  if (!logsEnvLoaded && logsInfo && !logsInfo.error) {
    // first load: the environment of the last session, else the default one from the config
    logsEnv = logsEnvSaved === '' || names.includes(logsEnvSaved) ? logsEnvSaved : logsInfo.defaultEnvironment || '';
    logsEnvLoaded = true;
  } else if (logsInfo && !logsInfo.error && logsEnv && !names.includes(logsEnv)) {
    logsEnv = logsInfo.defaultEnvironment || ''; // removed from the config meanwhile
  }
  select.textContent = '';
  for (const name of names) select.appendChild(new Option(name, name));
  select.appendChild(new Option('All environments', ''));
  const w = logsActiveWatch();
  const shown = w ? w.env || '' : logsEnv;
  if (w && shown && !names.includes(shown)) select.appendChild(new Option(shown, shown));
  select.value = shown;
  select.disabled = Boolean(w);
  select.title = w
    ? `This watch looks in ${shown || 'all environments'}. Open another tab to change the environment.`
    : 'Environment: the searches for each one are in logs-config.json';
  select.classList.toggle('hidden', names.length === 0 && !shown);
}

// ---------- search ----------

function logsRange() {
  if ($('#logsRange').value === 'custom') {
    // datetime-local values have no time zone, so they are read as local time
    return { from: Date.parse($('#logsFrom').value), to: Date.parse($('#logsTo').value) };
  }
  const to = Date.now();
  return { from: to - LOG_RANGES[$('#logsRange').value], to };
}

// Words and phrases from the search to highlight in the messages (not the excluded ones).
function logsHighlightTerms(query) {
  const terms = [];
  const re = /(-?)(?:[A-Za-z_@][\w.@]*:)?(?:"([^"]*)"?|(\S+))/g;
  let m;
  let negate = false;
  while ((m = re.exec(query))) {
    const value = m[2] !== undefined ? m[2] : m[3];
    if (m[2] === undefined && /^(AND|OR|&&|\|\|)$/.test(value)) continue;
    if (m[2] === undefined && /^(NOT|!)$/.test(value)) { negate = true; continue; }
    if (!m[1] && !negate) {
      const t = String(value || '').replace(/[*?]/g, '');
      if (t.length >= 2) terms.push(t);
    }
    negate = false;
  }
  return terms;
}

function logsMarked(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(vEl('mark', 'logs-mark', m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

// ---------- Grafana login: a window like the log-explorer's, or a cookie copied from a browser ----------

let logsGrafanaUser = null; // the Grafana login, when logged in
let logsGrafanaVia = null; // 'window' or 'cookie'
let logsGrafanaBusy = false;

// What the login button can do: 'setup' (Grafana is not set up yet), 'token' (no login needed) or 'login'.
function logsGrafanaMode() {
  const g = logsInfo && !logsInfo.error ? logsInfo.grafanaSetup : null;
  if (!g || g.missing.length) return 'setup';
  return g.token ? 'token' : 'login';
}

function renderLogsGrafanaBtn() {
  const btn = $('#logsGrafanaBtn');
  const mode = logsGrafanaMode();
  btn.disabled = logsGrafanaBusy;
  btn.classList.toggle('btn-primary', mode === 'login' && !logsGrafanaUser && !logsGrafanaBusy);
  if (logsGrafanaBusy) {
    btn.textContent = 'Waiting for the Grafana login...';
    btn.title = 'Log in in the window that opened. It closes by itself when the login ends.';
  } else if (logsGrafanaUser) {
    btn.textContent = `Grafana: ${logsGrafanaUser} ⏏`;
    btn.title = `Logged in to Grafana ${logsGrafanaVia === 'cookie' ? 'with a cookie' : 'through the login window'}. Click to log out.`;
  } else if (mode === 'token') {
    btn.textContent = 'Grafana: token';
    btn.title = 'Grafana uses the service account token in logs-config.json';
  } else {
    btn.textContent = 'Log in to Grafana';
    btn.title = mode === 'setup' ? 'Grafana is not set up yet: click to see what logs-config.json needs' : 'Log in through a window (Keycloak) or with the grafana_session cookie';
  }
}

async function loadLogsGrafanaStatus() {
  if (logsGrafanaMode() !== 'login') {
    logsGrafanaUser = null;
    renderLogsGrafanaBtn();
    return;
  }
  const r = await window.logs.grafanaStatus();
  logsGrafanaUser = r && r.loggedIn && r.user ? r.user.login || r.user.name || 'logged in' : null;
  logsGrafanaVia = r && r.via ? r.via : null;
  renderLogsGrafanaBtn();
}

async function logsGrafanaLogin() {
  if (logsGrafanaBusy) return;
  closeLogsMenus();
  logsGrafanaBusy = true;
  renderLogsGrafanaBtn();
  const r = await window.logs.grafanaLogin();
  logsGrafanaBusy = false;
  if (r.error) {
    logsGrafanaUser = null;
    renderLogsGrafanaBtn();
    toast(r.error, 'error');
    return;
  }
  logsGrafanaUser = r.user ? r.user.login || r.user.name : 'logged in';
  logsGrafanaVia = 'window';
  await loadLogsInfo(); // browserLogin may have been turned on
  renderLogsGrafanaBtn();
  toast(`Logged in to Grafana as ${logsGrafanaUser}`, 'success');
  runLogsSearch();
}

function toggleLogsLoginMenu(anchor) {
  if ($('#logsLoginMenu')) closeLogsMenus();
  else openLogsLoginMenu(anchor);
}

// The two ways to log in: the window, or the grafana_session cookie copied from a browser where Grafana is open.
// When Grafana is not set up yet, it says what logs-config.json needs.
function openLogsLoginMenu(anchor) {
  closeLogsMenus();
  const mode = logsGrafanaMode();
  const menu = vEl('div', 'clip-menu logs-watch-menu logs-login-menu');
  menu.id = 'logsLoginMenu';
  menu.appendChild(vEl('div', 'logs-form-title', 'Log in to Grafana'));
  const close = vEl('button', 'btn btn-sm', mode === 'login' ? 'Cancel' : 'Close');
  close.type = 'button';
  close.addEventListener('click', closeLogsMenus);
  if (mode !== 'login') {
    const missing = logsInfo && !logsInfo.error ? logsInfo.grafanaSetup.missing : [];
    menu.appendChild(vEl('div', 'logs-form-hint', mode === 'token'
      ? 'Grafana uses the service account token in logs-config.json (grafana.token), so there is no login. To log in as yourself, empty the token.'
      : `To log in to Grafana, fill in ${missing.length ? missing.join(', ') : 'the grafana part'} in logs-config.json, save it and press Search.`));
    const actions = vEl('div', 'logs-form-actions');
    const open = vEl('button', 'btn btn-sm btn-primary', 'Open config');
    open.type = 'button';
    open.addEventListener('click', async () => {
      closeLogsMenus();
      const r = await window.logs.openConfig();
      if (r.error) toast(r.error, 'error');
    });
    actions.append(close, open);
    menu.appendChild(actions);
    placeLogsMenu(menu, anchor, true);
    open.focus();
    return;
  }
  const win = vEl('button', 'btn btn-sm btn-primary logs-login-window', 'Log in through a window');
  win.type = 'button';
  win.addEventListener('click', logsGrafanaLogin);
  menu.appendChild(win);
  menu.appendChild(vEl('div', 'logs-form-hint', 'Opens the Grafana (Keycloak) login, as the log-explorer does. It closes by itself when the login ends.'));
  menu.appendChild(vEl('div', 'logs-login-or', 'Or with a cookie'));
  menu.appendChild(vEl('div', 'logs-form-hint', 'In a browser where Grafana is open and you are logged in, press F12, open Application (Edge or Chrome) > Cookies > the Grafana address, and copy the value of grafana_session. The app checks it and keeps it in logs-config.json.'));
  const input = vEl('input', 'input logs-col-input');
  input.type = 'password';
  input.placeholder = 'grafana_session value';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'grafana_session cookie');
  menu.appendChild(input);
  const show = vEl('label', 'logs-cookie-show');
  const box = vEl('input');
  box.type = 'checkbox';
  box.addEventListener('change', () => { input.type = box.checked ? 'text' : 'password'; });
  show.append(box, document.createTextNode(' Show'));
  menu.appendChild(show);
  const msg = vEl('div', 'logs-form-preview bad hidden');
  menu.appendChild(msg);
  const actions = vEl('div', 'logs-form-actions');
  const ok = vEl('button', 'btn btn-sm', 'Log in with the cookie');
  ok.type = 'button';
  actions.append(close, ok);
  menu.appendChild(actions);
  const submit = async () => {
    if (!input.value.trim()) {
      msg.textContent = 'Paste the value of the grafana_session cookie.';
      msg.classList.remove('hidden');
      input.focus();
      return;
    }
    ok.disabled = true;
    ok.textContent = 'Checking...';
    const r = await window.logs.grafanaCookie(input.value);
    ok.disabled = false;
    ok.textContent = 'Log in with the cookie';
    if (r.error) {
      msg.textContent = r.error;
      msg.classList.remove('hidden');
      input.focus();
      input.select();
      return;
    }
    closeLogsMenus();
    logsGrafanaUser = r.user ? r.user.login || r.user.name : 'logged in';
    logsGrafanaVia = 'cookie';
    await loadLogsInfo(); // the config now has the cookie
    renderLogsGrafanaBtn();
    toast(`Logged in to Grafana as ${logsGrafanaUser} with the cookie`, 'success');
    runLogsSearch();
  };
  logsMenuKeys(input, submit, '#logsGrafanaBtn');
  ok.addEventListener('click', submit);
  placeLogsMenu(menu, anchor, true);
  win.focus();
}

async function logsGrafanaLogout() {
  if (!window.confirm(`Log out of Grafana (${logsGrafanaUser})? The next search will ask for the login again.`)) return;
  const r = await window.logs.grafanaLogout();
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  logsGrafanaUser = null;
  logsGrafanaVia = null;
  await loadLogsInfo(); // a cookie was taken out of the config
  renderLogsGrafanaBtn();
  toast('Logged out of Grafana', 'success');
}

async function loadLogsInfo() {
  logsInfo = await window.logs.info();
  const src = $('#logsSource');
  if (logsInfo.error) {
    src.textContent = 'Config error';
    src.title = logsInfo.error;
  } else {
    const where = logsInfo.source === 'local' ? 'data/logs' : logsInfo.target;
    src.textContent = `Source: ${logsInfo.label}${where ? ` · ${where}` : ''}`;
    src.title = `${logsInfo.label}: ${logsInfo.target}\nChange it in ${logsInfo.configFile}`;
  }
  $('#logsGenerateBtn').classList.toggle('hidden', logsInfo.source !== 'local');
  $('#logsLiveBtn').classList.toggle('hidden', logsInfo.source !== 'local');
  if (logsGrafanaMode() !== 'login') logsGrafanaUser = null; // the config changed to a token or away from Grafana
  if (!logsColumnsChosen && !logsInfo.error) {
    const defaults = (logsInfo.defaultColumns || []).map(logsColumnFrom).filter(Boolean).slice(0, LOG_MAX_COLUMNS);
    if (JSON.stringify(defaults) !== JSON.stringify(logsColumns)) {
      logsColumns = defaults;
      renderLogsHead();
    }
  }
  renderLogsGrafanaBtn();
  renderLogsEnvs();
  updateCrumb();
}

async function refreshLogs() {
  setupLogs();
  await loadLogsInfo();
  await loadLogsWatches();
  if (logsInfo.error) {
    logsResult = null;
    renderLogs(logsInfo.error);
    return;
  }
  loadLogsGrafanaStatus();
  if (!logsResult) runLogsSearch();
}

async function runLogsSearch() {
  if (logsBusy) {
    logsPending = true;
    return;
  }
  const { from, to } = logsRange();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    toast('Choose a start time before the end time', 'error');
    return;
  }
  const query = $('#logsQuery').value.trim();
  updateLogsClear();
  const tab = { ...logsTab };
  const errorType = logsErrorType;
  logsBusy = true;
  $('#logsSearchBtn').disabled = true;
  $('#logsSummary').textContent = 'Searching...';
  let r;
  let sv = null;
  try {
    await loadLogsInfo(); // the config file may have changed since the last search
    if (logsInfo.error) {
      r = { error: logsInfo.error };
    } else {
      const env = logsEnvParam();
      const base = { query, from, to, origin: logsOriginParam(), ...(errorType && { errorType }), ...(env && { env }) };
      [r, sv] = await Promise.all([window.logs.search({ ...base, ...logsTabParams() }), window.logs.services(base)]);
    }
  } catch (e) {
    r = { error: e.message };
  } finally {
    logsBusy = false;
    $('#logsSearchBtn').disabled = false;
  }
  logsOpenId = null;
  closeLogsMenus(); // their lists came from the previous results
  logsServices = sv && !sv.error ? { list: sv.services, total: sv.total ?? null, sampled: sv.sampled || 0 } : { list: [], total: null, sampled: 0 };
  renderLogsTabs();
  if (r.error) {
    logsResult = null;
    if (r.code === 'GRAFANA_LOGIN') {
      logsGrafanaUser = null;
      renderLogsGrafanaBtn();
    }
    renderLogs(r.error, r.code);
  } else {
    logsResult = { ...r, query, from, to, tab, errorType, env: logsEnvParam(), origin: logsOriginParam() };
    renderLogs();
  }
  saveUiState();
  if (logsPending) {
    logsPending = false;
    runLogsSearch();
  }
}

function logsContext(result) {
  if (result.tab.kind === 'service') return ` in ${result.tab.name}`;
  if (result.tab.kind === 'watch') {
    const w = logsWatchState.watches.find((x) => x.id === result.tab.id);
    if (w) return ` matching "${w.query}"`;
  }
  return '';
}

function renderLogs(error, code) {
  logsOpenId = null;
  const body = $('#logsRows');
  body.textContent = '';
  const empty = $('#logsEmpty');
  empty.classList.remove('logs-error');
  const summary = $('#logsSummary');
  if (error || !logsResult) {
    summary.textContent = error ? 'Search failed' : '';
    empty.textContent = error || '';
    empty.classList.toggle('logs-error', Boolean(error));
    empty.classList.toggle('hidden', !error);
    if (code === 'GRAFANA_LOGIN') {
      empty.appendChild(document.createElement('br'));
      const b = vEl('button', 'btn btn-primary btn-sm logs-login-btn', 'Log in to Grafana');
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLogsLoginMenu(b);
      });
      empty.appendChild(b);
    }
    return;
  }
  const { hits, total, took, from, to, missing, sampled } = logsResult;
  const shown = hits.length < total ? ` · showing the newest ${hits.length.toLocaleString()}` : '';
  const sample = sampled ? ` · among the newest ${sampled.toLocaleString()} errors` : '';
  const env = `${logsResult.origin && logsResult.origin !== 'openshift' ? ` · ${logsOriginName(logsResult.origin)}` : ''}${logsResult.env ? ` · ${logsResult.env}` : ''}`;
  summary.textContent = `${logsPlural(total, 'log')}${logsContext(logsResult)}${env}${shown}${sample} · ${logsShortTime(from)} to ${logsShortTime(to)} · ${took} ms`;
  summary.title = summary.textContent;
  empty.classList.toggle('hidden', hits.length > 0);
  if (missing) empty.textContent = 'No test logs yet. Press "Generate test logs" to create a week of sample logs.';
  else if (!hits.length) empty.textContent = 'No logs match in this time range. Try a longer range or fewer words.';
  else if (!logsColumnCount()) {
    empty.textContent = 'Every column is removed. Put one back with + Column.';
    empty.classList.remove('hidden');
  }

  const terms = logsHighlightTerms(logsResult.query);
  const watch = logsResult.tab.kind === 'watch' && logsWatchState.watches.find((x) => x.id === logsResult.tab.id);
  if (watch) terms.push(...logsHighlightTerms(watch.query));
  for (const h of hits) {
    const tr = vEl('tr', `logs-row logs-${h.level}`);
    tr.dataset.id = h.id;
    if (logsShows('time')) tr.appendChild(vEl('td', 'logs-time', logsTime(h.ts)));
    if (logsShows('level')) {
      const levelCell = vEl('td');
      levelCell.appendChild(vEl('span', `logs-level ${h.level}`, (h.levelRaw || h.level).toUpperCase().slice(0, 7)));
      tr.appendChild(levelCell);
    }
    if (logsShows('service')) {
      const service = vEl('td', 'logs-service');
      if (h.origin === 'gcp' || (logsResult.origins && logsResult.origins.length > 1)) service.appendChild(logsOriginBadge(h.origin));
      if (h.service) service.appendChild(logsServiceTag(h.service));
      service.title = `${logsOriginName(h.origin === 'gcp' ? 'gcp' : 'openshift')} · ${h.service}`;
      tr.appendChild(service);
    }
    for (const col of logsColumns) {
      const text = logsColumnValue(col, h);
      const cell = vEl('td', `logs-extra${logsIsPlain(col) ? '' : ' custom'}`);
      const json = logsJsonOf(text);
      if (json) {
        // a value that is only a JSON (a request or response body...) shows as { }: a click opens it formatted
        cell.appendChild(logsJsonButton(logsColumnTitle(col), json));
      } else if (text && logsIsPlain(col)) {
        // a field value is a link: click shows only the logs with it, Alt+click leaves them out
        const link = vEl('button', 'logs-cell-link', text);
        link.type = 'button';
        link.title = `${col.field}: ${text.slice(0, 300)}\nClick: only logs with this value · Alt+click: leave them out`;
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          addLogsValueFilter(col.field, text, e.altKey);
        });
        cell.appendChild(link);
      } else {
        cell.textContent = text;
        if (text) cell.title = `${logsColumnTitle(col)}: ${text.slice(0, 500)}`;
      }
      tr.appendChild(cell);
    }
    if (logsShows('message')) {
      const msg = vEl('td', 'logs-msg');
      const json = logsJsonOf(h.message);
      if (json) msg.appendChild(logsJsonButton('Message', json));
      else msg.appendChild(logsMarked(h.message.replace(/\s+/g, ' ').trim().slice(0, 500), terms));
      tr.appendChild(msg);
    }
    tr.addEventListener('click', () => toggleLogDetail(h, tr));
    body.appendChild(tr);
  }
  fitLogsColumns();
}

// Each service keeps one colour: a new service gets the colour used the least so far, so the first 16
// services all look different. The choice is kept in this app's storage, so it stays the same next time.
const LOG_SERVICE_HUES = [212, 152, 32, 278, 346, 184, 52, 318, 106, 246, 12, 196, 88, 300, 170, 230];
const LOG_COLORS_KEY = 'logsServiceColors';
let logsServiceColors = null; // { name: index into LOG_SERVICE_HUES }, oldest first

function logsServiceHue(name) {
  if (!logsServiceColors) {
    try {
      logsServiceColors = JSON.parse(localStorage.getItem(LOG_COLORS_KEY) || '{}') || {};
    } catch {
      logsServiceColors = {};
    }
  }
  if (!(name in logsServiceColors)) {
    const used = new Array(LOG_SERVICE_HUES.length).fill(0);
    for (const i of Object.values(logsServiceColors)) if (used[i] !== undefined) used[i]++;
    logsServiceColors[name] = used.indexOf(Math.min(...used));
    const names = Object.keys(logsServiceColors);
    if (names.length > 300) for (const old of names.slice(0, names.length - 300)) delete logsServiceColors[old];
    try {
      localStorage.setItem(LOG_COLORS_KEY, JSON.stringify(logsServiceColors));
    } catch {
      // without storage the colours still work, they are just worked out again next time
    }
  }
  return LOG_SERVICE_HUES[logsServiceColors[name]] ?? LOG_SERVICE_HUES[0];
}

function logsServiceTag(name) {
  const tag = vEl('span', 'logs-svc-tag', name.replace(/^(?:[\w-]*-)?keycloak-/, 'kc-'));
  tag.style.setProperty('--svc-hue', String(logsServiceHue(name)));
  return tag;
}

// Adds field:"value" to the search box (or -field:"value" to leave it out) and searches again.
function addLogsValueFilter(field, value, exclude) {
  const quoted = `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const term = /^[A-Za-z_@][\w.@]*$/.test(field) ? `${field}:${quoted}` : quoted;
  const wanted = exclude ? `-${term}` : term;
  const opposite = exclude ? term : `-${term}`;
  const at = (t) => new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g');
  let q = $('#logsQuery').value.replace(at(opposite), ' ').replace(/\s+/g, ' ').trim();
  if (!at(wanted).test(q)) q = q ? `${q} ${wanted}` : wanted;
  $('#logsQuery').value = q;
  runLogsSearch();
}

// JSON kept as text inside a log (corpoPedido, corpoResposta, headers...) is read as JSON too, at any depth,
// so it shows indented instead of one line full of \".
function logsDeepJson(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return logsDeepJson(JSON.parse(t), depth + 1);
      } catch {
        // not JSON after all
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => logsDeepJson(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, logsDeepJson(v, depth + 1)]));
  return value;
}

// The text as indented JSON when it is JSON (with the JSON inside it opened too), else as it is.
function logsPretty(text) {
  const parsed = logsDeepJson(text);
  return typeof parsed === 'string' ? text : JSON.stringify(parsed, null, 2);
}

// ---------- popup: a JSON value formatted, or a request as curl ----------

// The JSON a value holds (with the JSON inside it opened too), or null when it is not only a JSON.
function logsJsonOf(text) {
  const t = String(text || '').trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return null;
  const parsed = logsDeepJson(t);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function logsJsonButton(title, json) {
  const b = vEl('button', 'logs-json-cell', Array.isArray(json) ? '[ ]' : '{ }');
  b.type = 'button';
  const n = Array.isArray(json) ? json.length : Object.keys(json).length;
  b.title = `${title}: JSON with ${n} ${Array.isArray(json) ? 'items' : 'fields'}. Click to see it formatted`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    openLogsPopup(title, [{ text: JSON.stringify(json, null, 2), copy: 'JSON' }]);
  });
  return b;
}

// parts: { note, bad } for a line of text, { label, text, copy } for a block with its Copy button.
function openLogsPopup(title, parts) {
  $('#logsPopupTitle').textContent = title;
  const body = $('#logsPopupBody');
  body.textContent = '';
  for (const p of parts) {
    if (p.note) {
      body.appendChild(vEl('div', `logs-popup-note${p.bad ? ' bad' : ''}`, p.note));
      continue;
    }
    const head = vEl('div', 'logs-popup-head');
    head.appendChild(vEl('span', '', p.label || ''));
    head.appendChild(vEl('span', 'logs-trace-space'));
    const copy = vEl('button', 'btn btn-sm', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(p.text, p.copy || 'Text'));
    head.appendChild(copy);
    body.appendChild(head);
    body.appendChild(vEl('pre', 'clip-formatted logs-popup-pre', p.text));
  }
  $('#logsPopup').classList.remove('hidden');
  $('#logsPopupClose').focus();
}

function closeLogsPopup() {
  $('#logsPopup').classList.add('hidden');
}

const LOG_CURL_SECRET = /^(authorization|cookie|x-api-key|apikey|x-auth-token|proxy-authorization)$/i;
const LOG_CURL_DROP = /^(host|content-length|connection|accept-encoding|traceparent|tracestate|x-b3-.*|x-request-id)$/i;

// The HTTP request a log describes (method and uri or url, or "Invoking ... POST http://..."), as the log-explorer
// reads it; null for logs that are not a request (responses included).
function logsRequestOf(h) {
  const j = h.json || {};
  const raw = h.raw || {};
  const top = (name) => logsValue(raw, name);
  if (/RESPONSE/i.test(String(j.logType || top('logType') || ''))) return null;
  const text = String(j.descricao || h.message || '').split('\n')[0];
  if (/^(Response fulfilled|Received response)/i.test(text)) return null;
  const inv = text.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/\S+)/);
  let url = String(j.uri || j.url || top('uri') || top('url') || top('path') || (inv && inv[2]) || '');
  const method = String(j.method || top('method') || (inv && inv[1]) || '').toUpperCase();
  if (!url || !/^[A-Z]+$/.test(method)) return null;
  let headers = j.headers ?? top('headers') ?? {};
  if (typeof headers === 'string') headers = logsDeepJson(headers);
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) headers = {};
  const hostHeader = Object.entries(headers).find(([k]) => /^(x-forwarded-host|host)$/i.test(k));
  let guessed = '';
  if (!/^https?:\/\//i.test(url)) {
    // the log has only the path: the Host header, else curlBaseUrl from logs-config.json
    const path = url.startsWith('/') ? url : `/${url}`;
    const env = String(j['deployment.environment'] || j.environment || top('environment') || top('env') || top('kubernetes.labels.env') || 'dev').toLowerCase();
    const base = String((logsInfo && logsInfo.curlBaseUrl) || '').replace(/\{env\}/g, env).replace(/\{service\}/g, h.service || '').replace(/\/+$/, '');
    if (hostHeader) {
      const proto = Object.entries(headers).find(([k]) => /^x-forwarded-proto$/i.test(k));
      url = `${proto ? proto[1] : 'https'}://${hostHeader[1]}${path}`;
      guessed = 'host';
    } else if (base) {
      url = `${base}${path}`;
      guessed = 'base';
    } else {
      url = `http://<host>${path}`;
      guessed = 'none';
    }
  }
  const hdrs = [];
  let hasSecret = false;
  for (const [k, v] of Object.entries(headers)) {
    if (LOG_CURL_DROP.test(k)) continue;
    const val = Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (LOG_CURL_SECRET.test(k)) {
      hdrs.push([k, `<${k.toUpperCase().replace(/[^A-Z]/g, '_')}>`]);
      hasSecret = true;
    } else hdrs.push([k, val]);
  }
  let reqBody = j.corpoPedido ?? top('corpoPedido') ?? j.body ?? null;
  if (reqBody != null && typeof reqBody !== 'string') reqBody = JSON.stringify(reqBody);
  if (reqBody === '' || reqBody === 'null') reqBody = null;
  if (reqBody && !hdrs.some(([k]) => /^content-type$/i.test(k)) && /^[[{]/.test(reqBody.trim())) hdrs.push(['Content-Type', 'application/json']);
  const envOf = (url.match(/[.-](dev|sit|uat|preprod|preprd|prd)[.-]/i) || [])[1] || String(j['deployment.environment'] || top('environment') || top('env') || '');
  return { method, url, headers: hdrs, body: reqBody, guessed, hasSecret, env: envOf.toLowerCase() };
}

const logsShQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const logsPsQ = (s) => `'${String(s).replace(/'/g, "''")}'`;

function logsCurlBash(r) {
  const lines = [`curl -sS -i -X ${r.method} ${logsShQ(r.url)}`, ...r.headers.map(([k, v]) => `  -H ${logsShQ(`${k}: ${v}`)}`)];
  if (r.body) lines.push(`  --data-raw ${logsShQ(r.body)}`);
  return lines.join(' \\\n');
}

// curl.exe (part of Windows) avoids the curl alias of Invoke-WebRequest in PowerShell 5.1; the body goes through
// a file so its quotes stay as they are.
function logsCurlPowerShell(r) {
  const out = [];
  if (r.body) out.push(`$body = @'\n${r.body}\n'@`, 'Set-Content -Path "$env:TEMP\\pedido.json" -Value $body -Encoding utf8 -NoNewline');
  const args = [`curl.exe -sS -i -X ${r.method} ${logsPsQ(r.url)}`, ...r.headers.map(([k, v]) => `  -H ${logsPsQ(`${k}: ${v}`)}`)];
  if (r.body) args.push('  --data-binary "@$env:TEMP\\pedido.json"');
  out.push(args.join(' `\n'));
  return out.join('\n');
}

function openLogsCurl(h) {
  const r = logsRequestOf(h);
  if (!r) {
    toast('This log does not describe an HTTP request (no method and uri)', 'error');
    return;
  }
  const risky = r.env && !/^(dev|sit)$/.test(r.env);
  const parts = [
    risky
      ? { note: `A request from ${r.env.toUpperCase()}: repeat it only if you are sure, better change the address to DEV or SIT.`, bad: true }
      : { note: 'The app runs nothing: copy the command and run it in a terminal. Repeating a request can create or change data.' },
  ];
  if (r.guessed === 'base') parts.push({ note: 'The log has only the path: the address comes from curlBaseUrl in logs-config.json. Check it before running.' });
  if (r.guessed === 'host') parts.push({ note: 'The log has only the path: the address comes from its Host header. Check it before running.' });
  if (r.guessed === 'none') parts.push({ note: 'The log has only the path: put the address in place of <host>, or set curlBaseUrl in logs-config.json (it takes {env} and {service}).', bad: true });
  if (r.hasSecret) parts.push({ note: 'Authentication headers are replaced by markers (<AUTHORIZATION>...): fill in a valid token.' });
  parts.push({ note: `${r.method} ${r.url} · ${r.headers.length} headers · body ${r.body ? `${r.body.length.toLocaleString()} characters` : 'empty'}` });
  parts.push({ label: 'PowerShell (Windows)', text: logsCurlPowerShell(r), copy: 'curl command' });
  parts.push({ label: 'Bash / Git Bash', text: logsCurlBash(r), copy: 'curl command' });
  openLogsPopup('curl', parts);
}

// One list of fields in the log details: a click on a value shows only the logs with it (Alt+click leaves them
// out), and ▦ shows the field as a column. "above" is the message field, already shown above the lists.
function logsDetailFields(box, h, title, fields, { sort = false, above = null } = {}) {
  const entries = Object.entries(fields).filter(([, v]) => logsText(v) !== '');
  if (!entries.length) return;
  if (sort) entries.sort(([a], [b]) => a.localeCompare(b));
  box.appendChild(vEl('div', 'logs-detail-label', title));
  const list = vEl('div', 'logs-field-list');
  for (const [name, value] of entries) {
    list.appendChild(vEl('span', 'logs-field-name', name));
    const text = logsText(value);
    if (name === above) {
      list.appendChild(vEl('span', 'logs-field-above', '(the message, above)'));
    } else {
      // a value that is JSON shows indented; the filter still uses the value as it is
      const pretty = logsPretty(text);
      const shown = pretty !== text ? pretty : text.length > 300 ? `${text.slice(0, 300)}…` : text;
      const link = vEl('button', `logs-cell-link logs-field-value${pretty !== text ? ' json' : ''}`, shown.length > 5000 ? `${shown.slice(0, 5000)}…` : shown);
      link.type = 'button';
      link.title = `${name}: ${text.slice(0, 500)}\nClick: only logs with this value · Alt+click: leave them out`;
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        addLogsValueFilter(name, text, e.altKey);
      });
      list.appendChild(link);
    }
    const on = logsColumns.some((c) => logsIsPlain(c) && c.field === name);
    const col = vEl('button', `logs-field-col${on ? ' on' : ''}`, '▦');
    col.type = 'button';
    col.title = on ? `Remove the ${name} column` : `Show ${name} as a column`;
    col.setAttribute('aria-label', col.title);
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      if (on) removeLogsColumn(name);
      else addLogsColumn(name);
      // the table was drawn again: open the same log again
      const tr = $(`#logsRows .logs-row[data-id="${CSS.escape(h.id)}"]`);
      if (tr) toggleLogDetail(h, tr);
    });
    list.appendChild(col);
  }
  box.appendChild(list);
}

function toggleLogDetail(h, tr) {
  const open = $('#logsRows .logs-detail');
  if (open) open.remove();
  $$('#logsRows .logs-row.open').forEach((r) => r.classList.remove('open'));
  if (logsOpenId === h.id) {
    logsOpenId = null;
    return;
  }
  logsOpenId = h.id;
  tr.classList.add('open');
  const row = vEl('tr', 'logs-detail');
  const td = vEl('td');
  td.colSpan = Math.max(1, logsColumnCount());
  const box = vEl('div', 'logs-detail-box');
  // When the table is wider than the window, the details keep to the visible part (see .logs-detail-box).
  box.style.width = `${Math.max(300, $('#logsView .logs-table-wrap').clientWidth - 48)}px`;
  const actions = vEl('div', 'logs-detail-actions');
  const btn = (label, title, fn) => {
    const b = vEl('button', 'btn btn-sm', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    actions.appendChild(b);
  };
  if (logsTraceIdOf(h)) {
    btn('View trace', 'Every log of this request as a waterfall, service by service', () => openLogsTrace(h));
    const view = actions.lastChild;
    view.classList.add('btn-primary', 'logs-trace-view');
    const icon = vEl('span', 'logs-trace-icon');
    icon.innerHTML = LOG_TRACE_ICON; // the app's own icon, not log data
    view.prepend(icon);
  }
  const messageName = (logsInfo && logsInfo.fields && logsInfo.fields.message) || 'message';
  const original = logsValue(h.raw, messageName);
  btn('Copy message', 'Copy the full message, as it came', () => copyText(typeof original === 'string' ? original : h.message, 'Message'));
  if (logsRequestOf(h)) btn('curl', 'The curl command that repeats this request (the app runs nothing)', () => openLogsCurl(h));
  btn('Copy JSON', 'Copy the whole log as JSON', () => copyText(JSON.stringify(h.raw, null, 2), 'JSON'));
  const traceId = h.raw && (h.raw.traceId || h.raw.trace_id || (h.raw.trace && h.raw.trace.id) || (h.json && h.json.traceId));
  if (traceId) {
    btn('Same request', `Search every log with traceId ${traceId}`, () => {
      $('#logsQuery').value = `"${String(traceId).replace(/"/g, '')}"`;
      if (logsTab.kind !== 'all' || logsErrorType) {
        // a request crosses services and error types, so look at all logs
        logsTab = { kind: 'all' };
        logsErrorType = '';
        renderLogsErrorChip();
      }
      runLogsSearch();
    });
  }
  box.appendChild(actions);
  box.appendChild(vEl('div', 'logs-detail-label', 'Message'));
  // with the logger's JSON, the JSON comes first, whole (the Message column shows its descricao)
  box.appendChild(vEl('pre', 'logs-pre', h.json ? JSON.stringify(logsDeepJson(h.json), null, 2) : logsPretty(h.message)));
  if (h.kc) logsDetailFields(box, h, 'Keycloak event (kc.*)', logsFlatten(h.kc, 'kc.'));
  if (h.json) logsDetailFields(box, h, 'Fields in the message (json.*)', logsFlatten(h.json, 'json.'));
  logsDetailFields(box, h, 'All fields', logsFlatten(h.raw), { sort: true, above: messageName });
  td.appendChild(box);
  row.appendChild(td);
  row.addEventListener('click', (e) => e.stopPropagation());
  tr.after(row);
}

function setupLogs() {
  if (logsSetUp) return;
  logsSetUp = true;
  $('#logsPopupClose').addEventListener('click', closeLogsPopup);
  $('#logsPopup').addEventListener('mousedown', (e) => {
    if (e.target.id === 'logsPopup') closeLogsPopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#logsPopup').classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeLogsPopup();
    }
  }, true);
  renderLogsHead();
  renderLogsTabs();
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#logsColumnMenu, #logsAddColumnBtn, #logsErrorMenu, #logsErrorsBtn, #logsWatchMenu, #logsAddWatchBtn, #logsServiceMenu, #logsAddServiceBtn, #logsLoginMenu, #logsGrafanaBtn, .logs-login-btn')) closeLogsMenus();
  });
  $('#logsSearchBtn').addEventListener('click', runLogsSearch);
  $('#logsQuery').addEventListener('input', updateLogsClear);
  $('#logsClearBtn').addEventListener('click', () => {
    $('#logsQuery').value = '';
    updateLogsClear();
    $('#logsQuery').focus();
    runLogsSearch();
  });
  $('#logsQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runLogsSearch();
    }
  });
  $('#logsRange').addEventListener('change', () => {
    const custom = $('#logsRange').value === 'custom';
    $('#logsCustom').classList.toggle('hidden', !custom);
    if (custom) {
      // start from what is on screen, or the last hour
      const to = logsResult ? logsResult.to : Date.now();
      const from = logsResult ? logsResult.from : to - 3600e3;
      $('#logsFrom').value = logsLocalInput(from);
      $('#logsTo').value = logsLocalInput(to);
      $('#logsFrom').focus();
      return;
    }
    runLogsSearch();
  });
  for (const id of ['#logsFrom', '#logsTo']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runLogsSearch();
      }
    });
  }
  $('#logsOrigin').addEventListener('change', () => {
    logsOrigin = $('#logsOrigin').value;
    updateCrumb();
    runLogsSearch();
  });
  $('#logsEnv').addEventListener('change', () => {
    logsEnv = $('#logsEnv').value;
    updateCrumb();
    runLogsSearch();
  });
  $('#logsErrorsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#logsErrorMenu')) closeLogsMenus();
    else openLogsErrorMenu($('#logsErrorsBtn'));
  });
  $('#logsGenerateBtn').addEventListener('click', async () => {
    const btn = $('#logsGenerateBtn');
    btn.disabled = true;
    const r = await window.logs.generate();
    btn.disabled = false;
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    toast(`${r.count.toLocaleString()} test logs written for the last 7 days`, 'success');
    runLogsSearch();
  });
  $('#logsGrafanaBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (logsGrafanaUser) logsGrafanaLogout();
    else toggleLogsLoginMenu($('#logsGrafanaBtn'));
  });
  $('#logsLiveBtn').addEventListener('click', async () => {
    const r = await window.logs.setLive(!logsWatchState.live);
    if (r.error) {
      toast(r.error, 'error');
      return;
    }
    await loadLogsWatches();
    toast(r.live ? 'New test logs are added every few seconds, so the watches find new logs' : 'No more new test logs', 'success');
  });
  $('#logsConfigBtn').addEventListener('click', async () => {
    const r = await window.logs.openConfig();
    if (r.error) toast(r.error, 'error');
    else toast('Opened logs-config.json. Save it and search again to use the changes.', 'success');
  });
  // The watches are checked in the main process; this keeps the tab counts up to date.
  window.logs.onWatchesChanged(async () => {
    await loadLogsWatches();
    const w = logsActiveWatch();
    if (w && w.newCount && currentMode === 'logs' && $('#logsRange').value !== 'custom') {
      markLogsWatchSeen(w.id);
      renderLogsTabs();
      runLogsSearch();
    }
  });
  window.logs.onOpenWatch(async (id) => {
    await loadLogsWatches();
    if (logsWatchState.watches.some((w) => w.id === id)) selectLogsTab({ kind: 'watch', id });
  });
}
