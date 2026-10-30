// Clipboard history view. Relies on helpers from app.js and vault.js ($, toast, vEl, vIconBtn, copyable, noteEl).
let clipData = { paused: false, entries: [] };

function clipWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${time}`;
}

async function refreshClips() {
  try {
    clipData = await window.clips.list();
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  renderClips();
}

function renderClips() {
  const q = $('#clipSearch').value.trim().toLowerCase();
  const matches = clipData.entries.filter((e) => !q || e.text.toLowerCase().includes(q));
  const rows = [...matches.filter((e) => e.pinned).sort((a, b) => a.pinned - b.pinned), ...matches.filter((e) => !e.pinned)];
  const total = clipData.entries.length;
  $('#clipCount').textContent = q ? `${rows.length} of ${total}` : `${total} item${total !== 1 ? 's' : ''}`;
  $('#clipPauseBtn').textContent = clipData.paused ? 'Resume' : 'Pause';
  $('#clipPauseBtn').classList.toggle('btn-primary', clipData.paused);
  $('#clipPaused').classList.toggle('hidden', !clipData.paused);

  const body = $('#clipRows');
  body.textContent = '';
  const empty = $('#clipEmpty');
  empty.classList.toggle('hidden', rows.length > 0);
  empty.textContent = q ? 'No matches' : 'Nothing copied yet. Copy some text anywhere and it appears here.';

  rows.forEach((e, i) => {
    const tr = document.createElement('tr');
    if (e.pinned) tr.className = 'clip-pinned';
    if (e.pinned && !(rows[i + 1] && rows[i + 1].pinned)) tr.classList.add('clip-pinned-last');
    const formatCell = vEl('td', 'clip-format');
    formatCell.appendChild(vIconBtn('format', 'Format as JSON or XML', (ev) => openFormatMenu(ev.currentTarget, e)));
    const td = vEl('td');
    const textCell = vEl('div', 'clip-text-cell');
    td.appendChild(textCell);
    const oneLine = e.text.replace(/\s+/g, ' ').trim();
    const text = vEl('span', 'clip-text', oneLine);
    copyable(text, `Copied ${clipWhen(e.at)} - click to copy again:\n${e.text.slice(0, 500)}`, async () => {
      const r = await window.clips.copy(e.id);
      toast(r.error || 'Copied', r.error ? 'error' : 'success');
      return !r.error;
    });
    textCell.appendChild(text);
    if (e.count > 1) {
      const times = vEl('span', 'clip-times', `x${e.count}`);
      times.title = `Copied ${e.count} times`;
      textCell.appendChild(times);
    }
    const actions = vEl('td', 'clip-actions');
    const pin = vIconBtn('pin', e.pinned ? 'Unpin' : 'Pin to the top', async () => {
      await window.clips.update(e.id, { pinned: !e.pinned });
      await refreshClips();
    }, e.pinned ? 'pinned' : '');
    actions.append(
      pin,
      vIconBtn('trash', 'Remove from history', async () => {
        await window.clips.remove(e.id);
        await refreshClips();
      }, 'danger')
    );
    tr.append(formatCell, td, actions);
    body.appendChild(tr);
  });
}

// -- Format JSON / XML --
function formatJson(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}

function escapeXml(s, attr) {
  const out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return attr ? out.replace(/"/g, '&quot;') : out;
}

function formatXml(text) {
  const source = text.trim();
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error('Not valid XML');
  const declaration = (source.match(/^<\?xml[^>]*\?>/) || [''])[0];
  const lines = declaration ? [declaration] : [];

  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    if (node.nodeType === Node.COMMENT_NODE) {
      lines.push(`${pad}<!--${node.nodeValue}-->`);
    } else if (node.nodeType === Node.CDATA_SECTION_NODE) {
      lines.push(`${pad}<![CDATA[${node.nodeValue}]]>`);
    } else if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      lines.push(`${pad}<?${node.target} ${node.data}?>`);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue.trim();
      if (t) lines.push(pad + escapeXml(t));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const attrs = [...node.attributes].map((a) => ` ${a.name}="${escapeXml(a.value, true)}"`).join('');
      const children = [...node.childNodes].filter((c) => c.nodeType !== Node.TEXT_NODE || c.nodeValue.trim());
      if (children.length === 0) {
        lines.push(`${pad}<${node.nodeName}${attrs}/>`);
      } else if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) {
        lines.push(`${pad}<${node.nodeName}${attrs}>${escapeXml(children[0].nodeValue.trim())}</${node.nodeName}>`);
      } else {
        lines.push(`${pad}<${node.nodeName}${attrs}>`);
        children.forEach((c) => walk(c, depth + 1));
        lines.push(`${pad}</${node.nodeName}>`);
      }
    }
  };
  [...doc.childNodes].forEach((n) => walk(n, 0));
  return lines.join('\n');
}

const FORMATTERS = [
  { id: 'json', label: 'Format as JSON', run: formatJson },
  { id: 'xml', label: 'Format as XML', run: formatXml },
];

function closeFormatMenu() {
  const menu = $('#clipFormatMenu');
  if (menu) menu.remove();
}

function openFormatMenu(anchor, entry) {
  closeFormatMenu();
  const menu = vEl('div', 'clip-menu');
  menu.id = 'clipFormatMenu';
  FORMATTERS.forEach((f) => {
    let result = null;
    try {
      result = f.run(entry.text);
    } catch {
      result = null;
    }
    const item = vEl('button', 'clip-menu-item', f.label);
    item.type = 'button';
    if (result === null) {
      item.disabled = true;
      item.title = `The text is not valid ${f.id.toUpperCase()}`;
    }
    item.addEventListener('click', () => {
      closeFormatMenu();
      showFormatted(f.id.toUpperCase(), result);
    });
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

function showFormatted(kind, text) {
  $('#clipFormatTitle').textContent = `Formatted ${kind}`;
  $('#clipFormatted').textContent = text;
  $('#clipFormatModal').classList.remove('hidden');
  $('#clipFormatCopy').focus();
}

function closeFormatted() {
  $('#clipFormatModal').classList.add('hidden');
}

function setupClips() {
  if (CARD_ID) return;
  $('#clipSearch').addEventListener('input', renderClips);
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#clipFormatMenu, .clip-format')) closeFormatMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFormatMenu();
      closeFormatted();
    }
  });
  $('#clipFormatClose').addEventListener('click', closeFormatted);
  $('#clipFormatCopy').addEventListener('click', async () => {
    if (await copyText($('#clipFormatted').textContent, 'Formatted text')) closeFormatted();
  });
  $('#clipPauseBtn').addEventListener('click', async () => {
    const r = await window.clips.pause(!clipData.paused);
    clipData.paused = r.paused;
    renderClips();
  });
  $('#clipClearBtn').addEventListener('click', async () => {
    if (!(await window.git.confirm('Delete the clipboard history? Pinned items are kept.'))) return;
    await window.clips.clear();
    await refreshClips();
  });
  window.clips.onChanged(() => {
    if (currentMode === 'clip') refreshClips();
  });
}

setupClips();
