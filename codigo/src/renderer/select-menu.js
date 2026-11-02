// Every dropdown (<select>) opens a list drawn by the app, the same on Windows and on a Mac, instead of the system's.
// The select stays what is chosen: a pick sets its value and fires its change event, as the system list does, so the
// code around each dropdown is the same. Hidden options (a placeholder such as "+ Add a step...") are not listed. A
// dropdown with a list of its own (the Maven command, with its macros) is marked data-own-menu.
(() => {
  let open = null; // { select, menu }

  const ours = (el) => el instanceof HTMLSelectElement && !el.multiple && el.size <= 1 && !el.disabled && !el.hasAttribute('data-own-menu');
  const items = () => (open ? [...open.menu.querySelectorAll('.sel-item:not(:disabled)')] : []);

  function closeSelectMenu(refocus = false) {
    if (!open) return;
    const { select, menu } = open;
    open = null;
    menu.remove();
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('scroll', onScroll, true);
    if (refocus && select.isConnected) select.focus();
  }

  function pick(select, value) {
    closeSelectMenu(true);
    if (value === select.value) return;
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openSelectMenu(select) {
    closeSelectMenu();
    const menu = document.createElement('div');
    menu.className = 'clip-menu sel-menu';
    menu.setAttribute('role', 'listbox');
    if (select.getAttribute('aria-label')) menu.setAttribute('aria-label', select.getAttribute('aria-label'));
    const cs = getComputedStyle(select);
    menu.style.fontFamily = cs.fontFamily;
    menu.style.fontSize = cs.fontSize;
    const item = (o) => {
      const b = document.createElement('button');
      b.type = 'button';
      const on = o.selected;
      b.className = `clip-menu-item sel-item${on ? ' current' : ''}`;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(on));
      b.disabled = o.disabled;
      if (o.title) b.title = o.title;
      b.innerHTML = '<svg class="sel-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';
      const text = document.createElement('span');
      text.className = 'sel-label';
      text.textContent = o.textContent;
      b.appendChild(text);
      b.addEventListener('click', () => pick(select, o.value));
      return b;
    };
    for (const child of select.children) {
      if (child.tagName === 'OPTION') {
        if (!child.hidden) menu.appendChild(item(child));
      } else if (child.tagName === 'OPTGROUP') {
        const shown = [...child.children].filter((o) => o.tagName === 'OPTION' && !o.hidden);
        if (!shown.length) continue;
        const head = document.createElement('div');
        head.className = 'sel-group';
        head.textContent = child.label;
        menu.appendChild(head);
        shown.forEach((o) => menu.appendChild(item(o)));
      }
    }
    if (!menu.querySelector('.sel-item')) return;
    // under the dropdown, at least as wide; above it when there is more room there
    const a = select.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(a.width)}px`;
    document.body.appendChild(menu);
    const m = menu.getBoundingClientRect();
    const below = window.innerHeight - a.bottom - 12;
    const above = a.top - 12;
    const up = m.height > below && above > below;
    const room = Math.max(120, up ? above : below);
    menu.style.maxHeight = `${room}px`;
    const height = Math.min(m.height, room);
    menu.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8)))}px`;
    menu.style.top = `${Math.round(up ? a.top - 4 - height : a.bottom + 4)}px`;
    open = { select, menu };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('scroll', onScroll, true);
    const current = menu.querySelector('.sel-item.current:not(:disabled)') || items()[0];
    if (current) {
      current.focus();
      current.scrollIntoView({ block: 'nearest' });
    }
  }

  // While a list is open its keys come first (before the shortcuts of the page and of a dialog): arrows, Enter, Esc,
  // and the first letters of an entry (or of a word in it) to go to it.
  let typed = '';
  let typedAt = 0;
  function onKey(e) {
    if (!open) return;
    const all = items();
    const i = all.indexOf(document.activeElement);
    const go = (n) => all[Math.max(0, Math.min(all.length - 1, n))] && all[Math.max(0, Math.min(all.length - 1, n))].focus();
    const handled = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.key === 'ArrowDown') {
      handled();
      go(i + 1);
    } else if (e.key === 'ArrowUp') {
      handled();
      go(i - 1);
    } else if (e.key === 'Home' || e.key === 'PageUp') {
      handled();
      go(0);
    } else if (e.key === 'End' || e.key === 'PageDown') {
      handled();
      go(all.length - 1);
    } else if (e.key === 'Enter' || (e.key === ' ' && Date.now() - typedAt > 700)) {
      handled();
      if (all[i]) all[i].click();
    } else if (e.key === 'Escape') {
      handled();
      closeSelectMenu(true);
    } else if (e.key === 'Tab') {
      closeSelectMenu(true);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handled();
      const now = Date.now();
      typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const from = typed.length === 1 ? i + 1 : i;
      const order = [...all.slice(Math.max(0, from)), ...all.slice(0, Math.max(0, from))];
      // the entry that starts with it, else one with a word that does ("t" finds "mvn test")
      const text = (b) => b.textContent.trim().toLowerCase();
      const hit = order.find((b) => text(b).startsWith(typed)) || order.find((b) => text(b).split(/[\s:/._()-]+/).some((w) => w.startsWith(typed)));
      if (hit) hit.focus();
    }
  }

  function onOutside(e) {
    if (open && !open.menu.contains(e.target) && e.target !== open.select) closeSelectMenu();
  }

  // the page scrolled under it: the list would float away from its dropdown
  function onScroll(e) {
    if (open && !open.menu.contains(e.target)) closeSelectMenu();
  }

  document.addEventListener('mousedown', (e) => {
    const select = e.target.closest ? e.target.closest('select') : null;
    if (!select || e.button !== 0 || !ours(select)) return;
    e.preventDefault();
    select.focus();
    if (open && open.select === select) closeSelectMenu();
    else openSelectMenu(select);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (open || !ours(e.target)) return;
    if ([' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key) || (e.altKey && e.key === 'ArrowDown')) {
      e.preventDefault();
      openSelectMenu(e.target);
    }
  }, true);
  window.addEventListener('blur', () => closeSelectMenu());
  window.addEventListener('resize', () => closeSelectMenu());
})();
