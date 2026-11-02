// -- The variables: the environment's, those the scripts kept (they can be cleared), and the names of the .env --
function openBrunoVars() {
  const pop = $('#bruVarsPop');
  if (!pop.classList.contains('hidden')) {
    closeBrunoVars();
    return;
  }
  pop.innerHTML = '';
  const kept = Object.entries(bru.vars || {});
  const head = bruEl('div', 'bru-vars-head');
  head.append(bruEl('strong', '', 'Kept by the scripts'));
  const clear = bruEl('button', 'btn btn-sm', 'Clear');
  clear.type = 'button';
  clear.disabled = !kept.length || Boolean(bru.run);
  clear.title = 'Forget them: the next sends start without them, as a new Bruno window';
  clear.addEventListener('click', async () => {
    const r = await window.bruno.clearVars(bru.repo, bru.dir);
    if (r.error) return toast(r.error, 'error');
    bru.vars = {};
    closeBrunoVars();
    renderBruno();
    toast('Variables cleared', 'success');
  });
  head.appendChild(clear);
  pop.appendChild(head);
  pop.appendChild(kept.length ? bruPairsTable(kept) : bruEl('div', 'bru-dim bru-vars-empty', 'None yet. A script keeps one with bru.setVar.'));
  if (kept.some(([, v]) => bruUnset(v))) pop.appendChild(bruEl('div', 'bru-vars-note', BRU_UNSET_NOTE));
  const env = bru.envs.find((e) => e.name === bru.env);
  pop.appendChild(bruEl('div', 'bru-vars-head', '')).appendChild(bruEl('strong', '', env ? `Environment ${env.name}` : 'No environment'));
  if (env && env.vars.length) pop.appendChild(bruPairsTable(env.vars.map((v) => [v.key, v.secret ? '(secret: not in the file)' : v.value, !v.enabled])));
  pop.appendChild(bruDotEnvPart());
  pop.classList.remove('hidden');
  $('#bruVarsBtn').setAttribute('aria-expanded', 'true');
}

// The collection's .env: its names and values, and a word when git could take it.
function bruDotEnvPart() {
  const part = document.createDocumentFragment();
  const de = bru.dotenv;
  part.appendChild(bruEl('div', 'bru-vars-head')).appendChild(bruEl('strong', '', de ? '.env of the collection' : 'No .env'));
  if (!de) {
    part.appendChild(bruEl('div', 'bru-dim bru-vars-empty', 'A .env next to bruno.json keeps secrets out of the .bru files: NAME=value, a line each, read as {{process.env.NAME}}.'));
    return part;
  }
  if (de.names.length) {
    const table = part.appendChild(bruEl('div', 'bru-kv bru-dotenv'));
    for (const n of de.names) table.append(bruEl('span', 'bru-k', n.key), bruEl('span', `bru-v${n.set ? '' : ' bru-dim unset'}`, n.set ? n.value : '(empty)'));
  } else part.appendChild(bruEl('div', 'bru-dim bru-vars-empty', 'Nothing in it yet: NAME=value, a line each.'));
  if (BRU_DOTENV_GIT[de.git]) part.appendChild(bruEl('div', 'bru-vars-note', BRU_DOTENV_GIT[de.git]));
  part.appendChild(bruEl('div', 'bru-dim bru-vars-empty', 'Read as {{process.env.NAME}}, or bru.getProcessEnv("NAME") in a script, when a request is sent.'));
  return part;
}

function closeBrunoVars() {
  $('#bruVarsPop').classList.add('hidden');
  $('#bruVarsBtn').setAttribute('aria-expanded', 'false');
}
