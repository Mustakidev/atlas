const LEVELS = { SYSTEM: 0, ERROR: 1, WARNING: 2, SUCCESS: 3, INFO: 4 };

class Logger {
  constructor(config) {
    this.logs = [];
    this.maxLogs = 500;
    this.minLevel = LEVELS[config.get('LOG_LEVEL')] ?? LEVELS.INFO;
  }

  _log(level, module, message, data = null) {
    const numericLevel = LEVELS[level];
    if (numericLevel === undefined || numericLevel > this.minLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    const dataStr = data ? ' ' + JSON.stringify(data) : '';
    console.log(
      `[${entry.timestamp}] [${level.padEnd(7)}] [${module}] ${message}${dataStr}`
    );

    return entry;
  }

  info(module, message, data) {
    return this._log('INFO', module, message, data);
  }

  success(module, message, data) {
    return this._log('SUCCESS', module, message, data);
  }

  warn(module, message, data) {
    return this._log('WARNING', module, message, data);
  }

  error(module, message, data) {
    return this._log('ERROR', module, message, data);
  }

  system(module, message, data) {
    return this._log('SYSTEM', module, message, data);
  }

  getLogs(limit = 50, level = null) {
    let result = this.logs;
    if (level) {
      result = result.filter((l) => l.level === level.toUpperCase());
    }
    return result.slice(-limit);
  }
}

module.exports = { Logger };
