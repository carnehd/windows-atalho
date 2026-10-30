// Help / cheat sheet view. Relies on helpers from app.js and vault.js ($, $$, vEl, copyable, copyText, noteEl).
const HELP = [
  {
    name: 'Maven',
    groups: [
      ['Build', [
        ['mvn clean install', 'Compile, test, package and install into the local repository (~/.m2)'],
        ['mvn clean install -DskipTests', 'Same, without running tests (still compiles them)'],
        ['mvn clean install -Dmaven.test.skip=true', 'Skip compiling and running tests'],
        ['mvn clean package', 'Build the jar/war into target/ without installing it'],
        ['mvn clean verify', 'Run the full build including integration tests'],
        ['mvn -o clean install', 'Offline build: only use what is already in ~/.m2'],
        ['mvn -U clean install', 'Force an update of SNAPSHOT dependencies'],
        ['mvn -T 1C clean install', 'Parallel build, one thread per CPU core'],
        ['mvn -pl <module> -am clean install', 'Build one module plus the modules it depends on'],
        ['mvn -rf :<module> clean install', 'Resume a failed multi-module build from a module'],
        ['mvn -P<profile> clean install', 'Build with a profile enabled'],
        ['mvn -X clean install', 'Debug output (very verbose), useful for plugin problems'],
        ['mvn -q clean install', 'Quiet output: only errors'],
      ]],
      ['Tests', [
        ['mvn test', 'Run the unit tests'],
        ['mvn test -Dtest=<ClassName>', 'Run one test class'],
        ['mvn test -Dtest=<ClassName>#<method>', 'Run one test method'],
        ['mvn test -Dtest=<ClassName> -Dsurefire.failIfNoSpecifiedTests=false', 'Run one test class in a multi-module build'],
        ['mvn -Dmaven.surefire.debug test', 'Run tests waiting for a debugger on port 5005'],
        ['mvn verify -DskipUnitTests', 'Integration tests only (if the project supports this flag)'],
      ]],
      ['Spring Boot', [
        ['mvn spring-boot:run', 'Start the Spring Boot application'],
        ['mvn spring-boot:run -Dspring-boot.run.profiles=<profile>', 'Start with a Spring profile (e.g. dev)'],
        ['mvn spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"', 'Start with remote debugging on port 5005'],
        ['mvn spring-boot:run -Dspring-boot.run.arguments="--server.port=8081"', 'Start on another port'],
        ['mvn spring-boot:build-image', 'Build a container image with Buildpacks'],
        ['java -jar target/<app>.jar --spring.profiles.active=<profile>', 'Run the packaged jar with a profile'],
      ]],
      ['Format and quality', [
        ['mvn spotless:apply', 'Format the code with Spotless'],
        ['mvn spotless:check', 'Check the formatting without changing files'],
        ['mvn checkstyle:check', 'Run Checkstyle rules'],
        ['mvn jacoco:report', 'Generate the test coverage report (target/site/jacoco)'],
        ['mvn sonar:sonar -Dsonar.host.url=<url> -Dsonar.token=<token>', 'Send analysis to SonarQube'],
      ]],
      ['Dependencies', [
        ['mvn dependency:tree', 'Show the dependency tree'],
        ['mvn dependency:tree -Dincludes=<groupId>:<artifactId>', 'Find where a dependency comes from'],
        ['mvn dependency:analyze', 'Find unused or undeclared dependencies'],
        ['mvn dependency:resolve -U', 'Download all dependencies again'],
        ['mvn versions:display-dependency-updates', 'List newer versions of dependencies'],
        ['mvn versions:set -DnewVersion=<version>', 'Change the project version'],
        ['mvn help:effective-pom', 'Show the final POM after inheritance and profiles'],
        ['mvn help:active-profiles', 'Show which profiles are active'],
        ['mvn -v', 'Maven, Java and OS versions in use'],
      ]],
    ],
  },
  {
    name: 'Git',
    groups: [
      ['Everyday', [
        ['git status -sb', 'Short status with the branch and ahead/behind'],
        ['git pull --rebase', 'Update the branch rebasing your commits on top'],
        ['git add -p', 'Stage changes piece by piece'],
        ['git commit --amend --no-edit', 'Add staged changes to the last commit (only if not pushed)'],
        ['git push -u origin <branch>', 'Push a new branch and set its upstream'],
        ['git log --oneline --graph --decorate -20', 'Compact history graph'],
        ['git diff --staged', 'Show what will be committed'],
      ]],
      ['Branches', [
        ['git switch -c <branch> origin/main', 'Create a branch from the remote main'],
        ['git branch -vv', 'Local branches with their upstream and status'],
        ['git branch -d <branch>', 'Delete a merged local branch'],
        ['git push origin --delete <branch>', 'Delete a remote branch'],
        ['git fetch --prune', 'Fetch and remove references to deleted remote branches'],
        ['git rebase -i HEAD~<n>', 'Edit, squash or reorder the last n commits'],
      ]],
      ['Undo', [
        ['git restore <file>', 'Discard local changes to a file'],
        ['git restore --staged <file>', 'Unstage a file, keeping the changes'],
        ['git reset --soft HEAD~1', 'Undo the last commit, keeping its changes staged'],
        ['git revert <commit>', 'Create a commit that undoes another one (safe for pushed commits)'],
        ['git reflog', 'Find lost commits (after a reset or rebase)'],
        ['git stash push -m "<message>"', 'Put changes aside with a name'],
        ['git stash pop', 'Bring back the last stash'],
      ]],
    ],
  },
  {
    name: 'Docker',
    groups: [
      ['Containers', [
        ['docker ps', 'Running containers'],
        ['docker ps -a', 'All containers, including stopped ones'],
        ['docker run -d --name <name> -p 8080:8080 <image>', 'Start a container in the background with a port'],
        ['docker run --rm -it <image> sh', 'Throwaway container with a shell'],
        ['docker logs -f --tail 200 <container>', 'Follow the last 200 log lines'],
        ['docker exec -it <container> sh', 'Open a shell inside a running container'],
        ['docker stop <container>', 'Stop a container'],
        ['docker rm -f <container>', 'Force remove a container'],
        ['docker inspect <container>', 'Full details (network, env, mounts)'],
        ['docker stats', 'Live CPU and memory usage'],
        ['docker cp <container>:<path> .', 'Copy a file out of a container'],
      ]],
      ['Images', [
        ['docker images', 'Local images'],
        ['docker build -t <image>:<tag> .', 'Build an image from the Dockerfile here'],
        ['docker pull <image>:<tag>', 'Download an image'],
        ['docker tag <image>:<tag> <registry>/<image>:<tag>', 'Tag an image for a registry'],
        ['docker push <registry>/<image>:<tag>', 'Upload an image to a registry'],
        ['docker login <registry>', 'Log in to a registry'],
        ['docker rmi <image>', 'Remove an image'],
      ]],
      ['Cleanup', [
        ['docker system df', 'Disk space used by images, containers and volumes'],
        ['docker system prune', 'Remove stopped containers, unused networks and dangling images'],
        ['docker image prune -a', 'Remove all images not used by a container'],
        ['docker volume ls', 'List volumes'],
      ]],
      ['Compose', [
        ['docker compose up -d', 'Start the services in the background'],
        ['docker compose down', 'Stop and remove the services'],
        ['docker compose down -v', 'Same, also removing volumes (data is lost)'],
        ['docker compose logs -f <service>', 'Follow the logs of one service'],
        ['docker compose ps', 'Status of the services'],
        ['docker compose build --no-cache', 'Rebuild images from scratch'],
        ['docker compose restart <service>', 'Restart one service'],
      ]],
    ],
  },
  {
    name: 'Podman',
    groups: [
      ['Containers', [
        ['podman ps -a', 'All containers'],
        ['podman run -d --name <name> -p 8080:8080 <image>', 'Start a container in the background with a port'],
        ['podman logs -f <container>', 'Follow the logs'],
        ['podman exec -it <container> sh', 'Shell inside a running container'],
        ['podman stop <container> && podman rm <container>', 'Stop and remove a container'],
        ['podman inspect <container>', 'Full details'],
      ]],
      ['Images', [
        ['podman images', 'Local images'],
        ['podman build -t <image>:<tag> .', 'Build an image'],
        ['podman login <registry>', 'Log in to a registry'],
        ['podman push <image>:<tag> <registry>/<image>:<tag>', 'Push an image to a registry'],
        ['podman image prune -a', 'Remove unused images'],
      ]],
      ['Machine (Windows)', [
        ['podman machine list', 'Podman virtual machines and their state'],
        ['podman machine start', 'Start the Podman machine (needed on Windows)'],
        ['podman machine stop', 'Stop the Podman machine'],
        ['podman machine ssh', 'Open a shell in the Podman machine'],
        ['podman system connection list', 'Configured connections'],
      ]],
      ['Pods and Kubernetes', [
        ['podman pod create --name <pod> -p 8080:8080', 'Create a pod (shared network for its containers)'],
        ['podman run -d --pod <pod> <image>', 'Run a container inside a pod'],
        ['podman pod ps', 'List pods'],
        ['podman pod rm -f <pod>', 'Remove a pod and its containers'],
        ['podman kube generate <pod> > pod.yaml', 'Export a pod as Kubernetes YAML'],
        ['podman kube play pod.yaml', 'Run Kubernetes YAML locally'],
        ['podman compose up -d', 'Run a docker-compose file with Podman'],
      ]],
    ],
  },
  {
    name: 'Kubernetes',
    groups: [
      ['Context', [
        ['kubectl config get-contexts', 'Available clusters/contexts'],
        ['kubectl config use-context <context>', 'Switch cluster'],
        ['kubectl config set-context --current --namespace=<namespace>', 'Set the default namespace'],
        ['kubectl get ns', 'List namespaces'],
      ]],
      ['Pods', [
        ['kubectl get pods -n <namespace>', 'Pods in a namespace'],
        ['kubectl get pods -A', 'Pods in all namespaces'],
        ['kubectl get pods -o wide -w', 'Pods with node and IP, watching for changes'],
        ['kubectl describe pod <pod>', 'Details and events (why a pod does not start)'],
        ['kubectl logs -f <pod>', 'Follow the logs of a pod'],
        ['kubectl logs <pod> --previous', 'Logs of the previous (crashed) container'],
        ['kubectl logs -f deploy/<deployment>', 'Logs from a deployment'],
        ['kubectl logs <pod> -c <container>', 'Logs of one container in the pod'],
        ['kubectl exec -it <pod> -- sh', 'Shell inside a pod'],
        ['kubectl port-forward <pod> 8080:8080', 'Access a pod port from localhost'],
        ['kubectl delete pod <pod>', 'Delete a pod (the deployment creates a new one)'],
        ['kubectl top pods', 'CPU and memory per pod'],
      ]],
      ['Deployments', [
        ['kubectl get deploy,svc,ingress', 'Deployments, services and ingresses'],
        ['kubectl rollout restart deploy/<deployment>', 'Restart all pods of a deployment'],
        ['kubectl rollout status deploy/<deployment>', 'Follow a rollout'],
        ['kubectl rollout undo deploy/<deployment>', 'Roll back to the previous version'],
        ['kubectl scale deploy/<deployment> --replicas=<n>', 'Change the number of pods'],
        ['kubectl set image deploy/<deployment> <container>=<image>:<tag>', 'Deploy a new image'],
        ['kubectl apply -f <file>.yaml', 'Create or update resources from a file'],
        ['kubectl get events --sort-by=.lastTimestamp', 'Recent events, newest last'],
      ]],
      ['Config and secrets', [
        ['kubectl get configmap <name> -o yaml', 'Show a ConfigMap'],
        ['kubectl get secret <name> -o jsonpath="{.data.<key>}"', 'Read a secret value (base64)'],
        ['kubectl create secret generic <name> --from-literal=<key>=<value>', 'Create a secret'],
      ]],
    ],
  },
  {
    name: 'OpenShift',
    groups: [
      ['Basics', [
        ['oc login <url> --token=<token>', 'Log in with a token (copy it from the web console)'],
        ['oc whoami --show-console', 'Current user and console URL'],
        ['oc projects', 'Projects you can access'],
        ['oc project <project>', 'Switch project'],
        ['oc get pods', 'Pods in the current project'],
        ['oc logs -f <pod>', 'Follow the logs of a pod'],
        ['oc rsh <pod>', 'Shell inside a pod'],
        ['oc port-forward <pod> 8080:8080', 'Access a pod port from localhost'],
        ['oc rollout restart deployment/<deployment>', 'Restart a deployment'],
        ['oc get routes', 'Public URLs of the services'],
        ['oc describe pod <pod>', 'Details and events of a pod'],
      ]],
    ],
  },
  {
    name: 'Windows',
    groups: [
      ['Ports and processes', [
        ['netstat -ano | findstr :8080', 'Which process uses port 8080 (last column is the PID)'],
        ['Get-NetTCPConnection -LocalPort 8080 | Select-Object OwningProcess', 'Same in PowerShell'],
        ['taskkill /PID <pid> /F', 'Kill a process by PID'],
        ['Get-Process java', 'Running Java processes'],
        ['Stop-Process -Name java -Force', 'Kill all Java processes'],
      ]],
      ['Environment', [
        ['$env:JAVA_HOME', 'Show JAVA_HOME (PowerShell)'],
        ['$env:JAVA_HOME = "C:\\path\\to\\jdk"', 'Change JAVA_HOME for this terminal only'],
        ['[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\\path\\to\\jdk", "User")', 'Change JAVA_HOME permanently for your user'],
        ['where.exe java', 'Which java executables are on the PATH'],
        ['java -version', 'Java version in use'],
      ]],
      ['Network', [
        ['Test-NetConnection <host> -Port <port>', 'Check whether a host and port are reachable'],
        ['nslookup <host>', 'Resolve a host name'],
        ['curl.exe -v <url>', 'HTTP request with details (use curl.exe, not the PowerShell alias)'],
        ['ipconfig /flushdns', 'Clear the DNS cache'],
      ]],
    ],
  },
];

let helpCategory = 'Maven';

// ---------- My commands: the user's own, saved in the app (data/git-quick-commands.json) ----------
const MY_TOPIC = 'My commands';
let savedCommands = [];
let myEditing = null; // the id of the command in the form, while it is being changed
let myDraft = { command: '', description: '', group: '' }; // what is typed in the form, kept across redraws

async function loadMyCommands() {
  const r = await window.myCommands.get();
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  savedCommands = r.commands;
  renderHelp();
}

// The saved commands by group, in the order the groups first appear; those without a group under "Saved".
function myGroups() {
  const groups = new Map();
  for (const c of savedCommands) {
    const name = c.group || 'Saved';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(c);
  }
  return [...groups];
}

function myMatches(c, q) {
  return helpMatches(c.command, c.description, q) || (Boolean(q) && c.group.toLowerCase().includes(q));
}

async function saveMyCommand(entry) {
  const r = await window.myCommands.save(entry);
  if (r.error) {
    toast(r.error, 'error');
    return false;
  }
  savedCommands = r.commands;
  toast(entry.id ? 'Command saved' : 'Saved in My commands', 'success');
  return true;
}

function editMyCommand(c) {
  myEditing = c.id;
  myDraft = { command: c.command, description: c.description, group: c.group };
  helpCategory = MY_TOPIC;
  $('#helpSearch').value = '';
  renderHelp();
  const input = $('#myCmdCommand');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function deleteMyCommand(c) {
  if (!(await window.git.confirm(`Delete the saved command "${c.command}"?`))) return;
  const r = await window.myCommands.delete(c.id);
  if (r.error) {
    toast(r.error, 'error');
    return;
  }
  savedCommands = r.commands;
  if (myEditing === c.id) {
    myEditing = null;
    myDraft = { command: '', description: '', group: '' };
  }
  toast('Deleted', 'info');
  renderHelp();
}

// Over the saved commands: the command, what it does, a group, and Add (Save while one is being changed).
function myCommandForm() {
  const form = vEl('form', 'help-add');
  form.id = 'myCmdForm';
  const field = (id, cls, placeholder, key, max) => {
    const input = vEl('input', `input ${cls}`);
    input.id = id;
    input.placeholder = placeholder;
    input.maxLength = max;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = myDraft[key];
    input.addEventListener('input', () => {
      myDraft[key] = input.value;
    });
    return input;
  };
  const command = field('myCmdCommand', 'help-add-cmd', 'Command, e.g. kubectl logs -f <pod> -n <namespace>', 'command', 2000);
  command.setAttribute('aria-label', 'Command');
  const description = field('myCmdDesc', '', 'What it does (optional)', 'description', 300);
  description.setAttribute('aria-label', 'What it does');
  const group = field('myCmdGroup', '', 'Group (optional)', 'group', 60);
  group.setAttribute('aria-label', 'Group');
  group.setAttribute('list', 'myCmdGroups');
  const groups = vEl('datalist');
  groups.id = 'myCmdGroups';
  for (const [name] of myGroups()) if (name !== 'Saved') groups.appendChild(Object.assign(document.createElement('option'), { value: name }));
  const save = vEl('button', 'btn btn-primary btn-sm', myEditing ? 'Save' : 'Add');
  save.type = 'submit';
  form.append(command, description, group, groups, save);
  const cancel = () => {
    myEditing = null;
    myDraft = { command: '', description: '', group: '' };
    renderHelp();
    $('#myCmdCommand').focus();
  };
  if (myEditing) {
    const back = vEl('button', 'btn btn-sm', 'Cancel');
    back.type = 'button';
    back.addEventListener('click', cancel);
    form.appendChild(back);
    form.classList.add('editing');
  }
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (myEditing || myDraft.command || myDraft.description || myDraft.group)) {
      e.stopPropagation();
      cancel();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await saveMyCommand({ id: myEditing, ...myDraft }))) return;
    myEditing = null;
    myDraft = { command: '', description: '', group: '' };
    renderHelp();
    $('#myCmdCommand').focus();
  });
  return form;
}

function helpMatches(cmd, desc, q) {
  return !q || cmd.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
}

function renderHelpCategories(q) {
  const box = $('#helpCategories');
  box.textContent = '';
  const topic = (name, count, cls = '') => {
    const item = vEl('div', `repo-item${!q && name === helpCategory ? ' active' : ''}${cls ? ` ${cls}` : ''}`);
    const title = vEl('div', 'repo-item-title todo-list-title');
    title.append(vEl('span', 'repo-item-name', name), vEl('span', 'todo-count', String(count)));
    item.appendChild(vEl('div', 'repo-item-text')).appendChild(title);
    if (q && count === 0) item.classList.add('help-dim');
    item.addEventListener('click', () => {
      helpCategory = name;
      $('#helpSearch').value = '';
      renderHelp();
    });
    box.appendChild(item);
  };
  HELP.forEach((cat) => topic(cat.name, cat.groups.reduce((n, [, cmds]) => n + cmds.filter(([c, d]) => helpMatches(c, d, q)).length, 0)));
  box.appendChild(vEl('div', 'help-topic-sep'));
  topic(MY_TOPIC, savedCommands.filter((c) => myMatches(c, q)).length, 'help-mine-topic');
}

// A command: the arrow that puts it in the terminal, the command (a click copies it), what it does; a saved one
// also has Edit and Delete.
function helpRow(cmd, desc, mine = null) {
  const row = vEl('div', `help-row${mine ? ' mine' : ''}`);
  const send = vEl('button', 'icon-action help-to-term');
  send.type = 'button';
  send.title = 'Put it in the terminal below';
  send.setAttribute('aria-label', `Put ${cmd} in the terminal`);
  send.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7l5 5l-5 5"/><path d="M12 19h7"/></svg>';
  send.addEventListener('click', () => putInTerminal(cmd));
  const code = vEl('code', 'help-cmd', cmd);
  copyable(code, 'Click to copy', () => copyText(cmd, 'Command'));
  row.append(send, code, vEl('span', 'help-desc', desc));
  if (mine) {
    const actions = vEl('div', 'help-mine-actions');
    actions.append(
      vIconBtn('edit', 'Change this command', () => editMyCommand(mine)),
      vIconBtn('trash', 'Delete this command', () => deleteMyCommand(mine), 'danger'),
    );
    row.appendChild(actions);
  }
  return row;
}

function renderHelp() {
  const q = $('#helpSearch').value.trim().toLowerCase();
  renderHelpCategories(q);
  const box = $('#helpList');
  box.textContent = '';
  const mineOnly = !q && helpCategory === MY_TOPIC;
  if (mineOnly) box.appendChild(myCommandForm());
  const cats = q ? HELP : HELP.filter((c) => c.name === helpCategory);
  let shown = 0;
  cats.forEach((cat) => {
    cat.groups.forEach(([group, cmds]) => {
      const rows = cmds.filter(([c, d]) => helpMatches(c, d, q));
      if (rows.length === 0) return;
      box.appendChild(vEl('div', 'help-group', q ? `${cat.name} / ${group}` : group));
      rows.forEach(([cmd, desc]) => {
        box.appendChild(helpRow(cmd, desc));
        shown++;
      });
    });
  });
  // the saved ones: in their own topic, and among the results of a search
  if (q || mineOnly) {
    for (const [group, cmds] of myGroups()) {
      const rows = cmds.filter((c) => myMatches(c, q));
      if (rows.length === 0) continue;
      box.appendChild(vEl('div', 'help-group', q ? `${MY_TOPIC} / ${group}` : group));
      rows.forEach((c) => {
        box.appendChild(helpRow(c.command, c.description, c));
        shown++;
      });
    }
  }
  if (shown === 0) {
    box.appendChild(noteEl(mineOnly
      ? 'No saved commands yet. Type one above and press Add, or save the line in the terminal with the bookmark on its right.'
      : 'No commands match your search.'));
  }
  updateCrumb();
}

// ---------- the terminal under the commands ----------
// One command line at a time, run as typed in the system shell, in the chosen repository (or the home folder).
const TERM_HISTORY_KEY = 'helpTermHistory';
const TERM_OPEN_KEY = 'helpTermOpen';
const TERM_MAX_CHARS = 400000;
let termRunning = false;
let termHome = '';
let termHistory = [];
let termHistoryAt = -1; // where Up/Down is in the history; -1: the line being typed

function termWrite(text, cls) {
  const out = $('#helpTermOutput');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  if (cls) {
    out.appendChild(vEl('span', cls, text));
  } else {
    out.append(text.replace(ANSI, ''));
  }
  // keep the end when it gets long
  if (out.textContent.length > TERM_MAX_CHARS) out.textContent = out.textContent.slice(-TERM_MAX_CHARS);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function setTermRunning(on) {
  termRunning = on;
  $('#helpTermStop').classList.toggle('hidden', !on);
  $('#helpTermCwd').disabled = on;
  $('#helpTermState').textContent = on ? 'running...' : '';
  $('#helpTerm').classList.toggle('running', on);
}

// The folders a command can run in: the repositories of the list, then the home folder. It follows the repository
// open in Git; a folder chosen here stays until another repository is opened.
let termRepoSeen = null;

function renderTermFolders() {
  const select = $('#helpTermCwd');
  const follow = currentRepo && currentRepo !== termRepoSeen && repos.some((r) => r.path === currentRepo);
  if (follow) termRepoSeen = currentRepo;
  const keep = follow ? currentRepo : select.value || currentRepo || termHome;
  select.textContent = '';
  for (const r of repos) select.appendChild(new Option(displayName(r), r.path));
  if (termHome) select.appendChild(new Option(`Home folder (${termHome})`, termHome));
  select.value = [...select.options].some((o) => o.value === keep) ? keep : (select.options[0] && select.options[0].value) || '';
  select.title = select.value;
}

function setTermOpen(open) {
  $('#helpTerm').classList.toggle('collapsed', !open);
  const toggle = $('#helpTermToggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide the terminal' : 'Show the terminal';
  toggle.setAttribute('aria-label', toggle.title);
  try {
    localStorage.setItem(TERM_OPEN_KEY, open ? '1' : '0');
  } catch {
    // not remembered
  }
}

// The arrow next to a command: the command goes in the line, its first <placeholder> selected to type over.
function putInTerminal(cmd) {
  setTermOpen(true);
  const input = $('#helpTermInput');
  input.value = cmd;
  input.focus();
  const m = /<[^>]+>/.exec(cmd);
  if (m) input.setSelectionRange(m.index, m.index + m[0].length);
  else input.setSelectionRange(cmd.length, cmd.length);
  termHistoryAt = -1;
}

async function termRun() {
  const input = $('#helpTermInput');
  const command = input.value.trim();
  if (!command || termRunning) return;
  if (/<[^>]+>/.test(command)) {
    toast('Replace the parts in <angle brackets> first', 'info');
    const m = /<[^>]+>/.exec(input.value);
    input.setSelectionRange(m.index, m.index + m[0].length);
    return;
  }
  termHistory = [command, ...termHistory.filter((c) => c !== command)].slice(0, 50);
  try {
    localStorage.setItem(TERM_HISTORY_KEY, JSON.stringify(termHistory));
  } catch {
    // only for this session
  }
  termHistoryAt = -1;
  input.value = '';
  const cwd = $('#helpTermCwd').value;
  const where = $('#helpTermCwd').selectedOptions[0] ? $('#helpTermCwd').selectedOptions[0].textContent : cwd;
  termWrite(`${$('#helpTermOutput').textContent ? '\n' : ''}${where} ❯ ${command}\n`, 'help-term-cmd');
  setTermRunning(true);
  const r = await window.terminal.run(cwd, command);
  if (r.error) {
    setTermRunning(false);
    termWrite(`${r.error}\n`, 'help-term-err');
  }
}

function setupTerminal() {
  try {
    termHistory = JSON.parse(localStorage.getItem(TERM_HISTORY_KEY)) || [];
  } catch {
    termHistory = [];
  }
  let open = true;
  try {
    open = localStorage.getItem(TERM_OPEN_KEY) !== '0';
  } catch {
    // open by default
  }
  setTermOpen(open);
  window.terminal.home().then((home) => {
    termHome = home;
    renderTermFolders();
  });
  const input = $('#helpTermInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      termRun();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!termHistory.length) return;
      e.preventDefault();
      termHistoryAt = Math.max(-1, Math.min(termHistory.length - 1, termHistoryAt + (e.key === 'ArrowUp' ? 1 : -1)));
      input.value = termHistoryAt === -1 ? '' : termHistory[termHistoryAt];
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'c' && e.ctrlKey && termRunning && !input.selectionStart && !input.selectionEnd) {
      e.preventDefault();
      window.terminal.stop();
    } else if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      termHistoryAt = -1;
    }
  });
  $('#helpTermOutput').addEventListener('click', () => {
    if (!window.getSelection().toString()) input.focus();
  });
  $('#helpTermStop').addEventListener('click', () => window.terminal.stop());
  $('#helpTermClear').addEventListener('click', () => {
    $('#helpTermOutput').textContent = '';
    input.focus();
  });
  $('#helpTermToggle').addEventListener('click', () => setTermOpen($('#helpTerm').classList.contains('collapsed')));
  $('#helpTermCwd').addEventListener('change', (e) => { e.target.title = e.target.value; });
  $('#helpTermExternal').addEventListener('click', async () => {
    const command = input.value.trim();
    if (!command) {
      toast('Type the command to run first', 'info');
      input.focus();
      return;
    }
    const r = await window.terminal.external($('#helpTermCwd').value, command);
    if (r.error) toast(r.error, 'error');
    else toast(`Opened in a ${window.git.platform === 'win32' ? 'PowerShell' : 'Terminal'} window`, 'success');
  });
  $('#helpTermSave').addEventListener('click', async () => {
    const command = input.value.trim();
    if (!command) {
      toast('Type the command to save first', 'info');
      input.focus();
      return;
    }
    if (savedCommands.some((c) => c.command === command)) {
      toast('Already in My commands', 'info');
      return;
    }
    if (await saveMyCommand({ command })) renderHelp();
    input.focus();
  });
  window.terminal.onOutput(({ text }) => termWrite(text));
  window.terminal.onExit(({ code, signal }) => {
    setTermRunning(false);
    const out = $('#helpTermOutput');
    if (out.textContent && !out.textContent.endsWith('\n')) termWrite('\n');
    termWrite(signal ? `[stopped]\n` : `[exit code ${code}]\n`, code === 0 ? 'help-term-ok' : 'help-term-err');
  });
}

function setupHelp() {
  if (CARD_ID) return;
  setupTerminal();
  $('#helpSearch').addEventListener('input', renderHelp);
  $('#helpSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) {
      e.target.value = '';
      renderHelp();
      e.stopPropagation();
    }
  });
  renderHelp();
  loadMyCommands();
}

setupHelp();
