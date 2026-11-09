// -- Version and updates, at the top of Settings: Check for updates asks GitHub for the latest release; Download puts
// its QuickDeck-<version>.zip in the folder of the exe and takes its QuickDeck-<version>.exe out next to it (updater.js);
// Open closes this one and opens that one, with the same data folder. --
let updateState = { phase: 'idle' };

const mb = (n) => `${Math.max(1, Math.round(n / 1048576))} MB`;

function setUpdate(next) {
  updateState = { ...updateState, ...next };
  renderUpdate();
}

function updateButton(label, onClick, { primary = false, title = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn btn-sm${primary ? ' btn-primary' : ''}`;
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function renderUpdate() {
  const s = updateState;
  const box = $('#updateBox');
  const text = $('#updateText');
  const actions = $('#updateActions');
  const busy = s.phase === 'checking' || s.phase === 'download' || s.phase === 'unpack';
  $('#updateCheckBtn').disabled = busy;
  box.classList.toggle('hidden', s.phase === 'idle');
  text.classList.toggle('error', s.phase === 'error');
  actions.replaceChildren();
  $('#updateTrack').classList.toggle('hidden', s.phase !== 'download' && s.phase !== 'unpack');
  const v = s.latest && s.latest.version;
  const notes = s.latest && s.latest.notes;
  $('#updateNotes').classList.toggle('hidden', !(notes && (s.phase === 'newer' || s.phase === 'ready')));
  if (notes) $('#updateNotesText').textContent = notes;
  switch (s.phase) {
    case 'checking':
      text.textContent = 'Asking GitHub for the latest version...';
      break;
    case 'error':
      text.textContent = s.error;
      break;
    case 'unsupported':
      text.textContent = 'This copy runs from the source code: only the Windows exe updates itself.';
      break;
    case 'latest':
      text.textContent = `You have the latest version${v && v !== s.current ? ` (the latest on GitHub is ${v})` : ''}.`;
      break;
    case 'newer': {
      const when = s.latest.date ? ` (${new Date(s.latest.date).toLocaleDateString()})` : '';
      text.textContent = `QuickDeck ${v} is out${when}. It goes into ${s.folder} as QuickDeck-${v}.zip, with QuickDeck-${v}.exe taken out of it next to it. The data folder stays as it is.`;
      const size = s.latest.asset && s.latest.asset.size ? ` (${mb(s.latest.asset.size)})` : '';
      actions.append(updateButton(`Download ${v}${size}`, downloadUpdate, { primary: true }));
      break;
    }
    case 'download': {
      const pct = s.total ? Math.min(100, Math.round((s.got / s.total) * 100)) : 0;
      $('#updateFill').style.width = `${pct}%`;
      $('#updateTrack').classList.toggle('busy', !s.total);
      text.textContent = `Downloading QuickDeck ${v}: ${s.total ? `${mb(s.got)} of ${mb(s.total)}` : mb(s.got || 0)}`;
      break;
    }
    case 'unpack':
      $('#updateFill').style.width = '100%';
      text.textContent = `Taking QuickDeck-${v}.exe out of the zip...`;
      break;
    case 'ready':
      text.textContent = `QuickDeck-${v}.exe is in ${s.folder}, next to this one. Shortcuts and the taskbar still open the exe you had: point them to the new one.`;
      if (s.canOpen) actions.append(updateButton(`Open ${v} now`, openUpdate, { primary: true, title: `Closes this one (${s.current}) and opens ${v}, with the same data` }));
      actions.append(updateButton('Show in folder', () => window.updates.reveal(v)));
      break;
    default:
  }
}

async function checkUpdate() {
  setUpdate({ phase: 'checking' });
  const r = await window.updates.check();
  if (r.error) return setUpdate({ phase: 'error', error: r.error });
  if (r.unsupported) return setUpdate({ phase: 'unsupported', current: r.current });
  const base = { current: r.current, folder: r.folder, canOpen: r.canOpen, latest: r.latest };
  if (!r.newer) return setUpdate({ ...base, phase: 'latest' });
  setUpdate({ ...base, phase: r.have ? 'ready' : 'newer' });
}

async function downloadUpdate() {
  setUpdate({ phase: 'download', got: 0, total: (updateState.latest.asset && updateState.latest.asset.size) || 0 });
  const r = await window.updates.download();
  if (r.error) return setUpdate({ phase: 'error', error: r.error });
  setUpdate({ phase: 'ready', latest: { ...updateState.latest, version: r.version } });
  toast(`QuickDeck-${r.version}.exe is ready next to this one`, 'success', { plain: true });
}

async function openUpdate() {
  const v = updateState.latest.version;
  // what runs in this one stops with it
  const running = await window.maven.running();
  if (running.length) {
    const ok = await askConfirm(`Open QuickDeck ${v} now? This one closes, and what runs in it stops.\n\n${running.map((r) => `${r.command} (${r.repo.split(/[\\/]/).pop()})`).join('\n')}`, { confirm: `Open ${v}` });
    if (!ok) return;
  }
  const r = await window.updates.open(v);
  if (r.error) setUpdate({ phase: 'error', error: r.error });
}

async function setupUpdates() {
  window.updates.onProgress((p) => {
    if (p.phase === 'unpack') setUpdate({ phase: 'unpack' });
    else if (updateState.phase === 'download') setUpdate({ got: p.got, total: p.total || updateState.total });
  });
  $('#updateCheckBtn').addEventListener('click', checkUpdate);
  const info = await window.updates.info();
  $('#updateVersion').textContent = `QuickDeck ${info.current}`;
}

if (!CARD_ID) setupUpdates();
