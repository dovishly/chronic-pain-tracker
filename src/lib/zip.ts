// A minimal .zip writer, so an export with several files arrives as one file. Written by hand to avoid a dependency.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A .zip archive (stored, not compressed) of the given files, as bytes, all dated `when` (local time). */
export function zip(files: [string, Uint8Array][], when = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries = files.map(([name, data]) => ({ name: encoder.encode(name), data, crc: crc32(data), offset: 0 }));
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(new ArrayBuffer(localSize + centralSize + 22));
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v: number) => { view.setUint32(at, v, true); at += 4; };
  const bytes = (b: Uint8Array) => { out.set(b, at); at += b.length; };
  // Zip stores dates in MS-DOS format: date and time packed into 16 bits each, seconds in steps of 2.
  const DOS_DATE = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const DOS_TIME = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);

  for (const e of entries) {
    e.offset = at;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(DOS_TIME); u16(DOS_DATE);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    bytes(e.name); bytes(e.data);
  }
  const centralStart = at;
  for (const e of entries) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(DOS_TIME); u16(DOS_DATE);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(e.offset); bytes(e.name);
  }
  const centralLength = at - centralStart;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(centralLength); u32(centralStart); u16(0);
  return out;
}
