const db = require('../db/database');

function buildExplanation(matchedCriteria, content, notificationType) {
  const parts = matchedCriteria.map(c => {
    const typeLabel = c.type.replace(/_/g, ' ');
    return `${typeLabel}: ${c.entityName}`;
  });

  const source = notificationType === 'plex_added' ? 'added to Plex' : 'available to request';
  const title = content.title || 'Unknown title';

  if (parts.length === 1) {
    return `A new ${parts[0]} title "${title}" has been ${source}.`;
  }

  return `A title matching ${parts.join(' + ')} is now ${source} ("${title}").`;
}

async function sendMatches(matches, source) {
  if (!matches || matches.length === 0) return;

  let sentCount = 0;
  const prefsCache = new Map();

  for (const { monitor, matchedCriteria, content, notificationType } of matches) {
    try {
      // Respect the user's notify_monitor preference, like every other notification path
      if (!prefsCache.has(monitor.userId)) {
        prefsCache.set(monitor.userId, db.getUserNotificationPrefs(monitor.userId));
      }
      const prefs = prefsCache.get(monitor.userId);
      if (prefs && prefs.notify_monitor === false) continue;

      const explanation = buildExplanation(matchedCriteria, content, notificationType);

      const notifId = db.createOrBundleNotification({
        userId: monitor.userId,
        type: 'monitor_match',
        title: `"${content.title}" matches "${monitor.name}"`,
        body: explanation,
        data: {
          monitorId: monitor.id,
          tmdbId: content.tmdbId,
          mediaType: content.mediaType,
          title: content.title,
        },
      });

      db.enqueueNotification({
        notificationId: notifId,
        agent: 'discord',
        userId: monitor.userId,
        payload: {
          type: 'monitor_match',
          title: `"${content.title}" matches "${monitor.name}"`,
          body: explanation,
          posterUrl: null,
        },
      });

      db.enqueueNotification({
        notificationId: notifId,
        agent: 'pushover',
        userId: monitor.userId,
        payload: {
          type: 'monitor_match',
          title: `"${content.title}" matches "${monitor.name}"`,
          body: explanation,
          posterUrl: null,
        },
      });

      db.recordNotification({
        monitorId: monitor.id,
        userId: monitor.userId,
        contentTmdbId: content.tmdbId,
        contentType: content.mediaType,
        notificationType,
      });

      sentCount++;
    } catch (err) {
      console.warn('[monitor] Failed to send match notification:', err.message);
    }
  }

  if (sentCount > 0) {
    console.log(`[monitor] Sent ${sentCount} monitor match notifications (${source})`);
  }
}

module.exports = {
  sendMatches,
  buildExplanation,
};
