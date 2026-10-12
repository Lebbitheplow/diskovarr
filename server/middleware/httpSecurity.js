const net = require('net');
const express = require('express');

// Proxies on loopback, link-local and private (RFC 1918 / ULA) addresses: a
// reverse proxy or tunnel on the same host, the LAN or a Docker network.
// Clients connecting straight from a public address are never trusted, so
// they can't spoof X-Forwarded-For (rate limits) or X-Forwarded-Proto.
const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';
const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

// proxy-addr < 2.0.8 (GHSA-jqcg-44mw-7w3h) lets an IPv6 subnet with zero
// leading bits, e.g. ::ffff:10.0.0.0/8 or ::/1, match every IPv4 client.
function trustsEveryIPv4(addr, prefix) {
  const list = new net.BlockList();
  list.addSubnet(addr, prefix, 'ipv6');
  return list.check('::ffff:198.51.100.7', 'ipv6');
}

/**
 * Express `trust proxy` value from the TRUST_PROXY env var, in any of express's
 * formats: a hop count, true/false, or comma-separated IPs, CIDRs and the
 * loopback/linklocal/uniquelocal presets. Unset → DEFAULT_TRUST_PROXY.
 * Throws on a value express can't compile, so a typo fails at boot.
 */
function trustProxySetting(raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return DEFAULT_TRUST_PROXY;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  // A numeric string would be read as an IP address; hop counts must be numbers
  if (/^\d+$/.test(value)) return Number(value);

  try {
    express().set('trust proxy', value);
  } catch (err) {
    throw new Error(`Invalid TRUST_PROXY "${value}": ${err.message}`);
  }
  for (const entry of value.split(',').map(e => e.trim())) {
    if (PRESETS.has(entry)) continue;
    const [addr, prefix] = entry.split('/');
    if (net.isIPv6(addr) && /^\d+$/.test(prefix || '') && trustsEveryIPv4(addr, Number(prefix))) {
      throw new Error(`Invalid TRUST_PROXY entry "${entry}": it matches every IPv4 address — write IPv4 ranges in IPv4 notation (e.g. 10.0.0.0/8)`);
    }
  }
  return value;
}

// Low-risk headers for every response. Deliberately no X-Frame-Options or CSP:
// Diskovarr is commonly embedded in dashboards (Organizr, Homarr) and renders
// inline styles. strict-origin-when-cross-origin rather than same-origin because
// the YouTube trailer embed refuses to play without a referring origin.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

module.exports = { trustProxySetting, securityHeaders, DEFAULT_TRUST_PROXY };
