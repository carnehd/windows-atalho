const fs = require('fs');
const crypto = require('crypto');
const { clipboard, ipcMain } = require('electron');

const POLL_MS = 700;
const MAX_ENTRIES = 500;
const MAX_CHARS = 20000;
const IGNORE_MS = 60000;
// Windows formats that password managers set to ask clipboard history tools not to record a copy.
const PRIVATE_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'];

function isPrivateCopy() {
  try {
    const formats = clipboard.availableFormats();
    return PRIVATE_FORMATS.some((f) => formats.includes(f) || clipboard.has(f));
  } catch {
    return false;
  }
}

function registerClipboardHistory({ file, getWindow }) {
  let data = { paused: false, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(parsed.entries)) data = { paused: Boolean(parsed.paused), entries: parsed.entries };
  } catch {
    // no history yet, or an unreadable file: start empty
  }

  const ignored = new Map();
  let last = clipboard.readText();
  let saveTimer = null;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    }, 300);
  };

  const notify = () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('clip-changed');
  };

  const add = (text) => {
    const existing = data.entries.findIndex((e) => e.text === text);
    const entry = existing === -1
      ? { id: crypto.randomUUID(), text, at: Date.now(), count: 1 }
      : { ...data.entries[existing], at: Date.now(), count: (data.entries[existing].count || 1) + 1 };
    if (existing !== -1) data.entries.splice(existing, 1);
    data.entries.unshift(entry);
    // Over the limit, drop the oldest unpinned copies; pinned ones are always kept.
    for (let i = data.entries.length - 1; data.entries.length > MAX_ENTRIES && i >= 0; i--) {
      if (!data.entries[i].pinned) data.entries.splice(i, 1);
    }
    save();
    notify();
  };

  setInterval(() => {
    let text;
    try {
      text = clipboard.readText();
    } catch {
      return;
    }
    if (!text || text === last) return;
    last = text;
    const now = Date.now();
    for (const [t, until] of ignored) if (until < now) ignored.delete(t);
    if (data.paused || ignored.has(text) || !text.trim() || text.length > MAX_CHARS || isPrivateCopy()) return;
    add(text);
  }, POLL_MS);

  ipcMain.handle('clip-list', () => data);

  // A copy from the list leaves the list as it is: the entry stays where it was, and the check above skips it
  // because it is the last text seen.
  ipcMain.handle('clip-copy', (_, id) => {
    const entry = data.entries.find((e) => e.id === id);
    if (!entry) return { error: 'Item not found' };
    last = entry.text;
    clipboard.writeText(entry.text);
    return { success: true };
  });

  ipcMain.handle('clip-update', (_, id, changes = {}) => {
    const entry = data.entries.find((e) => e.id === id);
    if (!entry) return { error: 'Item not found' };
    if (typeof changes.title === 'string') {
      const title = changes.title.trim().slice(0, 120);
      if (title) entry.title = title;
      else delete entry.title;
    }
    if (typeof changes.pinned === 'boolean') {
      if (changes.pinned) entry.pinned = Date.now();
      else delete entry.pinned;
    }
    save();
    return { success: true, entry };
  });

  ipcMain.handle('clip-delete', (_, id) => {
    data.entries = data.entries.filter((e) => e.id !== id);
    save();
    return { success: true };
  });

  ipcMain.handle('clip-clear', () => {
    data.entries = data.entries.filter((e) => e.pinned);
    save();
    return { success: true };
  });

  ipcMain.handle('clip-pause', (_, paused) => {
    data.paused = Boolean(paused);
    last = clipboard.readText();
    save();
    return { paused: data.paused };
  });

  return {
    ignore: (text) => ignored.set(String(text), Date.now() + IGNORE_MS),
  };
}

module.exports = { registerClipboardHistory };
