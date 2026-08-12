// Browser-side Plex Companion delivery. The server can't reach a player inside
// another household's network, but this browser usually can — it sits on the
// same LAN as the user's TV.
//
// Players publish plain http:// LAN URIs (e.g. http://10.0.0.5:32500). From an
// https page that is mixed content, EXCEPT in Chromium 142+ where annotating
// the fetch with targetAddressSpace: 'local' + the Local Network Access
// permission prompt exempts it. Firefox/Safari still block, so non-Chromium
// browsers skip browser delivery entirely and cast through the server
// (which only reaches players on the server's own LAN).

// userAgentData is itself Chromium-only; the UA regex covers older builds.
export function isChromiumBrowser() {
  if (navigator.userAgentData?.brands?.some(b => b.brand === 'Chromium')) return true
  return /Chrome|Chromium|Edg\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent)
}

// 'granted' | 'prompt' | 'denied' | null (Permissions API can't answer).
export async function localNetworkPermission() {
  try {
    const p = await navigator.permissions.query({ name: 'local-network-access' })
    return p.state
  } catch {
    return null
  }
}

// Controllers are expected to increment commandID per command.
let commandID = 0

const isHttpUri = uri => uri.startsWith('http:')

const localFetchOpts = uri => ({
  mode: 'cors',
  // Chromium: marks the request as local-network so mixed content is exempted
  // (after the user grants the LNA permission). Unknown fetch options are
  // ignored elsewhere. Player URIs are always LAN addresses.
  ...(isHttpUri(uri) ? { targetAddressSpace: 'local' } : {}),
})

// Fire-and-forget request to a player URI, made when the cast picker OPENS.
// Its only job is to surface Chrome's Local Network Access prompt while the
// user is still choosing a device — the first real cast otherwise sat behind
// a prompt the user hadn't noticed yet. The permission is per-site, so one
// probe covers every device, and once granted this is a no-op ~100ms request.
let probed = false
export function probeLocalNetwork(uri) {
  if (probed || !uri) return
  probed = true
  try {
    fetch(`${uri}/resources?X-Plex-Client-Identifier=DISKOVARR`, {
      ...localFetchOpts(uri),
      // Long timeout: the request stays pending until the user answers the
      // permission prompt. The response itself is irrelevant.
      signal: AbortSignal.timeout(120000),
    }).catch(() => {})
  } catch { /* fetch option validation quirks on old builds — probe is best-effort */ }
}

// prep is the /api/cast/prepare payload: { connections, params,
// clientIdentifier, targetClientIdentifier }. Tries each connection in order;
// resolves { ok: true, uri } on the first player that accepts, otherwise
// { ok: false, reason: 'rejected' | 'unreachable' }.
//
// When this returns not-ok, every fetch it started is dead (errored or
// aborted) — including one parked behind the LNA permission prompt, which
// never hit the wire. The caller can therefore run the server fallback
// afterwards with no risk of the player receiving the command twice.
export async function sendPlayMedia(prep) {
  const candidates = prep.connections || []
  if (candidates.length === 0) return { ok: false, reason: 'unreachable' }

  // If the LNA permission is still undecided, the fetch sits pending until
  // the user answers the prompt — give them time. Once granted (the normal
  // steady state), a reachable TV answers in well under a second, so short
  // timeouts keep the unreachable-TV case snappy. The overall deadline stops
  // multi-connection devices from stacking per-candidate timeouts.
  const permission = await localNetworkPermission()
  const granted = permission === 'granted'
  const perAttemptMs = granted ? 4000 : 30000
  const overall = AbortSignal.timeout(granted ? 12000 : 45000)

  let rejectedStatus = null
  for (const uri of candidates.slice(0, 6)) {
    if (overall.aborted) break
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
        ...localFetchOpts(uri),
        signal: AbortSignal.any([overall, AbortSignal.timeout(perAttemptMs)]),
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
