// consola-agente > Agente: the agents (definitions in Markdown, with a name and a description at the top) that a person keeps in a
// folder, for a session to start as one of them. The person chooses the folder; this lists what is in it (scanAgents) and, when a
// session starts as one of them, makes a small folder of its own under the temporary one (makeOverlay) with the agent in the layout
// each CLI reads (.claude/agents for Claude CLI, .github/agents for Copilot CLI) and the skills the agent names, written into its
// text so they are there whatever the CLI does with `skills:`. The CLI takes it with --add-dir and --agent. The files of the
// person are only read, never changed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILES = 300;
const MAX_CHILDREN = 80;
const MAX_TEXT = 256 * 1024;
const OVERLAY_PREFIX = 'gitquick-agent-';
// where agents are kept: the folder itself, and the usual places under it (and under each of its folders: a folder of packs)
const PLACES = ['agents', '.claude/agents', '.github/agents', 'claude/agents', 'copilot/agents'];
const NOT_AGENTS = /^(skill|readme|changelog|contributing|license|agents|claude|copilot-instructions)\.md$/i;
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'out']);

// The top of a Markdown file between --- lines: `key: value`, lists of "- item" or [a, b]. raw is the text of the top as it is.
function parseFrontmatter(text) {
  const t = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(t);
  if (!m) return null;
  const head = {};
  let key = null;
  const bare = (v) => v.trim().replace(/^["']|["']$/g, '');
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) head[key] = v.slice(1, -1).split(',').map(bare).filter(Boolean);
      else head[key] = v === '' ? [] : bare(v);
    } else if (key && item) {
      if (!Array.isArray(head[key])) head[key] = [];
      head[key].push(bare(item[1]));
    }
  }
  return { head, raw: m[1], body: m[2] || '' };
}

const listOf = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Which CLI an agent is for, from where it is: Copilot's (.github, copilot, *.agent.md), Claude's (.claude, claude), or either.
function kindOf(rel, name) {
  const parts = rel.toLowerCase().split('/');
  if (/\.agent\.md$/i.test(name) || parts.includes('copilot') || parts.includes('.github')) return 'copilot';
  if (parts.includes('claude') || parts.includes('.claude')) return 'claude';
  return 'both';
}

// The agents under a folder: { agents: [{ id, name, description, cli, file, skills }], truncated }. id is the path from the folder.
function scanAgents(dir) {
  const root = path.resolve(String(dir || ''));
  const agents = [];
  const seen = new Set();
  let files = 0;
  let truncated = false;
  const lookIn = (sub) => {
    const folder = path.join(root, sub);
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !/\.md$/i.test(e.name) || NOT_AGENTS.test(e.name)) continue;
      if (++files > MAX_FILES) {
        truncated = true;
        return;
      }
      const file = path.join(folder, e.name);
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (seen.has(rel)) continue;
      let text;
      try {
        if (fs.statSync(file).size > MAX_TEXT) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      if (!fm || typeof fm.head.name !== 'string' || !AGENT_NAME.test(fm.head.name)) continue;
      if (typeof fm.head.description !== 'string' || !fm.head.description) continue;
      seen.add(rel);
      agents.push({ id: rel, name: fm.head.name, description: oneLine(fm.head.description, 400), cli: kindOf(rel, e.name), file, skills: listOf(fm.head.skills).filter((s) => AGENT_NAME.test(s)) });
    }
  };
  lookIn('');
  for (const sub of PLACES) lookIn(sub);
  let children = [];
  try {
    children = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && !PLACES.some((p) => p.split('/')[0] === e.name)).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // not a folder any more
  }
  if (children.length > MAX_CHILDREN) truncated = true;
  for (const c of children.slice(0, MAX_CHILDREN)) for (const sub of PLACES) lookIn(path.join(c.name, sub));
  agents.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { agents, truncated };
}

// Whether an agent can be used with a CLI: its own, or one for either.
const fitsCli = (agent, cli) => agent.cli === 'both' || agent.cli === cli;

// Where the skill an agent names is: next to the folder of the agent (pack/claude/agents -> pack/claude/skills), else the usual places.
function skillFolder(agent, root, name) {
  const beside = path.join(path.dirname(path.dirname(agent.file)), 'skills', name);
  for (const c of [beside, path.join(root, 'skills', name), path.join(root, '.claude/skills', name), path.join(root, '.github/skills', name)]) {
    try {
      if (fs.statSync(path.join(c, 'SKILL.md')).isFile()) return c;
    } catch {
      // not there
    }
  }
  return null;
}

// The folder a session starts with: the agent (with its skills inside its text) as the CLI reads it, and the skills beside it.
// Returns { dir, name, args, warnings }. The caller removes dir (removeOverlay) when the session is over.
function makeOverlay(agent, cli, root) {
  const parsed = parseFrontmatter(fs.readFileSync(agent.file, 'utf8'));
  if (!parsed) throw new Error('O ficheiro do agente já não tem o cabeçalho com o nome');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), OVERLAY_PREFIX));
  const base = cli === 'copilot' ? '.github' : '.claude';
  const warnings = [];
  let inlined = '';
  for (const name of agent.skills) {
    const from = skillFolder(agent, path.resolve(root), name);
    if (!from) {
      warnings.push(`A skill ${name} não está na pasta`);
      continue;
    }
    const to = path.join(dir, base, 'skills', name);
    fs.cpSync(from, to, { recursive: true, filter: (src) => { try { return !fs.lstatSync(src).isSymbolicLink(); } catch { return false; } } });
    const skill = parseFrontmatter(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8'));
    inlined += `\n### Skill: ${name}\n\nOs ficheiros que esta skill refere (como \`referencia/...\`) estão na pasta \`${to}\`.\n\n${(skill ? skill.body : fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8')).trim()}\n`;
  }
  // an agent of either CLI keeps its own top for Claude; for Copilot only its name and description (its other fields are Claude's)
  const head = cli === 'copilot' && agent.cli === 'both' ? `name: ${agent.name}\ndescription: ${agent.description}` : parsed.raw;
  const body = `${parsed.body.replace(/\s+$/, '')}\n${inlined ? `\n---\n\n## Skills (já carregadas pela consola)\n\nSão as skills que este agente diz seguir: estão aqui, não as procures noutro sítio.\n${inlined}` : ''}`;
  const file = path.join(dir, base, 'agents', cli === 'copilot' ? `${agent.name}.agent.md` : `${agent.name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${head}\n---\n\n${body}`);
  return { dir, name: agent.name, args: ['--add-dir', dir, '--agent', agent.name], warnings };
}

// Only a folder that makeOverlay made, in the temporary folder.
function removeOverlay(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!path.basename(resolved).startsWith(OVERLAY_PREFIX) || path.dirname(resolved) !== path.resolve(os.tmpdir())) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // left for the system to clean
  }
}

module.exports = { parseFrontmatter, scanAgents, fitsCli, makeOverlay, removeOverlay, kindOf, AGENT_NAME, OVERLAY_PREFIX };
