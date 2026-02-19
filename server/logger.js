const fs = require('fs');
const path = require('path');

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  log(level, message, meta = null) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };
    const line = JSON.stringify(entry);
    this.stream.write(line + '\n');
    if (level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  }

  info(message, meta = null) {
    this.log('info', message, meta);
  }

  warn(message, meta = null) {
    this.log('warn', message, meta);
  }

  error(message, meta = null) {
    this.log('error', message, meta);
  }
}

module.exports = { Logger };
