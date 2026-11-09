// QuickDeck's loading icon, variant "Sincronizado": the back card of the app icon stays, and the front card (the one
// with the bolt) flips once for each turn of the ring around it. It is for the places where the app is blocked waiting
// for an answer: the full-window loading (showLoading in app.js) and the switch to another repository.
//
// Slots in index.html, <span class="qd-loader-slot" data-size="72"></span>, are filled when this file loads;
// qdLoaderMarkup(size) gives the same SVG for code that builds its own markup. The look and the animation are in
// styles.css (.qd-loader).
let qdLoaderCount = 0;

function qdLoaderMarkup(size) {
  // Its own gradient id for each copy: an id used by two SVGs in one page is not valid, and a gradient in a hidden
  // SVG does not paint for the others.
  const tile = `qdTile${++qdLoaderCount}`;
  return `<svg class="qd-loader" viewBox="-8 -8 80 80" width="${size}" height="${size}" role="img" aria-label="Loading">`
    + `<defs><linearGradient id="${tile}" x1="0" y1="0" x2="1" y2="1">`
    + '<stop offset="0" stop-color="#2f6df6"/><stop offset="1" stop-color="#7b3fe4"/></linearGradient></defs>'
    + `<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#${tile})"/>`
    + '<g class="qd-back"><rect x="13" y="16" width="26" height="34" rx="5" fill="none" stroke="#fff" stroke-width="3.5"'
    + ' opacity=".55" transform="rotate(-14 26 33)"/></g>'
    + '<g class="qd-front"><path fill="#fff" fill-rule="evenodd" transform="rotate(6 33 31)"'
    + ' d="M25 13h16a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H25a5 5 0 0 1-5-5V18a5 5 0 0 1 5-5zM36 18 27 33h7l-3 13 10-16h-7z"/></g>'
    + '<circle class="qd-loader-track" cx="32" cy="32" r="38" fill="none" stroke-width="2.5"/>'
    + '<circle class="qd-ring" cx="32" cy="32" r="38" fill="none" stroke="#5a55ee" stroke-width="2.5"'
    + ' stroke-linecap="round" stroke-dasharray="55 184"/>'
    + '</svg>';
}

function qdLoaderFill() {
  document.querySelectorAll('.qd-loader-slot').forEach((slot) => {
    if (slot.firstElementChild) return;
    slot.innerHTML = qdLoaderMarkup(Number(slot.dataset.size) || 72);
  });
}

qdLoaderFill();
