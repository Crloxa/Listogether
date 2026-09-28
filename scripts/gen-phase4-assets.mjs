// 生成 Phase 4 E2E 测试资源（gitignore 覆盖 scripts/tmp/，不入库）：
//   e2e-cover-song.wav  —— WAV + 前置 ID3v2.3（TIT2/TPE1/APIC 红色 PNG 封面）
//   e2e-cover-song.lrc  —— 同名歌词（验证自动检测与同步高亮）
// 用法：node scripts/gen-phase4-assets.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "tmp");
mkdirSync(outDir, { recursive: true });

// ---- WAV：440Hz 正弦 12 秒（16bit 单声道 44.1k） ----
const sampleRate = 44100;
const seconds = 12;
const dataBytes = sampleRate * seconds * 2;
const wav = Buffer.alloc(44 + dataBytes);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < sampleRate * seconds; i++) {
  const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
  wav.writeInt16LE(v, 44 + i * 2);
}

// ---- 32x32 红色 PNG（手工构造，无依赖） ----
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0); // PNG 规范：chunk 长度为 Big-Endian
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(32, 0);
ihdr.writeUInt32BE(32, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
const rawRows = Buffer.alloc(32 * (1 + 32 * 3));
for (let y = 0; y < 32; y++) {
  const rowStart = y * (1 + 32 * 3);
  rawRows[rowStart] = 0;
  for (let x = 0; x < 32; x++) {
    rawRows[rowStart + 1 + x * 3] = 0xc0;
    rawRows[rowStart + 2 + x * 3] = 0x20;
    rawRows[rowStart + 3 + x * 3] = 0x20;
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(rawRows)),
  chunk("IEND", Buffer.alloc(0)),
]);

// ---- ID3v2.3：TIT2 / TPE1 / APIC ----
function textFrame(id, text) {
  const enc = Buffer.from([0x03]); // UTF-8
  const body = Buffer.concat([enc, Buffer.from(text, "utf8")]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([Buffer.from(id, "ascii"), size, Buffer.from([0x00, 0x00]), body]);
}
function apicFrame(imageBuf, mime) {
  const body = Buffer.concat([
    Buffer.from([0x00]), // latin1 description encoding
    Buffer.from(mime, "latin1"), Buffer.from([0x00]),
    Buffer.from([0x03]), // front cover
    Buffer.from([0x00]), // 空 description 的 latin1 终止符（仅 1 个 0x00；多写会污染图片首字节）
    imageBuf,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([Buffer.from("APIC", "ascii"), size, Buffer.from([0x00, 0x00]), body]);
}
const frames = Buffer.concat([
  textFrame("TIT2", "封面歌词测试曲"),
  textFrame("TPE1", "E2E艺人"),
  apicFrame(png, "image/png"),
]);
const tagSize = frames.length;
const id3 = Buffer.concat([
  Buffer.from("ID3", "ascii"),
  Buffer.from([0x03, 0x00, 0x00]),
  Buffer.from([(tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f]),
  frames,
]);

writeFileSync(path.join(outDir, "e2e-cover-song.wav"), Buffer.concat([id3, wav]));
writeFileSync(
  path.join(outDir, "e2e-cover-song.lrc"),
  "[00:01.00]第一句：预备唱\n[00:04.00]第二句：统一开始\n[00:08.00]第三句：接近尾声\n",
  "utf8",
);
console.log("generated:", path.join(outDir, "e2e-cover-song.wav"), "+ .lrc");
