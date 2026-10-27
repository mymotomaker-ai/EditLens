'use strict';
// The out-dir argument of a preview script. A web address passed there by mistake (the arguments
// are in a different order in some scripts) would create a folder named "http:", which Windows
// can't check out, so it stops the script instead.
module.exports = function outDirArg(dir, usage) {
  if (typeof dir !== 'string' || !dir || /^[a-z][a-z0-9+.-]*:\/\//i.test(dir)) {
    console.error('Not an output folder: ' + JSON.stringify(dir) + (usage ? '\nusage: ' + usage : ''));
    process.exit(2);
  }
  return dir;
};
