/* Generates the PWA icons (a simple mic glyph) without any image libraries:
 * raw RGBA scanlines → zlib → hand-assembled PNG chunks. */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [79, 70, 229]; // indigo
const FG = [255, 255, 255];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let c = ~0;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function inCapsule(x, y, cx, y0, y1, r) {
  // vertical capsule: rectangle with semicircular caps
  if (Math.abs(x - cx) > r) return false;
  if (y >= y0 + r && y <= y1 - r) return true;
  const dx = x - cx;
  const dyTop = y - (y0 + r);
  const dyBot = y - (y1 - r);
  return dx * dx + dyTop * dyTop <= r * r || dx * dx + dyBot * dyBot <= r * r;
}

function makeIcon(size) {
  const cx = size / 2;
  // mic body capsule
  const capR = size * 0.115;
  const capTop = size * 0.24;
  const capBottom = size * 0.55;
  // stand arc (ring segment) and stem
  const arcR = size * 0.19;
  const arcCy = size * 0.5;
  const arcW = size * 0.035;
  const stemW = size * 0.035;
  const stemTop = arcCy + arcR;
  const stemBottom = size * 0.76;
  const baseW = size * 0.16;
  const baseH = size * 0.035;

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let [r, g, b] = BG;
      const dx = x - cx;
      const dy = y - arcCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const fg =
        inCapsule(x, y, cx, capTop, capBottom, capR) ||
        // arc: lower half ring around the mic body
        (dy > 0 && Math.abs(dist - arcR) <= arcW) ||
        // stem
        (Math.abs(dx) <= stemW && y >= stemTop && y <= stemBottom) ||
        // base bar
        (Math.abs(dx) <= baseW && Math.abs(y - stemBottom) <= baseH);
      if (fg) [r, g, b] = FG;
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(`public/icons/icon-${size}.png`, makeIcon(size));
  console.log(`wrote public/icons/icon-${size}.png`);
}
