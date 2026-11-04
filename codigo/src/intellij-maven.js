// Maven as IntelliJ IDEA runs it for a project, for the Maven page (maven.js): the Maven it uses (the one it comes
// with, the wrapper's, or one chosen in its settings), the settings file, the local repository and Work offline. Read
// from the Maven settings IntelliJ keeps for the project (.idea/workspace.xml), else from its settings for new
// projects. So a microservice starts here with the same Maven, repositories and downloaded dependencies as there: on a
// network that only lets the company's repository through, the project's mvnw would otherwise try to download Maven.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { intellijHomes } = require('./ide-open');

const IS_WIN = process.platform === 'win32';
const MVN = IS_WIN ? 'mvn.cmd' : 'mvn';
const MAX_XML = 20 * 1024 * 1024;
// how many folders above the repository an IntelliJ project of several microservices is looked for
const PARENTS = 3;
const PRODUCT = /^(?:IntelliJIdea|IdeaIC)(\d{4})\.(\d+)$/;

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readText = (file) => {
  try {
    return fs.statSync(file).size > MAX_XML ? null : fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const inside = (base, p) => {
  const rel = path.relative(base, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e] ?? m;
  return String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
});

// IntelliJ's own folders of each version on this computer, the newest first: where its settings are (config: the
// settings for new projects, its path variables) and its caches (system: a .home file there says where it is installed).
function productDirs(base) {
  try {
    return fs.readdirSync(base).filter((n) => PRODUCT.test(n)).sort((a, b) => {
      const [, ya, ra] = PRODUCT.exec(a);
      const [, yb, rb] = PRODUCT.exec(b);
      return Number(yb) - Number(ya) || Number(rb) - Number(ra) || a.localeCompare(b);
    }).map((n) => path.join(base, n));
  } catch {
    return [];
  }
}
function jetbrainsDirs(home) {
  if (process.platform === 'darwin') return { config: path.join(home, 'Library/Application Support/JetBrains'), system: path.join(home, 'Library/Caches/JetBrains') };
  if (IS_WIN) {
    return {
      config: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'JetBrains'),
      system: path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'JetBrains'),
    };
  }
  return { config: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'JetBrains'), system: path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'JetBrains') };
}

// Where IntelliJ is installed, the newest first: the folder each version wrote in its .home file (installed anywhere),
// then the usual places.
function installedHomes(systemDirs) {
  const said = systemDirs.map((d) => (readText(path.join(d, '.home')) || '').trim()).filter(Boolean);
  return [...new Set([...said, ...intellijHomes()].map((d) => path.resolve(d)))];
}

// The options of IntelliJ's Maven settings in one of its files, { name: value }: {} when the file has the Maven
// component with nothing changed in it, null when it does not have it.
function generalSettingsIn(xml) {
  const component = /<component\s+name="MavenImportPreferences"[^>]*?(?:\/>|>([\s\S]*?)<\/component>)/.exec(xml || '');
  if (!component) return null;
  const block = /<MavenGeneralSettings\b[^>]*>([\s\S]*?)<\/MavenGeneralSettings>/.exec(component[1] || '');
  const out = {};
  if (block) for (const m of block[1].matchAll(/<option\s+name="(\w+)"\s+value="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

// The path variables the user set in IntelliJ (Settings > Path Variables), for the paths written with them.
function userMacros(configDir) {
  const out = {};
  const xml = configDir && readText(path.join(configDir, 'options', 'path.macros.xml'));
  for (const m of (xml || '').matchAll(/<macro\s+name="([^"]+)"\s+value="([^"]*)"/g)) out[unescapeXml(m[1])] = unescapeXml(m[2]);
  return out;
}

// A path as IntelliJ writes it, with its $VARIABLES$ ($PROJECT_DIR$, $USER_HOME$, ...) put back; null when one of them
// is not known.
function expand(value, macros, base) {
  const out = String(value).replace(/\$([A-Za-z_][\w.-]*)\$/g, (m, name) => (Object.prototype.hasOwnProperty.call(macros, name) ? macros[name] : m));
  if (/\$[A-Za-z_][\w.-]*\$/.test(out)) return null;
  return path.resolve(base, out);
}

// The folder of the IntelliJ project the microservice is in: one with a .idea in the folder Maven runs in or above it
// in the repository; else, up to PARENTS folders above the repository, a project of several microservices that has a
// pom.xml of this repository among its Maven projects. null when IntelliJ has none.
function findProject(root, dir, home) {
  const top = path.resolve(root);
  for (let d = path.resolve(dir); inside(top, d); d = path.dirname(d)) {
    if (isFile(path.join(d, '.idea', 'workspace.xml'))) return d;
    if (d === top || path.dirname(d) === d) break;
  }
  let p = top;
  for (let i = 0; i < PARENTS && path.dirname(p) !== p; i++) {
    p = path.dirname(p);
    if (!isFile(path.join(p, '.idea', 'workspace.xml'))) continue;
    const text = ['misc.xml', 'workspace.xml'].map((f) => readText(path.join(p, '.idea', f)) || '').join('\n');
    const macros = { PROJECT_DIR: p, USER_HOME: home };
    const poms = [...text.matchAll(/value="([^"]*pom\.xml)"/g)].map((m) => expand(unescapeXml(m[1]), macros, p));
    if (poms.some((f) => f && inside(top, f))) return p;
  }
  return null;
}

// Which Maven IntelliJ uses: 'wrapper', 'bundled' (the one it comes with, its default), 'bundled4', or 'custom' with
// the folder chosen. IntelliJ 2024 and later write mavenHomeTypeForPersistence (and customMavenHome); before, mavenHome
// held the folder or the name of the choice.
function homeType(s) {
  const t = s.mavenHomeTypeForPersistence;
  if (t === 'WRAPPER') return { kind: 'wrapper' };
  if (t === 'BUNDLED4') return { kind: 'bundled4' };
  if (t === 'CUSTOM' && s.customMavenHome) return { kind: 'custom', folder: s.customMavenHome };
  if (t) return { kind: 'bundled' };
  const old = s.mavenHome;
  if (!old || /^Bundled \(Maven 3\)$/i.test(old)) return { kind: 'bundled' };
  if (/^Bundled \(Maven 4\)$/i.test(old)) return { kind: 'bundled4' };
  if (/^Use Maven wrapper$/i.test(old)) return { kind: 'wrapper' };
  if (/^Bundled\b/i.test(old)) return { kind: 'bundled' };
  return { kind: 'custom', folder: old };
}

// The Maven the project's wrapper names (distributionUrl of .mvn/wrapper/maven-wrapper.properties), in the folder
// Maven runs in or above it in the repository.
function wrapperUrl(root, dir) {
  const top = path.resolve(root);
  for (let d = path.resolve(dir); inside(top, d); d = path.dirname(d)) {
    const text = readText(path.join(d, '.mvn', 'wrapper', 'maven-wrapper.properties'));
    const m = text && /^\s*distributionUrl\s*[=:]\s*(.+?)\s*$/m.exec(text);
    if (m) return m[1].replace(/\\(.)/g, '$1');
    if (d === top || path.dirname(d) === d) break;
  }
  return null;
}

// The Maven of a wrapper as IntelliJ downloads it (MavenWrapperSupport): ~/.m2/wrapper/dists/<zip name>/<md5 of the
// url in base 32>/<the folder of the zip>. Not where mvnw keeps its own, so mvnw would download it again.
function intellijWrapperMaven(url, home) {
  const zip = url.slice(url.lastIndexOf('/') + 1);
  const hash = BigInt(`0x${crypto.createHash('md5').update(url, 'utf8').digest('hex')}`).toString(32);
  const base = path.join(home, '.m2', 'wrapper', 'dists', zip.replace(/\.[^.]*$/, ''), hash);
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      const file = path.join(base, e.name, 'bin', MVN);
      if (e.isDirectory() && isFile(file)) return file;
    }
  } catch {
    // IntelliJ did not download it
  }
  return null;
}

// Maven as IntelliJ runs it for the folder Maven runs in (dir) of a repository (root), or null when IntelliJ has
// nothing for it: { file: the mvn to start, null for the app's own (fallback says which: the project's mvnw, else mvn);
// args: the flags of its settings (-s, -Dmaven.repo.local, -o); said: the line the output shows; notes: what could not
// be taken and why }. opts (for a test): home, jetbrains (its config and system folders), homes (where it is installed).
function intellijMaven(root, dir, fallback, opts = {}) {
  const home = opts.home || os.homedir();
  const jb = opts.jetbrains || jetbrainsDirs(home);
  const configs = productDirs(jb.config);
  const project = findProject(root, dir, home);
  let settings;
  let from;
  let base;
  if (project) {
    settings = generalSettingsIn(readText(path.join(project, '.idea', 'workspace.xml'))) || {};
    base = project;
    const rel = path.relative(path.resolve(root), project);
    from = !rel ? 'its .idea in the repository' : rel.startsWith('..') ? `the IntelliJ project in ${project}` : `its .idea in ${rel.split(path.sep).join('/')}/`;
  } else {
    const file = configs.map((c) => path.join(c, 'options', 'project.default.xml')).find(isFile);
    settings = file ? generalSettingsIn(readText(file)) : null;
    if (!settings || !Object.keys(settings).length) return null;
    base = path.resolve(root);
    from = 'its settings for new projects';
  }
  const macros = { ...userMacros(configs[0]), PROJECT_DIR: base, USER_HOME: home, MAVEN_REPOSITORY: path.join(home, '.m2', 'repository') };
  const parts = [];
  const notes = [];
  let file = null;
  const type = homeType(settings);
  if (type.kind === 'wrapper') {
    const url = wrapperUrl(root, dir);
    file = url ? intellijWrapperMaven(url, home) : null;
    const version = url && (/apache-maven-([\w.-]+?)-bin\.zip$/.exec(url) || [])[1];
    parts.push(file ? `the wrapper's Maven${version ? ` ${version}` : ''}, as IntelliJ downloaded it` : fallback);
  } else if (type.kind === 'custom') {
    const folder = expand(type.folder, macros, base);
    const mvn = folder && path.join(folder, 'bin', MVN);
    if (mvn && isFile(mvn)) {
      file = mvn;
      parts.push(`Maven in ${folder}`);
    } else notes.push(`the Maven chosen in IntelliJ (${type.folder}) is not on this computer: ${fallback} instead`);
  } else if (type.kind === 'bundled4') {
    notes.push(`IntelliJ's own Maven 4 is not used here: ${fallback} instead`);
  } else {
    const homes = opts.homes || installedHomes(productDirs(jb.system));
    const at = homes.find((h) => isFile(path.join(h, 'plugins', 'maven', 'lib', 'maven3', 'bin', MVN)));
    if (at) {
      file = path.join(at, 'plugins', 'maven', 'lib', 'maven3', 'bin', MVN);
      parts.push(`the Maven IntelliJ comes with (in ${at})`);
    } else notes.push(`the Maven IntelliJ comes with was not found on this computer: ${fallback} instead`);
  }
  const args = [];
  if (settings.userSettingsFile) {
    const f = expand(settings.userSettingsFile, macros, base);
    if (f && isFile(f)) {
      args.push('-s', f);
      parts.push(`settings ${f}`);
    } else notes.push(`the settings file IntelliJ has (${settings.userSettingsFile}) is not on this computer: left out`);
  }
  if (settings.localRepository) {
    const d = expand(settings.localRepository, macros, base);
    if (d && isDir(d)) {
      args.push(`-Dmaven.repo.local=${d}`);
      parts.push(`local repository ${d}`);
    } else notes.push(`the local repository IntelliJ has (${settings.localRepository}) is not on this computer: left out`);
  }
  if (settings.workOffline === 'true') {
    args.push('-o');
    parts.push('offline');
  }
  // applies: something IntelliJ has changes how Maven runs (else only the notes are said)
  return { file, args, from, applies: Boolean(file || args.length), said: `Maven as in IntelliJ (${from}): ${parts.join(', ')}`, notes };
}

module.exports = { intellijMaven, generalSettingsIn, homeType, findProject, wrapperUrl, intellijWrapperMaven, expand };
