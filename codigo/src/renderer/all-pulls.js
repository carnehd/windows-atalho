// -- All pull requests (a page of its own): the pull requests of the microservices on the list, found with the filters
// and the search. Nothing is asked of GitHub when the page opens: only Search asks, a few microservices at a time, for
// the ones the filters leave; typing and "Mine" then only narrow what came. A click on one opens it in place, as in the
// Pull requests tab of its repository, with the same code: while one is open the page borrows the tab's state and the
// current repository (put back when the page is left), so only one is open at a time. --

const AP_AT_ONCE = 8;
const AP_FILTERS_KEY = 'allPullsFilters';
const AP_SHUT_KEY = 'allPullsShut';
const AP_PER_LIST = 50; // what a list brings of a microservice: more is seen in its tab

const apLoad = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
};
const apSave = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // only for this session
  }
};

const apFilters = { state: 'open', who: 'all', group: '', service: '', view: 'repo', dateBy: 'updated', order: 'newest', period: 'any', days: 14, from: '', to: '', stale: false, staleDays: 14, ...apLoad(AP_FILTERS_KEY, {}) };
// what was kept of the dates, checked: a value that is not one of these goes back to the usual
if (!['updated', 'created'].includes(apFilters.dateBy)) apFilters.dateBy = 'updated';
if (!['newest', 'oldest'].includes(apFilters.order)) apFilters.order = 'newest';
if (!['any', 'today', 'week', '7', '30', '90', 'days', 'range'].includes(apFilters.period)) apFilters.period = 'any';
if (apFilters.view !== 'date') apFilters.view = 'repo';
for (const k of ['days', 'staleDays']) if (!(Number(apFilters[k]) >= 1)) apFilters[k] = 14;
apFilters.stale = apFilters.stale === true;
for (const k of ['from', 'to']) if (!/^\d{4}-\d\d-\d\d$/.test(String(apFilters[k]))) apFilters[k] = '';
const apShut = new Set(apLoad(AP_SHUT_KEY, []));
let apText = '';
let apData = null; // { state, by: Map(repo path -> { name, pulls, more, error, code, site, owner, repo, hasToken }) }
let apTotal = 0; // how many are being asked now, and how many have answered
let apAnswered = 0;
let apBusy = false;
let apRun = 0;
let apChanged = false; // filters changed since the last Search
let apDrawTimer = null;
let apHome = null; // { repo, state }: what the Git page had when this page opened
let apActive = null; // the pull request open in the page, and its element
let apActiveEl = null;
const apStates = new Map(); // repo path -> the state its open pull request was shown with
const apLogins = new Map(); // site -> the login of its token

const apNameOf = (path) => {
  const r = repos.find((x) => x.path === path);
  return r ? displayName(r) : repoName(path);
};

// The microservices the filters leave, by name.
function apScope() {
  const groups = new Set(repoGroups.map((g) => g.id));
  return repos
    .filter((r) => r.isGit !== false)
    .filter((r) => !apFilters.group || (apFilters.group === '-' ? !groups.has(r.group) : r.group === apFilters.group))
    .filter((r) => !apFilters.service || r.path === apFilters.service)
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: 'base' }));
}

function apFillFilters() {
  const group = $('#apGroup');
  const groups = new Set(repoGroups.map((g) => g.id));
  if (apFilters.group && apFilters.group !== '-' && !groups.has(apFilters.group)) apFilters.group = '';
  group.textContent = '';
  group.append(new Option('All groups', ''), ...repoGroups.map((g) => new Option(g.name, g.id)));
  if (repoGroups.length && repos.some((r) => !groups.has(r.group))) group.appendChild(new Option('No group', '-'));
  group.value = apFilters.group;
  group.classList.toggle('hidden', !repoGroups.length);
  // the microservices of the group chosen
  const service = $('#apService');
  const wanted = apFilters.service;
  apFilters.service = '';
  const inGroup = apScope();
  apFilters.service = inGroup.some((r) => r.path === wanted) ? wanted : '';
  service.textContent = '';
  service.append(new Option('All microservices', ''), ...inGroup.map((r) => new Option(displayName(r), r.path)));
  service.value = apFilters.service;
}

function apRenderBar() {
  $$('#apStateSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.state === apFilters.state)));
  $$('#apWhoSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.who === apFilters.who)));
  $$('#apViewSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === apFilters.view)));
  $('#apGo').textContent = apBusy ? 'Stop' : 'Search';
  $('#apGo').title = apBusy ? 'Stop asking GitHub' : 'Ask GitHub for the pull requests of the microservices these filters leave';
  $('#apProgress').classList.toggle('hidden', !apBusy);
  $('#apProgress i').style.width = apTotal ? `${Math.round((apAnswered / apTotal) * 100)}%` : '0';
  $('#apGear').classList.toggle('hidden', !agentFound());
  apRenderWhen();
}

// The order, the date and the period, in the bar and in the panel the period opens. What is in force shows in the bar: the
// button turns blue with a cross to clear it, and the stale ones get a button of their own (amber).
const AP_ARROWS = {
  newest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M18 13l-6 6l-6 -6"/></svg>',
  oldest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M18 11l-6 -6l-6 6"/></svg>',
};

function apWhenLabel() {
  const f = apFilters;
  const day = (s) => {
    const d = new Date(`${s}T00:00:00`);
    return d.toLocaleDateString('en-GB', d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  };
  let text = 'Any time';
  if (f.period === 'today') text = 'Today';
  else if (f.period === 'week') text = 'This week';
  else if (['7', '30', '90'].includes(f.period)) text = `Last ${f.period} days`;
  else if (f.period === 'days') text = `Last ${f.days} days`;
  else if (f.period === 'range') text = f.from && f.to ? `${day(f.from)} – ${day(f.to)}` : f.from ? `Since ${day(f.from)}` : f.to ? `Until ${day(f.to)}` : 'Any time';
  return f.dateBy === 'created' ? `Opened · ${text}` : text;
}

function apRenderWhen() {
  const f = apFilters;
  const when = apPeriodRange() !== null || f.dateBy !== 'updated';
  const named = f.dateBy === 'created' ? 'opened' : 'last changed';
  const order = $('#apOrder');
  if (order.dataset.way !== f.order || order.dataset.date !== f.dateBy) {
    order.dataset.way = f.order;
    order.dataset.date = f.dateBy;
    order.innerHTML = AP_ARROWS[f.order];
    const label = f.order === 'newest' ? `Newest first, by when they were ${named}` : `Oldest first, by when they were ${named}`;
    order.setAttribute('aria-label', label);
    order.title = `${label}. Click for the ${f.order === 'newest' ? 'oldest' : 'newest'} first`;
  }
  $('#apWhenText').textContent = apWhenLabel();
  $('#apWhen').classList.toggle('act', when);
  $('#apWhenClear').classList.toggle('hidden', !when);
  $('#apStale').classList.toggle('hidden', !f.stale);
  $('#apStaleText').textContent = `Stale ${f.staleDays}+ days`;
  $('#apStaleShort').textContent = `${f.staleDays}d+`;
  // the panel: what is in force is marked; a number being typed is left alone
  $$('#apDateSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === f.dateBy)));
  $$('#apChips .ap-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === f.period)));
  if (document.activeElement !== $('#apDays')) $('#apDays').value = String(f.days);
  if (document.activeElement !== $('#apStaleDays')) $('#apStaleDays').value = String(f.staleDays);
  $('#apFrom').value = f.from;
  $('#apTo').value = f.to;
  $('#apDays').classList.toggle('ap-on', f.period === 'days');
  $('#apFrom').classList.toggle('ap-on', f.period === 'range');
  $('#apTo').classList.toggle('ap-on', f.period === 'range');
  $('#apStaleOn').checked = f.stale;
  $('#apStaleDays').classList.toggle('ap-on', f.stale);
}

// -- The panel of the period: under its button, over the page; it closes with a click outside or Esc --
function apPopOpen() {
  return !$('#apPop').classList.contains('hidden');
}

function apPlacePop() {
  const pop = $('#apPop');
  const a = $('#apWhen').getBoundingClientRect();
  const m = pop.getBoundingClientRect();
  pop.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8)))}px`;
  pop.style.top = `${Math.round(Math.min(a.bottom + 6, Math.max(8, window.innerHeight - m.height - 8)))}px`;
}

function apClosePop(focusBack = false) {
  if (!apPopOpen()) return;
  $('#apPop').classList.add('hidden');
  $('#apWhenBtn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', apPopOutside, true);
  document.removeEventListener('keydown', apPopKey, true);
  window.removeEventListener('resize', apClosePopSoon);
  if (focusBack) $('#apWhenBtn').focus();
}

const apClosePopSoon = () => apClosePop();

function apPopOutside(e) {
  if (e.target.closest('#apPop, #apWhen, #apStale')) return;
  apClosePop();
}

function apPopKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  apClosePop(true);
}

function apTogglePop() {
  if (apPopOpen()) {
    apClosePop();
    return;
  }
  apRenderWhen();
  $('#apPop').classList.remove('hidden');
  $('#apWhenBtn').setAttribute('aria-expanded', 'true');
  apPlacePop();
  document.addEventListener('mousedown', apPopOutside, true);
  document.addEventListener('keydown', apPopKey, true);
  window.addEventListener('resize', apClosePopSoon);
}

// -- The date of a pull request, the order and the period: they only narrow and order what came, so they show at once. The date
// is the one chosen: when it last changed (closed, merged or updated) or when it was opened. --
const AP_DAY = 24 * 60 * 60 * 1000;
const apTime = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
// when it last changed (closed, merged or updated), whatever date is chosen: what stale goes by
const apChangedAt = (p) => apTime(p.closed || p.updated);
const apDateOf = (p) => (apFilters.dateBy === 'created' ? apTime(p.created) : apChangedAt(p));

// Stale: not changed for this many days or more.
function apIsStale(p) {
  const t = apChangedAt(p);
  return t !== null && t <= Date.now() - Math.min(Math.round(Number(apFilters.staleDays)), 3650) * AP_DAY;
}

// The period as [from, to] in ms (null: no limit on that side), or null for any time. Between two dates, both days count whole;
// the dates the wrong way round are taken the right way round. This week starts on Monday.
function apPeriodRange() {
  const f = apFilters;
  if (f.period === 'any') return null;
  if (f.period === 'today' || f.period === 'week') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (f.period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return [d.getTime(), null];
  }
  if (f.period === 'range') {
    let from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
    let to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
    if (from !== null && to !== null && from > to) [from, to] = [new Date(`${f.to}T00:00:00`).getTime(), new Date(`${f.from}T23:59:59.999`).getTime()];
    return from === null && to === null ? null : [from, to];
  }
  const n = f.period === 'days' ? Math.round(Number(f.days)) : Number(f.period);
  if (!(n >= 1)) return null;
  return [Date.now() - Math.min(n, 3650) * AP_DAY, null];
}

function apInPeriod(p) {
  const range = apPeriodRange();
  if (!range) return true;
  const t = apDateOf(p);
  if (t === null) return false; // with no date it is in no period
  return (range[0] === null || t >= range[0]) && (range[1] === null || t <= range[1]);
}

// Newest or oldest first by the date chosen, the ones with no date last.
function apOrderPulls(list) {
  const sign = apFilters.order === 'oldest' ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = apDateOf(a);
    const y = apDateOf(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y);
  });
}

// What the filters that need no request leave of a pull request.
function apMatches(p) {
  if (!apInPeriod(p)) return false;
  if (apFilters.stale && !apIsStale(p)) return false;
  if (apFilters.who === 'mine') {
    const me = apLogins.get(p.site);
    if (!me || !p.author || p.author.toLowerCase() !== me.toLowerCase()) return false;
  }
  const q = apText.trim().toLowerCase();
  if (/^#\d+$/.test(q)) return `#${p.number}` === q; // that number, not #140 too
  return !q || `#${p.number} ${p.title} ${p.author} ${p.head.label} ${p.base.ref} ${p.labels.join(' ')} ${p.ms}`.toLowerCase().includes(q);
}

// By name: they answer in any order.
function apEntries() {
  return [...apData.by.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { numeric: true, sensitivity: 'base' }));
}

function apAllPulls() {
  return apData ? apEntries().flatMap(([, e]) => e.pulls || []) : [];
}

function apCountText() {
  if (apBusy) return `Asking GitHub: ${apAnswered} of ${apTotal}`;
  if (!apData) {
    const n = apScope().length;
    return n ? `Search asks GitHub about ${plural(n, 'microservice')}` : 'No microservice with these filters';
  }
  const all = apAllPulls();
  const shown = all.filter(apMatches);
  const where = new Set(shown.map((p) => p.repo)).size;
  const text = shown.length === all.length
    ? `${plural(all.length, 'pull request')} in ${plural(where, 'microservice')}`
    : `${shown.length} of ${plural(all.length, 'pull request')}, in ${plural(where, 'microservice')}`;
  return apChanged ? `${text} · the filters changed: press Search` : text;
}

// The count lives in the top bar, beside the name of the page: the bar of the filters has only the filters, in one line.
function allPullsCrumb() {
  return apCountText();
}

// A pull request while it is not the open one: its two lines, Analyse and its page on GitHub.
function apRowEl(p, inGroup) {
  const row = document.createElement('div');
  row.className = `log-item ap-row${inGroup ? ' ap-in' : ''}`;
  row.dataset.repo = p.repo;
  row.dataset.number = p.number;
  const head = document.createElement('div');
  head.className = 'log-item-head';
  head.tabIndex = 0;
  head.title = 'Click to show the files this pull request changes';
  const [state, body] = pullHeadParts(p, agentChipFor(p, Boolean(p.running), p.review), allPullsMsOf(p));
  head.append(state, body);
  if (agentFound()) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-sm btn-icon pr-agent-btn';
    go.innerHTML = AGENT_ICON;
    go.append(p.running ? 'Analysing...' : 'Analyse');
    go.disabled = Boolean(p.running);
    go.title = p.review ? `Show the review of #${p.number}` : `Have ${agentName()} read #${p.number} and look for errors and improvements`;
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      apOpen(p, true);
    });
    head.appendChild(go);
  }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn btn-sm btn-icon pr-open-btn';
  link.title = `Open #${p.number} on GitHub, in the browser`;
  link.setAttribute('aria-label', link.title);
  link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.open}</svg>`;
  link.addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.github.open(p.repo, p.number);
    if (result.error) toast(result.error, 'error', { title: `Couldn't open #${p.number}` });
  });
  head.appendChild(link);
  head.addEventListener('click', () => apOpen(p));
  head.addEventListener('keydown', (e) => {
    if (e.target === head && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      apOpen(p);
    }
  });
  row.appendChild(head);
  return row;
}

// Its name in a row, where the list is not by microservice (pull-requests.js asks too, for the open one).
function allPullsMsOf(p) {
  return currentMode === 'pulls' && apFilters.view === 'date' ? p.ms : '';
}

function apEl(p, inGroup) {
  if (apActive !== p) return apRowEl(p, inGroup);
  apActiveEl.classList.toggle('ap-in', inGroup);
  return apActiveEl;
}

function apServiceHead(path, entry, count) {
  const shut = apShut.has(path);
  const row = document.createElement('div');
  row.className = `ap-svc${shut ? ' shut' : ''}`;
  row.tabIndex = 0;
  row.setAttribute('aria-expanded', String(!shut));
  row.dataset.repo = path;
  row.innerHTML = '<svg class="dir-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
  const n = diffSpan('cmp-count', `${count}${entry.more ? '+' : ''}`);
  if (entry.more) n.title = `GitHub has more than ${AP_PER_LIST}: Open in Git lists them`;
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'ap-link';
  go.textContent = 'Open in Git';
  go.title = `The Pull requests tab of ${entry.name}`;
  go.addEventListener('click', (e) => {
    e.stopPropagation();
    apOpenInGit(path);
  });
  row.append(diffSpan('ap-svc-name', entry.name), n, diffSpan('ap-grow', ''), go);
  const toggle = () => {
    if (shut) apShut.delete(path);
    else apShut.add(path);
    apSave(AP_SHUT_KEY, [...apShut]);
    apDraw();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle();
      const again = [...$$('#apList .ap-svc')].find((x) => x.dataset.repo === path);
      if (again) again.focus();
    }
  });
  return row;
}

// What did not answer: the ones that want a token by GitHub, the others by what was said, and the ones not on GitHub.
function apWarnings(list) {
  const entries = apEntries().filter(([, e]) => e.error);
  const notHere = entries.filter(([, e]) => e.code === 'none');
  const tokens = new Map();
  const others = new Map();
  for (const [path, e] of entries) {
    if (e.code === 'none') continue;
    if (e.code === 'no-token' || e.code === 'token') tokens.set(e.site, [...(tokens.get(e.site) || []), path]);
    else others.set(e.error, [...(others.get(e.error) || []), path]);
  }
  const warn = (names, text, button, quiet = false) => {
    const row = document.createElement('div');
    row.className = `ap-warn${quiet ? ' quiet' : ''}`;
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    row.append(diffSpan('ap-warn-names', shown), diffSpan('ap-warn-text', text));
    if (button) row.appendChild(button);
    list.appendChild(row);
  };
  for (const [site, paths] of tokens) {
    warn(paths.map(apNameOf), `${site} asks for a token.`, agentBtn('Set token...', `Set the token of ${site}, in the Pull requests tab of ${apNameOf(paths[0])}`, () => apOpenInGit(paths[0])));
  }
  for (const [text, paths] of others) {
    warn(paths.map(apNameOf), text, agentBtn('Try again', 'Ask GitHub again for these', () => apAsk(paths)));
  }
  if (notHere.length) warn(notHere.map(([path]) => apNameOf(path)), 'not on GitHub, so left out.', null, true);
}

function apDraw() {
  clearTimeout(apDrawTimer);
  apDrawTimer = null;
  apRenderBar();
  updateCrumb();
  const list = $('#apList');
  const top = list.scrollTop;
  list.textContent = '';
  if (!apData) {
    list.appendChild(noteEl(apScope().length
      ? 'Nothing is asked of GitHub until you press Search. Choose a group or a microservice, or type what you are looking for, then press Search.'
      : 'No microservice with these filters.'));
    return;
  }
  apWarnings(list);
  const all = apAllPulls();
  const shown = all.filter(apMatches);
  if (!shown.length && !apBusy && all.length) {
    const byTime = apPeriodRange() || apFilters.stale;
    list.appendChild(noteEl(byTime ? 'No pull request fits the date, the period or the stale filter (and what you typed, if you did).' : 'No pull request has this: its title, number, branches, author and labels were searched.'));
  }
  if (!all.length && !apBusy && [...apData.by.values()].some((e) => !e.error)) list.appendChild(noteEl(`These microservices have no ${apData.state === 'all' ? '' : `${apData.state} `}pull requests.`));
  if (apFilters.who === 'mine' && !apBusy) {
    const blind = [...new Set(all.map((p) => p.site))].filter((site) => !apLogins.get(site));
    if (blind.length) list.appendChild(noteEl(`Mine needs a token for ${blind.join(', ')}, to know whose it is.`));
  }
  if (apFilters.view === 'date') {
    for (const p of apOrderPulls(shown)) list.appendChild(apEl(p, false));
  } else {
    for (const [path, entry] of apEntries()) {
      const mine = apOrderPulls((entry.pulls || []).filter(apMatches));
      if (!mine.length) continue;
      list.appendChild(apServiceHead(path, entry, mine.length));
      if (!apShut.has(path)) for (const p of mine) list.appendChild(apEl(p, true));
    }
  }
  if (!apBusy && all.length) {
    const none = [...apData.by.values()].filter((e) => !e.error && !e.pulls.length).length;
    if (none) {
      const foot = document.createElement('div');
      foot.className = 'ap-foot';
      foot.textContent = `${plural(none, 'microservice')} with none.`;
      list.appendChild(foot);
    }
  }
  list.scrollTop = top;
  markSelectedFile();
}

// Draws once for the many answers that come together.
function apDrawSoon() {
  if (!apDrawTimer) apDrawTimer = setTimeout(apDraw, 60);
}

// Asks for these microservices, a few at a time; each draws as it comes.
async function apAsk(paths) {
  const run = ++apRun;
  apBusy = true;
  apTotal = paths.length;
  apAnswered = 0;
  apDraw();
  const state = apData.state;
  let next = 0;
  const worker = async () => {
    while (next < paths.length && run === apRun) {
      const path = paths[next++];
      let got;
      try {
        got = await window.github.pulls(path, { state });
      } catch (e) {
        got = { error: e.message, code: 'failed' };
      }
      if (run !== apRun) return;
      const name = apNameOf(path);
      const pulls = (got.pulls || []).map((p) => ({ ...p, repo: path, ms: name, site: got.site }));
      if (pulls.length) {
        const kept = await window.agent.reviews(path, pulls.map((p) => p.number)).catch(() => ({}));
        if (run !== apRun) return;
        for (const p of pulls) {
          p.review = (kept.reviews && kept.reviews[p.number]) || null;
          p.running = Boolean(kept.running && kept.running.includes(p.number));
        }
      }
      apData.by.set(path, { name, pulls, more: Boolean(got.more), error: got.error || '', code: got.code || '', site: got.site || '', owner: got.owner || '', repo: got.repo || '', hasToken: Boolean(got.hasToken) });
      apAnswered++;
      apDrawSoon();
    }
  };
  await Promise.all(Array.from({ length: Math.min(AP_AT_ONCE, paths.length) }, worker));
  if (run !== apRun) return;
  apBusy = false;
  await apLoadLogins();
  if (run === apRun) apDraw();
}

// The owner of the token of each GitHub with results, when Mine is on: asked once for each.
async function apLoadLogins() {
  if (apFilters.who !== 'mine' || !apData) return;
  const firstOf = new Map();
  for (const [path, e] of apData.by) if (e.site && !firstOf.has(e.site)) firstOf.set(e.site, path);
  await Promise.all([...firstOf].filter(([site]) => !apLogins.has(site)).map(async ([site, path]) => {
    const got = await window.github.me(path).catch(() => ({}));
    apLogins.set(site, got.login || '');
  }));
}

function apSearch() {
  if (apBusy) {
    apRun++;
    apBusy = false;
    apDraw();
    return;
  }
  apCloseActive();
  apStates.clear();
  apChanged = false;
  const scope = apScope().map((r) => r.path);
  apData = { state: apFilters.state, by: new Map() };
  if (scope.length) apAsk(scope);
  else apDraw();
}

// -- The open one: drawn by the tab's code, on the repository and the state it would have there --
function apSyncActive() {
  if (!apActive || prState.repo !== apActive.repo) return;
  for (const p of prState.pulls) if (prState.reviews.has(p.number)) p.review = prState.reviews.get(p.number);
}

function apCloseActive() {
  apSyncActive();
  closeDiff();
  closePullLinePop();
  apActive = null;
  apActiveEl = null;
}

function apOpen(p, analyse = false) {
  if (apActive !== p) {
    apCloseActive();
    const entry = apData.by.get(p.repo);
    let state = apStates.get(p.repo);
    if (!state) {
      state = { ...newPrState(), repo: p.repo };
      apStates.set(p.repo, state);
    }
    state.loaded = true;
    state.pulls = entry.pulls;
    state.info = { site: entry.site, owner: entry.owner, repo: entry.repo, hasToken: entry.hasToken };
    state.open = new Set();
    for (const q of entry.pulls) if (q.review && !state.reviews.has(q.number)) state.reviews.set(q.number, q.review);
    if (p.running && !state.runs.has(p.number)) state.runs.set(p.number, { since: Date.now(), text: 'Analysing', agent: agentName() });
    currentRepo = p.repo;
    prState = state;
    apActive = p;
    apActiveEl = pullItem(p);
    apDraw();
    if (apShut.has(p.repo) || !apActiveEl.isConnected) return;
    apActiveEl.querySelector('.log-item-head').click();
    apActiveEl.scrollIntoView({ block: 'nearest' });
    tickAgentRuns();
  }
  if (analyse) {
    const go = apActiveEl.querySelector('.log-item-head .pr-agent-btn');
    if (go && !go.disabled) go.click();
  }
}

// What the agent says of a run, for the rows: the open one is kept up by agent-review.js.
function apOnAgentEvent(event) {
  if (!apData || !event) return;
  const entry = apData.by.get(event.repo);
  const p = entry && (entry.pulls || []).find((x) => x.number === event.number);
  if (!p) return;
  const state = apStates.get(event.repo);
  const elsewhere = state && state !== prState;
  if (event.type === 'progress') {
    const was = p.running;
    p.running = true;
    if (elsewhere && state.runs.has(p.number) && !state.runs.get(p.number).error) state.runs.get(p.number).text = event.text;
    if (!was && apActive !== p && currentMode === 'pulls') apDraw();
    return;
  }
  p.running = false;
  if (event.type === 'done') {
    p.review = event.review;
    if (state) {
      state.reviews.set(p.number, event.review);
      if (elsewhere) state.runs.delete(p.number);
    }
    if (apActive !== p) toast(`#${p.number} of ${p.ms} analysed: ${findingsText(liveFindings(event.review))}`, 'success', { plain: true });
  } else if (event.type === 'failed' && elsewhere) {
    if (event.code === 'stopped') state.runs.delete(p.number);
    else state.runs.set(p.number, { error: event.error, code: event.code });
  }
  if (currentMode === 'pulls') apDrawSoon();
}

// -- Coming and going: the Git page gets back what it had --
function allPullsEntered() {
  apHome = { repo: currentRepo, state: prState };
  $('#pullsView').appendChild($('#diffModal')); // the popup of a file: it opens from here too
  apFillFilters();
  apDraw();
  loadAgentInfo().then(() => {
    if (currentMode === 'pulls') apDraw();
  });
}

function allPullsLeft() {
  apClosePop();
  apCloseActive();
  closeAgentMenu();
  $('#mainContent').appendChild($('#diffModal'));
  if (!apHome) return;
  currentRepo = apHome.repo;
  prState = apHome.state;
  apHome = null;
  // something read the borrowed repository meanwhile: the Git page shows its own again
  if (shownRepo && currentRepo && shownRepo !== currentRepo) refresh();
}

// The tab of a microservice in the Git page: for what this page does not do (a token, the ones past the first page).
function apOpenInGit(path) {
  apHome = { repo: path, state: apHome && apHome.repo === path ? apHome.state : { ...newPrState(), repo: path } };
  activateMode('git');
  setGitView('git');
  renderSidebar();
  renderRepoPick();
  $('#gitView .tab[data-tab="pulls"]').click();
  if (shownRepo !== path) refresh();
}

function setupAllPulls() {
  window.agent.onEvent(apOnAgentEvent);
  $('#apGear').innerHTML = AGENT_GEAR_ICON;
  $('#apGear').addEventListener('click', (e) => {
    e.stopPropagation();
    openAgentMenu($('#apGear'));
  });
  $('#apGo').addEventListener('click', apSearch);
  // what changes what is asked waits for Search; what only narrows what came shows at once
  const changed = () => {
    apSave(AP_FILTERS_KEY, { ...apFilters });
    if (apData) apChanged = true;
    apDraw();
  };
  $$('#apStateSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.state === apFilters.state) return;
    apFilters.state = b.dataset.state;
    changed();
  }));
  $('#apGroup').addEventListener('change', (e) => {
    apFilters.group = e.target.value;
    apFillFilters();
    changed();
  });
  $('#apService').addEventListener('change', (e) => {
    apFilters.service = e.target.value;
    changed();
  });
  $$('#apWhoSeg .seg-btn').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.who === apFilters.who) return;
    apFilters.who = b.dataset.who;
    apSave(AP_FILTERS_KEY, { ...apFilters });
    apDraw();
    if (!apBusy) {
      await apLoadLogins();
      apDraw();
    }
  }));
  $$('#apViewSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === apFilters.view) return;
    apFilters.view = b.dataset.view;
    apSave(AP_FILTERS_KEY, { ...apFilters });
    // the open one says or not its microservice
    if (apActive) {
      const p = apActive;
      apCloseActive();
      apDraw();
      apOpen(p);
    } else apDraw();
  }));
  // the date, the order and the period only narrow what came: nothing is asked of GitHub
  const narrow = () => {
    apSave(AP_FILTERS_KEY, { ...apFilters });
    apDraw();
  };
  $('#apOrder').addEventListener('click', () => {
    apFilters.order = apFilters.order === 'newest' ? 'oldest' : 'newest';
    narrow();
  });
  $('#apWhenBtn').addEventListener('click', apTogglePop);
  $('#apStaleBtn').addEventListener('click', apTogglePop);
  // back to the usual: last changed, any time
  const clearWhen = () => {
    apFilters.dateBy = 'updated';
    apFilters.period = 'any';
    narrow();
  };
  $('#apWhenClear').addEventListener('click', clearWhen);
  $('#apStaleClear').addEventListener('click', () => {
    apFilters.stale = false;
    narrow();
  });
  $('#apWhenReset').addEventListener('click', () => {
    apFilters.stale = false;
    clearWhen();
  });
  $$('#apDateSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    apFilters.dateBy = b.dataset.date;
    narrow();
  }));
  // a shortcut again clears it
  $$('#apChips .ap-chip').forEach((b) => b.addEventListener('click', () => {
    apFilters.period = apFilters.period === b.dataset.period ? 'any' : b.dataset.period;
    narrow();
  }));
  const days = (key, on) => (e) => {
    const n = Math.round(Number(e.target.value));
    if (n >= 1) apFilters[key] = Math.min(n, 3650);
    on(n >= 1);
    narrow();
  };
  $('#apDays').addEventListener('input', days('days', (ok) => {
    if (ok) apFilters.period = 'days';
  }));
  $('#apFrom').addEventListener('change', (e) => {
    apFilters.from = e.target.value;
    apFilters.period = 'range';
    narrow();
  });
  $('#apTo').addEventListener('change', (e) => {
    apFilters.to = e.target.value;
    apFilters.period = 'range';
    narrow();
  });
  // stale ones are the ones that stand still the longest: they come first, as the arrow shows (it can be turned round)
  const staleOn = () => {
    if (!apFilters.stale) apFilters.order = 'oldest';
    apFilters.stale = true;
  };
  $('#apStaleOn').addEventListener('change', (e) => {
    if (e.target.checked) staleOn();
    else apFilters.stale = false;
    narrow();
  });
  $('#apStaleDays').addEventListener('input', days('staleDays', (ok) => {
    if (ok) staleOn();
  }));
  $('#apText').addEventListener('input', (e) => {
    apText = e.target.value;
    apDraw();
  });
  $('#apText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!apBusy) apSearch();
    }
  });
}
