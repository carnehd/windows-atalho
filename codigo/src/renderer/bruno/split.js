// -- The lines that share out the room of the Bruno tab, both dragged sideways: one between the requests and the
// request open, one between the request and what came back. Each stays where it was left; Left and Right move it too,
// and a double click puts it back as it was. A row of tabs keeps only the main ones in sight, the others behind a
// button at its end; wider than its pane, it scrolls sideways, faded on the side with more. --
const BRU_TREE_KEY = 'brunoTreeWidth';
const BRU_SPLIT_KEY = 'brunoReqWidth';

// line: the separator. box holds the CSS variable `prop` with the width of `part`; clamp(px) is the width it can take.
function bruDragLine({ line, box, prop, part, key, clamp }) {
  const width = () => part.getBoundingClientRect().width;
  const set = (px) => {
    const v = Math.round(clamp(px));
    box.style.setProperty(prop, `${v}px`);
    return v;
  };
  const keep = (v) => {
    try {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(v));
    } catch {
      // only for this session
    }
  };
  try {
    const saved = Number(localStorage.getItem(key));
    if (saved) box.style.setProperty(prop, `${saved}px`);
  } catch {
    // the default then
  }
  line.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = e.clientX;
    const start = width();
    let last = start;
    document.body.classList.add('bru-resizing');
    const move = (ev) => {
      last = set(start + ev.clientX - from);
    };
    const up = () => {
      document.body.classList.remove('bru-resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      keep(last);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  line.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    keep(set(width() + (e.key === 'ArrowRight' ? 24 : -24)));
  });
  line.addEventListener('dblclick', () => {
    box.style.removeProperty(prop);
    keep(null);
  });
}

function setupBrunoSplits() {
  const body = $('#tab-bruno .bru-body');
  // the requests: from 180px, leaving the request open 360px past the 1px line (the CSS keeps the same bounds when the
  // window narrows)
  bruDragLine({
    line: $('#bruTreeSplit'),
    box: body,
    prop: '--bru-tree-w',
    part: $('#bruTree'),
    key: BRU_TREE_KEY,
    clamp: (px) => Math.max(180, Math.min(body.clientWidth - 361, px)),
  });
  // the request: from 240px, leaving 320px to the response past the 11px line (its tabs and status), as in the CSS
  const panes = $('#bruPanes');
  bruDragLine({
    line: $('#bruSplit'),
    box: panes,
    prop: '--bru-req-w',
    part: $('#bruReqSide'),
    key: BRU_SPLIT_KEY,
    clamp: (px) => Math.max(240, Math.min(panes.clientWidth - 331, px)),
  });
  try {
    localStorage.removeItem('brunoSplit'); // the height the request had when it was over the response
  } catch {
    // nothing kept
  }
}

// The button at the end of a row of tabs, for the tabs not always in sight: "More", or the one of them open (marked as
// the tab open). items: [key, label, count, 'fail' for a count in red]; alert: something to see in one of them (checks
// that failed). It is a dropdown under the label, so select-menu.js draws its list as for every dropdown (the keys, a
// click outside).
function bruMoreTab(row, items, current, pick, { disabled = false, alert = false } = {}) {
  const shown = items.find(([key]) => key === current);
  const box = bruEl('span', `bru-tab bru-tab-more${shown ? ' active' : ''}${disabled ? ' disabled' : ''}`);
  box.appendChild(bruEl('span', '', shown ? shown[1] : 'More'));
  if (shown && shown[2] !== '') box.appendChild(bruEl('span', `bru-tab-count${shown[3] ? ` ${shown[3]}` : ''}`, String(shown[2])));
  if (alert && !shown) box.appendChild(bruEl('span', 'bru-more-alert'));
  box.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'More tabs');
  select.title = items.map(([, label]) => label).join(', ');
  select.disabled = disabled;
  const none = new Option('More', '');
  none.hidden = true;
  select.appendChild(none);
  for (const [key, label, count] of items) select.appendChild(new Option(count !== '' ? `${label} \u00b7 ${count}` : label, key));
  select.value = shown ? current : '';
  select.addEventListener('change', () => {
    pick(select.value);
    // the row was drawn again: the focus on its button, as on the one picked from
    const again = row.querySelector('.bru-tab-more select');
    if (again) again.focus();
  });
  box.appendChild(select);
  row.appendChild(box);
}

// The fades of a row of tabs: on the side(s) where some are out of sight.
function bruTabsEdge(row) {
  const more = row.scrollWidth - row.clientWidth;
  row.classList.toggle('more-left', more > 1 && row.scrollLeft > 1);
  row.classList.toggle('more-right', more > 1 && row.scrollLeft < more - 1);
}

// The tab chosen in sight (not scrollIntoView: it would scroll the boxes around the row too).
function bruTabInSight(row) {
  const on = row.querySelector('.bru-tab.active');
  if (!on) return;
  if (on.offsetLeft < row.scrollLeft) row.scrollLeft = on.offsetLeft;
  else if (on.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = on.offsetLeft + on.offsetWidth - row.clientWidth;
}

// The status on the line of the response's tabs: the tabs first, then the status code; the size, the time, then the
// words after the code ("OK") are left out while the tabs do not fit beside them.
function bruFitStatus() {
  const tabs = $('#bruTabs');
  const parts = [...$$('#bruStatusLine .bru-meta')].reverse();
  const reason = $('#bruStatusLine .bru-reason');
  if (reason) parts.push(reason);
  parts.forEach((m) => {
    m.hidden = false;
  });
  for (const m of parts) {
    if (tabs.scrollWidth <= tabs.clientWidth + 1) break;
    m.hidden = true;
  }
  bruTabsEdge(tabs);
}

function setupBrunoTabRows() {
  const rows = [$('#bruEditTabs'), $('#bruTabs')];
  const sized = new ResizeObserver(() => rows.forEach(bruTabsEdge));
  new ResizeObserver(bruFitStatus).observe($('#bruResSide'));
  rows.forEach((row) => {
    sized.observe(row);
    row.addEventListener('scroll', () => bruTabsEdge(row));
    // drawn again (another request, another tab): the one chosen in sight
    new MutationObserver(() => {
      bruTabInSight(row);
      bruTabsEdge(row);
    }).observe(row, { childList: true });
    // a mouse wheel moves it sideways
    row.addEventListener('wheel', (e) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    }, { passive: false });
  });
}
