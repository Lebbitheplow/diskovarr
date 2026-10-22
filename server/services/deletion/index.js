// Deletion profile runner. Modes per profile: dry_run records matches only,
// review queues matches for admin approval, auto deletes after the grace
// period. With no enabled profiles the run is a no-op — the app never deletes
// anything unless the admin explicitly configured a profile.
const db = require('../../db/database');
const automation = require('../../db/automation');
const plexService = require('../plex');
const tautulliService = require('../tautulli');
const evaluator = require('./evaluator');
const executor = require('./executor');
const logger = require('../logger');

function buildContext() {
  const { byRatingKey, movieFallback, showFallback } = tautulliService.getGlobalViewStats();
  return {
    now: Math.floor(Date.now() / 1000),
    viewStats: byRatingKey,
    viewStatsMovieFallback: movieFallback,
    viewStatsShowFallback: showFallback,
    watchlistedKeys: new Set(
      db.prepare('SELECT DISTINCT rating_key FROM watchlist').all().map(r => String(r.rating_key))
    ),
    // Any mirrored history counts (Tautulli or Jellyfin) — getWatchHistoryCount spans both.
    watchHistoryAvailable: tautulliService.hasWatchHistoryData(),
  };
}

// Sections whose items may be deletion candidates. Jellyfin sections join the
// pool only while Jellyfin is enabled: their play stats come from the mirrored
// watch_history (source='jellyfin') and the fallback delete path is
// Jellyfin's own DELETE /Items/{id}. They follow the Jellyfin sync's own rule
// (jellyfin/library.js isFolderEnabled): every synced folder counts unless the
// admin explicitly disabled it, including folders never listed in settings.
function candidateSections() {
  const sectionIds = new Set([String(plexService.MOVIES_SECTION), String(plexService.TV_SECTION)]);
  try { for (const id of db.getEnabledSectionIds()) if (!String(id).startsWith('jf_')) sectionIds.add(String(id)); } catch {}
  const jellyfinEnabled = (() => { try { return require('../jellyfin').isEnabled(); } catch { return false; } })();
  if (jellyfinEnabled) {
    const library = require('../jellyfin/library');
    const synced = db.prepare("SELECT DISTINCT section_id FROM library_items WHERE source = 'jellyfin' AND section_id LIKE 'jf\\_%' ESCAPE '\\'").all();
    for (const { section_id: sid } of synced) {
      if (library.isFolderEnabled(String(sid).slice(library.SECTION_PREFIX.length))) sectionIds.add(String(sid));
    }
  }
  return [...sectionIds];
}

// An item belongs to its section's server (a stray cross-source row never does).
const matchesSectionSource = (item, sectionId) =>
  (item.source || 'plex') === (String(sectionId).startsWith('jf_') ? 'jellyfin' : 'plex');

function getAllLibraryItems() {
  const items = [];
  for (const sectionId of candidateSections()) {
    items.push(...db.getLibraryItemsFromDb(sectionId).filter(i => matchesSectionSource(i, sectionId)));
  }
  return items;
}

function candidateDetails(match, ctx) {
  const stats = evaluator.statsFor(match.item, ctx);
  return {
    reasons: match.reasons,
    fileSize: match.item.fileSize || null,
    addedAt: match.item.addedAt || null,
    lastPlayedAt: stats ? stats.lastPlayedAt : 0,
    plays: stats ? stats.plays : 0,
    thumb: match.item.thumb || null,
    year: match.item.year || null,
  };
}

// Bell + every active provider; each provider relays it only when its
// "Media deletion notices" (deletion) type is selected.
function notifyAdmins(title, body) {
  try {
    const { enqueueForUser } = require('../notificationAgents');
    for (const adminId of db.getPrivilegedUserIds()) {
      const notifId = db.createOrBundleNotification({ userId: adminId, type: 'deletion', title, body, data: {} });
      enqueueForUser({ notificationId: notifId, userId: adminId, payload: { type: 'deletion', title, body } });
    }
  } catch (e) {
    logger.warn(`[deletion] admin notification failed: ${e.message}`);
  }
}

// Evaluate one profile without side effects (used by the preview endpoint).
function previewProfile(profile) {
  const ctx = buildContext();
  if (evaluator.usesWatchData(profile) && !ctx.watchHistoryAvailable) {
    return { error: 'This profile uses watch-history criteria but no watch history has synced yet (is Tautulli configured?)' };
  }
  const { matches, excluded } = evaluator.evaluateProfile(profile, getAllLibraryItems(), ctx);
  return {
    matches: matches.map(m => ({
      ratingKey: m.item.ratingKey,
      title: m.item.title,
      year: m.item.year,
      type: m.item.type,
      thumb: m.item.thumb,
      fileSize: m.item.fileSize || null,
      reasons: m.reasons,
    })),
    excluded,
  };
}

// Why a stored candidate may no longer be deleted, or null if it still may.
// A review can sit in the queue for days: since then the title may have been
// watchlisted, watched, labelled into an exclusion, or the profile edited,
// disabled or switched to dry-run. Re-runs the same evaluation as a scheduled
// run, against current data, for just this item.
function ineligibleReason(profile, item, ctx, sections) {
  if (!profile.enabled) return 'profile is disabled';
  if (profile.mode === 'dry_run') return 'profile is in dry-run mode';
  if (!sections.includes(String(item.sectionId)) || !matchesSectionSource(item, item.sectionId)) {
    return 'library section is no longer evaluated';
  }
  if (evaluator.usesWatchData(profile) && !ctx.watchHistoryAvailable) return 'watch history unavailable';
  const result = evaluator.evaluateItem(profile, item, ctx);
  if (!result) return 'no longer matches the profile criteria';
  return result.excluded ? `now protected (${result.excluded})` : null;
}

// Delete specific candidate rows (admin-approved review items). Shared by the
// approve endpoint and the auto mode path. Each candidate is re-checked
// against current conditions first; one that no longer qualifies is skipped
// and recorded as dismissed with the reason (a later run re-queues it if it
// matches again). Pass the run's ctx to skip rebuilding it.
async function executeCandidates(candidateIds, { ctx = buildContext() } = {}) {
  const results = { deleted: 0, failed: 0, skipped: 0, freedBytes: 0, sections: [], skippedItems: [] };
  const sections = candidateSections();
  for (const id of candidateIds) {
    const candidate = automation.getCandidateById(id);
    // Only open candidates are executable — not deleted, dismissed or failed history
    if (!candidate || !['pending_review', 'matched'].includes(candidate.status)) continue;
    const profile = automation.getDeletionProfile(candidate.profileId);
    const item = db.getLibraryItemByKey(candidate.ratingKey);
    if (!item || !profile) {
      automation.setCandidateStatus(id, 'failed', { error: !item ? 'item no longer in library' : 'profile missing' });
      results.failed++;
      continue;
    }
    const reason = ineligibleReason(profile, item, ctx, sections);
    if (reason) {
      automation.markCandidateIneligible(id, `Not deleted: ${reason}`);
      results.skipped++;
      results.skippedItems.push({ id, title: item.title, reason });
      logger.info(`[deletion] skipped "${item.title}" — ${reason}`);
      continue;
    }
    try {
      const { method } = await executor.deleteItem(item, profile);
      automation.setCandidateStatus(id, 'deleted', { deleteMethod: method });
      results.deleted++;
      results.freedBytes += item.fileSize || 0;
      results.sections.push(item.sectionId);
    } catch (e) {
      automation.setCandidateStatus(id, 'failed', { error: e.message });
      results.failed++;
      logger.warn(`[deletion] failed to delete "${item.title}": ${e.message}`);
    }
  }
  if (results.sections.length > 0) {
    await executor.refreshAndEmptyTrash(results.sections);
  }
  return results;
}

async function runProfiles() {
  const profiles = automation.getEnabledDeletionProfiles();
  if (profiles.length === 0) return { skipped: true };

  const ctx = buildContext();
  const items = getAllLibraryItems();
  const runSummary = {};

  for (const profile of profiles) {
    if (evaluator.usesWatchData(profile) && !ctx.watchHistoryAvailable) {
      runSummary[profile.id] = { error: 'watch history unavailable — profile skipped' };
      logger.warn(`[deletion] profile "${profile.name}" skipped: watch history unavailable`);
      continue;
    }

    const { matches, excluded } = evaluator.evaluateProfile(profile, items, ctx);
    const status = profile.mode === 'review' ? 'pending_review' : 'matched';
    for (const match of matches) {
      automation.upsertCandidate({
        profileId: profile.id,
        ratingKey: match.item.ratingKey,
        tmdbId: match.item.tmdbId,
        title: match.item.title,
        mediaType: match.item.type,
        status,
        details: candidateDetails(match, ctx),
      });
    }
    const pruned = automation.pruneStaleCandidates(profile.id, matches.map(m => m.item.ratingKey));
    const summary = { matched: matches.length, excluded, pruned, deleted: 0, failed: 0 };

    if (profile.mode === 'auto') {
      const graceCutoff = ctx.now - profile.gracePeriodDays * 86400;
      const eligible = automation.getCandidates({ profileId: profile.id, status: 'matched' })
        .filter(c => c.firstMatchedAt <= graceCutoff)
        .slice(0, profile.maxDeletionsPerRun);
      if (eligible.length > 0) {
        const result = await executeCandidates(eligible.map(c => c.id), { ctx });
        summary.deleted = result.deleted;
        summary.failed = result.failed;
        summary.freedBytes = result.freedBytes;
        if (result.deleted > 0) {
          notifyAdmins(
            `Auto-deletion: ${profile.name}`,
            `Deleted ${result.deleted} item(s), freed ${(result.freedBytes / 1e9).toFixed(1)} GB` +
            (result.failed ? ` (${result.failed} failed)` : '')
          );
        }
      }
    }
    runSummary[profile.id] = summary;
    logger.info(`[deletion] profile "${profile.name}" (${profile.mode}): ${JSON.stringify(summary)}`);
  }

  db.setSetting('deletion_last_run', JSON.stringify({ at: ctx.now, profiles: runSummary }));
  return runSummary;
}

module.exports = { runProfiles, previewProfile, executeCandidates, notifyAdmins };
