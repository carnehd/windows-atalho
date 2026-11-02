// -- Loading: on each refresh of the repository, its collections; the view switch shows Bruno when there is one --
async function refreshBruno() {
  if (!currentRepo) return;
  const repo = currentRepo;
  const r = await window.bruno.collections(repo);
  if (repo !== currentRepo) return;
  const list = (r && r.collections) || [];
  const had = brunoAvailable();
  bru.repo = repo;
  bru.collections = list;
  $('#viewBrunoBtn').classList.toggle('hidden', !list.length);
  if (list.length) {
    const saved = bruLoad(BRU_DIR_KEY)[repo];
    const dir = (list.find((c) => c.dir === saved) || list.find((c) => c.dir === bru.dir) || list[0]).dir;
    if (dir !== bru.dir) await openBrunoCollection(dir);
    else if (effectiveGitView() === 'bruno') await reloadBrunoTree();
  } else bru.dir = null;
  // the switch has one tab more or less; a Bruno view with nothing to show goes back to Git
  if (had !== brunoAvailable()) applyGitView();
  placeViewLine();
}

// The files again (on a refresh, or when the view shows): the list changes only when they did.
async function reloadBrunoTree() {
  const { repo, dir } = bru;
  if (!dir) return;
  const r = await window.bruno.read(repo, dir);
  if (repo !== bru.repo || dir !== bru.dir || r.error) return;
  if (JSON.stringify([r.tree, r.envs, r.dotenv]) === JSON.stringify([bru.tree, bru.envs, bru.dotenv])) return;
  bru.tree = r.tree || [];
  bru.envs = r.envs || [];
  bru.dotenv = r.dotenv || null;
  if (bru.env && !bru.envs.some((e) => e.name === bru.env)) bru.env = bru.envs.length ? bru.envs[0].name : '';
  const st = bruState();
  if (st.selected && !bruFind(st.selected)) st.selected = bruRequests()[0] ? bruRequests()[0].path : null;
  renderBrunoBar();
  renderBrunoTree();
  await loadBrunoDetail();
}

async function openBrunoCollection(dir) {
  const repo = bru.repo;
  const r = await window.bruno.read(repo, dir);
  if (repo !== bru.repo) return;
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  bru.dir = dir;
  bru.tree = r.tree || [];
  bru.envs = r.envs || [];
  bru.dotenv = r.dotenv || null;
  bru.vars = r.vars || {};
  const saved = bruLoad(BRU_ENV_KEY)[dir];
  const names = bru.envs.map((e) => e.name);
  bru.env = names.includes(saved) ? saved : saved === '' ? '' : names.includes('local') ? 'local' : names[0] || '';
  const st = bruState();
  if (st.selected && !bruFind(st.selected)) st.selected = null;
  if (!st.selected) {
    const first = bruRequests()[0];
    st.selected = first ? first.path : null;
  }
  renderBruno();
  await loadBrunoDetail();
}

async function loadBrunoDetail() {
  const st = bruState();
  const rel = st.selected;
  bru.detail = null;
  if (!rel) {
    renderBrunoDetail();
    return;
  }
  const r = await window.bruno.request(bru.repo, bru.dir, rel);
  if (bruState().selected !== rel) return;
  bru.detail = r.request ? { ...r.request, path: rel, editError: r.editError } : null;
  if (r.error) toast(r.error, 'error');
  // a draft with changes stays (it notes when the file changed on disk too); else the file as it is now
  const kept = bruState().drafts.get(rel);
  if (kept && bruDirty(kept)) kept.diskStamp = r.stamp;
  else if (r.edit) bruKeepDraft(rel, r.edit, r.stamp);
  else bruState().drafts.delete(rel);
  bru.editShown = null;
  renderBrunoDetail();
}

// The view was chosen: the CLI is looked for the first time (the note says how to get it when it is not there).
async function showBrunoView() {
  if (!bru.cli) {
    bru.cli = await window.bruno.cli(false);
    renderBrunoNote();
  }
  if (bru.dir && !bru.tree.length) await openBrunoCollection(bru.dir);
  else await reloadBrunoTree();
}

function renderBrunoNote() {
  const note = $('#bruNote');
  const cli = bru.cli;
  note.classList.toggle('hidden', !cli || cli.ok);
  $('#bruBar').title = cli && cli.ok ? `Bruno CLI ${cli.version}, from ${cli.from}` : '';
  if (!cli || cli.ok) return;
  note.innerHTML = '';
  const text = bruEl('div', 'bru-note-text');
  text.append(bruEl('strong', '', cli.reason), bruEl('span', '', ' Git Quick sends the requests with it. In a terminal:'));
  const cmd = bruEl('code', 'bru-note-cmd', cli.hint);
  const copy = bruEl('button', 'btn btn-sm', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(cli.hint, 'Command'));
  const again = bruEl('button', 'btn btn-sm', 'Look again');
  again.type = 'button';
  again.addEventListener('click', async () => {
    bru.cli = await window.bruno.cli(true);
    renderBrunoNote();
    renderBrunoBar();
    toast(bru.cli.ok ? `Bruno CLI ${bru.cli.version} found` : 'Still not there', bru.cli.ok ? 'success' : 'error');
  });
  const row = bruEl('div', 'bru-note-row');
  row.append(cmd, copy, again);
  note.append(text, row);
}

function renderBruno() {
  renderBrunoBar();
  renderBrunoTree();
  renderBrunoDetail();
}

// -- The bar, on the right: the collection (when more than one), the variables, the environment --
function renderBrunoBar() {
  const coll = $('#bruCollection');
  coll.classList.toggle('hidden', bru.collections.length < 2);
  coll.innerHTML = '';
  for (const c of bru.collections) {
    const o = bruEl('option', '', c.rel ? `${c.name} (${c.rel})` : c.name);
    o.value = c.dir;
    coll.appendChild(o);
  }
  coll.value = bru.dir || '';
  const env = $('#bruEnv');
  env.innerHTML = '';
  for (const e of bru.envs) {
    const o = bruEl('option', '', e.name);
    o.value = e.name;
    env.appendChild(o);
  }
  const none = bruEl('option', '', 'No environment');
  none.value = '';
  env.appendChild(none);
  env.value = bru.env;
  const kept = Object.keys(bru.vars || {}).length;
  $('#bruVarsCount').textContent = kept ? String(kept) : '';
  $('#bruVarsCount').classList.toggle('hidden', !kept);
}

