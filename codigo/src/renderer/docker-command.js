// -- Tools > Docker command: a docker or podman command (run, create, and the others) laid out an option a line, as a shell
// takes it again (\ in Bash, ` in PowerShell, ^ in cmd), with its variables, ports, mounts and labels apart. It all runs here
// in the window: nothing is run, nothing is sent. Uses the builders of tools.js. --

// The options that take a value after them (docker and podman, run and create): any other is a flag on its own.
const DKC_VALUE = new Set([
  '-e', '--env', '--env-file', '-p', '--publish', '--expose', '-v', '--volume', '--mount', '--tmpfs', '--volumes-from',
  '--name', '-l', '--label', '--label-file', '-h', '--hostname', '--network', '--net', '--network-alias', '--add-host', '--dns',
  '--dns-search', '--dns-option', '--ip', '--ip6', '--mac-address', '-w', '--workdir', '-u', '--user', '--entrypoint',
  '--restart', '-m', '--memory', '--memory-swap', '--memory-reservation', '--cpus', '--cpu-shares', '-c', '--cpuset-cpus',
  '--platform', '--pull', '--device', '--cap-add', '--cap-drop', '--security-opt', '--log-driver', '--log-opt',
  '--health-cmd', '--health-interval', '--health-retries', '--health-timeout', '--health-start-period', '--ulimit',
  '--shm-size', '--stop-signal', '--stop-timeout', '--gpus', '--link', '--annotation', '--secret', '-a', '--attach',
  '--cidfile', '--cgroupns', '--cgroup-parent', '--group-add', '--runtime', '--userns', '--ipc', '--pid', '--uts',
  '--pod', '--arch', '--os', '--variant', '--authfile', '--sysctl', '--storage-opt', '--init-path', '--detach-keys',
  '--blkio-weight', '--oom-score-adj', '--isolation', '--domainname', '--publish-all-ip', '--requires', '--umask',
  '--http-proxy', '--infra-name', '--pidfile', '--uidmap', '--gidmap', '--timeout', '-f', '--file', '-t', '--tag',
  '--build-arg', '--target', '--context', '-H', '--host', '--connection', '--log-level', '--config',
]);
// before the verb, docker -c x / podman --connection x: their own
const DKC_GLOBAL = new Set(['--context', '-c', '-H', '--host', '--connection', '--url', '--log-level', '--config', '--remote']);
const DKC_GROUPS = [
  ['name', 'Name and labels', /^(--name|-l|--label|--label-file|-h|--hostname|--annotation)$/],
  ['ports', 'Ports', /^(-p|--publish|-P|--publish-all|--expose)$/],
  ['env', 'Variables', /^(-e|--env|--env-file)$/],
  ['mounts', 'Mounts', /^(-v|--volume|--mount|--tmpfs|--volumes-from)$/],
  ['network', 'Network', /^(--network|--net|--network-alias|--add-host|--dns|--dns-search|--dns-option|--ip|--ip6|--link)$/],
];
const DKC_SECRET = /pass|secret|token|key|pwd|credential/i;

// Words as a shell reads them: quotes ('...' and "..."), a \ before a space or a quote, and a line that ends in \ ` or ^
// going on with the next. raw: as typed, to give it back the same; value: what the engine gets.
function dkcTokens(text) {
  const s = String(text).replace(/[ \t]+[\\`^][ \t]*\r?\n/g, ' ').replace(/[\\`^]\r?\n/g, ' ').replace(/\r?\n/g, ' ');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let raw = '';
    let value = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === "'") {
        const end = s.indexOf("'", i + 1);
        const stop = end < 0 ? s.length : end;
        value += s.slice(i + 1, stop);
        raw += s.slice(i, stop + 1);
        i = stop + 1;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\' && /["\\$`]/.test(s[j + 1] || '')) {
            value += s[j + 1];
            j += 2;
          } else value += s[j++];
        }
        raw += s.slice(i, j + 1);
        i = j + 1;
      } else if (ch === '\\' && /[\s"'\\$]/.test(s[i + 1] || '')) {
        value += s[i + 1];
        raw += s.slice(i, i + 2);
        i += 2;
      } else {
        value += ch;
        raw += ch;
        i++;
      }
    }
    out.push({ raw, value });
  }
  return out;
}

// { lead (the engine, its own options, the verb), options [{ flag, value, tokens, group }], image, rest (its command) }
function parseDockerCommand(text) {
  const tokens = dkcTokens(text);
  if (!tokens.length) return null;
  let at = 0;
  const lead = [];
  while (at < tokens.length && /^(sudo|winpty|exec)$/.test(tokens[at].value)) lead.push(tokens[at++]);
  const engine = tokens[at] ? tokens[at].value.split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase() : '';
  if (!['docker', 'podman', 'nerdctl'].includes(engine)) return { error: 'Paste a command that starts with docker or podman' };
  lead.push(tokens[at++]);
  while (at < tokens.length && tokens[at].value.startsWith('-')) {
    const t = tokens[at++];
    lead.push(t);
    if (!t.value.includes('=') && DKC_GLOBAL.has(t.value) && at < tokens.length) lead.push(tokens[at++]);
  }
  // the verb: run, container run, compose up...
  if (tokens[at] && /^(container|compose|image|volume|network|pod)$/.test(tokens[at].value)) lead.push(tokens[at++]);
  if (tokens[at] && !tokens[at].value.startsWith('-')) lead.push(tokens[at++]);
  const options = [];
  const groupOf = (flag) => (DKC_GROUPS.find(([, , re]) => re.test(flag)) || ['other'])[0];
  while (at < tokens.length) {
    const t = tokens[at];
    if (t.value === '--') {
      at++;
      break;
    }
    if (!t.value.startsWith('-') || t.value === '-') break;
    const eq = t.value.indexOf('=');
    if (t.value.startsWith('--') && eq > 0) {
      const flag = t.value.slice(0, eq);
      options.push({ flag, value: t.value.slice(eq + 1), tokens: [t], group: groupOf(flag) });
      at++;
    } else if (/^-[A-Za-z]$/.test(t.value) || t.value.startsWith('--')) {
      if (DKC_VALUE.has(t.value) && at + 1 < tokens.length) {
        options.push({ flag: t.value, value: tokens[at + 1].value, tokens: [t, tokens[at + 1]], group: groupOf(t.value) });
        at += 2;
      } else {
        options.push({ flag: t.value, value: null, tokens: [t], group: groupOf(t.value) });
        at++;
      }
    } else if (DKC_VALUE.has(t.value.slice(0, 2))) {
      // a short one with its value stuck to it: -eNAME=x, -p8080:80
      options.push({ flag: t.value.slice(0, 2), value: t.value.slice(2), tokens: [t], group: groupOf(t.value.slice(0, 2)) });
      at++;
    } else {
      // -it, -dit: flags together
      options.push({ flag: t.value, value: null, tokens: [t], group: 'other' });
      at++;
    }
  }
  const image = tokens[at] ? tokens[at++] : null;
  return { engine, lead, options, image, rest: tokens.slice(at) };
}

const DKC_BREAK = { bash: ' \\', powershell: ' `', cmd: ' ^' };

// An option a line, each as typed. grouped: the flags first, then names, ports, variables, mounts, network and the rest,
// each in the order written.
function formatDockerCommand(cmd, shell = 'bash', grouped = false) {
  const order = ['flags', 'name', 'ports', 'env', 'mounts', 'network', 'other'];
  const options = grouped
    ? [...cmd.options].map((o, i) => ({ o, i, g: o.group === 'other' && o.value === null ? 'flags' : o.group })).sort((a, b) => order.indexOf(a.g) - order.indexOf(b.g) || a.i - b.i).map((x) => x.o)
    : cmd.options;
  const lines = [cmd.lead.map((t) => t.raw).join(' ')];
  for (const o of options) lines.push(`  ${o.tokens.map((t) => t.raw).join(' ')}`);
  if (cmd.image) lines.push(`  ${cmd.image.raw}`);
  if (cmd.rest.length) lines.push(`  ${cmd.rest.map((t) => t.raw).join(' ')}`);
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}${DKC_BREAK[shell]}` : l)).join('\n');
}

// What the parts say, as a person reads them.
function dockerCommandParts(cmd) {
  const env = [];
  const ports = [];
  const mounts = [];
  const labels = [];
  for (const o of cmd.options) {
    const v = o.value ?? '';
    if (o.flag === '-e' || o.flag === '--env') {
      const eq = v.indexOf('=');
      env.push(eq > 0 ? { name: v.slice(0, eq), value: v.slice(eq + 1) } : { name: v, value: null });
    } else if (o.flag === '--env-file') env.push({ name: v, value: null, file: true });
    else if (o.flag === '-p' || o.flag === '--publish') {
      const [spec, proto = 'tcp'] = v.split('/');
      const parts = spec.split(':');
      const container = parts.pop();
      const host = parts.pop() || '';
      ports.push({ ip: parts.join(':'), host, container, proto });
    } else if (o.flag === '-v' || o.flag === '--volume') {
      const parts = v.split(':');
      // C:\path:/target on Windows: the drive letter is part of the source
      if (/^[A-Za-z]$/.test(parts[0]) && parts.length > 2) parts.splice(0, 2, `${parts[0]}:${parts[1]}`);
      mounts.push({ source: parts[0] || '', target: parts[1] || parts[0], options: parts.slice(2).join(':'), kind: parts.length > 1 && !/[\\/]/.test(parts[0]) ? 'volume' : 'bind' });
    } else if (o.flag === '--mount') {
      const kv = Object.fromEntries(v.split(',').map((p) => { const i = p.indexOf('='); return i < 0 ? [p, true] : [p.slice(0, i), p.slice(i + 1)]; }));
      mounts.push({ source: kv.source || kv.src || '', target: kv.target || kv.dst || kv.destination || '', options: ['readonly', 'ro'].filter((k) => kv[k] === true || kv[k] === 'true').length ? 'readonly' : '', kind: kv.type || 'volume' });
    } else if (o.flag === '--tmpfs') mounts.push({ source: '', target: v.split(':')[0], options: v.split(':').slice(1).join(':'), kind: 'tmpfs' });
    else if (o.flag === '-l' || o.flag === '--label') {
      const eq = v.indexOf('=');
      labels.push({ name: eq > 0 ? v.slice(0, eq) : v, value: eq > 0 ? v.slice(eq + 1) : '' });
    }
  }
  return { env, ports, mounts, labels };
}

function buildDockerTool() {
  const box = tEl('div', 'tool');
  let shell = window.git.platform === 'win32' ? 'powershell' : 'bash';
  let grouped = false;
  let cmd = null;
  const input = toolArea('docker run --rm --name orders -p 8080:8080 -e DB_HOST=localhost -e DB_PASSWORD=secret -v /tmp/app.jar:/app/app.jar:ro eclipse-temurin:21-jre java -jar /app/app.jar', 5);
  const error = tEl('div', 'tool-error');
  const output = tEl('pre', 'tool-out tool-out-tall dkc-out');
  const parts = tEl('div', 'dkc-parts');
  const secretIn = () => Boolean(cmd) && dockerCommandParts(cmd).env.some((e) => e.value && DKC_SECRET.test(e.name));
  const run = () => {
    error.textContent = '';
    parts.replaceChildren();
    output.textContent = '';
    cmd = input.value.trim() ? parseDockerCommand(input.value) : null;
    if (!cmd) return;
    if (cmd.error) {
      error.textContent = cmd.error;
      cmd = null;
      return;
    }
    output.textContent = formatDockerCommand(cmd, shell, grouped);
    const { env, ports, mounts, labels } = dockerCommandParts(cmd);
    const section = (title, count, fill, extra) => {
      const card = tEl('div', 'dkc-sec');
      const head = tEl('div', 'dkc-sec-head');
      head.append(tEl('span', 'dkc-sec-title', `${title} (${count})`));
      if (extra) head.append(extra);
      const grid = toolFields();
      fill(grid);
      card.append(head, grid);
      parts.append(card);
    };
    if (env.length) {
      const lines = env.filter((e) => e.value !== null).map((e) => `${e.name}=${e.value}`).join('\n');
      const copyAll = copyButton(() => lines, 'Variables', env.some((e) => e.value && DKC_SECRET.test(e.name)));
      copyAll.textContent = 'Copy as NAME=value';
      copyAll.title = 'A line each: Env on the Maven page takes them with Paste';
      section('Variables', env.length, (grid) => env.forEach((e) => {
        if (e.file) grid.add('From the file', e.name, { what: 'File' });
        else if (e.value === null) grid.add(e.name, 'its value on this computer', { copy: false, cls: 'dkc-muted' });
        else grid.add(e.name, e.value, { what: e.name, secret: DKC_SECRET.test(e.name), copyText: e.value || undefined });
      }), lines ? copyAll : null);
    }
    if (ports.length) {
      section('Ports', ports.length, (grid) => ports.forEach((p) => grid.add(p.host ? `${p.ip ? `${p.ip}:` : ''}${p.host} on this computer` : 'A port of this computer', `${p.container}/${p.proto} in the container`, { copy: false })));
    }
    if (mounts.length) {
      section('Mounts', mounts.length, (grid) => mounts.forEach((m) => grid.add(m.target || '(no target)', `${m.kind === 'tmpfs' ? 'in memory' : m.source || '(a new volume)'}${m.kind === 'volume' && m.source ? ' (a volume)' : ''}${m.options ? ` · ${m.options}` : ''}`, { what: 'The source', copyText: m.source || undefined, copy: Boolean(m.source) })));
    }
    if (labels.length) section('Labels', labels.length, (grid) => labels.forEach((l) => grid.add(l.name, l.value)));
    const more = [cmd.image ? `The image: ${cmd.image.value}` : 'No image found: an option this tool does not know may have taken it', cmd.rest.length ? `Its command: ${cmd.rest.map((t) => t.value).join(' ')}` : ''];
    parts.append(tEl('p', 'tool-hint', more.filter(Boolean).join('. ')));
  };
  const row = tEl('div', 'tool-row');
  row.append(
    toolSegment([['bash', 'Bash \\'], ['powershell', 'PowerShell `'], ['cmd', 'cmd ^']], shell, (v) => { shell = v; run(); }, 'The shell it is for'),
    toolCheck('Group: variables, ports, mounts...', false, (v) => { grouped = v; run(); }),
    copyButton(() => output.textContent, 'The command', secretIn()),
  );
  // the whole command is copied as a secret when a variable of it reads as one
  row.lastChild.addEventListener('click', (e) => {
    if (!secretIn()) return;
    e.stopImmediatePropagation();
    toolCopy(output.textContent, 'The command', true);
  }, true);
  input.addEventListener('input', run);
  box.append(
    toolHead('Docker command', 'A docker or podman command, an option a line, as the shell takes it again: \\ for Bash and zsh, ` for PowerShell, ^ for cmd. Its variables, ports, mounts and labels are listed under it. Nothing is run.'),
    input, row, error, output, parts,
  );
  run();
  return { el: box, focus: input };
}
