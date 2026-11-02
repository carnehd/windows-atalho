function setupBruno() {
  window.bruno.onResult(onBrunoResult);
  window.bruno.onOutput(onBrunoOutput);
  window.bruno.onDone(onBrunoDone);
  window.bruno.onCliProgress((p) => {
    if (!bru.cliInstall) return;
    Object.assign(bru.cliInstall, p);
    renderBrunoInstallProgress();
  });
  $('#bruSendBtn').addEventListener('click', bruSend);
  $('#bruEnv').addEventListener('change', (e) => {
    bru.env = e.target.value;
    bruSave(BRU_ENV_KEY, bru.dir, bru.env);
    renderBruno();
  });
  $('#bruCollection').addEventListener('change', (e) => {
    bruSave(BRU_DIR_KEY, bru.repo, e.target.value);
    openBrunoCollection(e.target.value);
  });
  $('#bruTree').addEventListener('keydown', onBrunoTreeKey);
  $('#bruVarsBtn').addEventListener('click', openBrunoVars);
  $('#bruEnvBtn').addEventListener('click', openBrunoEnvs);
  setupBrunoEditor();
  setupBrunoSplits();
  setupBrunoTabRows();
  setupBrunoPick();
  setupBrunoVarPick();
  setupBrunoSidebar();
  document.addEventListener('mousedown', (e) => {
    if (!$('#bruVarsPop').classList.contains('hidden') && !e.target.closest('#bruVarsPop, #bruVarsBtn')) closeBrunoVars();
  });
  document.addEventListener('keydown', (e) => {
    if (currentMode !== 'git' || effectiveGitView() !== 'bruno') return;
    if (e.key === 'Escape' && !$('#bruVarsPop').classList.contains('hidden')) {
      closeBrunoVars();
      $('#bruVarsBtn').focus();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
      e.preventDefault();
      bruSend();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.defaultPrevented && $('#bruEnvModal')?.classList.contains('hidden') !== false) {
      e.preventDefault();
      bruSaveRequest();
    }
  });
}

setupBruno();
