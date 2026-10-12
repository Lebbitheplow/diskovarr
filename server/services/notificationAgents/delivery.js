// Delivery contract shared by every notification provider and the queue worker.
//
// A provider's send(type, payload, ctx) resolves to a DeliveryResult:
//   { status, targets: { [targetId]: status }, error, retryAfter }
// where status is one of:
//   sent    — every target that was attempted accepted the message
//   retry   — at least one target hit a transient failure (429, 5xx, timeout, network)
//   failed  — a target failed permanently (other 4xx, invalid destination) and nothing is retryable
//   skipped — nothing to send (provider off, type not selected, recipient not opted in)
//
// ctx comes from the queue worker (services/notificationService.js):
//   recipientId — the queue row's user_id; the only user whose own destinations may be used
//   feed        — whether this row carries the provider's admin-feed copy of the event
//   delivered   — target ids that already succeeded on an earlier attempt; never re-sent

const DeliveryStatus = Object.freeze({
  SENT: 'sent',
  RETRY: 'retry',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

// ── Audience rules (the one place they are defined) ──────────────────────────
//
// FEED targets are a provider's own admin-configured destination: the Discord
// channel webhook, Pushover's global user key, Telegram's admin chat,
// Pushbullet's admin token, and the Slack/Gotify/ntfy/webhook URLs. A feed
// receives each event once (the queue marks one row per event as the feed
// carrier), filtered by the provider's admin type list. The carrier sends it
// even when its own recipient already read the event in the app (feed-only,
// recipientId null), and retries it like any other target.
//
// PERSONAL targets are a user's own destination: Discord DM / personal webhook,
// Pushover user key, Telegram chat, Pushbullet token, email address and browser
// push subscriptions. They receive an event only when the queue row is
// addressed to that user and the user opted in to the channel. A personal
// channel never fans an event out to other users (admins included): admin-facing
// events reach admins because producers enqueue one row per privileged user.
function resolveAudience(payload, ctx) {
  if (ctx) return { recipientId: ctx.recipientId ? String(ctx.recipientId) : null, feed: !!ctx.feed };
  // Direct (non-queue) calls keep the old contract: payload.userId addresses
  // the user and the feed always gets a copy.
  return { recipientId: payload?.userId ? String(payload.userId) : null, feed: true };
}

// ── Error classification ─────────────────────────────────────────────────────

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function classifyError(err) {
  if (!err) return DeliveryStatus.RETRY;
  if (typeof err.retryable === 'boolean') return err.retryable ? DeliveryStatus.RETRY : DeliveryStatus.FAILED;
  const status = Number(err.status || err.statusCode || 0);
  if (status >= 400) return isRetryableStatus(status) ? DeliveryStatus.RETRY : DeliveryStatus.FAILED;
  // SMTP replies: 4xx are transient, 5xx permanent.
  const smtp = Number(err.responseCode || 0);
  if (smtp >= 400 && smtp < 500) return DeliveryStatus.RETRY;
  if (smtp >= 500) return DeliveryStatus.FAILED;
  if (['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(err.code)) return DeliveryStatus.FAILED;
  // Timeouts, resets, DNS hiccups and anything unrecognised: retry, bounded by
  // the worker's attempt cap.
  return DeliveryStatus.RETRY;
}

function parseRetryAfter(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : 0;
}

function httpError(label, status, text, retryAfter) {
  const err = new Error(`${label} ${status}${text ? `: ${String(text).slice(0, 300)}` : ''}`);
  err.status = status;
  const ra = parseRetryAfter(retryAfter);
  if (ra) err.retryAfter = ra;
  return err;
}

// Throws a classified error for a non-2xx fetch Response.
async function ensureOk(res, label) {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  throw httpError(label, res.status, text, res.headers?.get?.('retry-after'));
}

function permanentError(message) {
  const err = new Error(message);
  err.retryable = false;
  return err;
}

// ── Running targets ──────────────────────────────────────────────────────────

function aggregate(statuses) {
  if (!statuses.length) return DeliveryStatus.SKIPPED;
  if (statuses.includes(DeliveryStatus.RETRY)) return DeliveryStatus.RETRY;
  if (statuses.includes(DeliveryStatus.FAILED)) return DeliveryStatus.FAILED;
  return DeliveryStatus.SENT;
}

function skipped(reason) {
  return { status: DeliveryStatus.SKIPPED, targets: {}, error: reason || null, retryAfter: 0 };
}

// targets: [{ id, send: async () => {} }]. Targets already delivered on an
// earlier attempt (ctx.delivered) are not sent again.
async function runTargets(targets, ctx) {
  const done = new Set(ctx?.delivered || []);
  const result = { status: DeliveryStatus.SKIPPED, targets: {}, error: null, retryAfter: 0 };
  const errors = [];
  for (const target of targets) {
    if (done.has(target.id)) { result.targets[target.id] = DeliveryStatus.SENT; continue; }
    try {
      await target.send();
      result.targets[target.id] = DeliveryStatus.SENT;
    } catch (err) {
      result.targets[target.id] = classifyError(err);
      errors.push(`${target.id}: ${err?.message || err}`);
      if (err?.retryAfter) result.retryAfter = Math.max(result.retryAfter, err.retryAfter);
    }
  }
  result.status = aggregate(Object.values(result.targets));
  result.error = errors.length ? errors.join('; ') : null;
  return result;
}

// Coerces whatever an agent returned (legacy agents return true/false/undefined)
// into a DeliveryResult.
function normalizeResult(value) {
  if (value && typeof value === 'object' && Object.values(DeliveryStatus).includes(value.status)) {
    return { targets: {}, error: null, retryAfter: 0, ...value };
  }
  if (value === false) return skipped('agent reported nothing sent');
  return { status: DeliveryStatus.SENT, targets: {}, error: null, retryAfter: 0 };
}

// Broadcast tallies: { attempted, sent, failed } per provider.
function emptyTally() { return { attempted: 0, sent: 0, failed: 0 }; }
async function tallySend(tally, fn, onError) {
  tally.attempted++;
  try { await fn(); tally.sent++; return true; }
  catch (err) { tally.failed++; if (onError) onError(err); return false; }
}

module.exports = {
  DeliveryStatus,
  resolveAudience,
  classifyError,
  isRetryableStatus,
  parseRetryAfter,
  httpError,
  ensureOk,
  permanentError,
  runTargets,
  skipped,
  normalizeResult,
  emptyTally,
  tallySend,
};
