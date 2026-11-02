// -- Fetch, pull and push on screen: a card over the page while git talks to origin. This branch on the left, origin
// on the right, a tube between them with arrows that light up in turn the way the commits go: from origin for a pull
// (blue), to origin for a push (green); a fetch only looks (grey, the tube dashed): what comes stays in origin/<branch>
// and the branch is not changed. When it is done the card says what happened, then goes; an error closes it (the
// error is a toast, as before). --
const SC_ICONS = {
  laptop: '<path d="M3 19l18 0"/><path d="M5 6m0 1a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v8a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1z"/>',
  cloud: '<path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878"/>',
  left: '<path d="M15 6l-6 6l6 6"/>',
  right: '<path d="M9 6l6 6l-6 6"/>',
  check: '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9 12l2 2l4 -4"/>',
};
const SC_MIN_MS = 700; // shown at least this long, so a quick fetch is seen to happen
const SC_DONE_MS = 1500;
let syncCard = null; // { el, kind, at, timer }

const scSvg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${SC_ICONS[name]}</svg>`;

function syncCardEl() {
  let el = $('#syncCard');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'syncCard';
  el.className = 'sync-card-overlay hidden';
  el.innerHTML = `
    <div class="sync-card" role="status" aria-live="polite">
      <div class="sc-ends">
        <div class="sc-end">${scSvg('laptop')}<span class="sc-branch"></span></div>
        <div class="sc-tube"></div>
        <div class="sc-end">${scSvg('cloud')}<span class="sc-remote"></span></div>
      </div>
      <div class="sc-msg"><span class="sc-check">${scSvg('check')}</span><span class="sc-text"></span></div>
    </div>`;
  document.body.appendChild(el);
  // once it is done: a click or Esc closes it at once
  el.addEventListener('mousedown', () => {
    if (el.classList.contains('done')) hideSyncCard();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('done') && !el.classList.contains('hidden')) hideSyncCard();
  });
  return el;
}

// kind: fetch, pull or push; branch: this branch; remote: origin; text: what it says while it runs.
function showSyncCard(kind, { branch, remote, text }) {
  const el = syncCardEl();
  clearTimeout(syncCard && syncCard.timer);
  el.className = `sync-card-overlay kind-${kind}`;
  el.querySelector('.sc-branch').textContent = branch || 'HEAD';
  el.querySelector('.sc-remote').textContent = remote || 'origin';
  // three arrows, lit one after the other towards where the commits go
  const way = kind === 'push' ? 'right' : 'left';
  el.querySelector('.sc-tube').innerHTML = scSvg(way).repeat(3);
  el.querySelector('.sc-tube').dataset.way = way;
  el.querySelector('.sc-text').textContent = text;
  syncCard = { el, kind, at: Date.now(), timer: null };
  requestAnimationFrame(() => el.classList.add('show'));
}

// Done: what happened, for a moment (after the card has been seen to run).
async function doneSyncCard(text) {
  const card = syncCard;
  if (!card) return;
  const wait = SC_MIN_MS - (Date.now() - card.at);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (syncCard !== card) return;
  card.el.classList.add('done');
  card.el.querySelector('.sc-text').textContent = text;
  card.timer = setTimeout(hideSyncCard, SC_DONE_MS);
}

function hideSyncCard() {
  if (!syncCard) return;
  const { el } = syncCard;
  clearTimeout(syncCard.timer);
  syncCard = null;
  el.classList.remove('show');
  setTimeout(() => {
    if (!syncCard) el.classList.add('hidden');
  }, 160);
}

// The remote of this branch (origin, from origin/main), and this branch, for the card.
function syncCardEnds() {
  const upstream = gitLine && gitLine.upstream;
  return { branch: (gitLine && gitLine.branch) || $('#currentBranch').textContent, remote: upstream ? upstream.split('/')[0] : 'origin' };
}
