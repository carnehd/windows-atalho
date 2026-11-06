// -- Analyse (Git > Pull requests): a pull request read by an agent the user has on this computer (Claude CLI or
// GitHub Copilot CLI), started by the main process (agent-review.js). Each pull request has an Analyse button and a
// gear with the agent and the skill it follows (a SKILL.md with what to look for). While it runs, the pull request shows what the
// agent is doing; then a summary and its findings, errors first and improvements after, each with its file and line.
// A finding opens the diff at its line, where it has a marker of its own, and can be put in the box of a comment on
// that line. The buttons only show when an agent is found on this computer. --

// Tabler, 24x24 outline
const AGENT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/></svg>';
const AGENT_GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>';

let agentInfo = null; // { agents: [{ id, name, found, version }], skills: [{ name, description }], agent, skill }
let agentTimer = null;

const agentFound = () => Boolean(agentInfo && agentInfo.agents && agentInfo.agents.some((a) => a.found));
// the findings of a review that were not dismissed
const liveFindings = (review) => (review ? review.findings.filter((f) => !(review.dismissed || []).includes(f.id)) : []);
const findingsText = (list) => `${plural(list.filter((f) => f.kind === 'error').length, 'error')} · ${plural(list.filter((f) => f.kind !== 'error').length, 'improvement')}`;

// "52.3k tokens": the tokens a review used, in a word; with each kind, in a sentence
function tokensText(tokens) {
  const n = tokens && tokens.total ? tokens.total : 0;
  const short = n < 1000 ? String(n) : n < 100000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
  return `${short} tokens`;
}

function tokensTitle(review) {
  const t = review.tokens;
  if (!t) return '';
  const f = (n) => Number(n || 0).toLocaleString();
  const read = t.input + t.cacheRead + t.cacheWrite;
  const parts = [`Read ${f(read)} tokens${t.cacheRead || t.cacheWrite ? ` (${f(t.cacheRead)} from the cache, ${f(t.cacheWrite)} written to it)` : ''}, wrote ${f(t.output)}`];
  if (review.costUsd) parts.push(`about $${review.costUsd.toFixed(2)} at the prices of the API (not charged on a subscription: it counts against the plan's limits)`);
  return parts.join(' · ');
}

// "haiku-4-5 + opus-4-8": the models by their short names (the full ones stay in the tip)
const shortModel = (model) => String(model || '').split(' + ').map((m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[\w+\]$/, '')).join(' + ');

function agentDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Which agents and skills there are, asked once (again from the gear), and the reviews kept for the pull requests
// on the list.
async function loadAgentInfo(again = false) {
  if (agentInfo && !again) return agentInfo;
  const got = await window.agent.info(again).catch((e) => ({ error: e.message }));
  if (!got.error) agentInfo = got;
  return agentInfo;
}

async function loadPullReviews() {
  const repoPath = currentRepo;
  const state = prState;
  const before = agentFound();
  await loadAgentInfo();
  if (state !== prState || repoPath !== currentRepo) return;
  const got = state.pulls.length ? await window.agent.reviews(repoPath, state.pulls.map((p) => p.number)).catch((e) => ({ error: e.message })) : { reviews: {}, running: [] };
  if (state !== prState || repoPath !== currentRepo) return;
  if (!got.error) {
    for (const [n, review] of Object.entries(got.reviews || {})) state.reviews.set(Number(n), review);
    for (const n of got.running || []) if (!state.runs.has(n)) state.runs.set(n, { since: Date.now(), text: 'Analysing' });
  }
  if (before !== agentFound() || state.reviews.size || state.runs.size) renderPulls();
  tickAgentRuns();
}

// On the row of a pull request: Analyse, and the gear of the agent and its skill.
function pullAgentButtons(p) {
  if (!agentFound()) return [];
  const run = prState.runs.get(p.number);
  const busy = Boolean(run && !run.error);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn btn-sm btn-icon pr-agent-btn';
  go.innerHTML = AGENT_ICON;
  go.append(busy ? 'Analysing...' : 'Analyse');
  go.disabled = busy;
  go.title = prState.reviews.has(p.number) ? `Show the review of #${p.number}` : `Have ${agentName()} read #${p.number} and look for errors and improvements`;
  go.addEventListener('click', (e) => {
    e.stopPropagation();
    if (prState.reviews.has(p.number)) showPullReview(p);
    else startPullReview(p);
  });
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'btn btn-sm btn-icon pr-agent-gear';
  gear.innerHTML = AGENT_GEAR_ICON;
  gear.title = 'The agent that analyses, and the skill it follows';
  gear.setAttribute('aria-label', gear.title);
  gear.setAttribute('aria-haspopup', 'dialog');
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    openAgentMenu(gear);
  });
  return [go, gear];
}

function agentName() {
  const a = agentInfo && agentInfo.agents.find((x) => x.id === agentInfo.agent);
  return a ? a.name : 'the agent';
}

// On the second line of a pull request: what the agent found, or that it is at it.
function pullAgentChip(p) {
  const run = prState.runs.get(p.number);
  return agentChipFor(p, Boolean(run && !run.error), prState.reviews.get(p.number));
}

function agentChipFor(p, running, review) {
  if (!running && !review) return null;
  const chip = document.createElement('span');
  chip.className = 'meta-tag pr-agent-chip';
  chip.innerHTML = AGENT_ICON;
  if (running) {
    chip.append('analysing...');
    chip.title = `${agentName()} is reading this pull request`;
  } else {
    const live = liveFindings(review);
    chip.append(findingsText(live));
    chip.title = `Found by ${review.agent}${review.model ? ` (${review.model})` : ''} with the skill ${review.skill}, ${formatDate(review.at)}${review.head !== p.head.sha ? ' (before its last commits)' : ''}`;
  }
  return chip;
}

// The pull request opened, with its review in sight.
function showPullReview(p) {
  if (!prState.open.has(p.number)) {
    const head = pullItemEl(p.number) && pullItemEl(p.number).querySelector('.log-item-head');
    if (head) head.click();
  }
  const box = pullItemEl(p.number) && pullItemEl(p.number).querySelector('.pr-agent');
  if (box) {
    fillPullAgent(box, p);
    box.scrollIntoView({ block: 'nearest' });
  }
}

async function startPullReview(p) {
  const repoPath = currentRepo;
  const state = prState;
  const now = state.runs.get(p.number);
  if (now && !now.error) return;
  state.runs.set(p.number, { since: Date.now(), text: 'Starting', agent: agentName() });
  redrawPullAgent(p.number);
  showPullReview(p);
  tickAgentRuns();
  let got;
  try {
    got = await window.agent.start(repoPath, { number: p.number, head: p.head.sha, base: p.base.sha, baseRef: p.base.ref, title: p.title, headLabel: p.head.label });
  } catch (e) {
    got = { error: e.message };
  }
  if (state !== prState) return;
  if (got.error) {
    state.runs.set(p.number, { error: got.error, code: got.code });
    redrawPullAgent(p.number);
  }
}

// What the main process says of a run: what the agent is doing, then its review, or why there is none.
function onAgentEvent(event) {
  if (!event || event.repo !== currentRepo || prState.repo !== currentRepo) return;
  const run = prState.runs.get(event.number);
  if (event.type === 'progress') {
    if (run && !run.error) run.text = event.text;
    const now = pullItemEl(event.number) && pullItemEl(event.number).querySelector('.pr-agent-now');
    if (now) now.textContent = `${event.text}...`;
    return;
  }
  if (event.type === 'done') {
    prState.runs.delete(event.number);
    prState.reviews.set(event.number, event.review);
    const live = liveFindings(event.review);
    toast(`#${event.number} analysed: ${findingsText(live)}`, 'success', { plain: true });
  } else if (event.type === 'failed') {
    if (event.code === 'stopped') prState.runs.delete(event.number);
    else prState.runs.set(event.number, { error: event.error, code: event.code });
  }
  redrawPullAgent(event.number);
}

// Everything of a pull request that shows its review: its row, its section, its files, and the diff when it is open.
function redrawPullAgent(number) {
  const p = prState.pulls.find((x) => x.number === number);
  const item = pullItemEl(number);
  if (!p || !item) return;
  const old = item.querySelector('.log-item-head .pr-agent-btn');
  if (old) {
    const [go] = pullAgentButtons(p);
    if (go) old.replaceWith(go);
  }
  const meta = item.querySelector('.log-meta');
  const chip = meta.querySelector('.pr-agent-chip');
  const next = pullAgentChip(p);
  if (chip && next) chip.replaceWith(next);
  else if (chip) chip.remove();
  else if (next) meta.appendChild(next);
  const box = item.querySelector('.pr-agent');
  if (box && prState.open.has(number)) fillPullAgent(box, p);
  markPullFileAgent(number);
  const shown = pullOfDiff();
  if (shown && shown.number === number) decoratePullDiff();
}

// The time of each run on show, once a second while one is going.
function tickAgentRuns() {
  const going = [...prState.runs.entries()].filter(([, run]) => !run.error);
  for (const [n, run] of going) {
    const el = pullItemEl(n) && pullItemEl(n).querySelector('.pr-agent-time');
    if (el) el.textContent = agentDuration(Date.now() - run.since);
  }
  if (going.length && !agentTimer) agentTimer = setInterval(tickAgentRuns, 1000);
  else if (!going.length && agentTimer) {
    clearInterval(agentTimer);
    agentTimer = null;
  }
}

const agentBtn = (label, title, run, cls = '') => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn btn-sm ${cls}`.trim();
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', run);
  return b;
};

// The section of the review in an open pull request, above its files: the run, its error, or the review.
function fillPullAgent(box, p) {
  const run = prState.runs.get(p.number);
  const review = prState.reviews.get(p.number);
  box.textContent = '';
  box.classList.toggle('hidden', !run && !review);
  if (!run && !review) return;
  const card = document.createElement('div');
  card.className = 'pr-agent-card';
  const head = document.createElement('div');
  head.className = 'pr-agent-head';
  const name = document.createElement('strong');
  name.className = 'pr-agent-name';
  name.innerHTML = AGENT_ICON;
  name.append('Agent review');
  head.appendChild(name);
  const about = diffSpan('pr-agent-about', '');
  head.appendChild(about);
  const acts = document.createElement('span');
  acts.className = 'pr-agent-acts';
  head.appendChild(acts);
  card.appendChild(head);
  if (run && !run.error) {
    about.textContent = run.agent || agentName();
    about.title = `With the skill ${agentInfo ? agentInfo.skill : ''}`;
    acts.append(diffSpan('pr-agent-time', agentDuration(Date.now() - run.since)), agentBtn('Stop', 'Stop the agent: nothing is kept of this run', () => window.agent.stop(currentRepo, p.number)));
    const line = document.createElement('div');
    line.className = 'pr-agent-run';
    line.append(diffSpan('pr-agent-spin', ''), diffSpan('pr-agent-now', `${run.text}...`));
    const bar = document.createElement('div');
    bar.className = 'pr-agent-bar';
    card.append(line, bar);
    box.appendChild(card);
    return;
  }
  if (run && run.error) {
    acts.append(agentBtn('Try again', '', () => startPullReview(p)), agentBtn('Close', '', () => {
      prState.runs.delete(p.number);
      redrawPullAgent(p.number);
    }));
    card.appendChild(diffSpan('pr-agent-error', run.error));
    if (!review) {
      box.appendChild(card);
      return;
    }
  }
  const live = liveFindings(review);
  const folded = prState.agentFolded.has(p.number);
  // the agent and the model it used (Copilot CLI does not say: the one its settings name, or its default)
  const model = review.model || (review.agentId === 'copilot' ? 'default model' : '');
  about.textContent = `${review.agent}${model ? ` · ${shortModel(model)}` : ''} · ${formatDate(review.at)} · took ${agentDuration(review.tookMs)}${review.tokens ? ` · ${tokensText(review.tokens)}` : ''}`;
  about.title = [new Date(review.at).toLocaleString(), `skill ${review.skill}`, model ? `model ${model}` : '', tokensTitle(review)].filter(Boolean).join(' · ');
  // folded away: its first line alone, with the way back
  const fold = (on) => {
    if (on) prState.agentFolded.add(p.number);
    else prState.agentFolded.delete(p.number);
    fillPullAgent(box, p);
  };
  if (folded) {
    about.textContent += ` · ${findingsText(live)}`;
    acts.append(agentBtn('Show', 'Show the review again', () => fold(false), 'pr-agent-unfold'));
    card.classList.add('folded');
    box.appendChild(card);
    return;
  }
  if (!(run && run.error)) acts.append(agentBtn('Run again', 'Analyse this pull request again, as it is now', () => startPullReview(p)));
  const copy = agentBtn('', 'Copy the review as text (Markdown)', () => copyText(pullReviewText(p, review), 'Review'), 'btn-icon pr-agent-copy');
  copy.setAttribute('aria-label', 'Copy');
  copy.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.copy}</svg>`;
  acts.append(copy, agentBtn('Comment PR', 'Put the review in the box of a comment on this pull request, to change and send', () => pullReviewToComment(p, review)));
  if (review.head !== p.head.sha) card.appendChild(diffSpan('pr-agent-old', 'This review was made before the last commits of the pull request. Run again to analyse it as it is now.'));
  if (review.summary) card.appendChild(summaryEl(review.summary));
  for (const [kind, title] of [['error', 'Errors'], ['improvement', 'Improvements']]) {
    const list = live.filter((f) => f.kind === kind);
    if (!list.length) continue;
    const group = document.createElement('div');
    group.className = 'pr-agent-group';
    group.append(title, diffSpan('cmp-count', String(list.length)));
    card.appendChild(group);
    for (const f of list) card.appendChild(pullFindingEl(p, f));
  }
  if (!live.length) card.appendChild(diffSpan('pr-agent-none', review.findings.length ? 'Every finding was dismissed.' : 'The agent found nothing to report.'));
  const gone = review.findings.length - live.length;
  if (gone) {
    const note = document.createElement('div');
    note.className = 'pr-agent-gone';
    note.append(`${plural(gone, 'finding')} dismissed. `);
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'pr-agent-back';
    back.textContent = 'Show again';
    back.addEventListener('click', async () => {
      for (const id of [...(review.dismissed || [])]) await dismissPullFinding(p.number, id, false);
    });
    note.appendChild(back);
    card.appendChild(note);
  }
  const foot = document.createElement('div');
  foot.className = 'pr-agent-foot';
  foot.appendChild(agentBtn('Collapse', 'Fold the review away, to its first line', () => fold(true), 'pr-agent-collapse'));
  card.appendChild(foot);
  box.appendChild(card);
}

// The summary as the agent wrote it: lines that start with "- " (or "* ", "• ") as a list, the rest as text.
function summaryEl(text) {
  const el = document.createElement('div');
  el.className = 'pr-agent-summary';
  const lines = String(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const bullet = /^\s*[-*•]\s+/;
  if (lines.filter((l) => bullet.test(l)).length < 2) {
    el.textContent = text;
    return el;
  }
  let list = null;
  for (const line of lines) {
    if (bullet.test(line)) {
      if (!list) {
        list = document.createElement('ul');
        el.appendChild(list);
      }
      const item = document.createElement('li');
      item.textContent = line.replace(bullet, '');
      list.appendChild(item);
    } else {
      list = null;
      el.appendChild(diffSpan('pr-agent-summary-line', line));
    }
  }
  return el;
}

// "store/CatalogStore.java:160": the last folder, the file and the line.
function findingPlace(f) {
  const parts = f.file.split('/');
  return `${parts.slice(-2).join('/')}${f.line ? `:${f.line}` : ''}`;
}

function pullFindingEl(p, f) {
  const key = `${p.number}:${f.id}`;
  const open = prState.openFindings.has(key);
  const wrap = document.createElement('div');
  wrap.className = `pr-finding ${f.kind}${open ? ' open' : ''}`;
  wrap.dataset.finding = f.id;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'pr-finding-row';
  row.setAttribute('aria-expanded', String(open));
  row.innerHTML = '<svg class="dir-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
  const dot = diffSpan('pr-finding-dot', '');
  dot.title = f.kind === 'error' ? 'An error: it can give a wrong result' : 'An improvement: it works, and could be better';
  const place = diffSpan('pr-finding-place', findingPlace(f));
  place.title = `${f.file}${f.line ? `, line ${f.line}${f.side === 'LEFT' ? ' (as it was)' : ''}` : ''}${f.known ? '' : ' (not a file of this pull request)'}`;
  row.append(dot, diffSpan('pr-finding-title', f.title), place);
  row.addEventListener('click', () => {
    if (open) prState.openFindings.delete(key);
    else prState.openFindings.add(key);
    wrap.replaceWith(pullFindingEl(p, f));
  });
  wrap.appendChild(row);
  if (!open) return wrap;
  const more = document.createElement('div');
  more.className = 'pr-finding-more';
  if (f.detail) more.appendChild(diffSpan('pr-finding-detail', f.detail));
  if (f.suggestion) {
    const code = document.createElement('pre');
    code.className = 'pr-finding-code';
    code.textContent = f.suggestion;
    more.appendChild(code);
  }
  const acts = document.createElement('div');
  acts.className = 'pr-finding-acts';
  if (f.known) acts.appendChild(agentBtn('Open in the diff', `See ${f.file}${f.line ? ` at line ${f.line}` : ''}`, () => openPullFinding(p, f)));
  if (f.known && f.line) acts.appendChild(agentBtn('Comment on this line', 'Open the diff at this line with the finding in the box of a comment, to change and send', () => openPullFinding(p, f, true)));
  acts.appendChild(agentBtn('Dismiss', 'Not a problem: take it off the list', () => dismissPullFinding(p.number, f.id, true)));
  more.appendChild(acts);
  wrap.appendChild(more);
  return wrap;
}

async function dismissPullFinding(number, id, on) {
  const got = await window.agent.dismiss(currentRepo, number, id, on).catch((e) => ({ error: e.message }));
  if (got.error || !got.review) {
    toast(got.error || 'That review is not kept any more', 'error');
    return;
  }
  prState.reviews.set(number, got.review);
  redrawPullAgent(number);
}

// A finding as a comment would say it.
function findingText(f) {
  return `**${f.title}**\n\n${f.detail}${f.suggestion ? `\n\nSuggested:\n\`\`\`\n${f.suggestion}\n\`\`\`` : ''}`;
}

// The review as text, for the clipboard or a comment.
function pullReviewText(p, review) {
  const live = liveFindings(review);
  const out = [`## Agent review of #${p.number}`, '', review.summary || ''];
  for (const [kind, title] of [['error', 'Errors'], ['improvement', 'Improvements']]) {
    const list = live.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('', `### ${title} (${list.length})`);
    for (const f of list) {
      out.push('', `- **${f.title}** (\`${f.file}${f.line ? `:${f.line}` : ''}\`)`, `  ${f.detail.replace(/\n/g, '\n  ')}`);
      if (f.suggestion) out.push('', '  ```', ...f.suggestion.split('\n').map((l) => `  ${l}`), '  ```');
    }
  }
  if (!live.length) out.push('', 'Nothing to report.');
  out.push('', `_${review.agent}${review.model ? ` (${review.model})` : ''}${review.tokens ? `, ${tokensText(review.tokens)}` : ''}._`);
  return out.join('\n');
}

// The review in the box of a comment on the pull request: nothing is sent until Comment is pressed.
function pullReviewToComment(p, review) {
  if (!prState.info || !prState.info.hasToken) {
    toast('Set a token (Token...) to comment on the pull request', 'error');
    return;
  }
  const c = prState.comments.get(p.number) || {};
  c.draft = pullReviewText(p, review);
  prState.comments.set(p.number, c);
  const box = pullItemEl(p.number) && pullItemEl(p.number).querySelector('.pr-comments');
  if (!box) return;
  fillPullComments(box, p);
  const text = box.querySelector('.pr-comment-input');
  if (text) {
    text.scrollIntoView({ block: 'center' });
    text.focus();
  }
}

// The diff of the file of a finding, at its line, with its balloon open (and, asked for, the finding in the box of
// a comment there).
function openPullFinding(p, f, toComment = false) {
  const ctx = prState.ctx.get(p.number);
  const entry = ctx && ctx.files.find((x) => x.file === f.file);
  if (!entry) {
    toast(`${f.file} is not among the files this pull request changes`, 'error');
    return;
  }
  closePullLinePop();
  prPendingLine = f.line ? { number: p.number, file: f.file, where: `${f.side}:${f.line}`, line: f.line, comment: toComment ? f.id : null } : null;
  openCompareDiff(entry, ctx);
}

// On the row of a file: how many findings the agent has in it.
function markPullFileAgent(number) {
  const live = liveFindings(prState.reviews.get(number));
  const item = pullItemEl(number);
  for (const row of item ? item.querySelectorAll('.pr-changes .cmp-file') : []) {
    const old = row.querySelector('.pr-file-agent');
    if (old) old.remove();
    const count = live.filter((f) => f.known && f.file === row.dataset.file).length;
    if (!count) continue;
    const chip = document.createElement('span');
    chip.className = 'pr-file-agent';
    chip.title = `${plural(count, 'finding')} of the agent in this file`;
    chip.innerHTML = AGENT_ICON;
    chip.append(String(count));
    row.insertBefore(chip, row.querySelector('.pr-file-talk') || row.querySelector('.cmp-lines'));
  }
}

// The findings of the agent in the file on show in the diff, by line ("RIGHT:12").
function pullLineFindings(pull) {
  const out = new Map();
  for (const f of liveFindings(prState.reviews.get(pull.number))) {
    if (!f.known || f.file !== diffFile || !f.line) continue;
    const where = `${f.side}:${f.line}`;
    out.set(where, [...(out.get(where) || []), f]);
  }
  return out;
}

// A finding in the balloon of its line: what it is, and the way to a comment or out of the list.
function pullLineFindingEl(pull, f, where, canComment) {
  const el = document.createElement('div');
  el.className = `pr-line-finding ${f.kind}`;
  const head = document.createElement('div');
  head.className = 'pr-line-finding-head';
  head.innerHTML = AGENT_ICON;
  head.append(`Agent · ${f.kind}`);
  el.append(head, diffSpan('pr-line-finding-title', f.title));
  if (f.detail) el.appendChild(diffSpan('pr-line-finding-detail', f.detail));
  if (f.suggestion) {
    const code = document.createElement('pre');
    code.className = 'pr-finding-code';
    code.textContent = f.suggestion;
    el.appendChild(code);
  }
  const acts = document.createElement('div');
  acts.className = 'pr-finding-acts';
  const say = agentBtn('Comment on this line', canComment ? 'Put the finding in the box below, to change and send' : 'GitHub takes comments only on the lines of its diff, with a token', () => findingToLineComment(pull, f, where));
  say.disabled = !canComment;
  acts.append(say, agentBtn('Dismiss', 'Not a problem: take it off the list', () => dismissPullFinding(pull.number, f.id, true)));
  el.appendChild(acts);
  return el;
}

// The finding in the box of the line's comment (its last conversation's answer, when it has comments already).
function setFindingDraft(pull, f, where) {
  const roots = pullLineThreads(pull).map((t) => t[0]).filter((root) => root.line !== null && `${root.side}:${root.line}` === where);
  const key = roots.length ? pullLineKey(pull, 'r', roots[roots.length - 1].id) : pullLineKey(pull, 'n', where);
  const form = prState.lineForms.get(key) || { draft: '', posting: false, error: '' };
  form.draft = findingText(f);
  prState.lineForms.set(key, form);
}

function findingToLineComment(pull, f, where) {
  setFindingDraft(pull, f, where);
  prFocusPop = true;
  decoratePullDiff();
}

// -- The gear: the agent and its skill --
function closeAgentMenu(refocus = false) {
  const menu = $('#agentMenu');
  if (!menu) return;
  document.removeEventListener('mousedown', agentMenuOutside, true);
  document.removeEventListener('keydown', agentMenuKey, true);
  const { anchor } = menu;
  menu.remove();
  if (refocus && anchor && anchor.isConnected) anchor.focus();
}

function agentMenuOutside(e) {
  const menu = $('#agentMenu');
  if (menu && !menu.contains(e.target) && !(e.target.closest && e.target.closest('.pr-agent-gear, .sel-menu'))) closeAgentMenu();
}

function agentMenuKey(e) {
  if (e.key !== 'Escape' || $('.sel-menu')) return;
  e.preventDefault();
  e.stopPropagation();
  closeAgentMenu(true);
}

function openAgentMenu(anchor) {
  const was = $('#agentMenu');
  const same = was && was.anchor === anchor;
  closeAgentMenu();
  if (same) return;
  const menu = document.createElement('div');
  menu.id = 'agentMenu';
  menu.className = 'clip-menu pr-agent-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'The agent and its skill');
  menu.anchor = anchor;
  document.body.appendChild(menu);
  fillAgentMenu(menu);
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8)))}px`;
  menu.style.top = `${Math.round(Math.min(a.bottom + 6, window.innerHeight - m.height - 8))}px`;
  document.addEventListener('mousedown', agentMenuOutside, true);
  document.addEventListener('keydown', agentMenuKey, true);
}

function fillAgentMenu(menu) {
  menu.textContent = '';
  const info = agentInfo || { agents: [], skills: [] };
  const row = (label, ...els) => {
    const line = document.createElement('div');
    line.className = 'pr-agent-menu-row';
    line.append(diffSpan('pr-agent-menu-label', label), ...els);
    menu.appendChild(line);
  };
  const apply = async (call) => {
    const got = await call.catch((e) => ({ error: e.message }));
    if (got.error) toast(got.error, 'error');
    else if (!got.canceled) {
      if (got.agents) agentInfo = got;
      if (got.loaded) toast(`Skill ${got.loaded} loaded`, 'success');
      if (menu.isConnected) fillAgentMenu(menu);
    }
  };
  const agent = document.createElement('select');
  agent.id = 'agentPick';
  agent.className = 'input';
  agent.setAttribute('aria-label', 'Agent');
  for (const a of info.agents) {
    const o = new Option(a.found ? a.name : `${a.name} (not found)`, a.id);
    o.disabled = !a.found;
    agent.appendChild(o);
  }
  agent.value = info.agent;
  agent.addEventListener('change', () => apply(window.agent.setSettings({ agent: agent.value, skill: info.skill })));
  row('Agent', agent);
  const skill = document.createElement('select');
  skill.id = 'agentSkill';
  skill.className = 'input';
  skill.setAttribute('aria-label', 'Skill');
  for (const s of info.skills) {
    const o = new Option(s.name, s.name);
    o.title = s.description;
    skill.appendChild(o);
  }
  skill.value = info.skill;
  skill.addEventListener('change', () => apply(window.agent.setSettings({ agent: info.agent, skill: skill.value })));
  row('Skill', skill);
  row('',
    agentBtn('Load skill...', 'Take a SKILL.md file from this computer into the app', () => apply(window.agent.loadSkill())),
    agentBtn('Edit', 'Open the SKILL.md of this skill, to change what the agent looks for', () => apply(window.agent.editSkill(skill.value))),
    agentBtn('Open folder', 'The folder the skills are kept in', () => apply(window.agent.openSkills())),
  );
  const chosen = info.skills.find((s) => s.name === info.skill);
  const found = info.agents.find((a) => a.id === info.agent);
  const hint = document.createElement('p');
  hint.className = 'settings-hint pr-agent-menu-hint';
  hint.textContent = `${chosen && chosen.description ? `${chosen.description}. ` : ''}A skill is a SKILL.md file with what to look for. `
    + `${info.agents.filter((a) => a.found).map((a) => `${a.name}${a.version ? ` ${a.version}` : ''}`).join(' and ') || 'No agent'} ${info.agents.filter((a) => a.found).length === 1 ? 'was' : 'were'} found on this computer${found && found.found ? '' : ' (not the one chosen)'}: the code of the pull request goes to the provider of the agent used, with your account there.`;
  menu.appendChild(hint);
}

function setupAgentReview() {
  window.agent.onEvent(onAgentEvent);
}
