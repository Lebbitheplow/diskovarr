// Transforms broadcast message text per channel so markdown markers that the channel
// doesn't render are stripped — recipients on those channels see clean plain text
// instead of literal markdown characters.
//
// Source markers (set by BroadcastMessage.jsx toolbar):
//   **bold**, *italic*, __underline__, ~~strike~~, ==highlight==, `code`

const PATTERNS = {
  bold:      /\*\*([^*\n]+?)\*\*/g,
  underline: /__([^_\n]+?)__/g,
  strike:    /~~([^~\n]+?)~~/g,
  highlight: /==([^=\n]+?)==/g,
  code:      /`([^`\n]+?)`/g,
  italic:    /\*([^*\n]+?)\*/g,
};

// `supports` is a set of marker names to PRESERVE; anything not listed is stripped to plain text.
// Order matters: double-marker variants must run before single-asterisk italic.
function transformForChannel(text, supports = {}) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  if (!supports.bold)      out = out.replace(PATTERNS.bold, '$1');
  if (!supports.underline) out = out.replace(PATTERNS.underline, '$1');
  if (!supports.strike)    out = out.replace(PATTERNS.strike, '$1');
  if (!supports.highlight) out = out.replace(PATTERNS.highlight, '$1');
  if (!supports.code)      out = out.replace(PATTERNS.code, '$1');
  if (!supports.italic)    out = out.replace(PATTERNS.italic, '$1');
  return out;
}

const toPlainText = (text) => transformForChannel(text, {});
const forDiscord  = (text) => transformForChannel(text, { bold: true, italic: true, underline: true, strike: true, code: true });
// Gotify renders CommonMark when extras.client::display.contentType=text/markdown. CommonMark treats
// __text__ as bold (not underline), so strip underline to avoid double-bolding.
const forGotify   = (text) => transformForChannel(text, { bold: true, italic: true, strike: true, code: true });

module.exports = { transformForChannel, toPlainText, forDiscord, forGotify };
