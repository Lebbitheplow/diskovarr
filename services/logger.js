/**
 * Diskovarr logger — writes to stdout/stderr so logs appear in:
 *   systemd:  journalctl -u diskovarr -f
 *   docker:   docker logs diskovarr -f
 *
 * Logging is toggled via the admin panel and persisted in the DB.
 * Call logger.setEnabled(true/false) when the setting changes.
 */

let _enabled = false;

function ts() {
  return new Date().toISOString();
}

function setEnabled(val) {
  _enabled = !!val;
}

function isEnabled() {
  return _enabled;
}

function info(...args) {
  if (_enabled) process.stdout.write(`[${ts()}] INFO  ${args.join(' ')}\n`);
}

function warn(...args) {
  if (_enabled) process.stderr.write(`[${ts()}] WARN  ${args.join(' ')}\n`);
}

function error(...args) {
  // Errors always go to stderr regardless of toggle
  process.stderr.write(`[${ts()}] ERROR ${args.join(' ')}\n`);
}

function http(req, res, duration) {
  if (_enabled) {
    process.stdout.write(
      `[${ts()}] HTTP  ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms\n`
    );
  }
}

module.exports = { setEnabled, isEnabled, info, warn, error, http };
