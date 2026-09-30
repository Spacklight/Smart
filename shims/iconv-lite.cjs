'use strict';
// Minimal iconv-lite replacement for Cloudflare Workers.
//
// Express's body parser (body-parser -> raw-body -> iconv-lite) only needs
// charset decoding. The real iconv-lite 0.4.x is bundled in its "browser"
// form by Wrangler, which stubs out ./streams and crashes Express at startup
// ("require_streams(...) is not a function"). Wrangler swaps this file in via
// the "alias" setting in wrangler.jsonc. Decoding uses the runtime's built-in
// TextDecoder, which covers UTF-8 (used for JSON/form bodies) and other
// common charsets.

function makeTextDecoder(encoding) {
  const label = String(encoding || 'utf-8').toLowerCase();
  return new TextDecoder(label === 'binary' ? 'latin1' : label);
}

function encodingExists(encoding) {
  try {
    makeTextDecoder(encoding);
    return true;
  } catch (e) {
    return false;
  }
}

function getDecoder(encoding) {
  const td = makeTextDecoder(encoding);
  return {
    write(chunk) { return td.decode(chunk, { stream: true }); },
    end() { return td.decode(); }
  };
}

function decode(buf, encoding) {
  return makeTextDecoder(encoding).decode(buf);
}

function encode(str, encoding) {
  return Buffer.from(String(str), encoding && Buffer.isEncoding(encoding) ? encoding : 'utf8');
}

module.exports = { encodingExists, getDecoder, decode, encode };
