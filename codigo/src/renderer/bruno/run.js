// -- Sending: one request or a folder, with the Bruno CLI --
// The CLI sends the file: a request changed here is saved first.
async function bruSend() {
  const d = bru.detail;
  if (!d) return;
  if (bru.run && bru.run.target === d.path) return bruStop();
  if (bru.run) return;
  if (!(await bruSaveRequest({ quiet: true }))) return;
  bruRun(d.path, d.name);
}

async function bruRun(target, label) {
  if (bru.run || !bru.dir) return;
  // a run of many: those changed here go as saved, or not at all
  const isOne = target && target.endsWith('.bru');
  const dirty = [...bruState().drafts.values()].filter(bruDirty).length;
  if (!isOne && dirty) {
    if (!(await askConfirm(`Save the changes first?\n${dirty === 1 ? '1 request has' : `${dirty} requests have`} changes not saved; the run sends the files as they are.`, { confirm: 'Save and run' }))) return;
    if (!(await bruSaveAll())) return;
  }
  if (bru.cli && !bru.cli.ok) {
    toast(`${bru.cli.reason} ${bru.cli.install ? 'Install it from the note above the requests.' : bru.cli.hint}`, 'error');
    return;
  }
  const isRequest = target && target.endsWith('.bru');
  const list = isRequest ? [bruFind(target)].filter(Boolean) : bruRequests(bru.tree, target);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const st = bruState();
  bru.run = { id, dir: bru.dir, target, label: label || 'Run all', env: bru.env, startedAt: Date.now(), queued: new Set(list.map((r) => r.path)), total: list.length, pass: 0, fail: 0 };
  st.log = `${st.log ? `${st.log}\n` : ''}\u25b6 ${bru.run.label}${bru.env ? ` (${bru.env})` : ''}, ${new Date().toLocaleTimeString()}\n`;
  renderBruno();
  const r = await window.bruno.run(bru.repo, bru.dir, { id, target, env: bru.env });
  if (r.error) {
    if (bru.run && bru.run.id === id) bru.run = null;
    st.log += `${r.error}\n`;
    toast(r.error, 'error');
    renderBruno();
  }
}

async function bruStop() {
  if (!bru.run) return;
  await window.bruno.stop(bru.run.id);
}

function onBrunoResult({ id, result }) {
  const run = bru.run && bru.run.id === id ? bru.run : null;
  if (!run || !result.file) return;
  const st = bruState(run.dir);
  st.results.set(result.file, { ...result, at: Date.now() });
  if (run.queued.delete(result.file)) {
    if (result.status === 'pass' || result.status === 'skipped') run.pass++;
    else run.fail++;
  }
  if (run.dir !== bru.dir) return;
  renderBrunoTree();
  if (bru.detail && bru.detail.path === result.file) renderBrunoDetail();
}

function onBrunoOutput({ id, text }) {
  const run = bru.run && bru.run.id === id ? bru.run : null;
  if (!run) return;
  const st = bruState(run.dir);
  st.log += text;
  if (st.log.length > BRU_MAX_LOG) st.log = st.log.slice(-BRU_MAX_LOG);
  if (run.dir === bru.dir && st.tab === 'log') {
    const pre = $('#bruPane .bru-log');
    if (pre) {
      pre.textContent = st.log;
      $('#bruPane').scrollTop = $('#bruPane').scrollHeight;
    }
  }
}

function onBrunoDone({ id, stopped, vars, code }) {
  const run = bru.run && bru.run.id === id ? bru.run : null;
  if (!run) return;
  bru.run = null;
  const st = bruState(run.dir);
  // the CLI ends with 1 when a check failed (the results say so); with nothing sent, the log says why
  st.log += stopped ? '\u25a0 Stopped\n' : code && !run.pass && !run.fail ? `\u25a0 The Bruno CLI ended with code ${code} before sending anything\n` : '';
  if (run.dir === bru.dir) bru.vars = vars || {};
  if (run.dir === bru.dir) renderBruno();
  if (!stopped && run.total > 1) toast(`${run.label}: ${run.pass} of ${run.total} passed`, run.pass === run.total ? 'success' : 'error');
}
