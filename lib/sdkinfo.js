'use strict';
// What page control downloads the first time, named the same way everywhere it is mentioned.
// hooks/mod.mjs can't load this file; test/sdkinfo.test.js checks its copy matches.

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const SDK_VERSION = '0.3.292';
const SDK_MAKER = 'Anthropic';
const DEFAULT_REGISTRY = 'registry.npmjs.org';

// The host of an npm registry address, or the default one when it isn't a usable address.
function registryHost(url) {
  if (typeof url !== 'string' || !url.trim()) return DEFAULT_REGISTRY;
  try {
    const u = new URL(url.trim());
    return /^https?:$/.test(u.protocol) && u.hostname ? u.host : DEFAULT_REGISTRY;
  } catch (err) {
    if (err instanceof TypeError) return DEFAULT_REGISTRY;
    throw err;
  }
}

// "@anthropic-ai/claude-agent-sdk (made by Anthropic) from registry.npmjs.org"
function sdkSource(host = DEFAULT_REGISTRY) {
  return `${SDK_PACKAGE} (made by ${SDK_MAKER}) from ${host}`;
}

module.exports = { SDK_PACKAGE, SDK_VERSION, SDK_MAKER, DEFAULT_REGISTRY, registryHost, sdkSource };
