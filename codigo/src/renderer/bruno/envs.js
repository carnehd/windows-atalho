// -- Environments, in a dialog: the list on the left (New, Duplicate), the one chosen on the right: its name and its
// variables ({{baseUrl}}...), a box switches one off. Save writes every environment changed here; Delete sends one's
// file to the Trash. A secret variable keeps its value in the Bruno app, not in the file: it is listed, not set. --
const bruEnvs = { list: [], at: 0 }; // list: [{ from: its name on disk (none for a new one), name, vars, base }]

const bruEnvChanged = (e) => !e.from || JSON.stringify([e.name, e.vars]) !== e.base;

function bruEnvModal() {
  let modal = $('#bruEnvModal');
  if (modal) return modal;
  modal = bruEl('div', 'settings-overlay hidden');
  modal.id = 'bruEnvModal';
  modal.innerHTML = `
    <div class="settings-card bru-env-card" role="dialog" aria-modal="true" aria-labelledby="bruEnvTitle">
      <h3 id="bruEnvTitle">Environments</h3>
      <div class="bru-env-layout">
        <div class="bru-env-side">
          <div id="bruEnvList" class="bru-env-list" role="listbox" aria-label="Environments"></div>
          <button id="bruEnvNewBtn" class="btn btn-sm" type="button">+ New environment</button>
        </div>
        <div id="bruEnvEdit" class="bru-env-edit"></div>
      </div>
      <div class="action-row settings-actions bru-env-actions">
        <button id="bruEnvDeleteBtn" class="btn btn-sm btn-danger" type="button">Delete</button>
        <button id="bruEnvCopyBtn" class="btn btn-sm" type="button" title="A new environment with the same variables">Duplicate</button>
        <span class="bru-env-gap"></span>
        <button id="bruEnvCancelBtn" class="btn" type="button">Cancel</button>
        <button id="bruEnvSaveBtn" class="btn btn-primary" type="button">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeBrunoEnvs();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeBrunoEnvs();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveBrunoEnvs();
    }
  });
  $('#bruEnvNewBtn').addEventListener('click', () => addBrunoEnv(null));
  $('#bruEnvCopyBtn').addEventListener('click', () => addBrunoEnv(bruEnvs.list[bruEnvs.at]));
  $('#bruEnvDeleteBtn').addEventListener('click', deleteBrunoEnv);
  $('#bruEnvCancelBtn').addEventListener('click', () => closeBrunoEnvs());
  $('#bruEnvSaveBtn').addEventListener('click', saveBrunoEnvs);
  return modal;
}

function openBrunoEnvs() {
  if (!bru.dir) return;
  closeBrunoVars();
  bruEnvs.list = bru.envs.map((e) => {
    const item = { from: e.name, name: e.name, vars: e.vars.map((v) => ({ ...v })) };
    item.base = JSON.stringify([item.name, item.vars]);
    return item;
  });
  bruEnvs.at = Math.max(0, bruEnvs.list.findIndex((e) => e.name === bru.env));
  bruEnvModal().classList.remove('hidden');
  if (!bruEnvs.list.length) addBrunoEnv(null);
  else renderBrunoEnvs();
  const first = $('#bruEnvEdit .bru-kv-value:not(:disabled)') || $('#bruEnvEdit input');
  if (first) first.focus();
}

async function closeBrunoEnvs(force = false) {
  if (!force && bruEnvs.list.some(bruEnvChanged) && !(await askConfirm('Discard the changes to the environments?', { confirm: 'Discard' }))) return;
  $('#bruEnvModal').classList.add('hidden');
  $('#bruEnvBtn').focus();
}

function renderBrunoEnvs() {
  const list = $('#bruEnvList');
  list.innerHTML = '';
  bruEnvs.list.forEach((e, i) => {
    const b = bruEl('button', `bru-env-item${i === bruEnvs.at ? ' on' : ''}`, e.name || '(no name)');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === bruEnvs.at));
    if (bruEnvChanged(e)) b.appendChild(bruEl('span', 'bru-dot', '•')).title = e.from ? 'Changed, not saved' : 'New, not saved';
    if (e.from === bru.env) b.appendChild(bruEl('span', 'bru-env-used', 'in use'));
    b.addEventListener('click', () => {
      bruEnvs.at = i;
      renderBrunoEnvs();
    });
    list.appendChild(b);
  });
  const edit = $('#bruEnvEdit');
  edit.innerHTML = '';
  const env = bruEnvs.list[bruEnvs.at];
  $('#bruEnvDeleteBtn').disabled = !env;
  $('#bruEnvCopyBtn').disabled = !env;
  if (!env) return;
  const name = bruInput(env.name, 'dev, staging...', 'env.name', 'bru-env-name');
  name.maxLength = 40;
  name.addEventListener('input', () => {
    env.name = name.value.trim();
    const item = list.children[bruEnvs.at];
    if (item) item.firstChild.textContent = env.name || '(no name)';
  });
  edit.appendChild(bruLabeled('Name', name, env.from ? `environments/${env.from}.bru` : 'A new file in environments/'));
  edit.appendChild(bruEl('div', 'bru-field-label', 'Variables'));
  edit.appendChild(bruKvEditor(env.vars, {
    focusKey: 'env.vars',
    nameKey: 'key',
    namePh: 'name',
    valuePh: 'value',
    locked: (row) => (row.secret ? 'secret: its value is in the Bruno app' : null),
    onChange: () => {
      const item = list.children[bruEnvs.at];
      if (item && !item.querySelector('.bru-dot')) renderBrunoEnvs();
      else bruEnvDotEnvHint(env);
    },
  }));
  edit.appendChild(bruEl('div', 'bru-dim bru-hint', 'Use one as {{name}} in an address, a header, a body or a script.'));
  edit.appendChild(bruEl('div', 'bru-hint bru-env-dotenv')).id = 'bruEnvDotEnv';
  bruEnvDotEnvHint(env);
}

// A secret out of git: {{process.env.NAME}} as the value, NAME=value in the collection's .env. Says the names it has,
// and those the environment reads that it does not.
function bruEnvDotEnvHint(env) {
  const box = $('#bruEnvDotEnv');
  if (!box) return;
  const de = bru.dotenv;
  const lacking = [...new Set(env.vars.filter((v) => v.enabled !== false).flatMap((v) => bruProcessRefs(v.value)))].filter((k) => !bruDotEnv(k));
  box.replaceChildren(bruEl('span', 'bru-dim', de
    ? `A secret kept out of git: {{process.env.NAME}}, NAME from the collection's .env${de.names.length ? ` (${de.names.map((n) => n.key).join(', ')})` : ', empty for now'}.`
    : 'A secret kept out of git: {{process.env.NAME}} as the value, and NAME=value in a .env next to bruno.json.'));
  if (lacking.length) box.appendChild(bruEl('div', 'bru-env-lacking', `Not in .env: ${lacking.join(', ')}. Sent without a value, unless the system's environment has it.`));
  if (de && BRU_DOTENV_GIT[de.git]) box.appendChild(bruEl('div', 'bru-env-lacking', BRU_DOTENV_GIT[de.git]));
}

function addBrunoEnv(copyOf) {
  const names = new Set(bruEnvs.list.map((e) => e.name));
  const base = copyOf ? `${copyOf.name} copy` : 'new';
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  const vars = copyOf ? copyOf.vars.filter((v) => !v.secret).map((v) => ({ ...v })) : [{ key: 'baseUrl', value: '', enabled: true }];
  bruEnvs.list.push({ from: null, name, vars, base: '' });
  bruEnvs.at = bruEnvs.list.length - 1;
  renderBrunoEnvs();
  const input = $('#bruEnvEdit .bru-env-name');
  input.focus();
  input.select();
}

async function deleteBrunoEnv() {
  const env = bruEnvs.list[bruEnvs.at];
  if (!env) return;
  if (env.from) {
    if (!(await askConfirm(`Delete environment "${env.from}"?\nIts file goes to the Trash.`, { confirm: 'Delete' }))) return;
    const r = await window.bruno.deleteEnv(bru.repo, bru.dir, env.from);
    if (r.error) return toast(r.error, 'error');
    if (bru.env === env.from) {
      bru.env = '';
      bruSave(BRU_ENV_KEY, bru.dir, '');
    }
    toast(`${env.from} is in the Trash`, 'success');
  }
  bruEnvs.list.splice(bruEnvs.at, 1);
  bruEnvs.at = Math.max(0, bruEnvs.at - 1);
  await reloadBrunoEnvs();
  renderBrunoEnvs();
}

async function saveBrunoEnvs() {
  const names = bruEnvs.list.map((e) => e.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) return toast(`Two environments are called ${twice}`, 'error');
  for (const [i, env] of bruEnvs.list.entries()) {
    if (!bruEnvChanged(env)) continue;
    const r = await window.bruno.saveEnv(bru.repo, bru.dir, { name: env.name, from: env.from, vars: env.vars });
    if (r.error) {
      bruEnvs.at = i;
      renderBrunoEnvs();
      return toast(r.error, 'error');
    }
    if (env.from && env.from !== env.name && bru.env === env.from) {
      bru.env = env.name;
      bruSave(BRU_ENV_KEY, bru.dir, env.name);
    }
    env.from = env.name;
    env.base = JSON.stringify([env.name, env.vars]);
  }
  await reloadBrunoEnvs();
  closeBrunoEnvs(true);
  toast('Environments saved', 'success');
}

async function reloadBrunoEnvs() {
  const r = await window.bruno.read(bru.repo, bru.dir);
  if (r.error) return;
  bru.envs = r.envs || [];
  bru.dotenv = r.dotenv || null;
  if (bru.env && !bru.envs.some((e) => e.name === bru.env)) bru.env = '';
  renderBruno();
}
