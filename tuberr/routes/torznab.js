const express = require('express');
const { db, getSetting } = require('../db');
const releases = require('../lib/releases');

const router = express.Router();

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

router.use((req, res, next) => {
  if ((req.query.apikey || '') !== getSetting('api_key')) {
    res.status(401).type('application/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><error code="100" description="Invalid API Key"/>');
    return;
  }
  next();
});

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Tuberr"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,season,ep,tvdbid"/>
    <movie-search available="no" supportedParams=""/>
  </searching>
  <categories>
    <category id="5000" name="TV">
      <subcat id="5070" name="TV/Web-DL"/>
    </category>
  </categories>
</caps>`;

function matchedRowsFor(mapping, season, ep) {
  let sql = 'SELECT * FROM episode_matches WHERE mapping_id = ? AND video_id IS NOT NULL AND broken = 0';
  const params = [mapping.id];
  if (season !== undefined && ep !== undefined && String(ep).includes('/')) {
    // Daily series: season=YYYY & ep=MM/DD → look up by air date
    const [mm, dd] = String(ep).split('/');
    sql += ' AND air_date = ?';
    params.push(`${season}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
  } else {
    if (season !== undefined) { sql += ' AND season = ?'; params.push(Number(season)); }
    if (ep !== undefined) { sql += ' AND episode = ?'; params.push(Number(ep)); }
  }
  sql += ' ORDER BY season DESC, episode DESC LIMIT 100';
  return db.prepare(sql).all(...params);
}

function itemXml(release, baseUrl, apikey) {
  const link = `${baseUrl}/torznab/download/${release.infoHash}.torrent?apikey=${apikey}`;
  return `    <item>
      <title>${xmlEscape(release.releaseTitle)}</title>
      <guid isPermaLink="false">tuberr-${release.infoHash}</guid>
      <link>${xmlEscape(link)}</link>
      <pubDate>${release.pubDate.toUTCString()}</pubDate>
      <size>${release.sizeBytes}</size>
      <category>5000</category>
      <enclosure url="${xmlEscape(link)}" length="${release.sizeBytes}" type="application/x-bittorrent"/>
      <torznab:attr name="category" value="5000"/>
      <torznab:attr name="category" value="5070"/>
      <torznab:attr name="seeders" value="99"/>
      <torznab:attr name="peers" value="100"/>
      <torznab:attr name="infohash" value="${release.infoHash}"/>
      <torznab:attr name="tvdbid" value="${release.tvdbId}"/>
      <torznab:attr name="season" value="${release.season}"/>
      <torznab:attr name="episode" value="${release.episode}"/>
    </item>`;
}

router.get('/api', (req, res) => {
  const { t, tvdbid, season, ep, q } = req.query;
  if (t === 'caps') return res.type('application/xml').send(CAPS);
  if (t !== 'tvsearch' && t !== 'search') {
    return res.status(400).type('application/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><error code="203" description="Function not available"/>');
  }

  let mappings = [];
  if (tvdbid) {
    const m = db.prepare('SELECT * FROM series_mappings WHERE tvdb_id = ?').get(Number(tvdbid));
    if (m) mappings = [m];
  } else if (q) {
    mappings = db.prepare('SELECT * FROM series_mappings WHERE title LIKE ?').all(`%${String(q).slice(0, 100)}%`);
  } else {
    // RSS sync: recently matched episodes across all mappings
    mappings = db.prepare('SELECT * FROM series_mappings').all();
  }

  const items = [];
  for (const mapping of mappings) {
    for (const match of matchedRowsFor(mapping, season, ep)) {
      items.push(itemXml(releases.buildRelease(mapping, match), baseUrlOf(req), req.query.apikey));
      if (items.length >= 100) break;
    }
    if (items.length >= 100) break;
  }

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <atom:link href="${xmlEscape(baseUrlOf(req) + '/torznab/api')}" rel="self" type="application/rss+xml"/>
    <title>Tuberr</title>
${items.join('\n')}
  </channel>
</rss>`);
});

function baseUrlOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/download/:hash.torrent', (req, res) => {
  const buffer = releases.torrentFor(req.params.hash);
  if (!buffer) return res.status(404).type('text/plain').send('unknown grab');
  res.set('Content-Disposition', `attachment; filename="${req.params.hash}.torrent"`);
  res.type('application/x-bittorrent').send(buffer);
});

module.exports = router;
