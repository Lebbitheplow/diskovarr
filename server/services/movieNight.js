// Movie Night reminders: every 15 minutes, remind the members of any group
// whose night is tonight — recurring groups with a theme pinned to today's
// weekday, and scheduled groups whose event starts within the next hour. One
// bundled notification per group per night (bundle key dedupes forced re-runs)
// fanned out to every human member through the notification agents.
const db = require('../db/database');
const logger = require('./logger');
const { enqueueForUser } = require('./notificationAgents');

const SCHEDULED_LOOKAHEAD_SECONDS = 60 * 60;

function tonightKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

// Groups whose night lands today, with the theme (recurring) that applies.
function getTonightGroups(now = new Date()) {
  const weekday = now.getDay();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const groups = db.prepare("SELECT * FROM movie_night_groups WHERE mode IN ('recurring','scheduled')").all();
  const nights = [];
  for (const group of groups) {
    if (group.mode === 'recurring') {
      const theme = db.getTonightMovieNightTheme(group.id, weekday);
      if (theme) nights.push({ group, theme, eventAt: null });
    } else if (group.event_at
      && group.event_at >= nowEpoch && group.event_at <= nowEpoch + SCHEDULED_LOOKAHEAD_SECONDS) {
      nights.push({ group, theme: db.getTonightMovieNightTheme(group.id, weekday), eventAt: group.event_at });
    }
  }
  return nights;
}

// Sends one reminder per member per group per night. Idempotent: once the
// bundle key exists for a group/night, later runs do nothing.
function runNightReminders(now = new Date()) {
  const dateKey = tonightKey(now);
  let sent = 0;
  for (const { group, theme, eventAt } of getTonightGroups(now)) {
    const bundlePrefix = `movie_night:${group.id}:${dateKey}`;
    // A reminder already went out for this group tonight (per member) — skip.
    const already = db.prepare('SELECT 1 FROM notifications WHERE bundle_key LIKE ? LIMIT 1').get(`${bundlePrefix}:%`);
    if (already) continue;
    const next = db.getMovieNightNextPick(group.id);
    const emoji = group.theme_emoji ? `${group.theme_emoji} ` : '';
    const title = `Movie Night tonight: ${emoji}${group.name}`;
    const themePart = theme ? `Tonight's theme: ${theme.name}. ` : '';
    const nextPart = next?.entry
      ? ` Next up: ${next.entry.title}${next.fallback ? '' : ` (${next.identity?.name || ''})`}`
      : ' Nothing queued yet — add something!';
    const body = `${themePart}${nextPart}`.trim();
    for (const member of db.getMovieNightGroupMembers(group.id)) {
      const notificationId = db.createOrBundleNotification({
        userId: member.user_id,
        type: 'movie_night_tonight',
        title,
        body,
        data: { groupId: group.id, themeId: theme?.id || null, eventAt, entryId: next?.entry?.id || null },
        bundleKey: `${bundlePrefix}:${member.user_id}`,
      });
      if (!notificationId) continue;
      sent += 1;
      enqueueForUser({
        notificationId,
        userId: member.user_id,
        payload: { type: 'movie_night_tonight', title, body, userId: member.user_id },
      });
    }
  }
  if (sent > 0) logger.info(`[movie-night] sent ${sent} night reminder(s)`);
  return { sent, dateKey };
}

module.exports = { runNightReminders, getTonightGroups, tonightKey };
