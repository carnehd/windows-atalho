// -- The sides of the Log's Base <- Compare: a tag, a commit or a branch (yours or one on origin), chosen in a picker
// with the tags, the commits of a branch (with the version each is on) and the branches; and the rows of its files,
// each opening the diff popup from one side to the other. --

const CMP_ICONS = {
  local: '<path d="M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8l0 8"/><path d="M9 18h6a2 2 0 0 0 2 -2v-5"/><path d="M14 14l3 -3l3 3"/>',
  remote: '<path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878"/>',
  tag: '<path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z"/>',
  commit: '<path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M12 3l0 6"/><path d="M12 15l0 6"/>',
};

let cmpRefs = null; // { repo, local, remote, tags, current, head }

const cmpName = (ref) => ref.replace(/^refs\/(heads|remotes|tags)\//, '');

// A side: { value (a full ref or a commit hash), kind, label, message and branch for a commit }.
function cmpSideFor(value, extra = {}) {
  if (value.startsWith('refs/tags/')) return { value, kind: 'tag', label: cmpName(value) };
  if (value.startsWith('refs/remotes/')) return { value, kind: 'remote', label: cmpName(value) };
  if (value.startsWith('refs/heads/')) return { value, kind: 'local', label: cmpName(value) };
  return { value, kind: 'commit', label: value.slice(0, 7), ...extra };
}

function cmpIcon(kind) {
  return `<svg class="cmp-icon ${kind}" viewBox="0 0 24 24" aria-hidden="true">${CMP_ICONS[kind]}</svg>`;
}

// "v1.0.2 +2": the version a commit is on, when a tag is below it.
function cmpVersionText(v) {
  return v ? (v.after ? `${v.tag} +${v.after}` : v.tag) : '';
}

// The branches and tags of the repository on screen, for the pickers. Null when it changed meanwhile.
async function loadCmpRefs() {
  const repoPath = currentRepo;
  const refs = await window.git.compareRefs(repoPath);
  if (repoPath !== currentRepo) return null;
  cmpRefs = refs.error ? null : { repo: repoPath, ...refs };
  return refs;
}

// On each refresh of the page, only while they are needed: a Base or Compare chosen in this repository (to see it is
// still there) or a picker open. Otherwise they are forgotten, and a picker asks for them when it opens.
async function refreshCmpRefs() {
  if (!currentRepo) return;
  if (cmpRefs && cmpRefs.repo !== currentRepo) closeCmpMenu();
  const sides = logSides.get(currentRepo);
  if ((sides && (sides.base || sides.compare)) || $('#cmpMenu')) await loadCmpRefs();
  else cmpRefs = null;
}

function cmpFileRow(f, ctx) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'log-file cmp-file';
  row.dataset.file = f.file;
  row.dataset.base = ctx.from;
  row.dataset.to = ctx.to;
  row.title = `Click to see this file in ${ctx.fromLabel} and in ${ctx.toLabel}, side by side`;
  const letter = diffSpan(`file-status ${f.letter}`, f.letter);
  letter.title = LETTER_TITLES[f.letter] || f.letter;
  const where = document.createElement('span');
  where.className = 'file-path';
  const slash = f.file.lastIndexOf('/');
  const dir = `${f.from ? `${f.from} → ` : ''}${f.file.slice(0, slash + 1)}`;
  if (dir) where.append(diffSpan('fp-dir', dir));
  where.append(diffSpan('fp-base', f.file.slice(slash + 1)));
  const lines = document.createElement('span');
  lines.className = 'cmp-lines';
  if (f.binary) lines.append(diffSpan('bin', 'binary'));
  else if (f.added !== undefined) lines.append(diffSpan('add', `+${f.added}`), diffSpan('del', `−${f.removed}`));
  row.append(letter, where, lines);
  row.addEventListener('click', () => openCompareDiff(f, ctx));
  return row;
}

// A file: the diff popup with one side on the left and the other on the right.
function openCompareDiff(f, ctx) {
  if (!currentRepo) return;
  const same = Boolean(diffCommit) && diffCommit.compare && diffCommit.base === ctx.from && diffCommit.hash === ctx.to && diffFile === f.file && diffRepo === currentRepo;
  if (!same) diffFull = false;
  // pull: a file of a pull request (its number and last commit), where lines can be commented on (pull-requests.js)
  diffCommit = { compare: true, base: ctx.from, hash: ctx.to, short: ctx.to.slice(0, 7), files: ctx.files, baseLabel: ctx.fromLabel, label: ctx.toLabel, pull: ctx.pull || null };
  diffFile = f.file;
  diffRepo = currentRepo;
  setDiffOpen(true);
  markSelectedFile();
  loadDiff({ keepScroll: same });
}

// -- The picker of a side: your branches, the ones on origin, then the tags. A click chooses one (a branch: its history,
// drawn as a graph); a right-click on a branch asks: View log (the same) or View commits (its commits listed under it,
// with a search of their own: a click chooses one). A hash typed that is not listed can be used as it is. --

const CMP_COMMITS_MAX = 300; // read at most, of a branch
const CMP_COMMITS_SHOWN = 30; // listed at first, then Show more
const CMP_COMMITS_FILTER_FROM = 10; // a search of its own above more commits than this

// "3d ago" within a week, then "28 Sep" (and the year, when not this one)
function cmpShortDate(date) {
  const d = new Date(date);
  if (Date.now() - d < 604800000) return formatDate(date);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

function closeCmpMenu(refocus = false) {
  const menu = $('#cmpMenu');
  if (!menu) return;
  menu.remove();
  const btn = menu.anchor;
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  if (refocus) btn.focus();
}

function closeCmpChoice(refocus = null) {
  const box = $('#cmpChoice');
  if (!box) return;
  box.remove();
  if (refocus && refocus.isConnected) refocus.focus();
}

// Under btn, with side (or nothing) ticked; onPick gets the side chosen.
function openRefPicker(btn, side, onPick) {
  const reopen = $('#cmpMenu') && $('#cmpMenu').anchor === btn;
  closeCmpMenu();
  if (reopen || !currentRepo) return;
  const repoPath = currentRepo;
  const menu = document.createElement('div');
  menu.id = 'cmpMenu';
  menu.className = 'clip-menu branch-menu cmp-menu';
  menu.setAttribute('role', 'menu');
  menu.anchor = btn;
  const search = document.createElement('input');
  search.className = 'input branch-menu-search';
  search.placeholder = 'Search branches and tags...';
  search.spellcheck = false;
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search branches and tags');
  const list = document.createElement('div');
  list.className = 'branch-menu-list';
  list.appendChild(noteEl('Loading...'));
  menu.append(search, list);

  const pick = (value, extra) => {
    closeCmpMenu(true);
    onPick(cmpSideFor(value, extra));
  };
  // A branch: its log, or one of its commits.
  const choose = (item, r) => {
    closeCmpChoice();
    const box = document.createElement('div');
    box.id = 'cmpChoice';
    box.className = 'clip-menu branch-actions-menu';
    box.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'branch-actions-title';
    head.textContent = r.name;
    box.appendChild(head);
    const listed = Boolean(open) && open.r.ref === r.ref;
    for (const [icon, label, hint, run] of [
      [ACTION_ICONS.log, 'View log', 'The branch itself: its history, drawn as a graph', () => pick(r.ref)],
      [CMP_ICONS.commit, listed ? 'Hide commits' : 'View commits', listed ? 'Stop listing its commits under it' : 'Its commits, listed under it: choose one of them', () => toggleCommits(r)],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'clip-menu-item';
      b.setAttribute('role', 'menuitem');
      b.title = hint;
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      b.append(label);
      b.addEventListener('click', run);
      box.appendChild(b);
    }
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const items = [...box.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        closeCmpChoice(item);
      }
    });
    menu.appendChild(box);
    const at = item.getBoundingClientRect();
    const m = box.getBoundingClientRect();
    box.style.left = `${Math.round(Math.min(at.left + 40, window.innerWidth - m.width - 8))}px`;
    box.style.top = `${Math.round(Math.min(at.bottom - 4, window.innerHeight - m.height - 8))}px`;
    box.querySelector('button').focus();
  };

  // "View commits": the commits of one branch listed under it, { r, data (once read), q (its search), shown }
  let open = null;
  const toggleCommits = async (r) => {
    closeCmpChoice();
    const was = Boolean(open) && open.r.ref === r.ref;
    open = was ? null : { r, data: null, q: '', shown: CMP_COMMITS_SHOWN };
    const top = list.scrollTop;
    render();
    list.scrollTop = top;
    const item = () => [...list.querySelectorAll('.cmp-menu-item')].find((el) => el.dataset.ref === r.ref);
    if (item()) item().focus();
    if (was) return;
    const mine = open;
    let data;
    try {
      data = await window.git.compareCommits(repoPath, r.ref, CMP_COMMITS_MAX);
    } catch (e) {
      data = { error: e.message };
    }
    if (open !== mine || !menu.isConnected) return;
    mine.data = data;
    const block = list.querySelector('.cmp-branch-commits');
    if (!block) return;
    const focused = document.activeElement;
    block.replaceWith(commitsBlock());
    if (focused && focused.isConnected) focused.focus();
    // the branch at the top when its commits do not fit under it
    const at = item();
    const box = list.getBoundingClientRect();
    const shown = list.querySelector('.cmp-branch-commits').getBoundingClientRect();
    if (at && shown.bottom > box.bottom) list.scrollTop += Math.min(shown.bottom - box.bottom, at.getBoundingClientRect().top - box.top - 4);
  };
  // the commits matching its search, the first open.shown of them; a click chooses one
  const fillCommits = (rows) => {
    rows.textContent = '';
    const { r, data } = open;
    const q = open.q.trim().toLowerCase();
    const hits = data.commits.filter((c) => !q || `${c.fullHash} ${c.message} ${c.author} ${c.tags.join(' ')} ${cmpVersionText(c.version)}`.toLowerCase().includes(q));
    for (const c of hits.slice(0, open.shown)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `clip-menu-item branch-menu-item cmp-commit-item${side && side.value === c.fullHash ? ' current' : ''}`;
      row.setAttribute('role', 'menuitem');
      row.title = `${c.message}\n${c.author} · ${new Date(c.date).toLocaleString()}${c.version ? `\nVersion: ${cmpVersionText(c.version)}` : ''}`;
      const tags = c.tags.map((t) => `<span class="branch-log-ref tag">${escapeHtml(t)}</span>`).join('');
      row.innerHTML = `<svg class="branch-menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg><span class="log-hash">${escapeHtml(c.hash)}</span><span class="cmp-menu-msg">${escapeHtml(c.message)}</span>${tags}<span class="cmp-menu-date">${escapeHtml(cmpShortDate(c.date))}</span>`;
      row.addEventListener('click', () => pick(c.fullHash, { message: c.message, branch: r.ref, label: c.hash }));
      rows.appendChild(row);
    }
    if (hits.length > open.shown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'clip-menu-item branch-menu-item cmp-commits-more';
      more.textContent = `Show ${Math.min(CMP_COMMITS_SHOWN, hits.length - open.shown)} more`;
      more.addEventListener('click', () => {
        const from = open.shown;
        open.shown += CMP_COMMITS_SHOWN;
        fillCommits(rows);
        const next = rows.querySelectorAll('.cmp-commit-item')[from];
        if (next) next.focus();
      });
      rows.appendChild(more);
    }
    // a hash the list does not have: that commit
    if (/^[0-9a-f]{4,40}$/.test(q) && !hits.length) {
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'clip-menu-item branch-menu-item cmp-commit-item';
      use.innerHTML = `<span class="cmp-menu-msg">Use commit <span class="log-hash">${escapeHtml(q)}</span></span>`;
      use.addEventListener('click', () => pick(q, { label: q.slice(0, 7), branch: r.ref }));
      rows.appendChild(use);
    } else if (!hits.length) rows.appendChild(noteEl(q ? `No commit has "${open.q.trim()}"` : 'No commits'));
    if (!q && data.total > data.commits.length && hits.length <= open.shown) rows.appendChild(noteEl(`The latest ${data.commits.length} of ${data.total} commits: type a hash to use an older one`));
  };
  // under the branch: its search (when it has more than a few), then its commits
  const commitsBlock = () => {
    const block = document.createElement('div');
    block.className = 'cmp-branch-commits';
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', `Commits of ${open.r.name}`);
    const { data } = open;
    if (!data || data.error) {
      block.appendChild(noteEl(data ? data.error : 'Loading...'));
      return block;
    }
    const rows = document.createElement('div');
    if (data.commits.length > CMP_COMMITS_FILTER_FROM) {
      const filter = document.createElement('input');
      filter.className = 'input cmp-commits-filter';
      filter.type = 'search';
      filter.placeholder = `Search its ${plural(data.total, 'commit')}...`;
      filter.title = 'Message, author, hash or version';
      filter.spellcheck = false;
      filter.autocomplete = 'off';
      filter.setAttribute('aria-label', `Search the commits of ${open.r.name}`);
      filter.value = open.q;
      filter.addEventListener('input', () => {
        open.q = filter.value;
        open.shown = CMP_COMMITS_SHOWN;
        fillCommits(rows);
      });
      filter.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = rows.querySelector('.branch-menu-item');
        if (first) first.click();
      });
      block.appendChild(filter);
    }
    block.appendChild(rows);
    fillCommits(rows);
    return block;
  };

  // the keyboard goes through the branches, and the search and commits of the one listed
  const items = () => [...list.querySelectorAll('.branch-menu-item, .cmp-commits-filter')];
  // more: what a right-click (or the right arrow) opens, for a branch
  const add = (r, kind, title, run, more = null) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `clip-menu-item branch-menu-item cmp-menu-item${side && side.value === r.ref ? ' current' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.title = title;
    item.dataset.ref = r.ref;
    item.innerHTML = `<svg class="branch-menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>${cmpIcon(kind)}<span class="branch-menu-name">${escapeHtml(r.name)}</span>`;
    item.addEventListener('click', run);
    if (more) {
      item.more = () => more(item);
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        item.more();
      });
    }
    list.appendChild(item);
    // its commits listed: an arrow down on it, and them under it
    if (open && open.r.ref === r.ref) {
      item.classList.add('expanded');
      item.setAttribute('aria-expanded', 'true');
      item.insertAdjacentHTML('beforeend', '<svg class="cmp-expanded-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>');
      list.appendChild(commitsBlock());
    }
  };
  const groupHead = (title, count) => {
    const head = document.createElement('div');
    head.className = 'branch-menu-group';
    head.textContent = `${title} (${count})`;
    list.appendChild(head);
  };

  const render = () => {
    if (!cmpRefs || cmpRefs.repo !== repoPath) return;
    closeCmpChoice();
    const q = search.value.trim().toLowerCase();
    const hit = (r) => !q || r.name.toLowerCase().includes(q);
    list.textContent = '';
    let shown = 0;
    for (const [title, refs, kind, hint] of [
      ['Local', cmpRefs.local, 'local', ''],
      ['Remote', cmpRefs.remote, 'remote', ' (as of the last fetch)'],
      ['Tags', cmpRefs.tags, 'tag', ''],
    ]) {
      const hits = refs.filter(hit);
      if (!hits.length) continue;
      groupHead(title, hits.length);
      for (const r of hits) {
        if (kind === 'tag') add(r, kind, `Tag ${r.name}`, () => pick(r.ref));
        else add(r, kind, `${r.name}${hint}: click for its log; right-click to list its commits`, () => pick(r.ref), (item) => choose(item, r));
      }
      shown += hits.length;
    }
    // A hash typed: that commit.
    if (/^[0-9a-f]{4,40}$/.test(q)) {
      add({ ref: q, name: `Use commit ${q}` }, 'commit', 'A commit by its hash', () => pick(q, { label: q.slice(0, 7) }));
      shown++;
    }
    if (shown === 0) list.appendChild(noteEl(q ? 'Nothing matches the search' : 'No branches or tags'));
  };

  search.addEventListener('input', () => {
    list.scrollTop = 0;
    render();
  });
  menu.addEventListener('mousedown', (e) => {
    if ($('#cmpChoice') && !$('#cmpChoice').contains(e.target)) closeCmpChoice();
  });
  menu.addEventListener('keydown', (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (all.length === 0) return;
      const next = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) search.focus();
      else all[Math.min(next, all.length - 1)].focus();
    } else if ((e.key === 'ArrowRight' || e.key === 'ContextMenu') && i >= 0 && all[i].more) {
      e.preventDefault();
      all[i].more();
    } else if (e.key === 'ArrowLeft' && i >= 0 && all[i].matches('button') && all[i].closest('.cmp-branch-commits')) {
      // from its commits: back to the branch, and they go
      e.preventDefault();
      toggleCommits(open.r);
    } else if (e.key === 'Enter' && document.activeElement === search) {
      e.preventDefault();
      if (all[0]) all[0].click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeCmpMenu(true);
    } else if (e.key === 'Tab') {
      closeCmpMenu();
    }
  });

  document.body.appendChild(menu);
  const a = btn.getBoundingClientRect();
  const left = Math.min(Math.max(8, a.left), window.innerWidth - menu.getBoundingClientRect().width - 8);
  const top = a.bottom + 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  search.focus();

  (async () => {
    if (!cmpRefs || cmpRefs.repo !== repoPath) await loadCmpRefs();
    if (!menu.isConnected) return;
    if (!cmpRefs) {
      list.textContent = '';
      list.appendChild(noteEl('The branches and tags could not be read'));
      return;
    }
    render();
  })();
}
