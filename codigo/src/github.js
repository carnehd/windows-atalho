// Pull requests (a tab of the Git page): the pull requests of the repository on screen, asked to GitHub with a token
// made there. Which GitHub is read from origin: github.com, or a GitHub Enterprise server (the host of origin, its
// API under /api/v3). The token is kept encrypted by the system (safeStorage: Windows DPAPI, the macOS Keychain) in
// data/github.json, one per host, and never goes to the page: it only knows there is one. It is sent to that host
// alone. Without a token GitHub is asked all the same: it answers for a public repository. What a pull request
// changed is not asked to GitHub: its commits are fetched from origin and compared here (git-service). The comments
// of a pull request are read from GitHub, the ones of its conversation and the ones on lines of its files, and one
// of either kind can be added.
const fs = require('fs');
const path = require('path');
const { app, ipcMain, safeStorage, shell } = require('electron');
const { stepBack, loginShellEnv } = require('./shell');
const { findAgent, agentEnv } = require('./agent-review');
const { listByClaude } = require('./github-mcp');

const TIMEOUT_MS = 20000;
const PER_PAGE = 50;
const STATES = ['open', 'closed', 'all'];
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(:\d{1,5})?$/;
const TOKEN = /^[\x21-\x7e]{1,400}$/;
const COMMENT_MAX = 65000; // GitHub takes 65536 characters
const PUBLIC_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

// a test answers as GitHub from this computer (never in the exe)
const dev = (name) => (app && !app.isPackaged ? process.env[name] || '' : '');

// origin as GitHub names it: { site, api, owner, repo }, or null when it is not host/owner/repo.
// https://host/owner/repo(.git), git@host:owner/repo(.git), ssh://git@host(:port)/owner/repo(.git)
function remoteOf(url) {
  const text = String(url || '').trim();
  let host = '';
  let rest = '';
  let scheme = 'https';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    const web = u.protocol === 'http:' || u.protocol === 'https:';
    if (!web && !/^(ssh|git|git\+ssh):$/.test(u.protocol)) return null;
    // the port of ssh is not the port of the API
    host = web ? u.host : u.hostname;
    if (u.protocol === 'http:') scheme = 'http';
    rest = u.pathname;
  } else {
    const m = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(.+)$/.exec(text);
    if (!m) return null;
    [, host, rest] = m;
  }
  host = host.toLowerCase();
  const parts = rest.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (!HOST.test(host) || parts.length !== 2 || !parts.every((p) => NAME.test(p))) return null;
  const [owner, repo] = parts;
  if (PUBLIC_HOSTS.has(host)) return { site: 'github.com', web: 'https://github.com', api: dev('GQ_GITHUB_API') || 'https://api.github.com', publicApi: true, owner, repo };
  return { site: host, web: `${scheme}://${host}`, api: dev('GQ_GITHUB_API') || `${scheme}://${host}/api/v3`, publicApi: false, owner, repo };
}

// The tokens, one per GitHub host, encrypted: { tokens: { "github.com": "<base64>" } }.
class GithubTokens {
  constructor(file, safe) {
    this.file = file;
    this.safe = safe;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
    } catch {
      return {};
    }
  }

  write(tokens) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ tokens }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  // Empty when there is none, or when it cannot be read here (the data folder came from another computer).
  get(site) {
    const kept = this.read()[site];
    if (typeof kept !== 'string' || !kept) return '';
    try {
      return this.safe.decryptString(Buffer.from(kept, 'base64'));
    } catch {
      return '';
    }
  }

  set(site, token) {
    if (!this.safe || !this.safe.isEncryptionAvailable()) throw new Error('This computer cannot keep a token safely, so it is not saved');
    this.write({ ...this.read(), [site]: this.safe.encryptString(token).toString('base64') });
  }

  clear(site) {
    const tokens = this.read();
    delete tokens[site];
    this.write(tokens);
  }
}

// What the list shows of a pull request.
function pullOf(p) {
  const head = p.head || {};
  const base = p.base || {};
  const fork = !head.repo || !base.repo || head.repo.full_name !== base.repo.full_name;
  // the MCP server gives no label: made from whose fork it is
  const forkOwner = head.repo && head.repo.full_name ? String(head.repo.full_name).split('/')[0] : '';
  const forkLabel = head.label || (forkOwner && head.ref ? `${forkOwner}:${head.ref}` : '');
  return {
    number: Number(p.number),
    title: String(p.title || ''),
    state: p.merged_at || p.merged ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
    author: p.user && p.user.login ? String(p.user.login) : '',
    // from a fork: "owner:branch", as GitHub writes it
    head: { ref: String(head.ref || ''), sha: String(head.sha || ''), label: String((fork && forkLabel) || head.ref || '') },
    base: { ref: String(base.ref || ''), sha: String(base.sha || '') },
    created: p.created_at || null,
    updated: p.updated_at || null,
    closed: p.merged_at || p.closed_at || null,
    labels: (Array.isArray(p.labels) ? p.labels : []).map((l) => String((typeof l === 'string' ? l : l && l.name) || '')).filter(Boolean).slice(0, 6),
  };
}

// What the page shows of a comment.
function commentOf(c) {
  return { id: Number(c.id), author: c.user && c.user.login ? String(c.user.login) : '', body: String(c.body || ''), created: c.created_at || null, edited: Boolean(c.updated_at && c.created_at && c.updated_at !== c.created_at) };
}

// A comment on a line of a file: where it is (the line of the new file, or of the old one for side LEFT). line is
// null when that line is not in the diff any more (the code changed after it): originalLine is where it was.
function lineCommentOf(c) {
  const int = (v) => (Number.isInteger(v) ? v : null);
  return { ...commentOf(c), path: String(c.path || ''), line: int(c.line), side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT', startLine: int(c.start_line), originalLine: int(c.original_line), replyTo: int(c.in_reply_to_id) };
}

// Why GitHub did not answer as asked, in words, with what to do about it. code: 'no-token' and 'token' ask for one.
function problem(res, body, remote, hasToken) {
  const name = `${remote.owner}/${remote.repo}`;
  const said = body && typeof body.message === 'string' ? body.message.trim().slice(0, 300) : '';
  const fail = (code, error) => ({ code, error });
  if (res.status === 401) {
    return hasToken
      ? fail('token', `GitHub does not accept the token kept for ${remote.site}: it expired, was revoked or was not copied whole. Set a new one.`)
      : fail('no-token', `${remote.site} asks for a token to show the pull requests of ${name}.`);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const at = reset ? ` It counts again at ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
    return fail('limit', `GitHub's limit of requests was reached${hasToken ? '' : ' (60 an hour without a token)'}.${at}`);
  }
  if (res.status === 403 && res.headers.get('x-github-sso')) {
    return fail('sso', `The organization of ${name} asks for single sign-on. On GitHub, in Settings > Developer settings > Personal access tokens, press Configure SSO next to the token and authorize it for the organization.`);
  }
  if (res.status === 403 && /not accessible by/i.test(said)) {
    return fail('read-only', 'This token can read but not write. To comment it needs: a classic token with the "repo" scope, or a fine-grained one for this repository with Pull requests: Read and write.');
  }
  if (res.status === 422) {
    const errors = (Array.isArray(body && body.errors) ? body.errors : []).map((x) => String((x && (x.message || x.code)) || '')).filter(Boolean);
    if (errors.some((m) => /must be part of the diff/i.test(m))) return fail('not-in-diff', 'GitHub takes comments only on the lines of its diff: a line the pull request changes, or one of the three around it.');
    return fail('refused', `GitHub did not take it: ${(errors.join('; ') || said || 'not valid').slice(0, 300)}`);
  }
  if (res.status === 404) {
    return hasToken
      ? fail('missing', `GitHub does not show ${name} to this token. It needs to read the repository: a classic token with the "repo" scope, or a fine-grained one for this repository with Pull requests: Read-only.`)
      : fail('no-token', `GitHub shows ${name} only with a token (the repository is private, or is not on ${remote.site}).`);
  }
  if (!body) return fail('not-github', `${remote.site} did not answer as GitHub does (${res.status}). Is origin on GitHub?`);
  return fail('refused', `GitHub answered ${res.status}${said ? `: ${said}` : ''}`);
}

// A question to the API, answered in JSON: about the repository (under /repos/owner/repo), or about the API itself
// when the path starts with /. With etag, an answer that did not change comes as a 304 with no body. Throws { code, error }.
async function ask(fetch, remote, token, pathAndQuery, { method = 'GET', send = null, etag = '' } = {}) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  const headers = { Accept: 'application/vnd.github+json' };
  if (remote.publicApi) headers['X-GitHub-Api-Version'] = '2022-11-28';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (send) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  const address = pathAndQuery.startsWith('/') ? `${remote.api}${pathAndQuery}` : `${remote.api}/repos/${remote.owner}/${remote.repo}/${pathAndQuery}`;
  let res;
  let text;
  try {
    res = await fetch(address, { method, headers, body: send ? JSON.stringify(send) : undefined, signal: stop.signal, cache: 'no-store' });
    text = await res.text();
  } catch (e) {
    const why = stop.signal.aborted ? `no answer in ${TIMEOUT_MS / 1000} seconds` : String(e.message || e).replace(/^net::/, '');
    throw { code: 'network', error: `${remote.site} did not answer: ${why}. Is this computer online (a proxy in the way)?` };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 304) return { res, body: null };
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || body === null || typeof body !== 'object') throw problem(res, res.ok ? null : body, remote, Boolean(token));
  return { res, body };
}

const hasNext = (res) => /rel="next"/.test(res.headers.get('link') || '');

// The last answer for each list, by its address: asked again with its ETag, GitHub says "not changed" without counting
// it against the limit, so asking again for many repositories costs nothing when nothing changed.
const listsKept = new Map();
const LISTS_KEPT = 500;

// A page of the pull requests of a repository, newest change first. Throws { code, error }.
async function listPulls(fetch, remote, token, { state = 'open', page = 1, perPage = PER_PAGE } = {}) {
  const query = `state=${STATES.includes(state) ? state : 'open'}&sort=updated&direction=desc&per_page=${perPage}&page=${Math.max(1, Number(page) || 1)}`;
  const key = `${remote.api}/${remote.owner}/${remote.repo}?${query}`;
  const kept = listsKept.get(key);
  const { res, body } = await ask(fetch, remote, token, `pulls?${query}`, kept ? { etag: kept.etag } : {});
  if (res.status === 304 && kept) return { pulls: kept.pulls, more: kept.more };
  if (!Array.isArray(body)) throw problem(res, null, remote, Boolean(token));
  const out = { pulls: body.map(pullOf).filter((p) => Number.isInteger(p.number) && p.number > 0), more: hasNext(res) };
  const etag = res.headers.get('etag');
  listsKept.delete(key);
  if (etag) {
    listsKept.set(key, { etag, ...out });
    if (listsKept.size > LISTS_KEPT) listsKept.delete(listsKept.keys().next().value);
  }
  return out;
}

// Who the token of this GitHub belongs to (for "Mine"): empty without a token. Throws { code, error }.
async function tokenOwner(fetch, remote, token) {
  if (!token) return '';
  const { body } = await ask(fetch, remote, token, '/user');
  return body && typeof body.login === 'string' ? body.login : '';
}

const pullNumber = (number) => {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) throw { code: 'failed', error: 'Unknown pull request' };
  return n;
};

// The comments of a pull request, oldest first (the first hundred: more says there are others on GitHub).
async function listComments(fetch, remote, token, number) {
  const { res, body } = await ask(fetch, remote, token, `issues/${pullNumber(number)}/comments?per_page=100`);
  if (!Array.isArray(body)) throw problem(res, null, remote, Boolean(token));
  return { comments: body.map(commentOf), more: hasNext(res) };
}

// What is written, as it is sent: trimmed, not empty, not too long; and a token to send it with.
function commentText(text, remote, token) {
  const value = String(text || '').trim();
  if (!value) throw { code: 'empty', error: 'Write the comment first.' };
  if (value.length > COMMENT_MAX) throw { code: 'long', error: `GitHub takes comments of up to ${COMMENT_MAX} characters: this one has ${value.length}.` };
  if (!token) throw { code: 'no-token', error: `A token is needed to comment: set one for ${remote.site} in Token...` };
  return value;
}

// A comment written here, added to a pull request as the owner of the token.
async function addComment(fetch, remote, token, number, text) {
  const n = pullNumber(number);
  const value = commentText(text, remote, token);
  const { body } = await ask(fetch, remote, token, `issues/${n}/comments`, { method: 'POST', send: { body: value } });
  return { comment: commentOf(body) };
}

// The comments on lines of the files of a pull request, oldest first (the first hundred).
async function listLineComments(fetch, remote, token, number) {
  const { res, body } = await ask(fetch, remote, token, `pulls/${pullNumber(number)}/comments?per_page=100`);
  if (!Array.isArray(body)) throw problem(res, null, remote, Boolean(token));
  return { comments: body.map(lineCommentOf), more: hasNext(res) };
}

// A comment on a line of a file as the pull request has it now (commit: its last commit), or an answer to one
// (replyTo: the first comment on that line, which says where).
async function addLineComment(fetch, remote, token, number, input) {
  const n = pullNumber(number);
  const at = input && typeof input === 'object' ? input : {};
  const value = commentText(at.body, remote, token);
  const replyTo = Number(at.replyTo);
  if (Number.isInteger(replyTo) && replyTo > 0) {
    const { body } = await ask(fetch, remote, token, `pulls/${n}/comments/${replyTo}/replies`, { method: 'POST', send: { body: value } });
    return { comment: lineCommentOf(body) };
  }
  const file = String(at.path || '');
  const line = Number(at.line);
  const commit = String(at.commit || '');
  if (!file || file.length > 4096 || /[\u0000-\u001f]/.test(file)) throw { code: 'failed', error: 'Unknown file' };
  if (!Number.isInteger(line) || line < 1) throw { code: 'failed', error: 'Unknown line' };
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw { code: 'failed', error: 'Unknown commit' };
  const send = { body: value, commit_id: commit, path: file, line, side: at.side === 'LEFT' ? 'LEFT' : 'RIGHT' };
  const { body } = await ask(fetch, remote, token, `pulls/${n}/comments`, { method: 'POST', send });
  return { comment: lineCommentOf(body) };
}

// -- The list through the GitHub MCP server of Claude CLI (github-mcp.js), in place of a token. Each answer takes the agent
// some seconds and some of the user's plan, so it is kept until it is asked for again (Refresh). --
const mcpKept = new Map();
const mcpAsked = new Map(); // the questions on their way, so two at once are one
const mcpRunning = new Set(); // how to stop each one

function hostOfLink(link) {
  try {
    return new URL(String(link)).host.toLowerCase();
  } catch {
    return '';
  }
}

async function listPullsByMcp(remote, { state = 'open', page = 1, fresh = false } = {}) {
  const wanted = STATES.includes(state) ? state : 'open';
  const at = Math.max(1, Number(page) || 1);
  const key = `${remote.site}/${remote.owner}/${remote.repo}?${wanted}&${at}`;
  if (!fresh && mcpKept.has(key)) return mcpKept.get(key);
  if (mcpAsked.has(key)) return mcpAsked.get(key);
  const asking = (async () => {
    const agent = await findAgent('claude');
    if (!agent || !agent.found) throw { code: 'no-agent', error: 'Claude CLI is not on this computer: install it, sign in once with "claude" in a terminal, then try again. For now MCP goes only through Claude CLI.' };
    const config = dev('GQ_AGENT_MCP_CONFIG');
    let stop = null;
    const running = () => stop && stop();
    mcpRunning.add(running);
    try {
      const { pulls } = await listByClaude({
        file: agent.file,
        env: agentEnv(await loginShellEnv()),
        owner: remote.owner,
        repo: remote.repo,
        state: wanted,
        page: at,
        perPage: PER_PAGE,
        extraArgs: config ? ['--mcp-config', config, '--strict-mcp-config'] : [],
        onStart: (s) => { stop = s; },
      });
      // the server answers for one GitHub: a repository of the same name on another host is another repository
      const elsewhere = pulls.map((p) => hostOfLink(p && p.html_url)).find((host) => host && host !== remote.site);
      if (elsewhere) throw { code: 'mcp-host', error: `The MCP server of Claude CLI answers for ${elsewhere}, and this repository is on ${remote.site}.` };
      const out = { pulls: pulls.map(pullOf).filter((p) => Number.isInteger(p.number) && p.number > 0), more: pulls.length >= PER_PAGE, via: 'mcp', at: new Date().toISOString() };
      mcpKept.set(key, out);
      return out;
    } catch (e) {
      // the commands it gives, as this computer starts Claude CLI: "claude" alone may not be found in a terminal
      if (e && !/\s/.test(agent.command)) {
        if (e.add) e.add = e.add.replace(/^claude/, agent.command);
        if (e.error) e.error = e.error.replace('claude mcp list', `${agent.command} mcp list`);
      }
      throw e;
    } finally {
      mcpRunning.delete(running);
    }
  })();
  mcpAsked.set(key, asking);
  try {
    return await asking;
  } finally {
    mcpAsked.delete(key);
  }
}

function registerGithub({ dataDir, fetch, isKnownRepo, originUrl }) {
  const tokens = new GithubTokens(path.join(dataDir, 'github.json'), safeStorage);
  // The GitHub of a repository of the list: throws what the page says when there is none.
  const remoteFor = async (repoPath) => {
    if (!isKnownRepo(repoPath)) throw { code: 'none', error: 'Unknown repository' };
    const url = await originUrl(repoPath);
    if (!url) throw { code: 'none', error: 'This repository has no origin, so there is no GitHub to ask for its pull requests.' };
    const remote = remoteOf(url);
    if (!remote) throw { code: 'none', error: 'The origin of this repository is not a GitHub repository (host/owner/repository), so there are no pull requests to show.' };
    return remote;
  };
  const shown = (remote) => ({ site: remote.site, owner: remote.owner, repo: remote.repo, hasToken: Boolean(tokens.get(remote.site)) });
  const owners = new Map(); // site -> login of its token, asked once
  const guard = (fn) => async (_, repoPath, ...args) => {
    let remote = null;
    try {
      remote = await remoteFor(repoPath);
      return { ...shown(remote), ...(await fn(remote, ...args)) };
    } catch (e) {
      const known = e && typeof e.error === 'string';
      return { ...(remote ? shown(remote) : {}), error: known ? e.error : String((e && e.message) || e), code: known ? e.code : 'failed', ...(known && e.add ? { add: e.add } : {}) };
    }
  };
  const open = async (url) => {
    const back = stepBack();
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      back();
      return { error: `The browser could not open the link: ${e.message}` };
    }
  };

  // with via: 'mcp', through Claude CLI's MCP server, and no token; fresh: not the answer kept
  ipcMain.handle('github-pulls', guard((remote, options) => {
    const o = options && typeof options === 'object' ? options : {};
    if (o.via === 'mcp') return listPullsByMcp(remote, { state: o.state, page: o.page, fresh: Boolean(o.fresh) });
    return listPulls(fetch, remote, tokens.get(remote.site), { state: o.state, page: o.page });
  }));
  // A token is kept once GitHub has answered with it for this repository
  ipcMain.handle('github-token-set', guard(async (remote, token) => {
    const value = String(token || '').trim();
    if (!TOKEN.test(value)) throw { code: 'token', error: 'Paste the token as GitHub shows it: one word, without spaces.' };
    await listPulls(fetch, remote, value, { perPage: 1 });
    tokens.set(remote.site, value);
    owners.delete(remote.site);
    return { success: true, hasToken: true };
  }));
  ipcMain.handle('github-token-clear', guard(async (remote) => {
    tokens.clear(remote.site);
    owners.delete(remote.site);
    return { success: true, hasToken: false };
  }));
  ipcMain.handle('github-me', guard(async (remote) => {
    if (!owners.has(remote.site)) owners.set(remote.site, await tokenOwner(fetch, remote, tokens.get(remote.site)));
    return { login: owners.get(remote.site) };
  }));
  ipcMain.handle('github-comments', guard((remote, number) => listComments(fetch, remote, tokens.get(remote.site), number)));
  ipcMain.handle('github-comment-add', guard((remote, number, text) => addComment(fetch, remote, tokens.get(remote.site), number, text)));
  ipcMain.handle('github-line-comments', guard((remote, number) => listLineComments(fetch, remote, tokens.get(remote.site), number)));
  ipcMain.handle('github-line-comment-add', guard((remote, number, input) => addLineComment(fetch, remote, tokens.get(remote.site), number, input)));
  // In the browser: a pull request (or all of them), and the page where tokens are made
  ipcMain.handle('github-open', guard((remote, number) => {
    const n = Number(number);
    return open(`${remote.web}/${remote.owner}/${remote.repo}/${Number.isInteger(n) && n > 0 ? `pull/${n}` : 'pulls'}`);
  }));
  ipcMain.handle('github-open-tokens', guard((remote) => open(`${remote.web}/settings/tokens`)));
  // The page of GitHub that creates a pull request from a branch on origin, into the default branch (changed there)
  ipcMain.handle('github-open-compare', guard((remote, branch) => {
    const name = String(branch || '');
    if (!name || name.length > 255 || name.startsWith('-') || name.includes('..') || /[\s~^:?*[\\]/.test(name)) throw { code: 'failed', error: 'Unknown branch' };
    return open(`${remote.web}/${remote.owner}/${remote.repo}/compare/${name.split('/').map(encodeURIComponent).join('/')}?expand=1`);
  }));
  return { stopAll: () => mcpRunning.forEach((stop) => stop()) };
}

module.exports = { registerGithub, remoteOf, listPulls, tokenOwner, listComments, addComment, listLineComments, addLineComment, pullOf, GithubTokens };
