const { db, getSetting } = require('../db');
const runtime = require('./state');

// YouTube Data API v3. Steady-state usage is cheap: playlistItems.list and
// videos.list cost 1 unit each; only search.list (channel suggestions during
// add) costs 100 units against the 10k/day quota.

const API = 'https://www.googleapis.com/youtube/v3';
const MAX_VIDEOS_PER_MAPPING = 5000;
const FULL_REFRESH_INTERVAL_SEC = 7 * 24 * 3600;

async function ytFetch(path, params) {
  const key = getSetting('youtube_api_key');
  if (!key) throw new Error('YouTube API key not configured');
  const qs = new URLSearchParams({ ...params, key });
  const res = await fetch(`${API}${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(body)) {
      runtime.noteQuotaExceeded(`YouTube API quota exceeded (${path})`);
    }
    throw new Error(`YouTube API ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  runtime.noteQuotaOk();
  return res.json();
}

function parseIso8601Duration(text) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(text || '');
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function uploadsPlaylistOf(channelId) {
  return String(channelId).startsWith('UC') ? 'UU' + String(channelId).slice(2) : null;
}

async function searchChannels(q) {
  const data = await ytFetch('/search', { part: 'snippet', type: 'channel', maxResults: 8, q });
  return (data.items || []).map(item => ({
    channelId: item.snippet.channelId,
    title: item.snippet.channelTitle || item.snippet.title,
    description: item.snippet.description || '',
    thumbnail: item.snippet.thumbnails?.default?.url || '',
  }));
}

// Accepts a channel id, @handle, or any YouTube URL (channel/video/handle)
// and resolves it to { channelId, title }.
async function resolveChannel(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  let m = /(?:youtube\.com\/(?:channel\/|c\/)?|^)(UC[\w-]{22})/.exec(text);
  if (m) return channelById(m[1]);
  m = /youtube\.com\/(?:watch\?.*v=|shorts\/|live\/)([\w-]{11})/.exec(text) || /youtu\.be\/([\w-]{11})/.exec(text);
  if (m) {
    const data = await ytFetch('/videos', { part: 'snippet', id: m[1] });
    const video = data.items?.[0];
    return video ? channelById(video.snippet.channelId) : null;
  }
  m = /(?:youtube\.com\/)?@([\w.-]+)/.exec(text);
  if (m) {
    const data = await ytFetch('/channels', { part: 'snippet', forHandle: '@' + m[1] });
    const ch = data.items?.[0];
    return ch ? { channelId: ch.id, title: ch.snippet.title } : null;
  }
  m = /youtube\.com\/user\/([\w.-]+)/.exec(text);
  if (m) {
    const data = await ytFetch('/channels', { part: 'snippet', forUsername: m[1] });
    const ch = data.items?.[0];
    return ch ? { channelId: ch.id, title: ch.snippet.title } : null;
  }
  return null;
}

async function channelById(channelId) {
  const data = await ytFetch('/channels', { part: 'snippet', id: channelId });
  const ch = data.items?.[0];
  return ch ? { channelId: ch.id, title: ch.snippet.title } : null;
}

// Walks a playlist newest-first. With `knownIds`, stops after the first page
// that contains no unseen video (incremental poll: usually a single page).
async function listPlaylistVideos(playlistId, { knownIds = null } = {}) {
  const out = [];
  let pageToken = '';
  while (out.length < MAX_VIDEOS_PER_MAPPING) {
    const data = await ytFetch('/playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    let unseen = 0;
    for (const item of data.items || []) {
      const videoId = item.contentDetails?.videoId;
      if (!videoId) continue;
      if (knownIds && !knownIds.has(videoId)) unseen++;
      out.push({
        videoId,
        title: item.snippet?.title || '',
        description: (item.snippet?.description || '').slice(0, 2000),
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '',
        position: item.snippet?.position ?? -1,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (knownIds && unseen === 0) break;
  }
  return out;
}

async function getVideoDetails(videoIds) {
  const details = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const data = await ytFetch('/videos', {
      part: 'contentDetails,status',
      id: videoIds.slice(i, i + 50).join(','),
      maxResults: 50,
    });
    for (const item of data.items || []) {
      details.set(item.id, {
        durationSec: parseIso8601Duration(item.contentDetails?.duration),
        ok: item.status?.privacyStatus === 'public' && item.status?.uploadStatus !== 'rejected',
      });
    }
  }
  return details;
}

function playlistsOf(mapping) {
  const playlists = [];
  const uploads = mapping.uploads_playlist_id ||
    (mapping.channel_id ? uploadsPlaylistOf(mapping.channel_id) : null);
  if (uploads) playlists.push({ id: uploads, explicit: false });
  for (const id of JSON.parse(mapping.playlist_ids || '[]')) {
    playlists.push({ id, explicit: true });
  }
  if (playlists.length === 0) throw new Error('mapping has no channel or playlists configured');
  return playlists;
}

const UPSERT_VIDEO = `
  INSERT INTO videos (video_id, mapping_id, title, description, published_at, duration_sec, playlist_id, position, status, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id, mapping_id) DO UPDATE SET
    title = excluded.title, description = excluded.description, published_at = excluded.published_at,
    duration_sec = excluded.duration_sec, playlist_id = excluded.playlist_id, position = excluded.position,
    status = excluded.status, fetched_at = excluded.fetched_at
`;

// Rebuilds (full) or tops up (incremental) the candidate video pool for a
// mapping: channel uploads + any explicitly mapped playlists (whose positions
// feed the matcher). Incremental pages the uploads playlist only until a page
// has no unseen ids and never deletes; explicit playlists are always walked in
// full so positions stay accurate. A full rebuild happens automatically when
// the last one is older than a week. Returns { total, added, full }.
async function refreshVideos(mapping, { incremental = false } = {}) {
  const playlists = playlistsOf(mapping);
  const now = Math.floor(Date.now() / 1000);
  const known = new Set(db.prepare('SELECT video_id FROM videos WHERE mapping_id = ?').all(mapping.id).map(r => r.video_id));
  const full = !incremental || known.size === 0 ||
    (now - (Number(mapping.last_full_refresh_at) || 0)) > FULL_REFRESH_INTERVAL_SEC;

  const byId = new Map();
  for (const pl of playlists) {
    const opts = (!full && !pl.explicit) ? { knownIds: known } : {};
    for (const v of await listPlaylistVideos(pl.id, opts)) {
      const existing = byId.get(v.videoId);
      // Explicit playlist membership wins so position scoring can use it
      if (!existing || pl.explicit) {
        byId.set(v.videoId, { ...v, playlistId: pl.explicit ? pl.id : null });
      }
    }
  }

  const newIds = [...byId.keys()].filter(id => !known.has(id));
  // Full rebuilds refresh every video's duration/status; incremental only
  // needs details for videos we have never seen.
  const details = await getVideoDetails(full ? [...byId.keys()] : newIds);
  const existingDetails = full ? null : new Map(
    db.prepare('SELECT video_id, duration_sec, status FROM videos WHERE mapping_id = ?').all(mapping.id)
      .map(r => [r.video_id, { durationSec: r.duration_sec, ok: r.status === 'ok' }]));

  const insert = db.prepare(UPSERT_VIDEO);
  db.exec('BEGIN');
  try {
    if (full) db.prepare('DELETE FROM videos WHERE mapping_id = ?').run(mapping.id);
    for (const v of byId.values()) {
      const d = details.get(v.videoId) || (existingDetails && existingDetails.get(v.videoId)) || { durationSec: 0, ok: true };
      insert.run(v.videoId, mapping.id, v.title, v.description, v.publishedAt,
        d.durationSec, v.playlistId, v.position, d.ok ? 'ok' : 'private', now);
    }
    db.prepare(`UPDATE series_mappings SET last_refreshed_at = ?,
      last_full_refresh_at = CASE WHEN ? THEN ? ELSE last_full_refresh_at END,
      last_new_video_at = CASE WHEN ? THEN ? ELSE last_new_video_at END
      WHERE id = ?`).run(now, full ? 1 : 0, now, (newIds.length > 0 && known.size > 0) ? 1 : 0, now, mapping.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE mapping_id = ?').get(mapping.id).n;
  if (newIds.length && known.size > 0) {
    console.log(`[youtube] "${mapping.title}": ${newIds.length} new video(s) (${full ? 'full' : 'incremental'} refresh, pool ${total})`);
  }
  return { total, added: known.size > 0 ? newIds.length : 0, full };
}

module.exports = {
  searchChannels, resolveChannel, refreshVideos, uploadsPlaylistOf,
  parseIso8601Duration, listPlaylistVideos, getVideoDetails, MAX_VIDEOS_PER_MAPPING,
};
