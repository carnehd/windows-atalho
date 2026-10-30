const { BrowserWindow, screen, ipcMain } = require('electron');

const CARD_PAD = 14;
const MIN_WIDTH = 300;
const MAX_WIDTH = 620;
const MIN_HEIGHT = 30;
const SHOW_FALLBACK_MS = 3000;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function registerCardWindows({ preload, page }) {
  const cardWindows = new Map();
  const isCardWindow = (win) => Boolean(win) && [...cardWindows.values()].includes(win);

  ipcMain.handle('vault-popout', (event, opts = {}) => {
    const id = String(opts.id || '');
    if (!id) return { error: 'Missing item' };

    const existing = cardWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return { success: true };
    }

    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) return { error: 'Window not found' };

    const content = parent.getContentBounds();
    const width = clamp(Math.round(Number(opts.width)) || 400, MIN_WIDTH, MAX_WIDTH) + CARD_PAD;
    const height = clamp(Math.round(Number(opts.height)) || 120, MIN_HEIGHT, 600) + CARD_PAD;
    const offset = cardWindows.size * 26;
    const area = screen.getDisplayMatching(parent.getBounds()).workArea;
    const x = clamp(content.x + (Number(opts.x) || 0) - CARD_PAD / 2 + offset, area.x, area.x + area.width - width);
    const y = clamp(content.y + (Number(opts.y) || 0) - CARD_PAD / 2 + offset, area.y, area.y + area.height - height);

    const win = new BrowserWindow({
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
      useContentSize: true,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
    });
    cardWindows.set(id, win);
    win.on('closed', () => cardWindows.delete(id));
    win.loadFile(page, { query: { card: id } });
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, SHOW_FALLBACK_MS);
    return { success: true };
  });

  ipcMain.handle('card-fit', (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!isCardWindow(win)) return false;
    const [width] = win.getContentSize();
    win.setContentSize(width, clamp(Math.ceil(Number(height)) || 100, MIN_HEIGHT + CARD_PAD, 700));
    if (!win.isVisible()) win.show();
    return true;
  });

  // Follows the real cursor while the button is held, so it does not depend on how many move events the page gets.
  const drags = new Map();
  const stopDrag = (win) => {
    const d = drags.get(win);
    if (d) clearInterval(d.timer);
    drags.delete(win);
  };

  ipcMain.on('card-drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!isCardWindow(win)) return;
    stopDrag(win);
    const start = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const timer = setInterval(() => {
      if (win.isDestroyed()) return stopDrag(win);
      const p = screen.getCursorScreenPoint();
      // setBounds keeps the size fixed: setPosition alone can grow the window on scaled displays.
      win.setBounds({ ...bounds, x: bounds.x + p.x - start.x, y: bounds.y + p.y - start.y });
    }, 16);
    drags.set(win, { timer });
    win.once('closed', () => clearInterval(timer));
  });

  ipcMain.on('card-drag-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isCardWindow(win)) stopDrag(win);
  });

  ipcMain.handle('card-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isCardWindow(win)) win.close();
  });

  return { cardWindows };
}

module.exports = { registerCardWindows };
