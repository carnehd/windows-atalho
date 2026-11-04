// Run by Git Quick with the computer's Node (or its own, as Node), not inside the app:
// `node bruno-runner.js <cli folder> <vars file> run ...`.
// It starts the Bruno CLI as `bru` would, with two things added around each request it sends:
//  - the variables the scripts set (bru.setVar) are there from the start, as the last run left them, and saved after
//    each request, so a request sent alone can use what an earlier one kept (the id of what it created);
//  - each result is printed on a line of its own, marked, for Git Quick to show it while the rest still runs.
// The app copies this file next to its settings before it runs it (a file inside the packed app cannot be run by Node).
'use strict';
const fs = require('fs');
const path = require('path');

// Run by the app itself as Node (ELECTRON_RUN_AS_NODE: the Bruno CLI Git Quick installed), whose Node is 18: what the
// CLI takes from a newer one (crypto on globalThis), and its arguments read as Node's (yargs takes them for a packed
// Electron app's otherwise, one fewer).
if (process.versions.electron) {
  if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
  process.defaultApp = true;
}

const MARK = '\u001eGQ-BRUNO ';
// A variable a script set to undefined (res.body.id of a list): JSON would leave it out, so it is kept as this mark, for
// Git Quick to show it set without a value, and undefined again in the next run.
const UNSET = '$gitQuickUndefined';
const MAX_BODY = 512 * 1024;
const [cliDir, varsFile, ...args] = process.argv.slice(2);

let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(varsFile, 'utf8')) || {};
} catch {
  saved = {};
}

// A body as it can travel: text and JSON as they are (cut when very long), a file as its size.
function body(data) {
  if (data === undefined || data === null) return data;
  if (Buffer.isBuffer(data)) return { binary: data.length };
  if (data.type === 'Buffer' && Array.isArray(data.data)) return { binary: data.data.length };
  if (typeof data === 'string') return data.length > MAX_BODY ? `${data.slice(0, MAX_BODY)}\n... (cut: ${data.length} characters)` : data;
  try {
    const text = JSON.stringify(data);
    return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n... (cut: ${text.length} characters)` : data;
  } catch {
    return String(data);
  }
}

const checks = (list, name) => (Array.isArray(list) ? list : []).map((c) => ({ name: name(c), status: c.status, error: c.error ? String(c.error) : null }));

function report(result) {
  if (!result || typeof result !== 'object') return;
  const req = result.request || {};
  const res = result.response || {};
  const out = {
    file: result.test && result.test.filename,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : null,
    request: { method: req.method, url: req.url, headers: req.headers, data: body(req.data) },
    response: { status: res.status, statusText: res.statusText, headers: res.headers, data: body(res.data), time: res.responseTime, size: res.size },
    asserts: checks(result.assertionResults, (a) => `${a.lhsExpr}: ${a.rhsExpr}`),
    tests: checks([...(result.preRequestTestResults || []), ...(result.testResults || []), ...(result.postResponseTestResults || [])], (t) => t.description),
  };
  // the CLI says "pass" for a request it sent, even when one of its checks failed: then it failed
  if (out.status === 'pass' && [...out.asserts, ...out.tests].some((c) => c.status === 'fail' || c.status === 'error')) out.status = 'fail';
  process.stdout.write(`\n${MARK}${JSON.stringify(out)}\n`);
}

// Bruno 4 takes the variables back from a script through JSON, which leaves out one set to undefined: bru.setVar itself
// says which were, and which a script deleted (bru.deleteVar), so that one shows as set without a value until then.
const setUndefined = new Set();
const forgotten = new Set();
let forgotAll = false;
try {
  const js = [path.join(cliDir, 'node_modules', '@usebruno', 'js'), path.join(cliDir, '..', 'js')].find((d) => fs.existsSync(path.join(d, 'src', 'bru.js')));
  const proto = js && require(path.join(js, 'src', 'bru.js')).prototype;
  if (proto && typeof proto.setVar === 'function' && typeof proto.deleteVar === 'function') {
    const { setVar, deleteVar, deleteAllVars } = proto;
    proto.setVar = function (key, value) {
      const r = setVar.call(this, key, value);
      if (value === undefined) setUndefined.add(key);
      else setUndefined.delete(key);
      forgotten.delete(key);
      return r;
    };
    proto.deleteVar = function (key) {
      setUndefined.delete(key);
      forgotten.add(key);
      return deleteVar.call(this, key);
    };
    if (typeof deleteAllVars === 'function') {
      proto.deleteAllVars = function (...a) {
        setUndefined.clear();
        forgotAll = true;
        return deleteAllVars.apply(this, a);
      };
    }
  }
} catch {
  // an undefined one is then left out, as Bruno does
}

function keep(vars) {
  try {
    const out = {};
    for (const [key, value] of Object.entries(vars)) out[key] = value === undefined ? { [UNSET]: true } : value;
    for (const key of setUndefined) if (!(key in out)) out[key] = { [UNSET]: true };
    // one an earlier run left undefined, still so unless a script deleted it
    for (const [key, value] of Object.entries(saved)) if (value && value[UNSET] && !(key in out) && !forgotAll && !forgotten.has(key)) out[key] = value;
    fs.writeFileSync(varsFile, JSON.stringify(out));
  } catch {
    // not kept: the next run starts without them
  }
}

try {
  const mod = require(path.join(cliDir, 'src', 'runner', 'run-single-request.js'));
  const send = mod && mod.runSingleRequest;
  if (typeof send === 'function') {
    const seeded = new WeakSet();
    mod.runSingleRequest = async function (item, collectionPath, runtimeVariables, ...rest) {
      const vars = runtimeVariables && typeof runtimeVariables === 'object' ? runtimeVariables : null;
      if (vars && !seeded.has(vars)) {
        seeded.add(vars);
        for (const [key, value] of Object.entries(saved)) if (!(key in vars)) vars[key] = value && value[UNSET] ? undefined : value;
      }
      const result = await send.call(this, item, collectionPath, runtimeVariables, ...rest);
      if (vars) keep(vars);
      try {
        report(result);
      } catch {
        // the result still reaches the JSON report
      }
      return result;
    };
  } else process.stdout.write(`\n${MARK}${JSON.stringify({ warning: 'This Bruno CLI is not one Git Quick knows: the variables are not kept between runs' })}\n`);
} catch {
  process.stdout.write(`\n${MARK}${JSON.stringify({ warning: 'This Bruno CLI is not one Git Quick knows: the variables are not kept between runs' })}\n`);
}

process.argv = [process.argv[0], path.join(cliDir, 'bin', 'bru.js'), ...args];
require(path.join(cliDir, 'src')).run();
