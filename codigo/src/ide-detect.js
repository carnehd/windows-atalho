const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JETBRAINS_PROCESS = /^(idea|pycharm|webstorm|rider|goland|clion|phpstorm|datagrip|rubymine|studio)(64)?$/i;
const POLL_MS = 300;

// Prints "pid<TAB>process<TAB>title" every time the foreground window changes.
const WATCHER = `
Add-Type @"
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class Fg {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static void Watch(int ms, int parentPid) {
    IntPtr last = IntPtr.Zero; string lastTitle = null;
    var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    Process parent = null;
    try { parent = Process.GetProcessById(parentPid); } catch { return; }
    while (true) {
      if (parent.HasExited) return;
      IntPtr h = GetForegroundWindow();
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string title = sb.ToString();
      if (h != IntPtr.Zero && (h != last || title != lastTitle)) {
        last = h; lastTitle = title;
        uint pid; GetWindowThreadProcessId(h, out pid);
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
        stdout.WriteLine(pid + "\\t" + name + "\\t" + title.Replace("\\t", " "));
      }
      Thread.Sleep(ms);
    }
  }
}
"@
[Fg]::Watch(${POLL_MS}, ${process.pid})
`;

function startForegroundWatcher(isOwnPid) {
  let last = null;
  let child = null;
  let stopped = false;
  let buffer = '';

  const start = () => {
    if (stopped || process.platform !== 'win32') return;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WATCHER], { windowsHide: true });
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const [pid, name, ...rest] = line.split('\t');
        if (!name || isOwnPid(Number(pid))) continue;
        last = { pid: Number(pid), name, title: rest.join('\t'), at: Date.now() };
      }
    });
    child.on('exit', () => {
      child = null;
      if (!stopped) setTimeout(start, 5000);
    });
    child.on('error', () => {});
  };
  start();

  return {
    last: () => last,
    stop: () => {
      stopped = true;
      if (child) child.kill();
    },
  };
}

const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function readRecentProjects(appData = process.env.APPDATA) {
  const base = path.join(appData || '', 'JetBrains');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const projects = [];
  for (const d of dirs) {
    let xml;
    try {
      xml = fs.readFileSync(path.join(base, d.name, 'options', 'recentProjects.xml'), 'utf8');
    } catch {
      continue;
    }
    const entryRe = /<entry key="([^"]+)">([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml))) {
      const projectPath = path.resolve(unescapeXml(m[1]).replace('$USER_HOME$', os.homedir()));
      const title = (m[2].match(/frameTitle="([^"]*)"/) || [])[1];
      const activated = Number((m[2].match(/name="activationTimestamp" value="(\d+)"/) || [])[1] || 0);
      projects.push({ path: projectPath, frameTitle: title ? unescapeXml(title) : '', activated });
    }
  }
  return projects;
}

// IntelliJ titles look like "project - File.java", "project [D:\\path] - File.java" or just "project" (the dash is an en dash).
function projectNameFromTitle(title) {
  return title.split(/\s+[\u2013\u2014-]\s+/)[0].replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

function detectIdeProject(fg, recent = readRecentProjects()) {
  if (!fg || !JETBRAINS_PROCESS.test(fg.name)) return null;
  const title = fg.title.trim();
  if (!title) return null;
  const bracket = title.match(/\[([A-Za-z]:\\[^\]]+)\]/);
  if (bracket) return { name: projectNameFromTitle(title), path: path.resolve(bracket[1]) };

  const name = projectNameFromTitle(title);
  if (!name) return null;
  const exact = recent.filter((p) => p.frameTitle && p.frameTitle === title);
  const byName = recent.filter(
    (p) => projectNameFromTitle(p.frameTitle || '') === name || path.basename(p.path).toLowerCase() === name.toLowerCase()
  );
  const best = (exact.length ? exact : byName).sort((a, b) => b.activated - a.activated)[0];
  return { name, path: best ? best.path : null };
}

const key = (p) => path.resolve(p).toLowerCase();
const inside = (child, parent) => {
  const c = key(child);
  const p = key(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

// Returns the repo in the list that contains the project (or the only repo inside it).
function resolveRepo(project, repos) {
  if (!project) return null;
  if (project.path) {
    const containing = repos.filter((r) => inside(project.path, r)).sort((a, b) => b.length - a.length)[0];
    if (containing) return containing;
    const within = repos.filter((r) => inside(r, project.path));
    if (within.length === 1) return within[0];
    return null;
  }
  const byName = repos.filter((r) => path.basename(r).toLowerCase() === project.name.toLowerCase());
  return byName.length === 1 ? byName[0] : null;
}

module.exports = { startForegroundWatcher, readRecentProjects, detectIdeProject, resolveRepo, projectNameFromTitle };
