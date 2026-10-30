const fs = require('fs');
const path = require('path');

class Store {
  constructor(name, dir) {
    this.path = path.join(dir, `${name}.json`);
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
    } catch {
      this.data = {};
    }
  }

  get(key, defaultValue) {
    return key in this.data ? this.data[key] : defaultValue;
  }

  set(key, value) {
    this.data[key] = value;
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

module.exports = Store;
