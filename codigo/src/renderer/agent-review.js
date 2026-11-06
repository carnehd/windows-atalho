// -- Analyse (Git > Pull requests): a pull request read by an agent the user has on this computer (Claude CLI or
// GitHub Copilot CLI), started by the main process (agent-review.js). Each pull request has an Analyse button and a
// gear with the agent and the skill it follows (a SKILL.md with what to look for). While it runs, the pull request shows what the
// agent is doing; then a summary and its findings, errors first and improvements after, each with its file and line.
// A finding opens the diff at its line, where it has a marker of its own, and can be put in the box of a comment on
// that line. The buttons only show when an agent is found on this computer. The Push and Changes tabs have the same,
// for what the branch is about to push and for what is not committed yet (at the end of this file). --

// Tabler, 24x24 outline
const AGENT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/></svg>';
const AGENT_GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>';

let agentInfo = null; // { agents: [{ id, name, found, version }], skills: [{ name, description }], agent, skill }
let agentInfoAsked = null; // the question on its way, for the ones who ask at the same time
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
  if (agentInfoAsked && !again) return agentInfoAsked;
  const asked = window.agent.info(again).catch((e) => ({ error: e.message })).then((got) => {
    if (!got.error) agentInfo = got;
    agentInfoAsked = null;
    return agentInfo;
  });
  agentInfoAsked = asked;
  return asked;
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
  if (agentDocs.repo !== currentRepo) loadAgentDocs(currentRepo);
  const docs = document.createElement('button');
  docs.type = 'button';
  docs.className = 'btn btn-sm btn-icon pr-agent-docs';
  docs.setAttribute('aria-haspopup', 'dialog');
  fillDocsBtn(docs, p.head.ref);
  docs.addEventListener('click', (e) => {
    e.stopPropagation();
    openAgentDocs(docs, p.head.ref, () => startPullReview(p));
  });
  const run = prState.runs.get(p.number);
  const busy = Boolean(run && !run.error);
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn btn-sm btn-icon pr-agent-btn';
  go.innerHTML = AGENT_ICON;
  go.append(busy ? 'Analysing...' : 'Analyse');
  go.disabled = busy;
  go.title = reviewOfSkill(prState.reviews.get(p.number)) ? `Show the review of #${p.number}` : `Have ${agentName()} read #${p.number} and look for errors and improvements`;
  go.addEventListener('click', (e) => {
    e.stopPropagation();
    if (reviewOfSkill(prState.reviews.get(p.number))) showPullReview(p);
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
  return [docs, go, gear];
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
  if (needsDocs(p.head.ref)) {
    const docs = pullItemEl(p.number) && pullItemEl(p.number).querySelector('.pr-agent-docs');
    if (docs) openAgentDocs(docs, p.head.ref, () => startPullReview(p));
    return;
  }
  state.runs.set(p.number, { since: Date.now(), text: 'Starting', agent: agentName() });
  redrawPullAgent(p.number);
  showPullReview(p);
  tickAgentRuns();
  let got;
  try {
    got = await window.agent.start(repoPath, { number: p.number, head: p.head.sha, base: p.base.sha, baseRef: p.base.ref, title: p.title, headLabel: p.head.label, headRef: p.head.ref });
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
  if (event && typeof event.number === 'string') {
    onPanelEvent(event);
    return;
  }
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
    const go = pullAgentButtons(p).find((b) => b.classList.contains('pr-agent-btn'));
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
  const panels = AGENT_PANELS.filter((p) => p.run && !p.run.error);
  for (const p of panels) {
    const el = $(`${p.box} .pr-agent-time`);
    if (el) el.textContent = agentDuration(Date.now() - p.run.since);
  }
  const any = going.length > 0 || panels.length > 0;
  if (any && !agentTimer) agentTimer = setInterval(tickAgentRuns, 1000);
  else if (!any && agentTimer) {
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

// The section of the review in an open pull request, above its files.
function fillPullAgent(box, p) {
  const review = prState.reviews.get(p.number);
  fillAgentCard(box, {
    run: prState.runs.get(p.number),
    review,
    folded: prState.agentFolded.has(p.number),
    setFolded: (on) => {
      if (on) prState.agentFolded.add(p.number);
      else prState.agentFolded.delete(p.number);
      fillPullAgent(box, p);
    },
    start: () => startPullReview(p),
    stop: () => window.agent.stop(currentRepo, p.number),
    dropError: () => {
      prState.runs.delete(p.number);
      redrawPullAgent(p.number);
    },
    againTitle: 'Analyse this pull request again, as it is now',
    copyText: () => pullReviewText(p, review),
    moreActs: () => [agentBtn('Comment PR', 'Put the review in the box of a comment on this pull request, to change and send', () => pullReviewToComment(p, review))],
    old: review && review.head !== p.head.sha ? 'This review was made before the last commits of the pull request. Run again to analyse it as it is now.' : '',
    findingEl: (f) => pullFindingEl(p, f),
    showDismissed: async () => {
      for (const id of [...(review.dismissed || [])]) await dismissPullFinding(p.number, id, false);
    },
  });
}

// The section of a review (of a pull request, or of what is about to be pushed): the run, its error, or the review.
function fillAgentCard(box, host) {
  const { run, review } = host;
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
    acts.append(diffSpan('pr-agent-time', agentDuration(Date.now() - run.since)), agentBtn('Stop', 'Stop the agent: nothing is kept of this run', host.stop));
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
    acts.append(agentBtn('Try again', '', host.start), agentBtn('Close', '', host.dropError));
    card.appendChild(diffSpan('pr-agent-error', run.error));
    if (!review) {
      box.appendChild(card);
      return;
    }
  }
  const live = liveFindings(review);
  // the agent and the model it used (Copilot CLI does not say: the one its settings name, or its default)
  const model = review.model || (review.agentId === 'copilot' ? 'default model' : '');
  about.textContent = `${review.agent}${model ? ` · ${shortModel(model)}` : ''} · ${formatDate(review.at)} · took ${agentDuration(review.tookMs)}${review.tokens ? ` · ${tokensText(review.tokens)}` : ''}`;
  about.title = [new Date(review.at).toLocaleString(), `skill ${review.skill}`, model ? `model ${model}` : '', tokensTitle(review)].filter(Boolean).join(' · ');
  // folded away: its first line alone, with the way back
  if (host.folded) {
    about.textContent += ` · ${findingsText(live)}`;
    acts.append(agentBtn('Show', 'Show the review again', () => host.setFolded(false), 'pr-agent-unfold'));
    card.classList.add('folded');
    box.appendChild(card);
    return;
  }
  if (!(run && run.error)) acts.append(agentBtn('Run again', host.againTitle, host.start));
  const copy = agentBtn('', 'Copy the review as text (Markdown)', () => copyText(host.copyText(), 'Review'), 'btn-icon pr-agent-copy');
  copy.setAttribute('aria-label', 'Copy');
  copy.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS.copy}</svg>`;
  acts.append(copy, ...host.moreActs());
  if (host.old) card.appendChild(diffSpan('pr-agent-old', host.old));
  if (review.documents && review.documents.length) card.appendChild(diffSpan('pr-agent-docs-used', `Compared with: ${review.documents.join(', ')}`));
  if (review.summary) card.appendChild(summaryEl(review.summary));
  for (const [kind, title] of [['error', 'Errors'], ['improvement', 'Improvements']]) {
    const list = live.filter((f) => f.kind === kind);
    if (!list.length) continue;
    const group = document.createElement('div');
    group.className = 'pr-agent-group';
    group.append(title, diffSpan('cmp-count', String(list.length)));
    card.appendChild(group);
    for (const f of list) card.appendChild(host.findingEl(f));
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
    back.addEventListener('click', host.showDismissed);
    note.appendChild(back);
    card.appendChild(note);
  }
  const foot = document.createElement('div');
  foot.className = 'pr-agent-foot';
  foot.appendChild(agentBtn('Collapse', 'Fold the review away, to its first line', () => host.setFolded(true), 'pr-agent-collapse'));
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
  if (!f.file) return 'no file';
  const parts = f.file.split('/');
  return `${parts.slice(-2).join('/')}${f.line ? `:${f.line}` : ''}`;
}

function pullFindingEl(p, f) {
  const key = `${p.number}:${f.id}`;
  return agentFindingEl(f, {
    open: prState.openFindings.has(key),
    toggle: (on) => {
      if (on) prState.openFindings.add(key);
      else prState.openFindings.delete(key);
    },
    again: () => pullFindingEl(p, f),
    notHere: 'not a file of this pull request',
    acts: () => {
      const acts = [];
      if (f.known) acts.push(agentBtn('Open in the diff', `See ${f.file}${f.line ? ` at line ${f.line}` : ''}`, () => openPullFinding(p, f)));
      if (f.known && f.line) acts.push(agentBtn('Comment on this line', 'Open the diff at this line with the finding in the box of a comment, to change and send', () => openPullFinding(p, f, true)));
      acts.push(agentBtn('Dismiss', 'Not a problem: take it off the list', () => dismissPullFinding(p.number, f.id, true)));
      return acts;
    },
  });
}

// A finding on the list of a review: one line, and a click opens what it says and what can be done with it.
function agentFindingEl(f, { open, toggle, again, notHere, acts: actsOf }) {
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
  place.title = f.file ? `${f.file}${f.line ? `, line ${f.line}${f.side === 'LEFT' ? ' (as it was)' : ''}` : ''}${f.known ? '' : ` (${notHere})`}` : 'Not in a file: something nothing does yet';
  row.append(dot, diffSpan('pr-finding-title', f.title), place);
  row.addEventListener('click', () => {
    toggle(!open);
    wrap.replaceWith(again());
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
  acts.append(...actsOf());
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
  return agentReviewText(`#${p.number}`, review);
}

function agentReviewText(what, review) {
  const live = liveFindings(review);
  const out = [`## Agent review of ${what}`, '', ...(review.documents && review.documents.length ? [`Compared with: ${review.documents.join(', ')}`, ''] : []), review.summary || ''];
  for (const [kind, title] of [['error', 'Errors'], ['improvement', 'Improvements']]) {
    const list = live.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('', `### ${title} (${list.length})`);
    for (const f of list) {
      out.push('', `- **${f.title}**${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : ''}`, `  ${f.detail.replace(/\n/g, '\n  ')}`);
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
  for (const f of liveFindings(pull.push ? panelOf(pull).review : prState.reviews.get(pull.number))) {
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
  // what is about to be pushed or committed has no pull request to comment on yet
  if (pull.push) acts.appendChild(agentBtn('Dismiss', 'Not a problem: take it off the list', () => dismissPanelFinding(panelOf(pull), f.id, true)));
  else {
    const say = agentBtn('Comment on this line', canComment ? 'Put the finding in the box below, to change and send' : 'GitHub takes comments only on the lines of its diff, with a token', () => findingToLineComment(pull, f, where));
    say.disabled = !canComment;
    acts.append(say, agentBtn('Dismiss', 'Not a problem: take it off the list', () => dismissPullFinding(pull.number, f.id, true)));
  }
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
  closeAgentDocs();
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
  // the skills as the folder has them now: one put there since shows as it opens
  window.agent.info(false).then((got) => {
    if (got.error || (agentInfo && JSON.stringify([got.skills, got.skill]) === JSON.stringify([agentInfo.skills, agentInfo.skill]))) return;
    agentInfo = got;
    drawAllDocs();
    if (menu.isConnected) fillAgentMenu(menu);
  }).catch(() => {});
}

// Refresh in the gear: the folder of the skills read again, and the agents looked for again (one just installed).
async function refreshAgentMenu(menu, btn) {
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  const before = new Set((agentInfo ? agentInfo.skills : []).map((s) => s.name));
  const seen = new Promise((resolve) => setTimeout(resolve, 400));
  const got = await window.agent.info(true).catch((e) => ({ error: e.message }));
  await seen;
  btn.classList.remove('busy');
  if (got.error) {
    toast(got.error, 'error');
    return;
  }
  agentInfo = got;
  drawAllPanels();
  drawAllDocs();
  if (menu.isConnected) fillAgentMenu(menu);
  const fresh = got.skills.map((s) => s.name).filter((name) => !before.has(name));
  toast(fresh.length ? `New skill: ${fresh.join(', ')}` : 'No new skills', fresh.length ? 'success' : 'info', { plain: true });
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
      if (got.agents) {
        agentInfo = got;
        drawAllPanels();
        drawAllDocs();
      }
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
  const again = agentBtn('', 'Refresh: read the folder of the skills again, and look for the agents again', () => refreshAgentMenu(menu, again), 'btn-icon refresh-changes-btn pr-agent-again');
  again.setAttribute('aria-label', 'Refresh');
  again.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>';
  row('',
    agentBtn('Load skill...', 'Take a SKILL.md file from this computer into the app', () => apply(window.agent.loadSkill())),
    agentBtn('Edit', 'Open the SKILL.md of this skill, to change what the agent looks for', () => apply(window.agent.editSkill(skill.value))),
    agentBtn('Open folder', 'The folder the skills are kept in', () => apply(window.agent.openSkills())),
    again,
  );
  const chosen = info.skills.find((s) => s.name === info.skill);
  const found = info.agents.find((a) => a.id === info.agent);
  const hint = document.createElement('p');
  hint.className = 'settings-hint pr-agent-menu-hint';
  hint.textContent = `${chosen && chosen.description ? `${chosen.description}. ` : ''}${chosen && chosen.documentation ? `It ${chosen.documentation === 'required' ? 'needs' : 'can use'} documentation: Documents, beside Analyse. ` : ''}A skill is a SKILL.md file with what to look for. `
    + `${info.agents.filter((a) => a.found).map((a) => `${a.name}${a.version ? ` ${a.version}` : ''}`).join(' and ') || 'No agent'} ${info.agents.filter((a) => a.found).length === 1 ? 'was' : 'were'} found on this computer${found && found.found ? '' : ' (not the one chosen)'}: the code under review goes to the provider of the agent used, with your account there.`;
  menu.appendChild(hint);
}

// -- Documents: what a skill asks for before it runs (the documentation: line at the top of its SKILL.md). The button
// shows beside Analyse only then, and they are given before the analysis starts: files, folders, text pasted, links. Kept by
// branch, so they follow the work from Changes to Push to its pull request. With documentation: required, Analyse
// opens this first when there are none. --
const DOC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M9 9l1 0"/><path d="M9 13l6 0"/><path d="M9 17l6 0"/></svg>';
let agentDocs = { repo: null, by: {} };
let agentDocsAsked = null; // the repository being asked for

const skillNow = () => (agentInfo && agentInfo.skills.find((s) => s.name === agentInfo.skill)) || null;
const skillAsks = () => (skillNow() ? skillNow().documentation || '' : '');
const docsOf = (branch) => (agentDocs.repo === currentRepo ? agentDocs.by[branch] || [] : []);
const needsDocs = (branch) => skillAsks() === 'required' && docsOf(branch).length === 0;
// A review kept is what Analyse shows only when it was made with the skill chosen now: with another one, it analyses.
const reviewOfSkill = (review) => (review && (!agentInfo || review.skill === agentInfo.skill) ? review : null);

async function loadAgentDocs(repo = currentRepo) {
  if (!repo || agentDocsAsked === repo) return;
  agentDocsAsked = repo;
  const got = await window.agent.documents(repo).catch((e) => ({ error: e.message }));
  agentDocsAsked = null;
  if (got.error || repo !== currentRepo) return;
  agentDocs = { repo, by: got.byBranch || {} };
  drawAllDocs();
}

function fillDocsBtn(btn, branch, show = true) {
  const asks = skillAsks();
  const n = docsOf(branch).length;
  btn.dataset.branch = branch;
  btn.classList.toggle('hidden', !show || !asks);
  btn.classList.toggle('needs', asks === 'required' && n === 0);
  btn.innerHTML = DOC_ICON;
  btn.append(n ? `Documents (${n})` : 'Documents');
  btn.title = `${asks === 'required' ? `The skill ${agentInfo.skill} needs documentation` : `The skill ${agentInfo ? agentInfo.skill : ''} can use documentation`}: what the agent compares the code with. For the branch ${branch || '(none)'}.`;
}

// Every Documents button there is: on the tabs, and on the rows of the pull requests.
function drawAllDocs() {
  AGENT_PANELS.forEach(drawAgentButtons);
  for (const btn of $$('#prList .pr-agent-docs, #apList .pr-agent-docs')) fillDocsBtn(btn, btn.dataset.branch);
  const menu = $('#agentDocsMenu');
  if (menu) fillAgentDocs(menu);
}

function closeAgentDocs(refocus = false) {
  const menu = $('#agentDocsMenu');
  if (!menu) return;
  document.removeEventListener('mousedown', agentDocsOutside, true);
  document.removeEventListener('keydown', agentDocsKey, true);
  const { anchor } = menu;
  menu.remove();
  if (refocus && anchor && anchor.isConnected) anchor.focus();
}

function agentDocsOutside(e) {
  const menu = $('#agentDocsMenu');
  if (menu && !menu.contains(e.target) && !(e.target.closest && e.target.closest('.pr-agent-docs'))) closeAgentDocs();
}

function agentDocsKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeAgentDocs(true);
}

function placeAgentDocs(menu) {
  const a = menu.anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8)))}px`;
  menu.style.top = `${Math.round(Math.max(8, Math.min(a.bottom + 6, window.innerHeight - m.height - 8)))}px`;
}

// start: what Analyse in it does, the analysis this was opened for.
function openAgentDocs(anchor, branch, start) {
  const was = $('#agentDocsMenu');
  const same = was && was.anchor === anchor;
  closeAgentDocs();
  closeAgentMenu();
  if (same) return;
  const menu = document.createElement('div');
  menu.id = 'agentDocsMenu';
  menu.className = 'clip-menu pr-agent-menu pr-docs-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Documents for the analysis');
  Object.assign(menu, { anchor, branch, start, adding: '', error: '', draftName: '', draftText: '', draftLink: '' });
  document.body.appendChild(menu);
  fillAgentDocs(menu);
  document.addEventListener('mousedown', agentDocsOutside, true);
  document.addEventListener('keydown', agentDocsKey, true);
}

// What was added or taken out: what the main process says the branch has now.
async function changeAgentDocs(menu, call) {
  const got = await call.catch((e) => ({ error: e.message }));
  if (got.canceled) return;
  menu.error = got.error || '';
  if (!got.error) {
    agentDocs.repo = currentRepo;
    agentDocs.by[menu.branch] = got.docs;
    menu.adding = '';
    menu.draftName = '';
    menu.draftText = '';
    menu.draftLink = '';
  }
  drawAllDocs();
}

function agentDocRow(menu, doc) {
  const row = document.createElement('div');
  const folderBad = doc.kind === 'folder' && !doc.missing && (doc.more || doc.files === 0);
  row.className = `pr-doc${doc.missing || folderBad ? ' bad' : ''}`;
  row.dataset.id = doc.id;
  const what = document.createElement('div');
  what.className = 'pr-doc-what';
  const name = diffSpan('pr-doc-name', doc.name);
  name.title = doc.detail;
  what.append(diffSpan('pr-doc-kind', doc.kind), name);
  row.appendChild(what);
  if (doc.missing) row.appendChild(diffSpan('pr-doc-note', 'Not found where it was: add it again, or remove it.'));
  else if (doc.kind === 'folder') {
    const say = doc.more ? 'More than 300 files: choose a folder with only what the agent needs.'
      : doc.files === 0 ? 'No files in it yet.'
        : `${plural(doc.files, 'file')}, as they are when the analysis starts.${doc.unreadableFiles ? ` The agent may not read ${doc.unreadableFiles === 1 ? 'one of them' : `${doc.unreadableFiles} of them`} (Word, Excel...): save as PDF or text.` : ''}`;
    row.appendChild(diffSpan('pr-doc-note', say));
  } else if (doc.unreadable) row.appendChild(diffSpan('pr-doc-note', 'The agent may not read this kind of file: save it as PDF or text, or paste its text.'));
  else if (doc.kind === 'link') row.appendChild(diffSpan('pr-doc-note', 'Only named to the agent: it cannot open it.'));
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'icon-action pr-doc-drop';
  drop.title = `Take ${doc.name} out`;
  drop.setAttribute('aria-label', drop.title);
  drop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';
  drop.addEventListener('click', () => changeAgentDocs(menu, window.agent.removeDocument(currentRepo, menu.branch, doc.id)));
  row.appendChild(drop);
  return row;
}

function fillAgentDocs(menu) {
  const skill = skillNow();
  const docs = docsOf(menu.branch);
  menu.textContent = '';
  const head = document.createElement('div');
  head.className = 'pr-docs-head';
  head.append(diffSpan('pr-docs-title', 'Documents'), diffSpan('pr-docs-branch', menu.branch || 'no branch'));
  menu.appendChild(head);
  if (skill && skill.documentationNote) menu.appendChild(diffSpan('pr-docs-ask', `${skill.name}: ${skill.documentationNote}`));
  const list = document.createElement('div');
  list.className = 'pr-docs-list';
  for (const doc of docs) list.appendChild(agentDocRow(menu, doc));
  if (!docs.length) list.appendChild(diffSpan('pr-docs-none', skillAsks() === 'required' ? 'None yet. This skill needs at least one to analyse.' : 'None yet. This skill can analyse without them.'));
  menu.appendChild(list);
  const add = document.createElement('div');
  add.className = 'pr-docs-add';
  const toggle = (what) => {
    menu.adding = menu.adding === what ? '' : what;
    menu.error = '';
    fillAgentDocs(menu);
  };
  add.append(
    agentBtn('Add files...', 'Choose files on this computer. They are read when the analysis starts, as they are then', () => changeAgentDocs(menu, window.agent.addDocumentFiles(currentRepo, menu.branch))),
    agentBtn('Add folder...', 'Choose a folder: the agent gets every file in it and in its folders, as they are when the analysis starts', () => changeAgentDocs(menu, window.agent.addDocumentFolder(currentRepo, menu.branch))),
    agentBtn('Paste text', 'Paste the text of a ticket, say', () => toggle('text')),
    agentBtn('Add link', 'Name a link to the agent, as a reference', () => toggle('link')),
  );
  menu.appendChild(add);
  if (menu.adding === 'text') {
    const form = document.createElement('div');
    form.className = 'pr-docs-form';
    const name = document.createElement('input');
    name.className = 'input pr-docs-input-name';
    name.placeholder = 'A name for it (optional)';
    name.maxLength = 80;
    name.value = menu.draftName;
    name.addEventListener('input', () => { menu.draftName = name.value; });
    const text = document.createElement('textarea');
    text.className = 'input pr-docs-input-text';
    text.rows = 6;
    text.placeholder = 'The text of the ticket, its requirements...';
    text.value = menu.draftText;
    text.addEventListener('input', () => { menu.draftText = text.value; });
    form.append(name, text, agentBtn('Add', '', () => changeAgentDocs(menu, window.agent.addDocumentText(currentRepo, menu.branch, name.value, text.value)), 'pr-docs-save'));
    menu.appendChild(form);
    text.focus();
  } else if (menu.adding === 'link') {
    const form = document.createElement('div');
    form.className = 'pr-docs-form pr-docs-form-line';
    const link = document.createElement('input');
    link.className = 'input pr-docs-input-link';
    link.placeholder = 'https://...';
    link.value = menu.draftLink;
    link.addEventListener('input', () => { menu.draftLink = link.value; });
    const save = () => changeAgentDocs(menu, window.agent.addDocumentLink(currentRepo, menu.branch, link.value));
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    form.append(link, agentBtn('Add', '', save, 'pr-docs-save'));
    menu.appendChild(form);
    link.focus();
  }
  if (menu.error) menu.appendChild(diffSpan('pr-token-error', menu.error));
  const hint = document.createElement('p');
  hint.className = 'settings-hint pr-agent-menu-hint';
  hint.textContent = 'They go to the provider of the agent, with the code, and the agent reads all of them. The agent cannot open links: for what is behind a login, as a ticket in Jira, add a file or paste its text.';
  menu.appendChild(hint);
  const foot = document.createElement('div');
  foot.className = 'pr-docs-foot';
  const go = agentBtn('Analyse', needsDocs(menu.branch) ? 'Add a document first' : 'Start the analysis with these documents', () => {
    const { start } = menu;
    closeAgentDocs();
    start();
  }, 'btn-primary pr-docs-go');
  go.disabled = needsDocs(menu.branch);
  foot.appendChild(go);
  menu.appendChild(foot);
  placeAgentDocs(menu);
}

// -- Analyse on the tabs with no pull request: Push (what the branch is about to push) and Changes (the ticked files,
// not committed yet), read by the same agent with the same skill, before they leave this computer. As for a pull
// request: a review kept, its findings by file and in the diff at their lines, each to dismiss. There is no pull
// request yet to comment on. --
const agentPanel = (fields) => ({ repo: null, branch: '', review: null, run: null, folded: false, openFindings: new Set(), ...fields });

const pushAgent = agentPanel({
  box: '#pushAgent',
  go: '#pushAgentBtn',
  gear: '#pushAgentGear',
  docs: '#pushAgentDocs',
  subject: () => `push:${pushAgent.branch}`,
  done: 'Push analysed',
  againTitle: 'Analyse what this push sends again, as it is now',
  notHere: 'not a file of this push',
  count: () => (pushInfo ? pushInfo.commits.length : 0),
  // with nothing left to push, the review of what was pushed goes away (kept, for when there are new commits)
  shown: () => (pushInfo && pushInfo.commits.length ? pushAgent.review : null),
  buttonsShow: () => true,
  goTitle: (review, n) => (!n ? 'Nothing to push, so nothing to analyse' : review ? 'Show the review of what this push sends' : `Have ${agentName()} read what this push sends and look for errors and improvements`),
  copyName: (review) => `what ${pushAgent.branch} pushes to origin/${review.target}`,
  old: (review) => (pushInfo && review.head !== pushInfo.head ? 'This review was made before the last commits. Run again to analyse them as they are now.' : ''),
  ask: (repo) => window.agent.startPush(repo),
  rows: () => $$('#pushList .push-file[data-net]'),
  placeChip: (row, chip) => row.appendChild(chip),
  open: (f) => openPushFinding(f),
});

const changesAgent = agentPanel({
  box: '#changesAgent',
  go: '#changesAgentBtn',
  gear: '#changesAgentGear',
  docs: '#changesAgentDocs',
  current: '', // what the files it read are now, to tell whether it is about them as they are
  subject: () => 'changes',
  done: 'Changes analysed',
  againTitle: 'Analyse the ticked files again, as they are now',
  notHere: 'not a file of these changes',
  count: () => selectedEntries().length,
  // once none of the files it read is among the changes (committed, or reverted), it is about nothing here
  shown: () => {
    const { review } = changesAgent;
    return review && changesAgent.repo === currentRepo && currentEntries.some((e) => (review.reviewed || []).includes(e.file)) ? review : null;
  },
  buttonsShow: () => currentEntries.length > 0,
  goTitle: (review, n) => (review ? 'Show the review of these changes' : !n ? 'Tick the files to analyse' : `Have ${agentName()} read the ${plural(n, 'ticked file')} and look for errors and improvements`),
  copyName: () => 'the changes not committed',
  old: (review) => (changesAgent.current && review.head !== changesAgent.current ? 'This review was made before the last changes. Run again to analyse them as they are now.' : ''),
  ask: (repo) => window.agent.startChanges(repo, selectedEntries().map((e) => e.file)),
  rows: () => $$('#fileList .file-item'),
  placeChip: (row, chip) => row.querySelector('.file-path').appendChild(chip),
  open: (f) => openChangesFinding(f),
});

const AGENT_PANELS = [pushAgent, changesAgent];
// A file of the Changes tab in the diff, as far as the findings on its lines go (pullOfDiff, pull-requests.js)
const CHANGES_PULL = { push: true, number: 'changes' };
const panelOf = (pull) => (pull.number === 'changes' ? changesAgent : pushAgent);
const drawAllPanels = () => AGENT_PANELS.forEach(drawAgentPanel);
const drawPushAgent = () => drawAgentPanel(pushAgent);
const markPushFileAgent = () => markPanelFiles(pushAgent);

// What renderPush (app.js) has just put on the tab: another repository or branch brings its own review.
function syncPushAgent(info) {
  const branch = info && !info.error ? info.current : '';
  if (pushAgent.repo !== currentRepo || pushAgent.branch !== branch) {
    Object.assign(pushAgent, { repo: currentRepo, branch, review: null, run: null, folded: false, openFindings: new Set() });
    if (branch) loadPushAgent();
  }
  if (!agentInfo && $('#pushTab').classList.contains('active')) loadAgentInfo().then(drawAllPanels);
  if (agentDocs.repo !== currentRepo) loadAgentDocs();
  drawPushAgent();
}

async function loadPushAgent() {
  const { repo, branch } = pushAgent;
  const got = await window.agent.pushReview(repo, branch).catch((e) => ({ error: e.message }));
  if (got.error || pushAgent.repo !== repo || pushAgent.branch !== branch) return;
  pushAgent.review = got.review;
  if (got.running && !pushAgent.run) pushAgent.run = { since: Date.now(), text: 'Analysing' };
  drawPushAgent();
  tickAgentRuns();
}

// refreshStatus (app.js) reads the changes: the review kept for them, and whether they are still as it read them. The
// agents are looked for once, a moment after the app has its first changes on screen.
let agentLookup = null;

async function syncChangesAgent(status) {
  const p = changesAgent;
  const repo = currentRepo;
  if (p.repo !== repo) Object.assign(p, { repo, review: null, current: '', run: null, folded: false, openFindings: new Set() });
  p.branch = (status && status.branch) || '';
  if (agentDocs.repo !== repo) loadAgentDocs();
  if (!agentInfo && !agentLookup) agentLookup = setTimeout(() => loadAgentInfo().then(drawAllPanels), 1200);
  const got = await window.agent.changesReview(repo).catch((e) => ({ error: e.message }));
  if (got.error || p.repo !== repo) return;
  p.review = got.review;
  p.current = got.current;
  if (got.running && !p.run) p.run = { since: Date.now(), text: 'Analysing' };
  drawAgentPanel(p);
  tickAgentRuns();
}

// Analyse and the gear of a tab: they follow what there is to analyse.
function drawAgentButtons(p) {
  const go = $(p.go);
  const busy = Boolean(p.run && !p.run.error);
  const n = p.count();
  const review = p.shown();
  const show = agentFound() && (busy || p.buttonsShow());
  go.classList.toggle('hidden', !show);
  $(p.gear).classList.toggle('hidden', !show);
  fillDocsBtn($(p.docs), p.branch, show);
  go.innerHTML = AGENT_ICON;
  go.append(busy ? 'Analysing...' : 'Analyse');
  go.disabled = busy || (!n && !review);
  go.title = p.goTitle(reviewOfSkill(review), n);
}

// The buttons, the section of the review over the list, and how many findings each file has.
function drawAgentPanel(p) {
  drawAgentButtons(p);
  const box = $(p.box);
  const review = p.shown();
  const top = box.scrollTop;
  fillAgentCard(box, {
    run: p.run,
    review,
    folded: p.folded,
    setFolded: (on) => {
      p.folded = on;
      drawAgentPanel(p);
    },
    start: () => startAgentPanel(p),
    stop: () => window.agent.stop(currentRepo, p.subject()),
    dropError: () => {
      p.run = null;
      drawAgentPanel(p);
    },
    againTitle: p.againTitle,
    copyText: () => agentReviewText(p.copyName(review), review),
    moreActs: () => [],
    old: review ? p.old(review) : '',
    findingEl: (f) => panelFindingEl(p, f),
    showDismissed: async () => {
      for (const id of [...(review.dismissed || [])]) await dismissPanelFinding(p, id, false);
    },
  });
  box.scrollTop = top;
  markPanelFiles(p);
}

async function startAgentPanel(p) {
  const { repo, branch, run } = p;
  if (run && !run.error) return;
  if (needsDocs(branch)) {
    openAgentDocs($(p.docs), branch, () => startAgentPanel(p));
    return;
  }
  p.run = { since: Date.now(), text: 'Starting', agent: agentName() };
  p.folded = false;
  drawAgentPanel(p);
  tickAgentRuns();
  const got = await p.ask(repo).catch((e) => ({ error: e.message }));
  if (!got.error || p.repo !== repo || p.branch !== branch) return;
  p.run = { error: got.error, code: got.code };
  drawAgentPanel(p);
  tickAgentRuns();
}

function onPanelEvent(event) {
  const p = event.number === 'changes' ? changesAgent : pushAgent;
  if (event.repo !== currentRepo || event.repo !== p.repo || event.number !== p.subject()) return;
  if (event.type === 'progress') {
    if (p.run && !p.run.error) p.run.text = event.text;
    const now = $(`${p.box} .pr-agent-now`);
    if (now) now.textContent = `${event.text}...`;
    return;
  }
  if (event.type === 'done') {
    p.run = null;
    p.review = event.review;
    p.folded = false;
    toast(`${p.done}: ${findingsText(liveFindings(event.review))}`, 'success', { plain: true });
    if (p === changesAgent) syncChangesAgent({ branch: p.branch }); // the files may have changed while it read them
  } else if (event.type === 'failed') {
    p.run = event.code === 'stopped' ? null : { error: event.error, code: event.code };
  }
  drawAgentPanel(p);
  tickAgentRuns();
  redrawPanelDiff();
}

function redrawPanelDiff() {
  const shown = pullOfDiff();
  if (shown && shown.push) decoratePullDiff();
}

function panelFindingEl(p, f) {
  return agentFindingEl(f, {
    open: p.openFindings.has(f.id),
    toggle: (on) => {
      if (on) p.openFindings.add(f.id);
      else p.openFindings.delete(f.id);
    },
    again: () => panelFindingEl(p, f),
    notHere: p.notHere,
    acts: () => {
      const acts = [];
      if (f.known) acts.push(agentBtn('Open in the diff', `See ${f.file}${f.line ? ` at line ${f.line}` : ''}`, () => p.open(f)));
      acts.push(agentBtn('Dismiss', 'Not a problem: take it off the list', () => dismissPanelFinding(p, f.id, true)));
      return acts;
    },
  });
}

async function dismissPanelFinding(p, id, on) {
  const got = await window.agent.dismiss(currentRepo, p.subject(), id, on).catch((e) => ({ error: e.message }));
  if (got.error || !got.review) {
    toast(got.error || 'That review is not kept any more', 'error');
    return;
  }
  p.review = got.review;
  drawAgentPanel(p);
  redrawPanelDiff();
}

// Two sides of a file of this push: where its commits start, and the last of them. Findings show at their lines.
function pushDiffCtx() {
  const { base, head, files, target, targetExists, current } = pushInfo;
  return { from: base, to: head, files, fromLabel: targetExists ? `origin/${target}` : 'Before these commits', toLabel: current, pull: { push: true, number: pushAgent.subject(), headSha: head } };
}

function openPushFile(f) {
  if (pushInfo) openCompareDiff(f, pushDiffCtx());
}

function openPushFinding(f) {
  const entry = pushInfo && pushInfo.files.find((x) => x.file === f.file);
  if (!entry) {
    toast(`${f.file} is not among the files of this push`, 'error');
    return;
  }
  closePullLinePop();
  prPendingLine = f.line ? { number: pushAgent.subject(), file: f.file, where: `${f.side}:${f.line}`, line: f.line, comment: null } : null;
  openCompareDiff(entry, pushDiffCtx());
}

function openChangesFinding(f) {
  const entry = currentEntries.find((x) => x.file === f.file);
  if (!entry) {
    toast(`${f.file} is not among the changes now`, 'error');
    return;
  }
  closePullLinePop();
  prPendingLine = f.line ? { number: 'changes', file: f.file, where: `${f.side}:${f.line}`, line: f.line, comment: null } : null;
  openDiff(entry);
}

function markPanelFiles(p) {
  const live = liveFindings(p.shown());
  for (const row of p.rows()) {
    const old = row.querySelector('.pr-file-agent');
    if (old) old.remove();
    const count = live.filter((f) => f.known && f.file === row.dataset.file).length;
    if (!count) continue;
    const chip = document.createElement('span');
    chip.className = 'pr-file-agent';
    chip.title = `${plural(count, 'finding')} of the agent in this file`;
    chip.innerHTML = AGENT_ICON;
    chip.append(String(count));
    p.placeChip(row, chip);
  }
}

function setupAgentReview() {
  window.agent.onEvent(onAgentEvent);
  for (const p of AGENT_PANELS) {
    const gear = $(p.gear);
    gear.innerHTML = AGENT_GEAR_ICON;
    gear.title = 'The agent that analyses, and the skill it follows';
    gear.setAttribute('aria-label', gear.title);
    gear.addEventListener('click', () => openAgentMenu(gear));
    $(p.docs).addEventListener('click', () => openAgentDocs($(p.docs), p.branch, () => startAgentPanel(p)));
    $(p.go).addEventListener('click', () => {
      if (!reviewOfSkill(p.shown())) {
        startAgentPanel(p);
        return;
      }
      p.folded = false;
      drawAgentPanel(p);
      $(p.box).scrollIntoView({ block: 'nearest' });
    });
  }
  $('#pushTab').addEventListener('click', () => {
    if (!agentInfo) loadAgentInfo().then(drawAllPanels);
  });
}
