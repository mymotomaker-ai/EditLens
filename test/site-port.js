'use strict';
// For previews and e2e scripts that open a running site (examples/vite-react, a static page): each
// page the browser opens loads live.js from this script's own EditLens port (EDITLENS_PORT, set
// before this file is loaded) instead of the port written in the page, usually 4317. So the
// EditLens server the user runs there is never used or stopped.
const config = require('../lib/config');
const { launch } = require('./launch');

const LIVE_SRC = /(\/\/(?:127\.0\.0\.1|localhost|\[::1\]):)\d+(\/live\.js)/g;

// The page text with every live.js address on this script's port.
function onOwnPort(html) {
  return html.replace(LIVE_SRC, `$1${config.port}$2`);
}

// Starts Chromium (`chromium` from playwright) and changes the HTML pages of every new context;
// other requests are not changed. A changed page has no network address for Chromium, so its check
// on pages loading from this computer (127.0.0.1) is off, as it is for a page the site serves itself.
async function launchOwnPort(chromium, options = {}) {
  const browser = await launch(chromium, { ...options, args: [...(options.args || []), '--disable-features=LocalNetworkAccessChecks'] });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.route(() => true, async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      let res;
      try {
        res = await route.fetch();
      } catch (err) {
        if (!(err instanceof Error) || !/^route\.fetch: /.test(err.message)) throw err;
        // The site did not answer. The request ends here with that error: asked again unchanged, an
        // answer would load live.js from the port written in the page.
        return route.abort(/\bECONNREFUSED\b/.test(err.message) ? 'connectionrefused' : 'failed');
      }
      if (!/text\/html/i.test(res.headers()['content-type'] || '')) return route.fulfill({ response: res });
      return route.fulfill({ response: res, body: onOwnPort(await res.text()) });
    });
    return context;
  };
  browser.newPage = async (...args) => (await browser.newContext(...args)).newPage();
  return browser;
}

module.exports = { launchOwnPort, onOwnPort };
