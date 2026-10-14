import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function createPNG(width, height) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    // CRC calculation
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  // Raw image data: height rows, each with 1 filter byte (0) + width * 3 bytes (RGB)
  const rowLen = 1 + width * 3;
  const rawData = Buffer.alloc(height * rowLen);
  for (let y = 0; y < height; y++) {
    const offset = y * rowLen;
    rawData[offset] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const px = offset + 1 + x * 3;
      // Vibrant indigo/blue gradient: #4363D8
      rawData[px] = Math.floor(40 + (x / width) * 40); // R
      rawData[px + 1] = Math.floor(90 + (y / height) * 60); // G
      rawData[px + 2] = 220; // B
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Basic CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const outDir = path.resolve('packages/extension/media');
fs.mkdirSync(outDir, { recursive: true });
const iconPng = createPNG(128, 128);
fs.writeFileSync(path.join(outDir, 'icon.png'), iconPng);
console.log('Generated 128x128 icon at packages/extension/media/icon.png');
