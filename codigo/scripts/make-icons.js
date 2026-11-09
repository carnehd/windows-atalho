// Makes the app's icons from src/assets/icon.svg (40 px and up) and icon-small.svg (16 to 32 px): icon.png (256),
// tray.png (16), tray@2x.png (32) and tray.ico (every size the tray may ask for at any display scaling).
// Run from the codigo folder: npm run icons
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'src', 'assets');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const SMALL_UP_TO = 32;
const WINDOW = 256;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const source = (size) => fs.readFileSync(path.join(ASSETS, size <= SMALL_UP_TO ? 'icon-small.svg' : 'icon.svg'), 'utf8');

async function render(win, size) {
  const svg = source(size).replace('<svg ', `<svg width="${size}" height="${size}" `);
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // an offscreen window hands each frame over as it paints: ask for one, now that the page is in
  const frame = new Promise((resolve) => win.webContents.once('paint', (_event, _dirty, image) => resolve(image)));
  win.webContents.invalidate();
  const full = await frame;
  const scale = full.getSize().width / WINDOW; // 2 on a high-resolution screen, whatever the switch above says
  let img = full.crop({ x: 0, y: 0, width: Math.round(size * scale), height: Math.round(size * scale) });
  if (img.getSize().width !== size) img = img.resize({ width: size, height: size, quality: 'best' });
  const png = img.toPNG();
  if (!png.length) throw new Error(`the ${size} px image came out empty`);
  return png;
}

// An .ico whose images are PNG (read by Windows since Vista, and by Electron's nativeImage).
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: WINDOW, height: WINDOW, frame: false, transparent: true, webPreferences: { offscreen: true } });
  try {
    const images = [];
    for (const size of ICO_SIZES) images.push({ size, png: await render(win, size) });
    const png = (size) => images.find((i) => i.size === size).png;
    fs.writeFileSync(path.join(ASSETS, 'tray.ico'), ico(images));
    fs.writeFileSync(path.join(ASSETS, 'tray.png'), png(16));
    fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), png(32));
    fs.writeFileSync(path.join(ASSETS, 'icon.png'), png(256));
    console.log(`Icons written to ${ASSETS}: tray.ico (${ICO_SIZES.join(', ')} px), tray.png, tray@2x.png, icon.png`);
  } catch (e) {
    console.error(`The icons could not be made: ${e.message}`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
