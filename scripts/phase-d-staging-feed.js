#!/usr/bin/env node
/**
 * PHASE D — local staging update feed.
 *
 * Serves the real electron-updater wire format (latest.yml + .blockmap + the
 * installer itself) over plain HTTP on 127.0.0.1, so the packaged application
 * exercises the genuine GenericProvider download path: real HTTP, real YAML
 * metadata, real sha512 verification, real byte stream, real NSIS installer.
 *
 * This exists because §2 and §20 forbid touching the production GitHub feed.
 * Nothing about the CLIENT is stubbed — only the origin of the bytes.
 *
 * Routes:
 *   GET /latest.yml              -> version metadata for the staged v2
 *   GET /<installer>.exe         -> the update artifact itself
 *   GET /<installer>.exe.blockmap-> differential metadata
 *
 * Usage: node scripts/phase-d-staging-feed.js <distDir> <port>
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = process.argv[2] || path.join(__dirname, '..', 'dist');
const PORT = parseInt(process.argv[3] || '34811', 10);

/**
 * Stream a byte range, optionally throttled.
 *
 * Byte-exact: identical bytes, identical length, identical Content-Length and
 * Range semantics. With PHASE_D_THROTTLE_MS set, it writes in 1MB chunks with a
 * pause between them so the transfer spans enough wall-clock time for
 * electron-updater to emit genuine download-progress events. It does NOT invent
 * progress in the client — every value the app reports still comes from the
 * updater's own byte counters.
 */
async function streamThrottled(res, file, start, end) {
  // `end` must be a number or omitted entirely. Passing `{ start: 0, end: null }`
  // throws ERR_INVALID_ARG_TYPE, which used to CRASH the feed process, so a plain
  // GET of the installer killed the server instead of serving it.
  const rangeOpts = (start == null) ? undefined
    : (end == null ? { start } : { start, end });
  const stream = fs.createReadStream(file, rangeOpts);

  // Iterate the stream properly: a `data` handler that ignores events while a
  // chunk is "in flight" DROPS those chunks. Async iteration applies backpressure
  // and delivers every byte exactly once.
  try {
    for await (const chunk of stream) {
      if (res.destroyed) break;
      if (!res.write(chunk)) {
        await new Promise((r) => res.once('drain', r));
      }
      if (THROTTLE_MS) await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
    if (!res.destroyed) res.end();
  } catch (e) {
    // Never let a per-request stream error take the feed down.
    log(500, `${path.basename(file)}: ${e.message}`);
    try { res.destroy(); } catch { /* client already gone */ }
  }
}

/**
 * Optional per-chunk delay (ms) so a loopback transfer spans enough wall-clock
 * time for electron-updater to emit `download-progress` events. A 114MB file over
 * loopback otherwise completes in ~300ms, and the updater emits no progress at
 * all — which makes the progress assertions unobservable rather than wrong.
 *
 * The bytes themselves are untouched: same file, same length, same sha512.
 * Controlled by PHASE_D_THROTTLE_MS.
 */
const THROTTLE_MS = parseInt(process.env.PHASE_D_THROTTLE_MS || '0', 10);
console.log(`[feed]   throttle: ${THROTTLE_MS}ms per chunk (${THROTTLE_MS ? 'pacing download' : 'unthrottled'})`);
const CHUNK = 1024 * 1024;

/** The staged feed advertises exactly one release: v2. */
function buildFeed() {
  const installer = fs.readdirSync(DIST)
    .find((f) => /^BlackStack.*Setup.*\.exe$/i.test(f));
  if (!installer) throw new Error(`no installer (*Setup*.exe) found in ${DIST}`);

  const file = path.join(DIST, installer);
  const bytes = fs.readFileSync(file);
  let sha512 = require('crypto').createHash('sha512').update(bytes).digest('base64');
  let size = fs.statSync(file).size;

  // PHASE_D_FEED_FORCE_SHA512=<b64> makes the feed DECLARE a different hash
  // than the bytes it serves. That is the only way to exercise electron-updater's
  // integrity check: a self-consistent feed is, by construction, verifiable.
  const forced = process.env.PHASE_D_FEED_FORCE_SHA512;
  if (forced) sha512 = forced;

  // Advertise an artifact that is not on disk. electron-updater must fail the
  // download rather than install anything.
  let advertisedName = installer;
  const forcedPath = process.env.PHASE_D_FEED_FORCE_PATH;
  if (forcedPath) advertisedName = forcedPath;

  // Read the version electron-builder itself wrote, so the feed can never
  // disagree with the artifact it is advertising.
  const meta = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const version = (meta.match(/^version:\s*(\S+)/m) || [])[1];
  if (!version) throw new Error('cannot determine staged version from latest.yml');

  return {
    installer,          // the REAL file on disk — used for routing
    advertised: advertisedName, // the name published in metadata
    file,
    version,
    size,
    sha512,
    blockmap: fs.existsSync(file + '.blockmap') ? installer + '.blockmap' : null,
  };
}

const feed = buildFeed();

// Absolute artifact URL: electron-updater resolves `files[].url` and `path`
// against the provider base. A relative value loses the feed's port and yields
// "http://127.0.0.1/<file>", which 404s.
const absolute = `http://127.0.0.1:${PORT}/${feed.advertised.replace(/ /g, '%20')}`;
const yml = [
  `version: ${feed.version}`,
  'files:',
  `  - url: ${absolute}`,
  `    sha512: ${feed.sha512}`,
  `    size: ${feed.size}`,
  `path: ${absolute}`,
  `sha512: ${feed.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const log = (code, what) => {
    try {
      fs.appendFileSync(path.join(DIST, 'phase-d-feed.log'),
        `${new Date().toISOString()} ${req.method} ${url} -> ${code} ${what}\n`);
    } catch { /* logging must not break the feed */ }
  };

  // electron-updater requests a CHANNEL-scoped metadata file when a channel is
  // set (`stable.yml`, `beta.yml`), and falls back to `latest.yml` only for the
  // "latest" channel. Serving just latest.yml produced a real 404 —
  // "Cannot find channel \"stable.yml\" update info" — so both are served, with
  // identical content, because both builds publish to the same staged release.
  const isMeta = url === '/latest.yml' || url === '/stable.yml'
    || url === '/beta.yml' || url === '/enterprise.yml';

  if (isMeta) {
    res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(yml) });
    res.end(yml);
    log(200, `${url} -> ${feed.version} metadata`);
    return;
  }

  const want = url.replace(/^\//, '');
  if (want === feed.installer || want === feed.installer + '.blockmap') {
    const target = want.endsWith('.blockmap') ? feed.file + '.blockmap' : feed.file;
    if (!fs.existsSync(target)) {
      res.writeHead(404); res.end('missing'); log(404, want); return;
    }
    const stat = fs.statSync(target);
    const range = req.headers.range;
    // Range support matters: electron-updater uses it for the blockmap-driven
    // differential download. Returning 200 for a range request would still
    // "work" but would not exercise the real path.
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      streamThrottled(res, target, start, end);
      log(206, `${want} ${start}-${end}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    streamThrottled(res, target, 0, null);
    log(200, `${want} (${stat.size} bytes)`);
    return;
  }

  res.writeHead(404); res.end('not found'); log(404, url);
});

server.listen(PORT, '127.0.0.1', () => {
  // The machine-readable handshake the driver script waits for.
  fs.writeFileSync(path.join(DIST, 'phase-d-feed.ready'),
    JSON.stringify({ port: PORT, version: feed.version, installer: feed.installer, size: feed.size }, null, 2));
  console.log(`[feed] serving v${feed.version} on http://127.0.0.1:${PORT}`);
  console.log(`[feed]   /latest.yml`);
  console.log(`[feed]   /${feed.installer}`);
});
