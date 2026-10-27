'use strict';
// A list argument of a tool call -> an array, or null when nothing was given. Smaller models
// sometimes send the list as JSON text, or one item without the list: both still count.
function listArg(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return [value];
  const text = value.trim();
  if (!text) return null;
  if (/^[[{]|^null$/.test(text)) {
    try {
      return listArg(JSON.parse(text));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return [value];
}

module.exports = { listArg };
