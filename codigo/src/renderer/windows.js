// The windows of the app, in one place. All of them (.settings-card, .confirm-card) have the same X, in a red box at the
// top right corner, and their main buttons say by colour and icon what kind of thing they do. Nothing to add when a window
// is made: the ones made later are found when they reach the page.

const WIN_CARDS = '.settings-card, .confirm-card';
const WIN_X_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
// The way out a window had of its own at the top: hidden, and what the X presses.
const WIN_OWN_CLOSE = '.close-btn, [aria-label^="Close"]';

// The first word of a button: what kind of thing it does, and its icon. A word not here keeps the look it has; so does a
// button that changes to a word of its work ("Saving..."), with the colour it had.
const WIN_ACTIONS = {
  // only looks, or gets what is new: nothing changes
  search: ['see', 'search'], find: ['see', 'search'], check: ['see', 'search'], fetch: ['see', 'fetch'],
  view: ['see', 'eye'], show: ['see', 'eye'], watch: ['see', 'eye'], copy: ['see', 'copy'], open: ['see', 'open'],
  go: ['see', 'open'], log: ['see', 'login'], scan: ['see', 'search'],
  // adds something, or keeps it
  save: ['make', 'save'], add: ['make', 'plus'], create: ['make', 'plus'], new: ['make', 'plus'], make: ['make', 'plus'],
  initialize: ['make', 'plus'], clone: ['make', 'clone'], duplicate: ['make', 'copy'], import: ['make', 'pull'], '+': ['make', ''],
  // changes the code, origin, or what runs
  pull: ['change', 'pull'], push: ['change', 'push'], commit: ['change', 'commit'], amend: ['change', 'pencil'],
  stash: ['change', 'stash'], move: ['change', 'move'], rename: ['change', 'pencil'], run: ['change', 'play'],
  start: ['change', 'play'], restart: ['change', 'retry'], send: ['change', 'send'], merge: ['change', 'merge'],
  put: ['change', 'revert'], retry: ['change', 'retry'], update: ['change', 'retry'], switch: ['change', 'move'],
  // takes something away, or undoes it
  delete: ['del', 'trash'], remove: ['del', 'trash'], discard: ['del', 'trash'], drop: ['del', 'trash'], clear: ['del', 'eraser'],
  revert: ['del', 'revert'], reset: ['del', 'revert'], replace: ['del', 'revert'], overwrite: ['del', 'revert'],
  stop: ['del', 'stop'], abort: ['del', 'stop'], end: ['del', 'stop'],
  // only closes the window: not a main button
  close: ['none', ''], done: ['none', ''], ok: ['none', ''],
};

const WIN_ICONS = {
  search: 'M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0M21 21l-6-6',
  fetch: 'M12 18h-5.3c-2.6 0-4.7-2-4.7-4.5s2.1-4.5 4.7-4.5c.4-1.8 1.8-3.2 3.7-3.8c1.9-.6 4-.2 5.4 1c1.5 1.2 2.2 3 1.8 4.8h1c1.4 0 2.6.8 3.1 2M19 16v6M22 19l-3 3l-3-3',
  eye: 'M10 12a2 2 0 1 0 4 0a2 2 0 0 0-4 0M21 12c-2.4 4-5.4 6-9 6c-3.6 0-6.6-2-9-6c2.4-4 5.4-6 9-6c3.6 0 6.6 2 9 6',
  copy: 'M7 9.7a2.7 2.7 0 0 1 2.7-2.7h8.6a2.7 2.7 0 0 1 2.7 2.7v8.6a2.7 2.7 0 0 1-2.7 2.7h-8.6a2.7 2.7 0 0 1-2.7-2.7zM4 16.1a2 2 0 0 1-1-1.7v-10.4c0-1.1.9-2 2-2h10c.8 0 1.2.4 1.7 1',
  open: 'M12 6h-6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M11 13l9-9M15 4h5v5',
  login: 'M15 8v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M21 12h-13l3-3M11 15l-3-3',
  save: 'M6 4h10l4 4v10a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2M10 14a2 2 0 1 0 4 0a2 2 0 1 0-4 0M14 4v4h-6v-4',
  plus: 'M12 5v14M5 12h14',
  clone: 'M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M12 12v4',
  pull: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5l5-5M12 4v12',
  push: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 9l5-5l5 5M12 4v12',
  commit: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 3v6M12 15v6',
  pencil: 'M4 20h4l10.5-10.5a2.8 2.8 0 1 0-4-4l-10.5 10.5v4M13.5 6.5l4 4',
  stash: 'M3 4h18v4h-18zM5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10M10 12h4',
  move: 'M5 12h14M13 18l6-6M13 6l6 6',
  play: 'M7 4v16l13-8z',
  send: 'M10 14l11-11M21 3l-6.5 18a.55.55 0 0 1-1 0l-3.5-7l-7-3.5a.55.55 0 0 1 0-1l18-6.5',
  merge: 'M5 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 8v8M7 8a4 4 0 0 0 4 4h4',
  retry: 'M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
  eraser: 'M19 20h-10.5l-4.2-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-9.2 9.3M18 13.3l-6.3-6.3',
  revert: 'M9 14l-4-4l4-4M5 10h11a4 4 0 1 1 0 8h-1',
  stop: 'M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2z',
};

function winIconUrl(name) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${WIN_ICONS[name]}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// What the X does is what the window already does to close: its own close, its Cancel or Close, Esc, or else its Done.
// A button that is disabled (the window is busy) does nothing, and the window stays.
function closeWindowOf(card) {
  const buttons = [...card.querySelectorAll('button')].filter((b) => !b.classList.contains('win-x'));
  const says = (words) => buttons.slice().reverse().find((b) => b.getClientRects().length && words.test(b.textContent.trim()));
  const own = buttons.find((b) => b.matches(WIN_OWN_CLOSE)) || buttons.find((b) => b.classList.contains('confirm-no')) || says(/^(cancel|close)$/i);
  if (own) {
    own.click();
    return;
  }
  const open = () => card.isConnected && card.getClientRects().length > 0;
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  if (!open()) return;
  const done = says(/^done$/i);
  if (done) {
    done.click();
    return;
  }
  const overlay = card.closest('.settings-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function paintWindowButtons(card) {
  for (const btn of card.querySelectorAll('.btn-primary, .btn-danger, .confirm-yes')) {
    const words = btn.textContent.trim().split(/\s+/);
    const entry = WIN_ACTIONS[words[0].toLowerCase()];
    const danger = btn.classList.contains('btn-danger') || btn.classList.contains('danger');
    if (!entry && !danger) continue; // a word of its work, or one not known: as it is
    const act = danger && (!entry || entry[0] !== 'del') ? 'del' : entry[0];
    const icon = entry ? entry[1] : 'trash';
    if (btn.dataset.act !== act) btn.dataset.act = act;
    const wanted = icon && !btn.querySelector('svg') ? icon : '';
    if ((btn.dataset.ico || '') === wanted) continue;
    if (wanted) {
      btn.dataset.ico = wanted;
      btn.style.setProperty('--win-ico', winIconUrl(wanted));
    } else {
      delete btn.dataset.ico;
      btn.style.removeProperty('--win-ico');
    }
  }
}

function dressWindow(card) {
  if (card.dataset.dressed) return;
  card.dataset.dressed = '1';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'win-x';
  x.title = 'Close (Esc)';
  x.setAttribute('aria-label', 'Close');
  x.innerHTML = WIN_X_SVG;
  x.addEventListener('click', () => closeWindowOf(card));
  const style = getComputedStyle(card);
  if (/auto|scroll/.test(style.overflowY)) {
    // a window that scrolls as a whole: the X stays at its corner, and comes first so the title goes beside it
    x.classList.add('win-x-sticky');
    x.style.top = `-${style.paddingTop}`;
    x.style.marginTop = `-${style.paddingTop}`;
    x.style.marginRight = `-${style.paddingRight}`;
    if (/flex/.test(style.display)) {
      // as an item of the column it takes no room in it
      const gap = style.rowGap === 'normal' ? '0px' : style.rowGap;
      x.style.alignSelf = 'flex-end';
      x.style.flex = 'none';
      x.style.marginBottom = `calc(${style.paddingTop} - 30px - ${gap})`;
    }
    card.prepend(x);
  } else {
    card.append(x);
  }
  card.querySelectorAll(WIN_OWN_CLOSE).forEach((old) => {
    if (old !== x) old.classList.add('hidden');
  });
  paintWindowButtons(card);
  new MutationObserver(() => paintWindowButtons(card)).observe(card, { subtree: true, childList: true, characterData: true });
}

// A window that opens with the keyboard on its way out: the X, in place of the close it had.
function focusWindowX(el) {
  const card = el && el.closest(WIN_CARDS);
  if (!card) return;
  dressWindow(card); // it may have reached the page just now
  const x = card.querySelector(':scope > .win-x');
  if (x) x.focus();
}

function dressWindowsIn(node) {
  if (node.nodeType !== 1) return;
  if (node.matches(WIN_CARDS)) dressWindow(node);
  node.querySelectorAll(WIN_CARDS).forEach(dressWindow);
}

dressWindowsIn(document.body);
// the windows made later are added to the page itself
new MutationObserver((records) => {
  records.forEach((r) => r.addedNodes.forEach(dressWindowsIn));
}).observe(document.body, { childList: true });

// -- A list to choose several from (Pull, Fetch, Remove, Stash): a bar above it says what is chosen, each with its ×, so it
// shows with the groups closed or a filter on. It stays one line, so the list does not move under the mouse: what does not
// fit is "+N more", which opens it. With all of them chosen it says so, not a line of names. --
const chosenBarWatch = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (target.offsetWidth !== target.chosenWidth) fitChosenBar(target);
  }
});

// items: [{ key, label, title }]. onTake(key) takes one out and draws the bar again; out: where the focus goes after the last.
function renderChosenBar(bar, { items, total, allText, onTake, out }) {
  if (!bar.chosenWatched) {
    bar.chosenWatched = true;
    chosenBarWatch.observe(bar);
  }
  const grew = items.length > (bar.chosenCount || 0);
  bar.chosenCount = items.length;
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'choose-label';
  label.textContent = 'Chosen';
  bar.appendChild(label);
  if (!items.length || (items.length === total && total > 1)) {
    const text = document.createElement('span');
    text.className = 'choose-text';
    text.textContent = items.length ? allText : 'None yet';
    bar.appendChild(text);
    bar.classList.remove('open');
    return;
  }
  items.forEach((item, i) => {
    const chip = document.createElement('span');
    chip.className = 'choose-chip';
    chip.title = item.title || item.label;
    const name = document.createElement('span');
    name.className = 'choose-chip-name';
    name.textContent = item.label;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'choose-x';
    x.setAttribute('aria-label', `Take ${item.label} out`);
    x.innerHTML = WIN_X_SVG;
    x.addEventListener('click', () => {
      onTake(item.key);
      const left = [...bar.querySelectorAll('.choose-chip:not(.hidden) .choose-x')];
      const next = left[Math.min(i, left.length - 1)] || out;
      if (next) next.focus();
    });
    chip.append(name, x);
    bar.appendChild(chip);
  });
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'choose-more';
  more.addEventListener('click', () => {
    bar.classList.toggle('open');
    fitChosenBar(bar);
    more.focus();
  });
  bar.appendChild(more);
  fitChosenBar(bar);
  if (grew && bar.classList.contains('open')) bar.scrollTop = bar.scrollHeight;
}

// How many fit on the line is only known once drawn; in a window still hidden, the watcher above does it when it shows.
function fitChosenBar(bar) {
  bar.chosenWidth = bar.offsetWidth;
  const more = bar.querySelector('.choose-more');
  if (!more || !bar.offsetWidth) return;
  const open = bar.classList.contains('open');
  const chips = [...bar.querySelectorAll('.choose-chip')];
  bar.classList.remove('open');
  chips.forEach((c) => c.classList.remove('hidden'));
  more.classList.add('hidden');
  const line = chips[0].offsetTop;
  let shown = chips.filter((c) => c.offsetTop === line).length;
  if (shown === chips.length) return;
  more.classList.remove('hidden');
  if (open) {
    bar.classList.add('open');
    more.textContent = 'Less';
    return;
  }
  for (; shown >= 1; shown -= 1) {
    chips.forEach((c, i) => c.classList.toggle('hidden', i >= shown));
    more.textContent = `+${chips.length - shown} more`;
    if (more.offsetTop === line || shown === 1) break;
  }
}
