/**
 * Diskovarr logger — writes to stdout/stderr so logs appear in:
 *   systemd:  journalctl -u diskovarr -f
 *   docker:   docker logs diskovarr -f
 *
 * INFO/WARN/ERROR are always written.
 * HTTP request logs and DEBUG output require verbose mode (toggled via admin panel).
 * Call logger.setVerbose(true/false) when the setting changes.
 */

let _verbose = false;

function ts() {
  return new Date().toISOString();
}

function setVerbose(val) {
  _verbose = !!val;
}

function isVerbose() {
  return _verbose;
}

function info(...args) {
  process.stdout.write(`[${ts()}] INFO  ${args.join(' ')}\n`);
}

function warn(...args) {
  process.stderr.write(`[${ts()}] WARN  ${args.join(' ')}\n`);
}

function error(...args) {
  process.stderr.write(`[${ts()}] ERROR ${args.join(' ')}\n`);
}

function http(req, res, duration) {
  if (_verbose) {
    process.stdout.write(
      `[${ts()}] HTTP  ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms\n`
    );
  }
}

function debug(...args) {
  if (_verbose) process.stdout.write(`[${ts()}] DEBUG ${args.join(' ')}\n`);
}

module.exports = { setVerbose, isVerbose, info, warn, error, http, debug };
