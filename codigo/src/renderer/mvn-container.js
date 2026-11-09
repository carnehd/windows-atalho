// -- Start in container: the jar Maven builds, run by Docker or Podman in a Java image, with nothing added to the
// microservice's folder. Run with it chosen opens a dialog with what the container needs (the image, its name, the
// port, debug, build first, the values of the Values button, this PC's proxy, more options of the run, the variables:
// Env's, or with From Env those application.yml reads, with their defaults), the command it runs under them (Copy gives it with the values, for a terminal); Start saves them for
// the repository and runs it, its output in the page (maven.js). --
let mvnContainerSpec = null; // what the dialog starts with (from the page's info): saved for the repository, or defaults
let mcRows = []; // the variables of the dialog, { name, value, enabled }: the table changes them in place
let mcEngine = null; // { name, label } of the engine that answers, or { error }
let mcValues = {}; // what Values would give the application: { values, valuesNote }, or {}
let mcPreviewTimer = 0;
let mcProxyFound = null; // what this PC's settings say: { url, from, noProxy }
// Java images often used, offered under the image field (a datalist's own popup takes Electron down on macOS)
const MC_IMAGES = ['eclipse-temurin:17-jre', 'eclipse-temurin:21-jre', 'eclipse-temurin:25-jre', 'amazoncorretto:17', 'amazoncorretto:21'];

// "eclipse-temurin:21-jre · :8080" next to the command list
function mvnContainerSummary(spec) {
  return spec ? `${spec.image} · :${spec.port}${spec.debug ? ` · debug :${spec.debugPort}` : ''}${spec.proxy && spec.proxy.on ? ' · proxy' : ''}${spec.options ? ' · extra options' : ''}` : '';
}

function mvnContainerModal() {
  let modal = $('#mvnContainerModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'mvnContainerModal';
  modal.className = 'settings-overlay hidden';
  modal.innerHTML = `
    <div class="settings-card mc-card" role="dialog" aria-modal="true" aria-labelledby="mcTitle">
      <h3 id="mcTitle">Start in a container</h3>
      <p class="mv-sub">The jar Maven builds, run in a Java image. Nothing is added to the microservice's folder: the jar is mounted read-only, and the container is removed when it stops.</p>
      <p id="mcEngine" class="me-hint mc-engine" aria-live="polite"></p>
      <div class="mc-grid">
        <label class="mc-key" for="mcImage">Java image</label>
        <div class="mc-line">
          <input id="mcImage" class="input mc-wide" maxlength="255" spellcheck="false" autocomplete="off" />
          <button id="mcImagePick" class="btn btn-sm" type="button" aria-haspopup="menu" title="Java images often used">Images</button>
        </div>
        <label class="mc-key" for="mcName">Container</label>
        <div class="mc-line"><input id="mcName" class="input mc-wide" maxlength="128" spellcheck="false" autocomplete="off" /></div>
        <label class="mc-key" for="mcPort">Port</label>
        <div class="mc-line"><input id="mcPort" class="input mc-port" type="number" min="1" max="65535" /><span class="me-hint mc-inline-hint">on this PC and in the container (given as SERVER_PORT)</span></div>
        <span class="mc-key">Debug</span>
        <div class="mc-line"><label class="mv-differs"><input id="mcDebug" type="checkbox" /> Debug on port</label><input id="mcDebugPort" class="input mc-port" type="number" min="1" max="65535" aria-label="Debug port" /></div>
        <span class="mc-key">Build</span>
        <div class="mc-line"><label class="mv-differs"><input id="mcBuild" type="checkbox" /> Build first (mvn package -DskipTests)</label><span id="mcJar" class="me-hint mc-inline-hint"></span></div>
        <span id="mcValuesKey" class="mc-key">Values</span>
        <div id="mcValuesLine" class="mc-line"><label class="mv-differs"><input id="mcValues" type="checkbox" /> <span id="mcValuesText"></span></label></div>
        <span class="mc-key">Proxy</span>
        <div class="mc-line"><label class="mv-differs"><input id="mcProxy" type="checkbox" /> Use this PC's proxy</label><input id="mcProxyUrl" class="input mc-wide mc-proxy" maxlength="300" placeholder="http://proxy:8080" spellcheck="false" autocomplete="off" aria-label="The proxy" aria-describedby="mcProxyHint" /></div>
        <label class="mc-key" for="mcNoProxy">Not through it</label>
        <div class="mc-line"><input id="mcNoProxy" class="input mc-wide" maxlength="1000" placeholder=".company.local, 10.1.2.3" spellcheck="false" autocomplete="off" /></div>
        <span></span>
        <p id="mcProxyHint" class="me-hint mc-inline-hint" aria-live="polite"></p>
        <label class="mc-key" for="mcOptions">Extra options</label>
        <div class="mc-line"><input id="mcOptions" class="input mc-wide" maxlength="1000" placeholder="--network my-net --label team=billing" spellcheck="false" autocomplete="off" aria-describedby="mcOptionsHint" /></div>
        <span></span>
        <p id="mcOptionsHint" class="me-hint mc-inline-hint">Given to docker run / podman run as typed, before the image: --network, --label, -v, --add-host...</p>
      </div>
      <div class="me-vars-head mc-vars-head">
        <span class="settings-label">Environment variables</span>
        <span class="mv-gap"></span>
        <button id="mcCopyVars" class="btn btn-sm" type="button" title="Copy these variables, to paste them in another microservice (as NAME=value lines; left out of the clipboard history)">Copy</button>
        <button id="mcPasteVars" class="btn btn-sm" type="button" title="Paste the variables copied, or NAME=value lines copied anywhere: a name already here takes the new value">Paste</button>
        <button id="mcFromEnv" class="btn btn-sm" type="button" title="In place of these: the variables application.yml reads (\${NAME:default}) with their defaults, Env's value over them, and Env's other variables. localhost becomes the name the container reaches this PC by">From Env</button>
      </div>
      <div id="mcVars" class="me-vars mc-vars" role="group" aria-label="Environment variables of the container" aria-describedby="mcNote"></div>
      <p id="mcNote" class="me-note" aria-live="polite"></p>
      <p class="me-hint">Inside the container, localhost is the container itself: for a database or a service on this PC, use host.docker.internal (Podman: host.containers.internal).</p>
      <div class="me-vars-head mc-vars-head">
        <span class="settings-label">Command</span>
        <span class="mv-gap"></span>
        <button id="mcCopy" class="btn btn-sm" type="button" title="Copy the command to paste in a terminal, with the values of the variables in it">Copy</button>
      </div>
      <pre id="mcCommand" class="mc-command" aria-label="The command it runs"></pre>
      <div class="action-row settings-actions mv-actions">
        <span class="mv-gap"></span>
        <button id="mcCancel" class="btn" type="button">Cancel</button>
        <button id="mcStart" class="btn btn-primary" type="button" title="Start (Ctrl+Enter)">Start</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMvnContainer();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      startMvnContainer();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && e.target.matches('#mcVars .bru-input')) {
      e.preventDefault();
      focusKvRow($('#mcVars'), kvRowOf(e.target) + 1);
    }
  });
  modal.addEventListener('input', () => previewMvnContainerLater());
  modal.addEventListener('change', () => previewMvnContainerLater());
  $('#mcDebug').addEventListener('change', () => ($('#mcDebugPort').disabled = !$('#mcDebug').checked));
  $('#mcProxy').addEventListener('change', () => {
    setMcProxyOn($('#mcProxy').checked);
    if ($('#mcProxy').checked && !$('#mcProxyUrl').value.trim()) $('#mcProxyUrl').focus();
  });
  $('#mcImagePick').addEventListener('click', () => {
    openActionMenu({
      anchor: $('#mcImagePick'),
      title: 'Java image',
      items: MC_IMAGES.map((image) => ({
        label: image,
        run: () => {
          $('#mcImage').value = image;
          $('#mcImage').focus();
          previewMvnContainerLater();
        },
      })),
    });
    const first = $('#actionMenu .clip-menu-item');
    if (first) first.focus();
  });
  $('#mcCancel').addEventListener('click', closeMvnContainer);
  $('#mcStart').addEventListener('click', startMvnContainer);
  $('#mcCopy').addEventListener('click', copyMvnContainer);
  $('#mcFromEnv').addEventListener('click', takeMcFromEnv);
  $('#mcCopyVars').addEventListener('click', () => copyMvnEnvRows(mcRows));
  $('#mcPasteVars').addEventListener('click', async () => {
    const vars = await mvnEnvToPaste();
    if (!vars) {
      toast(MVN_ENV_NO_PASTE, 'error');
      return;
    }
    drawMcRows(mcRows.length, pasteMvnEnvRows(mcRows, mcRows.length, vars));
  });
  // × takes the row out: the focus goes to the row that took its place
  $('#mcVars').addEventListener(
    'click',
    (e) => {
      const del = e.target.closest('.bru-kv-del');
      if (!del || del.disabled) return;
      const at = kvRowOf(del);
      setTimeout(() => focusKvRow($('#mcVars'), at));
    },
    true
  );
  $('#mcVars').addEventListener('paste', (e) => {
    const input = e.target.closest('.bru-kv-name');
    const vars = input && pastedMvnEnvVars(e.clipboardData.getData('text/plain'));
    if (!vars) return;
    e.preventDefault();
    const done = pasteMvnEnvRows(mcRows, kvRowOf(input), vars);
    drawMcRows(mcRows.length, done);
  });
  return modal;
}

function drawMcRows(focusAt, done = '') {
  const box = $('#mcVars');
  box.replaceChildren(
    bruKvEditor(mcRows, {
      onChange: () =>
        setTimeout(() => {
          renderMcNote();
          previewMvnContainerLater();
        }),
      focusKey: 'mc',
    })
  );
  if (focusAt !== undefined) focusKvRow(box, focusAt);
  renderMcNote(done);
  previewMvnContainerLater();
}

const renderMcNote = (done = '') => renderEnvRowsNote($('#mcVars'), $('#mcNote'), mcRows, done);

// localhost (or 127.0.0.1) as the host of a value: inside the container it is the container itself
const mcReachHost = (value, host) => String(value).replace(/(^|[^\w.-])(localhost|127\.0\.0\.1)(?![\w-]|\.\w)/g, (_, before) => before + host);

// From Env: the variables the microservice's own application.yml / .properties read (${NAME:default}), with their
// defaults; Env's value over one it has switched on, and Env's other variables after them. localhost in a value becomes
// the name the container reaches this PC by. SERVER_PORT, and a variable only server.port reads, are left out: the Port
// field gives SERVER_PORT, which Spring puts over server.port.
async function takeMcFromEnv() {
  const repo = mvnRepo;
  if (!repo) return;
  const [table, info] = await Promise.all([
    window.maven.envValues(repo).catch(() => null),
    mcEngine ? null : window.maven.containerInfo(repo).catch(() => null),
  ]);
  if (repo !== mvnRepo || $('#mvnContainerModal').classList.contains('hidden')) return;
  const engine = (mcEngine && mcEngine.name) || (info && info.engine && info.engine.name);
  const host = engine === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
  const ok = table && !table.error;
  const files = ok ? (table.files || []).filter((f) => f.env === 'local') : [];
  const read = files.filter((f) => !f.error).map((f) => f.file);
  const broken = files.find((f) => f.error);
  const port = mvnEnvKey('SERVER_PORT');
  const found = (ok && table.placeholders ? table.placeholders : []).filter((p) => mvnEnvKey(p.name) !== port && !p.keys.every((k) => k === 'server.port'));
  const rows = found.map((p) => ({ name: p.name, value: p.def ?? '', enabled: true }));
  const noDefault = found.filter((p) => p.def === null).map((p) => p.name);
  let over = 0;
  let more = 0;
  for (const v of mvnRunEnv.vars) {
    const on = v.enabled !== false;
    const row = rows.find((r) => mvnEnvKey(r.name) === mvnEnvKey(v.name));
    if (row && on) {
      row.value = v.value;
      over += 1;
    } else if (!row) {
      rows.push({ name: v.name, value: v.value, enabled: on });
      more += 1;
    }
  }
  const moved = [];
  for (const r of rows) {
    const value = mcReachHost(r.value, host);
    if (value !== r.value) {
      r.value = value;
      moved.push(r.name);
    }
  }
  mcRows = rows;
  const where = read.join(' and ') || 'application.yml';
  const fromEnv = [over && `${over} with Env's value`, more && `${more} more from Env`].filter(Boolean).join(', ');
  const parts = [
    broken ? `${broken.file} could not be read (${broken.error}).` : '',
    found.length
      ? `From ${where}: ${plural(found.length, 'variable')}${noDefault.length ? ` (${noDefault.length} with no default, give ${noDefault.length > 1 ? 'them' : 'it'} a value: ${noDefault.join(', ')})` : ''}${fromEnv ? `; ${fromEnv}` : ''}.`
      : `No \${NAME} in ${where}: taken from Env.`,
    moved.length ? `localhost is ${host} in ${moved.join(', ')}.` : '',
  ];
  drawMcRows(0, parts.filter(Boolean).join(' '));
}

// What the dialog says: the fields, and the variables as they are saved.
function mcSpec() {
  return {
    image: $('#mcImage').value.trim(),
    name: $('#mcName').value.trim(),
    port: $('#mcPort').value,
    debug: $('#mcDebug').checked,
    debugPort: $('#mcDebugPort').value,
    build: $('#mcBuild').checked,
    values: $('#mcValues').checked,
    proxy: { on: $('#mcProxy').checked, url: $('#mcProxyUrl').value.trim(), noProxy: $('#mcNoProxy').value.trim() },
    options: $('#mcOptions').value.trim(),
    vars: checkMvnEnvRows(mcRows).vars,
  };
}

function setMcProxyOn(on) {
  ['#mcProxyUrl', '#mcNoProxy'].forEach((sel) => ($(sel).disabled = !on));
}

// Under the proxy: where this PC's comes from, and what it reaches (the application, not the image's download).
function renderMcProxyHint() {
  const found = mcProxyFound;
  const where = !found ? 'Looking for this PC\'s proxy...' : `${found.url ? `This PC's: ${found.url.replace(/\/\/[^@/]*@/, '//***@')}, from ${found.from}.` : 'None in this PC\'s settings: type the company\'s, if it has one.'} For the application, not the image's download.`;
  $('#mcProxyHint').textContent = where;
  $('#mcProxyHint').title = 'The application in the container gets HTTP_PROXY, HTTPS_PROXY, NO_PROXY and, for Java, JAVA_TOOL_OPTIONS; this PC (host.docker.internal) never goes through it. Not the download of the image: that is Docker\'s or Podman\'s own setting.';
}

function previewMvnContainerLater() {
  clearTimeout(mcPreviewTimer);
  mcPreviewTimer = setTimeout(previewMvnContainer, 120);
}

// The command under the fields, as the output will show it; or what is wrong with them.
async function previewMvnContainer() {
  const modal = $('#mvnContainerModal');
  if (!mvnRepo || !modal || modal.classList.contains('hidden')) return;
  const withValues = $('#mcValues').checked && Boolean(mcValues.values);
  const r = await window.maven.containerPreview(mvnRepo, mcSpec(), mcEngine && mcEngine.name, withValues);
  const box = $('#mcCommand');
  box.classList.toggle('error', Boolean(r.error));
  box.textContent = r.error || `${$('#mcBuild').checked ? 'mvn package -DskipTests, then\n' : ''}${r.command}`;
}

// Copy: the command as it runs, the values of the variables in it, quoted for this PC's terminal.
async function copyMvnContainer() {
  if (!mvnRepo) return;
  const withValues = $('#mcValues').checked && mcValues.values ? mcValues : {};
  const r = await window.maven.containerCopy(mvnRepo, mcSpec(), mcEngine && mcEngine.name, withValues);
  const done = r.error ? r : await window.tools.copy(r.command);
  toast(done.error || 'Command copied, with the values of the variables', done.error ? 'error' : 'success');
}

async function openMvnContainer() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const modal = mvnContainerModal();
  const spec = mvnContainerSpec || {};
  $('#mcImage').value = spec.image || '';
  $('#mcName').value = spec.name || '';
  $('#mcPort').value = spec.port || 8080;
  $('#mcDebug').checked = Boolean(spec.debug);
  $('#mcDebugPort').value = spec.debugPort || 5005;
  $('#mcDebugPort').disabled = !spec.debug;
  $('#mcBuild').checked = spec.build !== false;
  // never started in a container: the variables of Env
  const vars = Array.isArray(spec.vars) ? spec.vars : mvnRunEnv.vars;
  mcRows = vars.map((v) => ({ name: v.name, value: v.value, enabled: v.enabled !== false }));
  mcEngine = null;
  mcValues = {};
  $('#mcEngine').textContent = 'Looking for Docker or Podman...';
  $('#mcEngine').classList.remove('error');
  $('#mcJar').textContent = '';
  ['#mcValuesKey', '#mcValuesLine'].forEach((sel) => $(sel).classList.add('hidden'));
  $('#mcValues').checked = spec.values !== false;
  const proxy = spec.proxy || {};
  $('#mcProxy').checked = Boolean(proxy.on);
  $('#mcProxyUrl').value = proxy.url || '';
  $('#mcNoProxy').value = proxy.noProxy || '';
  setMcProxyOn(Boolean(proxy.on));
  $('#mcOptions').value = spec.options || '';
  mcProxyFound = null;
  renderMcProxyHint();
  modal.classList.remove('hidden');
  drawMcRows();
  $('#mcStart').focus();
  const [info, values, found] = await Promise.all([window.maven.containerInfo(repo), mvnValuesRequest(), window.maven.containerProxy().catch(() => ({}))]);
  if (repo !== mvnRepo || modal.classList.contains('hidden')) return;
  // never chosen: this PC's proxy, ready to be switched on
  mcProxyFound = { url: (found && found.url) || '', from: (found && found.from) || '', noProxy: (found && found.noProxy) || '' };
  if (!$('#mcProxyUrl').value.trim() && !$('#mcProxy').checked) {
    $('#mcProxyUrl').value = mcProxyFound.url;
    if (!$('#mcNoProxy').value.trim()) $('#mcNoProxy').value = mcProxyFound.noProxy;
  }
  renderMcProxyHint();
  mcEngine = (info && info.engine) || { error: (info && info.error) || 'Docker or Podman did not answer' };
  $('#mcEngine').textContent = mcEngine.error || `Runs with ${mcEngine.label}.`;
  $('#mcEngine').classList.toggle('error', Boolean(mcEngine.error));
  // without Build first, the newest jar in target/ runs: which one, and how old
  $('#mcJar').textContent = info && info.jar ? `now: ${info.jar.name}, built ${info.jar.ago}` : 'no jar in target/ yet';
  mcValues = values || {};
  const hasValues = Boolean(mcValues.values);
  ['#mcValuesKey', '#mcValuesLine'].forEach((sel) => $(sel).classList.toggle('hidden', !hasValues));
  $('#mcValuesText').textContent = hasValues ? `With the values chosen in Values: ${mcValues.valuesNote}, as SPRING_APPLICATION_JSON` : '';
  previewMvnContainer();
}

function closeMvnContainer() {
  const modal = $('#mvnContainerModal');
  if (!modal || modal.classList.contains('hidden')) return;
  closeActionMenu();
  modal.classList.add('hidden');
  $('#mvnRunBtn').focus();
}

async function startMvnContainer() {
  if (!mvnRepo) return;
  const repo = mvnRepo;
  const errors = renderMcNote();
  if (errors.length) {
    focusKvRow($('#mcVars'), errors[0].at);
    return;
  }
  const spec = mcSpec();
  const withValues = spec.values && mcValues.values ? mcValues : {};
  $('#mcStart').disabled = true;
  const r = await window.maven.containerRun(repo, spec, withValues);
  $('#mcStart').disabled = false;
  if (repo !== mvnRepo) return;
  if (r.error) {
    const note = $('#mcNote');
    note.classList.add('error');
    note.textContent = r.error;
    return;
  }
  // as it was saved (the proxy's address written in full)
  mvnContainerSpec = r.spec || { ...spec, port: Number(spec.port), debugPort: Number(spec.debugPort) };
  closeMvnContainer();
  startedMvnRun(r);
  renderMvnPreview();
}
