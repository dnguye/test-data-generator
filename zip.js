/* ---------------------------------------------------------------------------
   zip.js -- a minimal ZIP writer, so "Download all" hands back ONE file.

   Downloading a file per entity means a browser sees several downloads in a
   row from one click, which Chrome and Firefox both interrupt with a "wants to
   download multiple files" prompt and sometimes drop outright. A single
   archive is one download, arrives whole, and keeps the files of one
   generation run together -- which matters here, because the ids in those
   files only line up when they came from the same run.

   No dependencies and no build step, like everything else in this repo. The
   format written is the plain original one: local header, data, central
   directory, end record. Entries are deflated through the platform's own
   CompressionStream where it exists and stored uncompressed where it does not,
   which every unzip program has understood for thirty years.

   Zip64 is deliberately absent. It starts mattering at 4 GB per entry, and the
   generator caps a run at 10,000 rows.
--------------------------------------------------------------------------- */
"use strict";

/* ---------- CRC-32 (the checksum the format requires per entry) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- MS-DOS date and time, which is what the format stores ----------
   Two 16-bit fields with two-second resolution, epoch 1980. Anything earlier
   cannot be represented, so it is clamped rather than written as garbage. */
function dosTime(d) {
  return (((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31)) & 0xFFFF;
}
function dosDate(d) {
  const year = Math.max(1980, d.getFullYear());
  return ((((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)) & 0xFFFF;
}

/* ---------- entry names ----------
   Zip paths use forward slashes and no drive letters or leading slash; a
   caller passing one would produce an archive some tools refuse to extract. */
function cleanName(name) {
  const s = String(name).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\.(?=\/|$)/g, "_");
  if (!s) throw new Error("zip: an entry needs a name");
  return s;
}

/* ---------- deflate through the platform, when it has one ----------
   CompressionStream("deflate-raw") is exactly the bit stream a zip entry with
   method 8 holds. Where it is missing (older Safari, an odd runtime) or where
   compressing made the entry bigger, the entry is stored instead -- a valid
   archive either way, just larger. */
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.length < bytes.length ? out : null;
  } catch (e) {
    return null;                              // no compression is never wrong, only bigger
  }
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, text?: string, bytes?: Uint8Array}>} files
 * @param {{date?: Date, compress?: boolean}} [options]
 *        date     stamped on every entry; pass a fixed one for a byte-stable archive
 *        compress default true; false stores everything, which is faster
 * @returns {Promise<Uint8Array>}
 */
async function zipFiles(files, options = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error("zip: nothing to archive");
  const when = options.date instanceof Date ? options.date : new Date();
  const compress = options.compress !== false;
  const time = dosTime(when), date = dosDate(when);
  const enc = new TextEncoder();

  const parts = [];                 // the archive, in order
  const central = [];               // central directory records, written after the data
  const seen = new Set();
  let offset = 0;                   // where the next local header starts

  for (const file of files) {
    const name = cleanName(file.name);
    if (seen.has(name)) throw new Error('zip: two entries are both named "' + name + '"');
    seen.add(name);

    const data = file.bytes instanceof Uint8Array ? file.bytes : enc.encode(String(file.text ?? ""));
    const nameBytes = enc.encode(name);
    const crc = crc32(data);

    const packed = compress ? await deflateRaw(data) : null;
    const body = packed || data;
    const method = packed ? 8 : 0;

    /* Bit 11 says the name is UTF-8. Entity names reach these filenames, so
       an accented or non-Latin name has to survive the round trip. */
    const flags = 0x0800;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);     // local file header signature
    local.setUint16(4, 20, true);             // version needed
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);   // compressed size
    local.setUint32(22, data.length, true);   // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);             // extra field length
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014B50, true);       // central directory signature
    dir.setUint16(4, 20, true);               // version made by
    dir.setUint16(6, 20, true);               // version needed
    dir.setUint16(8, flags, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint16(30, 0, true);               // extra
    dir.setUint16(32, 0, true);               // comment
    dir.setUint16(34, 0, true);               // disk number
    dir.setUint16(36, 0, true);               // internal attributes
    dir.setUint32(38, 0, true);               // external attributes
    dir.setUint32(42, offset, true);          // where this entry's local header is
    central.push(new Uint8Array(dir.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);         // end of central directory
  end.setUint16(4, 0, true);                  // this disk
  end.setUint16(6, 0, true);                  // disk with the central directory
  end.setUint16(8, seen.size, true);          // entries on this disk
  end.setUint16(10, seen.size, true);         // entries total
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);                 // archive comment length

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/* A name that has not been used yet, so two entities whose names reduce to the
   same slug do not collide inside the archive. */
function uniqueEntryName(base, ext, taken) {
  let name = base + "." + ext;
  let n = 2;
  while (taken.has(name)) name = base + "-" + (n++) + "." + ext;
  taken.add(name);
  return name;
}

export { zipFiles, crc32, uniqueEntryName, cleanName };
