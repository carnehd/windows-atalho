// -- Bruno takes the room of the repositories: the list folds to a thin bar each time the Bruno view opens, and comes
// back with Git or Maven. The bar opens it again (a click anywhere on it); while it is open in Bruno, the button in its
// header folds it back. --
let bruSideOpen = false; // opened by hand in Bruno; folded again the next time Bruno opens

const BRU_SIDE_ICON = (arrow) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M9 4v16"/><path d="${arrow}"/></svg>`;

// From applyGitView, each time the view on show is set.
function brunoSidebar(view) {
  const page = $('#gitView');
  const unfold = $('#sideUnfoldBtn');
  if (!page || !unfold) return;
  if (view !== 'bruno') bruSideOpen = false;
  const folded = view === 'bruno' && !bruSideOpen;
  const was = page.classList.contains('side-folded');
  page.classList.toggle('side-folded', folded);
  page.classList.toggle('side-bruno', view === 'bruno');
  unfold.setAttribute('aria-expanded', String(!folded));
  // the tabs moved with the page: the line under them follows
  if (was !== folded) requestAnimationFrame(placeViewLine);
}

function setupBrunoSidebar() {
  const aside = $('#gitView .sidebar');
  const unfold = bruEl('button', 'side-unfold');
  unfold.id = 'sideUnfoldBtn';
  unfold.type = 'button';
  unfold.title = 'Show the repositories';
  unfold.setAttribute('aria-label', 'Show the repositories');
  unfold.innerHTML = `${BRU_SIDE_ICON('M14 10l2 2l-2 2')}<span class="side-unfold-label">Repositories</span>`;
  unfold.addEventListener('click', () => {
    bruSideOpen = true;
    brunoSidebar(effectiveGitView());
    $('#sideFoldBtn').focus();
  });
  aside.prepend(unfold);

  const fold = bruEl('button', 'side-fold');
  fold.id = 'sideFoldBtn';
  fold.type = 'button';
  fold.title = 'Hide the repositories: more room for Bruno';
  fold.setAttribute('aria-label', 'Hide the repositories');
  fold.innerHTML = BRU_SIDE_ICON('M15 10l-2 2l2 2');
  fold.addEventListener('click', () => {
    bruSideOpen = false;
    brunoSidebar(effectiveGitView());
    unfold.focus();
  });
  $('#gitView .sidebar-header').appendChild(fold);
  brunoSidebar(effectiveGitView());
}
