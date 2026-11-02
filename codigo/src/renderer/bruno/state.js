// Bruno tab (renderer/bruno/): state.js the state and small helpers; view.js loading a collection, the bar; tree.js the
// requests on the left; req-menu.js a request's right-click menu; kv.js the parts of the editors; var-pick.js the
// list of variables a click on a {{variable}} opens; editor.js the request chosen, to change; response.js what came
// back; run.js sending with the Bruno CLI; vars.js the variables kept; envs.js the environments; sidebar.js the
// repositories folded away while Bruno is open; setup.js the events.
// They share these globals, as the other scripts of the page do.
// -- Bruno: the requests of the repository's Bruno collection, sent from here with the Bruno CLI. On the left its
// folders and requests, each with how it went the last time; on the right the request chosen: Send, then what came
// back (status, time, body, headers), its checks (asserts and tests) and what was sent. Run all / a folder's ▶ send
// many, in the collection's order; the results come in one by one. What the scripts keep (bru.setVar, as the id of
// what a request created) stays for the next sends until the app closes, as in Bruno. --
const BRU_ENV_KEY = 'brunoEnv'; // { [collection folder]: environment }
const BRU_DIR_KEY = 'brunoCollection'; // { [repository]: collection folder }
const BRU_TABS = [['response', 'Response'], ['headers', 'Headers'], ['checks', 'Checks'], ['sent', 'Sent'], ['log', 'Log']];
const BRU_TABS_SHOWN = 2; // Response and Headers in sight; the others from the button at the end
const BRU_MAX_LOG = 400000;

const bru = {
  repo: null,
  collections: [],
  dir: null,
  tree: [],
  envs: [],
  env: '',
  dotenv: null, // the collection's .env: { names: [{ key, value, set }], git: 'ignored' | 'tracked' | 'open' | null }; none: null
  vars: {},
  detail: null, // the chosen request as its file says
  editShown: null, // which request and tab the editor shows (drawn again only when that changes)
  run: null, // { id, dir, target, label, env, startedAt, queued: Set, pass, fail }
  cli: null,
};
// per collection: the last results, the log, the chosen request, the closed folders, the tabs, and the drafts of the
// requests changed here (editor.js)
const bruByDir = new Map();

function bruState(dir = bru.dir) {
  if (!bruByDir.has(dir)) bruByDir.set(dir, { results: new Map(), log: '', selected: null, closed: new Set(), tab: 'response', editTab: 'params', drafts: new Map() });
  return bruByDir.get(dir);
}

const bruLoad = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
};
const bruSave = (key, k, v) => {
  try {
    localStorage.setItem(key, JSON.stringify({ ...bruLoad(key), [k]: v }));
  } catch {
    // only for this session
  }
};

// A variable a script set to undefined (res.body.id when the body is a list): kept as a mark by bruno/runner.js.
const bruUnset = (v) => Boolean(v && typeof v === 'object' && v.$gitQuickUndefined === true);
const BRU_UNSET_NOTE = 'A script set it to undefined: what it read had nothing there (res.body.id when the body is a list?)';

// {{process.env.NAME}}: NAME from the collection's .env, its value as it is (as the Bruno app shows it), else only the
// system's environment could give it.
const bruDotEnv = (key) => (bru.dotenv && bru.dotenv.names.find((n) => n.key === key)) || null;
const bruProcessRefs = (text) => [...String(text).matchAll(/\{\{\s*process\.env\.([^}\s]+)\s*\}\}/g)].map((m) => m[1]);
const bruProcessNote = (key) => {
  const own = bruDotEnv(key);
  return `${key}: ${own ? (own.set ? `${own.value} (from .env)` : 'in .env, empty') : `not in .env${bru.dotenv ? '' : ' (the collection has none)'}: only the system's environment could give it`}`;
};
// what git does with the .env: a line when its secrets could go in a commit
const BRU_DOTENV_GIT = {
  tracked: '.env is in git: its secrets go with every clone. Take it out (git rm --cached .env) and add it to .gitignore.',
  open: '.env is not in .gitignore: a commit of everything would take its secrets.',
};

function bruEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function brunoAvailable() {
  return bru.repo === currentRepo && bru.collections.length > 0;
}

// The requests under a folder ('' for all), in the order of the list (the order a run goes).
function bruRequests(items = bru.tree, under = '') {
  const out = [];
  const walk = (list) => list.forEach((it) => (it.type === 'folder' ? walk(it.items) : out.push(it)));
  if (!under) walk(items);
  else {
    const find = (list) => {
      for (const it of list) {
        if (it.type !== 'folder') continue;
        if (it.path === under) return walk(it.items);
        find(it.items);
      }
    };
    find(items);
  }
  return out;
}

const bruFind = (rel) => bruRequests().find((r) => r.path === rel) || null;
