// Minimal deterministic zip writer.
//
// Node has zlib built in, so writing a zip needs no dependency. Determinism is
// the point: identical inputs must produce a byte-identical archive, so a
// rebuild that changes nothing can be proven to have changed nothing. That
// means fixed timestamps, fixed version and attribute fields, no extra fields,
// and entries written in sorted order.
//
// Deliberately not supported: zip64. Entries are checked against the 4 GiB
// field limits and the writer throws rather than emitting a broken archive.

import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createDeflateRaw, constants as zlibConstants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';

const U32_MAX = 0xffffffff;
const MAX_ENTRIES = 0xffff;

// MS-DOS timestamp for 1980-01-01 00:00:00, the earliest the format can
// express. Any fixed value works; this one is unambiguous.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Deflate a file, returning the compressed chunks plus crc and sizes.
 *
 * We buffer the compressed output rather than streaming straight into the
 * archive because a local file header has to state the compressed size before
 * the data. The alternative is a trailing data descriptor, which some older
 * unpackers handle poorly. Peak memory is the compressed size of the single
 * largest file - about 230 MB for MoonHeight - not the whole archive.
 */
async function deflateFile(path, level) {
  const chunks = [];
  let crc = 0;
  let rawSize = 0;
  let compressedSize = 0;

  // The checksum is taken by a Transform in the middle of the pipeline rather
  // than by a listener on the source. Attaching a 'data' handler would switch
  // the source into flowing mode and drain it before pipeline() wires up the
  // deflate stream, producing correct checksums over empty compressed output.
  const tally = new Transform({
    transform(chunk, _enc, cb) {
      crc = crc32(chunk, crc);
      rawSize += chunk.length;
      cb(null, chunk);
    },
  });

  const collect = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      compressedSize += chunk.length;
      cb();
    },
  });

  await pipeline(createReadStream(path), tally, createDeflateRaw({ level }), collect);
  return { chunks, crc, rawSize, compressedSize };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const b = Buffer.alloc(30 + name.length);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);            // version needed: 2.0 (deflate)
  b.writeUInt16LE(0, 6);             // flags: none
  b.writeUInt16LE(8, 8);             // method: deflate
  b.writeUInt16LE(DOS_TIME, 10);
  b.writeUInt16LE(DOS_DATE, 12);
  b.writeUInt32LE(entry.crc, 14);
  b.writeUInt32LE(entry.compressedSize, 18);
  b.writeUInt32LE(entry.rawSize, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);            // extra field length
  name.copy(b, 30);
  return b;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const b = Buffer.alloc(46 + name.length);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);            // version made by
  b.writeUInt16LE(20, 6);            // version needed
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(8, 10);
  b.writeUInt16LE(DOS_TIME, 12);
  b.writeUInt16LE(DOS_DATE, 14);
  b.writeUInt32LE(entry.crc, 16);
  b.writeUInt32LE(entry.compressedSize, 20);
  b.writeUInt32LE(entry.rawSize, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(0, 30);            // extra
  b.writeUInt16LE(0, 32);            // comment
  b.writeUInt16LE(0, 34);            // disk number
  b.writeUInt16LE(0, 36);            // internal attrs
  b.writeUInt32LE(0, 38);            // external attrs: fixed, not from the fs
  b.writeUInt32LE(entry.offset, 42);
  name.copy(b, 46);
  return b;
}

function endOfCentralDirectory(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  b.writeUInt16LE(0, 20);            // comment length
  return b;
}

/**
 * Write `files` (an array of {source, name}) into a zip at `outPath`.
 * Entries are sorted by archive name so the output does not depend on
 * directory iteration order.
 */
export async function writeZip(outPath, files, { level = zlibConstants.Z_DEFAULT_COMPRESSION, onProgress } = {}) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (sorted.length > MAX_ENTRIES) {
    throw new Error(outPath + ': ' + sorted.length + ' entries exceeds the non-zip64 limit of ' + MAX_ENTRIES);
  }

  const out = createWriteStream(outPath);
  const write = (buf) => new Promise((resolve, reject) => {
    out.write(buf, (err) => (err ? reject(err) : resolve()));
  });

  const entries = [];
  let offset = 0;

  for (const f of sorted) {
    const size = (await stat(f.source)).size;
    if (size > U32_MAX) throw new Error(f.source + ' exceeds 4 GiB; zip64 is not supported');

    const { chunks, crc, rawSize, compressedSize } = await deflateFile(f.source, level);
    const entry = { name: f.name, crc, rawSize, compressedSize, offset };

    const header = localHeader(entry);
    await write(header);
    offset += header.length;
    for (const c of chunks) {
      await write(c);
      offset += c.length;
    }
    if (offset > U32_MAX) throw new Error(outPath + ' exceeds 4 GiB; zip64 is not supported');

    entries.push(entry);
    onProgress?.(entry, entries.length, sorted.length);
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const e of entries) {
    const buf = centralHeader(e);
    await write(buf);
    cdSize += buf.length;
  }
  await write(endOfCentralDirectory(entries.length, cdSize, cdOffset));

  await new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });

  const rawTotal = entries.reduce((n, e) => n + e.rawSize, 0);
  return { path: outPath, entries: entries.length, rawBytes: rawTotal, zipBytes: cdOffset + cdSize + 22 };
}
