// -- What Start and Debug give the application, like an IntelliJ run configuration: environment variables, each switched
// on or off (Spring's profiles are one of them, SPRING_PROFILES_ACTIVE). Saved per repository; a build or the tests
// never get them (maven.js). Also read from the run configurations IntelliJ keeps in the repository (.idea/workspace.xml,
// .run/). --
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const LIMITS = { vars: 200, name: 200, value: 8000, profiles: 300 };
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PROFILE = /^[A-Za-z0-9_.-]+$/;
const PROFILES_VAR = 'SPRING_PROFILES_ACTIVE';

const EMPTY = { vars: [] };
// The variables the application gets: those switched on.
const givenVars = (r) => (r && Array.isArray(r.vars) ? r.vars.filter((v) => v.enabled !== false) : []);
const hasRunEnv = (r) => givenVars(r).length > 0;

// "sit, local" or "sit local" as Spring takes it: sit,local.
function cleanProfiles(text) {
  const list = String(text || '').split(/[\s,]+/).filter(Boolean);
  const bad = list.find((p) => !PROFILE.test(p));
  if (bad) throw new Error(`"${bad.slice(0, 40)}" is not a profile name: letters, digits, . _ and - only`);
  const out = [...new Set(list)].join(',');
  if (out.length > LIMITS.profiles) throw new Error('Too many profiles');
  return out;
}

// What may be saved and given to the application: names an environment variable can have, text values, no name twice
// among those switched on (one switched off stays, with enabled: false). The profiles an older version kept in a field
// of their own become the SPRING_PROFILES_ACTIVE variable.
function cleanRunEnv(input = {}) {
  const list = Array.isArray(input.vars) ? [...input.vars] : [];
  const profiles = cleanProfiles(input.profiles);
  if (profiles && !list.some((v) => v && v.name === PROFILES_VAR && v.enabled !== false)) list.unshift({ name: PROFILES_VAR, value: profiles });
  if (list.length > LIMITS.vars) throw new Error(`At most ${LIMITS.vars} variables`);
  const vars = [];
  const seen = new Set();
  for (const v of list) {
    const name = String((v && v.name) || '').trim();
    const value = String((v && v.value) ?? '');
    const on = !(v && v.enabled === false);
    if (!NAME.test(name) || name.length > LIMITS.name) throw new Error(`"${name.slice(0, 40)}" is not a variable name: a letter or _ first, then letters, digits, _ . -`);
    if (value.length > LIMITS.value) throw new Error(`The value of ${name} is too long`);
    if (/[\0\r\n]/.test(value)) throw new Error(`The value of ${name} has a line break`);
    const id = IS_WIN ? name.toUpperCase() : name;
    if (on && seen.has(id)) throw new Error(`${name} is switched on twice: switch one off`);
    if (on) seen.add(id);
    vars.push(on ? { name, value } : { name, value, enabled: false });
  }
  return { vars };
}

// The environment of a run that starts the application: the variables switched on, over the user's own.
// Windows names do not care about case: the user's PATH replaces Path, not sits beside it.
function withRunEnv(env, runEnv) {
  if (!hasRunEnv(runEnv)) return env;
  const out = { ...(env || process.env) };
  const put = (name, value) => {
    if (IS_WIN) for (const k of Object.keys(out)) if (k.toUpperCase() === name.toUpperCase()) delete out[k];
    out[name] = value;
  };
  for (const { name, value } of givenVars(runEnv)) put(name, value);
  return out;
}

// Under the command in the output: the profiles, and the names of the other variables (never their values).
function runEnvLines(runEnv) {
  const vars = givenVars(runEnv);
  if (!vars.length) return '';
  const profiles = vars.find((v) => v.name === PROFILES_VAR);
  const names = vars.filter((v) => v !== profiles).map((v) => v.name);
  return `${profiles ? `  ${PROFILES_VAR}: ${profiles.value}\n` : ''}${names.length ? `  env: ${names.join(', ').slice(0, 400)}\n` : ''}`;
}

// -- IntelliJ's run configurations: Spring Boot, Application and the others that carry variables or profiles --
const unescapeXml = (s) =>
  String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
const attrsOf = (text) => Object.fromEntries([...String(text).matchAll(/([\w.:-]+)="([^"]*)"/g)].map((m) => [m[1], unescapeXml(m[2])]));
const optionOf = (body, name) => {
  const m = new RegExp(`<option\\s+name="${name}"\\s+value="([^"]*)"`).exec(body);
  return m ? unescapeXml(m[1]) : '';
};
const KINDS = { SpringBootApplicationConfigurationType: 'Spring Boot', Application: 'Application', MavenRunConfiguration: 'Maven', JUnit: 'JUnit' };

function configsIn(xml, file) {
  const out = [];
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of clean.matchAll(/<configuration\b([^>]*?)(?:\/>|>([\s\S]*?)<\/configuration>)/g)) {
    const a = attrsOf(m[1]);
    const body = m[2] || '';
    // templates (default="true") are not configurations of the project
    if (!a.name || a.default === 'true') continue;
    const vars = [...body.matchAll(/<env\s([^>]*?)\/?>/g)].map((e) => attrsOf(e[1])).filter((e) => e.name).map((e) => ({ name: e.name, value: e.value || '' }));
    let profiles = optionOf(body, 'ACTIVE_PROFILES');
    if (!profiles) {
      const vm = /-Dspring\.profiles\.active=("([^"]*)"|(\S+))/.exec(optionOf(body, 'VM_PARAMETERS'));
      if (vm) profiles = vm[2] ?? vm[3];
    }
    // IntelliJ's Active profiles field (or the system property) wins over the variable, and becomes it
    const allVars = profiles ? [{ name: PROFILES_VAR, value: profiles }, ...vars.filter((v) => v.name !== PROFILES_VAR)] : vars;
    if (!allVars.length) continue;
    const module = /<module\s+name="([^"]*)"/.exec(body);
    out.push({ name: a.name, kind: KINDS[a.type] || a.factoryName || a.type || '', module: module ? unescapeXml(module[1]) : '', vars: allVars, file });
  }
  return out;
}

// A configuration as this app can take it: a variable it cannot give (a value on several lines, a name no shell
// takes, the same name again) left out and named in skipped.
function takeable(c) {
  const vars = [];
  const skipped = [];
  for (const v of c.vars) {
    try {
      vars.push(cleanRunEnv({ vars: [...vars, v] }).vars.pop());
    } catch {
      skipped.push(v.name);
    }
  }
  return { ...c, vars: vars.slice(0, LIMITS.vars), skipped };
}

// The configurations of the repository's IntelliJ project, and of the folder Maven runs in when it has its own:
// .idea/workspace.xml (those not shared) and .run/*.run.xml (those stored as project files).
function readIntellijConfigs(root, dir) {
  const found = [];
  const places = [...new Set([root, dir].filter(Boolean).map((d) => path.resolve(d)))];
  for (const place of places) {
    const files = [path.join(place, '.idea', 'workspace.xml')];
    try {
      for (const f of fs.readdirSync(path.join(place, '.run'))) if (f.endsWith('.run.xml')) files.push(path.join(place, '.run', f));
    } catch {
      // no shared run configurations
    }
    for (const file of files) {
      let xml;
      try {
        if (fs.statSync(file).size > 20 * 1024 * 1024) continue;
        xml = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(root, file).split(path.sep).join('/');
      for (const c of configsIn(xml, rel)) found.push(takeable(c));
    }
  }
  return found.slice(0, 50);
}

module.exports = { EMPTY, LIMITS, cleanRunEnv, cleanProfiles, withRunEnv, runEnvLines, hasRunEnv, readIntellijConfigs, configsIn };
