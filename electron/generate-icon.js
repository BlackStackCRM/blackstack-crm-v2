/**
 * Generate electron/icons/icon.ico and icon.png from a simple raster drawing.
 * Pure Node (no image libraries): renders a "BS" monogram into RGBA buffers
 * and packs a multi-resolution ICO. Deterministic and dependency-free.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function drawIcon(size) {
  // RGBA buffer, dark slate rounded square + white "BS"
  const px = new Uint8Array(size * size * 4);
  const bg = [30, 41, 59, 255];      // slate-800
  const fg = [255, 255, 255, 255];
  const margin = size * 0.08;
  const radius = size * 0.18;

  const insideRounded = (x, y) => {
    if (x < margin || y < margin || x >= size - margin || y >= size - margin) return false;
    const cx = Math.max(margin + radius, Math.min(x, size - margin - radius));
    const cy = Math.max(margin + radius, Math.min(y, size - margin - radius));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius || (x >= cx - radius && x <= cx + radius) || (y >= cy - radius && y <= cy + radius);
  };
  const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  // B and S built from bars
  const inB = (x, y) => {
    const bx = size * 0.22, bw = size * 0.07, h = size * 0.5, by = size * 0.26;
    if (inRect(x, y, bx, by, bx + bw, by + h)) return true;
    if (inRect(x, y, bx, by, bx + bw * 2.4, by + bw)) return true;
    if (inRect(x, y, bx, by + h - bw, bx + bw * 2.4, by + h)) return true;
    if (inRect(x, y, bx, by + h / 2 - bw / 2, bx + bw * 2.1, by + h / 2 + bw / 2)) return true;
    if (inRect(x, y, bx + bw * 1.7, by, bx + bw * 2.4, by + h)) return true;
    return false;
  };
  const inS = (x, y) => {
    const sx = size * 0.56, sw = size * 0.34, h = size * 0.5, sy = size * 0.26, t = size * 0.07;
    if (inRect(x, y, sx, sy, sx + sw, sy + t)) return true;
    if (inRect(x, y, sx, sy, sx + t, sy + h / 2)) return true;
    if (inRect(x, y, sx, sy + h / 2 - t / 2, sx + sw, sy + h / 2 + t / 2)) return true;
    if (inRect(x, y, sx + sw - t, sy + h / 2, sx + sw, sy + h)) return true;
    if (inRect(x, y, sx, sy + h - t, sx + sw, sy + h)) return true;
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = insideRounded(x, y) ? (inB(x, y) || inS(x, y) ? fg : bg) : [0, 0, 0, 0];
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
    }
  }
  return px;
}

// --- PNG encoder (RGBA, no filter) ---
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO packer (PNG-compressed entries) ---
function encodeIco(sizes) {
  const pngs = sizes.map((s) => ({ s, png: encodePng(drawIcon(s), s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((p, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16);
    e[0] = p.s === 256 ? 0 : p.s; e[1] = 0; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.png.length, 8); e.writeUInt32LE(offset, 12);
    offset += p.png.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.png)]);
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco([16, 32, 48, 256]));
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(drawIcon(256), 256));
console.log('icons written to', outDir);
