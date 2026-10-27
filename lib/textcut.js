'use strict';
// Text cut to a length without splitting an emoji (or any character outside the basic plane):
// half of one shows as "�" on the page.
function sliceSafe(s, n) {
  let end = Math.max(0, n);
  if (end > 0 && end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

// A leading byte order mark (Notepad, Visual Studio) is not part of the text the code view shows.
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

module.exports = { sliceSafe, stripBom };
