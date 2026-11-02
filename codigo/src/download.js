// -- A file from the internet into a folder of this computer, and a zip unpacked: through the app's own network (the
// computer's proxy), checked, and nothing left half done. For the Bruno CLI and the updates of Git Quick. --
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { net } = require('electron');

const IS_WIN = process.platform === 'win32';
// Windows' own tar (Windows 10 and 11 have it; another tar on the PATH, Git's, cannot read a zip); macOS's reads one too.
const tarProgram = () => (IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

// A file or folder renamed; on Windows again for a few seconds while the antivirus still reads what was just written.
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// url into file, written as it comes; it stops when no data comes for a minute. what names the download in the errors.
// size and sha256, when known, must match. progress({ got, total }). The file is the caller's to remove when it fails.
async function downloadFile(url, file, { what, size = 0, sha256 = null, progress = () => {} }) {
  const stop = new AbortController();
  let idle = setTimeout(() => stop.abort(), 60000);
  let res;
  try {
    res = await net.fetch(url, { signal: stop.signal, cache: 'no-store' });
  } catch (e) {
    clearTimeout(idle);
    throw new Error(`Couldn't download ${what}: ${stop.signal.aborted ? 'no answer in a minute' : e.message}`);
  }
  if (!res.ok) {
    clearTimeout(idle);
    throw new Error(`Couldn't download ${what}: the server said ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || size;
  const hash = crypto.createHash('sha256');
  const out = await fs.promises.open(file, 'w');
  let got = 0;
  let shown = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle);
      idle = setTimeout(() => stop.abort(), 60000);
      hash.update(value);
      await out.write(value);
      got += value.length;
      if (Date.now() - shown > 150) {
        shown = Date.now();
        progress({ got, total });
      }
    }
  } catch (e) {
    throw new Error(`The download of ${what} stopped: ${stop.signal.aborted ? 'no data for a minute' : e.message}`);
  } finally {
    clearTimeout(idle);
    await out.close();
  }
  progress({ got, total });
  if (sha256 && hash.digest('hex') !== sha256.toLowerCase()) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} downloaded is not the file Git Quick expects (its checksum differs)`);
  if (size && got !== size) throw new Error(`The download of ${what} is not whole (${got} of ${size} bytes)`);
  return { got };
}

// The zip's files into folder (which must exist). what names it in the errors.
function unzip(zip, folder, what) {
  return new Promise((resolve, reject) => {
    execFile(tarProgram(), ['-xf', zip, '-C', folder], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if (!err) resolve();
      else if (err.code === 'ENOENT') reject(new Error(`Couldn't unpack ${what}: ${tarProgram()} is not on this computer.`));
      else reject(new Error(`Couldn't unpack ${what}: ${String(errOut || err.message).trim().split('\n')[0]}`));
    });
  });
}

module.exports = { downloadFile, unzip, rename, tarProgram };
