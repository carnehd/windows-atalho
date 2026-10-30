const fs = require('fs');
const path = require('path');

const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_DIRS = 20000;
const SCAN_SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information', '.git']);

async function findRepos(root) {
  const repos = [];
  let visited = 0;

  async function walk(dir, depth) {
    if (visited++ > SCAN_MAX_DIRS) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      repos.push(dir);
      return;
    }
    if (depth >= SCAN_MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SCAN_SKIP.has(e.name)) {
        await walk(path.join(dir, e.name), depth + 1);
      }
    }
  }

  await walk(root, 0);
  return { repos, truncated: visited > SCAN_MAX_DIRS };
}

module.exports = { findRepos };
