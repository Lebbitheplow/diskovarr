// Validation for notification destinations that ordinary users supply (their
// personal Discord webhook and browser push subscriptions). These are checked
// when saved and again right before sending, so a user can't steer
// server-originated requests at loopback/LAN services. Destinations the admin
// configures (ntfy/Gotify/webhook on the LAN) are deliberately not restricted.
const net = require('net');
const dns = require('dns');
const https = require('https');

const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
// /api/webhooks/<id>/<token>, optionally versioned (/api/v10/webhooks/...).
const DISCORD_WEBHOOK_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/\d{15,25}\/[A-Za-z0-9_-]{20,200}\/?$/;

// Loopback, private, link-local, CGNAT, multicast, reserved and documentation
// ranges. IPv4-mapped IPv6 addresses are checked against the IPv4 rules.
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
// The local-use NAT64 prefix (RFC 8215) is blocked whole: where the IPv4
// address sits inside it depends on the operator's chosen prefix length.
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

// The well-known NAT64 prefix (RFC 6052) embeds the IPv4 address in its low 32
// bits; that address decides (DNS64 hosts reach public services through it).
const NAT64_WKP = new net.BlockList();
NAT64_WKP.addSubnet('64:ff9b::', 96, 'ipv6');

// '64:ff9b::808:808' / '64:ff9b::8.8.8.8' → the last two 16-bit groups.
function lowIPv4(host) {
  const v6 = host.toLowerCase().replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) => `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`);
  const [head, tail = null] = v6.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const [g6, g7] = groups.slice(6).map(g => parseInt(g, 16) || 0);
  return [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255].join('.');
}

function isPrivateAddress(ip) {
  const host = String(ip || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (!family) return false;
  if (family === 6 && NAT64_WKP.check(host, 'ipv6')) return BLOCKED.check(lowIPv4(host), 'ipv4');
  return BLOCKED.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  try { return new URL(value.trim()); } catch { return null; }
}

function isDiscordWebhookUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return url.protocol === 'https:'
    && !url.username && !url.password
    && url.port === ''
    && DISCORD_WEBHOOK_HOSTS.has(url.hostname)
    && DISCORD_WEBHOOK_PATH.test(url.pathname);
}

// Push services (FCM, Mozilla autopush, Apple, WNS) are public HTTPS hosts. The
// URL parser normalises alternate IPv4 spellings (0x7f.1, 2130706433) to
// dotted form before this check runs.
function isSafePushEndpoint(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (net.isIP(host)) return !isPrivateAddress(host);
  return true;
}

// dns.lookup replacement for outbound requests to user-supplied hosts: refuses
// to connect when the name resolves to a private address (covers DNS names
// pointed at the LAN and rebinding between the check and the connect).
function publicOnlyLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    const blocked = list.find((a) => isPrivateAddress(a.address));
    if (blocked || !list.length) {
      const e = new Error(`Refusing to connect to ${hostname}: resolves to a private address`);
      e.code = 'EPRIVATEADDR';
      e.retryable = false;
      return callback(e);
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

let _publicAgent = null;
function publicHttpsAgent() {
  if (!_publicAgent) _publicAgent = new https.Agent({ lookup: publicOnlyLookup });
  return _publicAgent;
}

module.exports = {
  DISCORD_WEBHOOK_HOSTS,
  isPrivateAddress,
  isDiscordWebhookUrl,
  isSafePushEndpoint,
  publicOnlyLookup,
  publicHttpsAgent,
};
