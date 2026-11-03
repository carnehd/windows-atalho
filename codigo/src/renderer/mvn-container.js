// -- Start in container: the jar Maven builds, run by Docker or Podman in a Java image, with nothing added to the
// microservice's folder. Run with it chosen opens a dialog with what the container needs (the image, its name, the
// port, debug, build first, the variables as Env has them, the values of the Values button), the command it runs under
// them; Start saves them for the repository and runs it, its output in the page (maven.js). --
let mvnContainerSpec = null; // what the dialog starts with (from the page's info): saved for the repository, or defaults
let mcRows = []; // the variables of the dialog, { name, value, enabled }: the table changes them in place
let mcEngine = null; // { name, label } of the engine that answers, or { error }
let mcValues = {}; // what Values would give the application: { values, valuesNote }, or {}
let mcPreviewTimer = 0;
// Java images often used, offered under the image field (a datalist's own popup takes Electron down on macOS)
const MC_IMAGES = ['eclipse-temurin:17-jre', 'eclipse-temurin:21-jre', 'eclipse-temurin:25-jre', 'amazoncorretto:17', 'amazoncorretto:21'];

// "eclipse-temurin:21-jre · :8080" next to the command list
function mvnContainerSummary(spec) {
  return spec ? `${spec.image} · :${spec.port}${spec.debug ? ` · debug :${spec.debugPort}` : ''}` : '';
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
      </div>
      <div class="me-vars-head mc-vars-head">
        <span class="settings-label">Environment variables</span>
        <span class="mv-gap"></span>
        <button id="mcFromEnv" class="btn btn-sm" type="button" title="The variables of Env, in place of these">From Env</button>
      </div>
      <div id="mcVars" class="me-vars mc-vars" role="group" aria-label="Environment variables of the container" aria-describedby="mcNote"></div>
      <p id="mcNote" class="me-note" aria-live="polite"></p>
      <p class="me-hint">Inside the container, localhost is the container itself: for a database or a service on this PC, use host.docker.internal (Podman: host.containers.internal).</p>
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
  $('#mcFromEnv').addEventListener('click', () => {
    mcRows = mvnRunEnv.vars.map((v) => ({ name: v.name, value: v.value, enabled: v.enabled !== false }));
    drawMcRows(0, 'Taken from Env.');
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
    vars: checkMvnEnvRows(mcRows).vars,
  };
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
  modal.classList.remove('hidden');
  drawMcRows();
  $('#mcStart').focus();
  const [info, values] = await Promise.all([window.maven.containerInfo(repo), mvnValuesRequest()]);
  if (repo !== mvnRepo || modal.classList.contains('hidden')) return;
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
  mvnContainerSpec = { ...spec, port: Number(spec.port), debugPort: Number(spec.debugPort) };
  closeMvnContainer();
  startedMvnRun(r);
  renderMvnPreview();
}
