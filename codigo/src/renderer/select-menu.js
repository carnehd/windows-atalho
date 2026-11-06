// Every dropdown (<select>) opens a list drawn by the app, the same on Windows and on a Mac, instead of the system's.
// The select stays what is chosen: a pick sets its value and fires its change event, as the system list does, so the
// code around each dropdown is the same. Hidden options (a placeholder such as "+ Add a step...") are not listed. A
// dropdown with a list of its own (the Maven command, with its macros) is marked data-own-menu. A long list (10
// entries or more), or a dropdown marked data-search, has a search field at the top.
(() => {
  let open = null; // { select, menu, search, filter }
  const SEARCH_FROM = 10;

  const ours = (el) => el instanceof HTMLSelectElement && !el.multiple && el.size <= 1 && !el.disabled && !el.hasAttribute('data-own-menu');
  const items = () => (open ? [...open.menu.querySelectorAll('.sel-item:not(:disabled):not([hidden])')] : []);

  // The entries with the text typed (a group's name only while one of its entries is left), "Nothing matches" else.
  function filterMenu(menu, text, none) {
    const q = text.trim().toLowerCase();
    let shown = 0;
    let group = null;
    let inGroup = 0;
    const settle = () => {
      if (group) group.hidden = !inGroup;
    };
    for (const el of menu.children) {
      if (el.classList.contains('sel-group')) {
        settle();
        group = el;
        inGroup = 0;
      } else if (el.classList.contains('sel-item')) {
        const on = !q || el.textContent.toLowerCase().includes(q);
        el.hidden = !on;
        if (on) {
          shown++;
          inGroup++;
        }
      }
    }
    settle();
    none.hidden = shown > 0;
  }

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
    const count = menu.querySelectorAll('.sel-item').length;
    if (!count) return;
    let search = null;
    let filter = () => {};
    if (select.hasAttribute('data-search') || count >= SEARCH_FROM) {
      const box = document.createElement('div');
      box.className = 'sel-search';
      search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Search';
      search.spellcheck = false;
      search.setAttribute('autocomplete', 'off');
      search.setAttribute('aria-label', 'Search the list');
      box.appendChild(search);
      const none = document.createElement('div');
      none.className = 'sel-none';
      none.textContent = 'Nothing matches';
      none.hidden = true;
      menu.prepend(box);
      menu.appendChild(none);
      filter = () => filterMenu(menu, search.value, none);
      search.addEventListener('input', filter);
    }
    // under the dropdown, at least as wide; above it when there is more room there (held by its bottom, so a list
    // narrowed by the search stays by the dropdown); as wide while it is narrowed
    const a = select.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(a.width)}px`;
    document.body.appendChild(menu);
    const m = menu.getBoundingClientRect();
    const below = window.innerHeight - a.bottom - 12;
    const above = a.top - 12;
    const up = m.height > below && above > below;
    const room = Math.max(120, up ? above : below);
    menu.style.maxHeight = `${room}px`;
    if (search) menu.style.width = `${Math.ceil(m.width)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8)))}px`;
    if (up) menu.style.bottom = `${Math.round(window.innerHeight - a.top + 4)}px`;
    else menu.style.top = `${Math.round(a.bottom + 4)}px`;
    open = { select, menu, search, filter };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('scroll', onScroll, true);
    const current = menu.querySelector('.sel-item.current:not(:disabled)') || items()[0];
    if (current) {
      if (!search) current.focus();
      current.scrollIntoView({ block: 'nearest' });
    }
    if (search) search.focus();
  }

  // While a list is open its keys come first (before the shortcuts of the page and of a dialog): arrows, Enter, Esc,
  // and the first letters of an entry (or of a word in it) to go to it. In the search field: what is typed narrows
  // the list, Down goes into it, Enter takes the first entry left, Esc clears the text (then closes).
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
    const { search } = open;
    if (search && document.activeElement === search) {
      if (e.key === 'ArrowDown') {
        handled();
        go(0);
      } else if (e.key === 'Enter') {
        handled();
        const current = search.value.trim() ? null : all.find((b) => b.classList.contains('current'));
        if (current || all[0]) (current || all[0]).click();
      } else if (e.key === 'Escape') {
        handled();
        if (search.value) {
          search.value = '';
          open.filter();
        } else closeSelectMenu(true);
      } else if (e.key === 'Tab') {
        closeSelectMenu(true);
      } else {
        // the field's own keys (typing, Backspace, the arrows along the text); not the page's
        e.stopImmediatePropagation();
      }
      return;
    }
    if (search && e.key === 'ArrowUp' && i <= 0) {
      handled();
      search.focus();
      return;
    }
    // typed on an entry of a list with a search: it goes to the search
    if (search && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handled();
      search.focus();
      search.value += e.key;
      open.filter();
      return;
    }
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

  // A press in the list is a press on its dropdown, as in the system's list: the page does not hear it, so a menu or a
  // form the dropdown is in (New branch..., in the branch list) does not take it for a press outside and close.
  window.addEventListener('mousedown', (e) => {
    if (open && open.menu.contains(e.target)) e.stopPropagation();
  }, true);
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
