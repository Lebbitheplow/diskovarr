'use strict';

const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function formatMsg(level, prefix, args) {
  const ts = new Date().toISOString();
  const parts = [ts, `[${level}]`];
  if (prefix) parts.push(prefix);
  const strs = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  });
  return parts.join(' ') + ' ' + strs.join(' ');
}

function makeLogger(prefix) {
  return {
    error(...args) { if (currentLevel >= LEVELS.ERROR) console.error(formatMsg('ERROR', prefix, args)); },
    warn(...args)  { if (currentLevel >= LEVELS.WARN)  console.warn(formatMsg('WARN',  prefix, args)); },
    info(...args)  { if (currentLevel >= LEVELS.INFO)  console.log(formatMsg('INFO',  prefix, args)); },
    debug(...args) { if (currentLevel >= LEVELS.DEBUG) console.log(formatMsg('DEBUG', prefix, args)); },
    child(childPrefix) { return makeLogger(prefix ? `${prefix}${childPrefix}` : childPrefix); },
  };
}

module.exports = makeLogger(null);
