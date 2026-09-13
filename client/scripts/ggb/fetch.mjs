/**
 * Build-time fetch of the official GeoGebra math-apps bundle.
 *
 * The sandbox document (public/ggb-runtime.html) is served from an origin of its own
 * with `default-src 'none'`, so the runtime cannot come from the GeoGebra CDN the
 * official loader would normally use — it has to be self-hosted under this build.
 * This script downloads the bundle once and lays out only the files the document
 * loads, under public/geogebra/, where copyPublicAssets() picks them up.
 *
 * The `HTML5/5.0/web3d/` depth is load-bearing: deployggb.js derives the module name
 * from `folders[folders.length - 3]`, so flattening the tree breaks the lookup.
 *
 * Network or layout failure exits non-zero on purpose: a dist missing these files is
 * a runtime full of 404s, which is worse than a build that stops. SKIP_GGB_FETCH=1
 * opts out explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BUNDLE_URL = 'https://download.geogebra.org/package/geogebra-math-apps-bundle';
const PINNED_SOURCE = 'geogebra-math-apps-bundle-5-4-929-3.zip';
const EXPECTED_BYTES = 33412547;
const MIN_PLAUSIBLE_BYTES = 20 * 1024 * 1024;
/** Generous enough for a slow CI runner (~110 KB/s), short enough that a black-holed
 *  route fails the build instead of hanging it. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const ZIP_ROOT = 'GeoGebra/';
const KEEP_PREFIXES = ['HTML5/5.0/web3d/', 'HTML5/5.0/css/'];
const KEEP_FILES = ['deployggb.js'];
const KEEP_LANGUAGES = ['en', 'zh-CN'];
const LANGUAGE_FILE = /^properties_keys_(.+)\.js$/;
const LANGUAGE_DIR = 'HTML5/5.0/web3d/js';
const MARKER = '.ggb-bundle.json';
/** Bump when the extraction or pruning rules change, so a stale tree is refetched. */
const LAYOUT_VERSION = 1;

const target = path.resolve(import.meta.dirname, '../../public/geogebra');

const log = (...parts) => console.log('[ggb]', ...parts);

function fail(message) {
  console.error(`[ggb] ERROR: ${message}`);
  /* An explicit process.exit() here trips a libuv assertion on Windows while undici's
     handles are still closing, which turns a clear failure into a crash dump. */
  process.exitCode = 1;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function keptRelativePath(name) {
  if (!name.startsWith(ZIP_ROOT)) {
    return null;
  }
  const relative = name.slice(ZIP_ROOT.length);
  if (KEEP_FILES.includes(relative)) {
    return relative;
  }
  return KEEP_PREFIXES.some((prefix) => relative.startsWith(prefix)) ? relative : null;
}

function readDirectoryEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error('the archive uses ZIP64, which this extractor does not implement');
  }
  const entries = [];
  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entries.push({
      name: buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      size: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error('not a zip archive: end of central directory not found');
}

function readEntryData(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    return raw;
  }
  if (entry.method !== 8) {
    throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  }
  return zlib.inflateRawSync(raw);
}

async function download() {
  log(`downloading ${BUNDLE_URL}`);
  let response;
  let buffer;
  try {
    response = await fetch(BUNDLE_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const hint =
      error.name === 'TimeoutError'
        ? '; a machine behind a proxy needs NODE_USE_ENV_PROXY=1 for fetch() to use it'
        : '';
    throw new Error(`download failed: ${error.message}${hint}`);
  }
  if (buffer.length !== EXPECTED_BYTES) {
    log(`NOTE: expected ${EXPECTED_BYTES} bytes from ${PINNED_SOURCE}, got ${buffer.length}`);
    log(`NOTE: resolved to ${response.url}`);
  }
  if (buffer.length < MIN_PLAUSIBLE_BYTES) {
    throw new Error(`download looks truncated: ${buffer.length} bytes`);
  }
  log(`downloaded ${formatBytes(buffer.length)} (${buffer.length} bytes)`);
  log(`resolved source: ${response.url}`);
  return { buffer, source: response.url };
}

async function extract(buffer) {
  await fs.promises.rm(target, { recursive: true, force: true });
  const entries = readDirectoryEntries(buffer);
  let files = 0;
  let skipped = 0;
  for (const entry of entries) {
    const relative = keptRelativePath(entry.name);
    if (relative === null) {
      skipped += 1;
      continue;
    }
    const destination = path.join(target, relative);
    if (entry.name.endsWith('/')) {
      await fs.promises.mkdir(destination, { recursive: true });
      continue;
    }
    const data = readEntryData(buffer, entry);
    if (data.length !== entry.size) {
      throw new Error(`${entry.name}: extracted ${data.length} bytes, expected ${entry.size}`);
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, data);
    files += 1;
  }
  log(`extracted ${files} files, ignored ${skipped} unrelated entries`);
}

async function pruneLanguages() {
  const directory = path.join(target, LANGUAGE_DIR);
  const names = await fs.promises.readdir(directory);
  const removed = [];
  for (const name of names) {
    const match = LANGUAGE_FILE.exec(name);
    if (!match || KEEP_LANGUAGES.includes(match[1])) {
      continue;
    }
    await fs.promises.rm(path.join(directory, name));
    removed.push(name);
  }
  log(`pruned ${removed.length} language files, kept: ${KEEP_LANGUAGES.join(', ')}`);
}

/** Names of language files that should have been pruned, or null when the directory is gone. */
async function staleLanguages() {
  const directory = path.join(target, LANGUAGE_DIR);
  const names = await fs.promises.readdir(directory).catch(() => null);
  if (names === null) {
    return null;
  }
  return names.filter((name) => {
    const match = LANGUAGE_FILE.exec(name);
    return match && !KEEP_LANGUAGES.includes(match[1]);
  });
}

async function requiredPaths() {
  const web3d = path.join(target, 'HTML5/5.0/web3d');
  const names = await fs.promises.readdir(web3d).catch(() => []);
  return {
    deployggb: path.join(target, 'deployggb.js'),
    nocache: path.join(web3d, 'web3d.nocache.js'),
    module: path.join(web3d, 'web3d.nocache.mjs'),
    cache: names
      .filter((name) => /^[0-9a-fA-F]{32}\.cache\.js$/.test(name))
      .map((name) => path.join(web3d, name)),
  };
}

async function isComplete() {
  let marker;
  try {
    marker = JSON.parse(await fs.promises.readFile(path.join(target, MARKER), 'utf8'));
  } catch {
    return false;
  }
  if (marker.layoutVersion !== LAYOUT_VERSION) {
    return false;
  }
  const paths = await requiredPaths();
  const candidates = [paths.deployggb, paths.nocache, paths.module, ...paths.cache];
  if (paths.cache.length === 0 || !candidates.every((p) => fs.existsSync(p))) {
    return false;
  }
  const stale = await staleLanguages();
  return stale !== null && stale.length === 0;
}

async function measure(directory) {
  const stats = await fs.promises.stat(directory);
  if (!stats.isDirectory()) {
    return { bytes: stats.size, files: 1 };
  }
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map((entry) => measure(path.join(directory, entry.name))),
  );
  return results.reduce(
    (total, result) => ({ bytes: total.bytes + result.bytes, files: total.files + result.files }),
    { bytes: 0, files: 0 },
  );
}

async function report() {
  const paths = await requiredPaths();
  const parts = [
    ['deployggb.js', paths.deployggb],
    ['HTML5/5.0/web3d', path.join(target, 'HTML5/5.0/web3d')],
    ['HTML5/5.0/css', path.join(target, 'HTML5/5.0/css')],
  ];
  for (const [label, directory] of parts) {
    const { bytes, files } = await measure(directory);
    log(`  ${label}: ${formatBytes(bytes)} in ${files} files`);
  }
  const total = await measure(target);
  log(`geogebra runtime total: ${formatBytes(total.bytes)} in ${total.files} files`);
  const languages = (await fs.promises.readdir(path.join(target, LANGUAGE_DIR))).filter((name) =>
    LANGUAGE_FILE.test(name),
  );
  log(`language files kept: ${languages.join(', ')}`);
}

async function main() {
  if (process.env.SKIP_GGB_FETCH === '1') {
    log('SKIP_GGB_FETCH=1 set, leaving public/geogebra/ untouched');
    return;
  }
  const force = process.argv.includes('--force');
  if (!force && (await isComplete())) {
    log(`public/geogebra/ is already complete, skipping download (--force to refetch)`);
    await report();
    return;
  }
  const { buffer, source } = await download();
  await extract(buffer);
  await pruneLanguages();
  await fs.promises.writeFile(
    path.join(target, MARKER),
    `${JSON.stringify(
      { layoutVersion: LAYOUT_VERSION, source, bytes: buffer.length, languages: KEEP_LANGUAGES },
      null,
      2,
    )}\n`,
  );
  await report();
}

try {
  await main();
} catch (error) {
  fail(error.message);
}
