// "My commands" in Help: the commands the user keeps, each with a description and an optional group, saved in
// data/git-quick-commands.json (the data folder never goes to Git).
const crypto = require('crypto');

const LIMITS = { command: 2000, description: 300, group: 60, count: 500 };
const text = (v, max) => String(v ?? '').trim().slice(0, max);

class MyCommands {
  constructor(store) {
    this.store = store;
  }

  list() {
    const raw = this.store.get('commands', []);
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c.id === 'string' && typeof c.command === 'string' && c.command.trim())
      .map((c) => ({ id: c.id, command: c.command, description: text(c.description, LIMITS.description), group: text(c.group, LIMITS.group) }));
  }

  save({ id, command, description, group } = {}) {
    const cmd = String(command ?? '').trim();
    if (!cmd) throw new Error('Type the command');
    if (cmd.length > LIMITS.command) throw new Error(`The command is too long (${LIMITS.command} characters at most)`);
    if (cmd.includes('\0')) throw new Error('The command has a character that cannot be saved');
    const entry = { command: cmd, description: text(description, LIMITS.description), group: text(group, LIMITS.group) };
    const list = this.list();
    let saved;
    if (id) {
      const i = list.findIndex((c) => c.id === id);
      if (i === -1) throw new Error('That command is no longer there');
      saved = { ...list[i], ...entry };
      list[i] = saved;
    } else {
      if (list.length >= LIMITS.count) throw new Error(`You already have ${LIMITS.count} commands saved`);
      saved = { id: crypto.randomUUID(), ...entry };
      list.push(saved);
    }
    this.store.set('commands', list);
    return { id: saved.id, commands: list };
  }

  delete(id) {
    const list = this.list();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) throw new Error('That command is no longer there');
    this.store.set('commands', next);
    return { commands: next };
  }
}

module.exports = { MyCommands, LIMITS };
