'use strict';
// A file's text only when it is at most max bytes. The size is checked on the open file, so a huge
// file is never read into memory, and a file replaced between the check and the read is still
// caught. -> text | null (no such file, or not a plain file) | undefined (larger than max)
const fs = require('fs');

function readSmall(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR' || err.code === 'EACCES' || err.code === 'EPERM')) return null;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (!(st.size <= max)) return undefined;
    // Read at most max + 1 bytes: a file that grew since the stat is still bounded.
    const buf = Buffer.alloc(st.size + 1 > max + 1 ? max + 1 : st.size + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    if (got > max) return undefined;
    return buf.toString('utf8', 0, got);
  } catch (err) {
    if (err && err.code === 'EISDIR') return null;
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readSmall };
