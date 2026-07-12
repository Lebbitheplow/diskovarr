// Browser-side Plex Companion delivery. The server can't reach a player inside
// another household's network, but this browser usually can — it sits on the
// same LAN as the user's TV.
//
// Players publish plain http:// LAN URIs (e.g. http://10.0.0.5:32500). From an
// https page that is mixed content, EXCEPT in Chromium 142+ where annotating
// the fetch with targetAddressSpace: 'local' + the Local Network Access
// permission prompt exempts it. Firefox/Safari still block; those callers land
// on the server-side fallback (which only helps on the server's own LAN).

// The LNA mechanism above is Chromium-only, so every other browser can only
// cast to players on the server's own LAN — used to warn users up front.
// userAgentData is itself Chromium-only; the UA regex covers older builds.
export function isChromiumBrowser() {
  if (navigator.userAgentData?.brands?.some(b => b.brand === 'Chromium')) return true
  return /Chrome|Chromium|Edg\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent)
}

// Controllers are expected to increment commandID per command.
let commandID = 0

const isHttpUri = uri => uri.startsWith('http:')

// prep is the /api/cast/prepare payload: { connections, params,
// clientIdentifier, targetClientIdentifier }. Tries each connection in order;
// resolves { ok: true, uri } on the first player that accepts, otherwise
// { ok: false, reason: 'rejected' | 'unreachable' }.
export async function sendPlayMedia(prep) {
  const candidates = prep.connections || []
  if (candidates.length === 0) return { ok: false, reason: 'unreachable' }

  let rejectedStatus = null
  for (const uri of candidates) {
    commandID += 1
    // Everything goes in the query string, headers included: Plex accepts any
    // X-Plex-* header as a query param, and header-free GETs are CORS simple
    // requests — no OPTIONS preflight, which some player builds mishandle.
    const qs = new URLSearchParams({
      ...prep.params,
      commandID: String(commandID),
      'X-Plex-Target-Client-Identifier': prep.targetClientIdentifier,
      'X-Plex-Client-Identifier': prep.clientIdentifier,
      'X-Plex-Device-Name': 'Diskovarr',
    })
    try {
      const res = await fetch(`${uri}/player/playback/playMedia?${qs}`, {
        mode: 'cors',
        // Chromium: marks the request as local-network so mixed content is
        // exempted (after the user grants the LNA permission). Unknown fetch
        // options are ignored elsewhere. Player URIs are always LAN addresses.
        ...(isHttpUri(uri) ? { targetAddressSpace: 'local' } : {}),
        // Generous timeout: the Local Network Access permission prompt can
        // hold the request open while the user decides.
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) return { ok: true, uri }
      rejectedStatus = res.status
    } catch {
      // Timeout, mixed-content, CORS or network failure — try next candidate.
    }
  }
  return rejectedStatus
    ? { ok: false, reason: 'rejected', status: rejectedStatus }
    : { ok: false, reason: 'unreachable' }
}
