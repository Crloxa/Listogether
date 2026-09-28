#!/usr/bin/env node
// 生成端到端测试用的本地音频 WAV（合成音，非个人音频，不入库）：
// 每 5 秒一个频率台阶（440Hz 起步、每段 +60Hz），听感上可分辨位置推进，
// 便于双浏览器人工核对同步；同时用于采集首音滞后等量化证据。
// 用法：node scripts/gen-test-audio.mjs [输出路径] [时长秒，默认 120]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outArg = process.argv[2] ?? "scripts/tmp/testtone.wav";
const durationSec = Number(process.argv[3] ?? 120);
const sampleRate = 22050;

if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) {
  console.error("时长必须是 1..600 的数字");
  process.exit(1);
}

const totalSamples = Math.floor(durationSec * sampleRate);
const data = Buffer.alloc(totalSamples * 2);
const segmentSamples = Math.floor(5 * sampleRate); // 每 5 秒换一个频率
for (let i = 0; i < totalSamples; i++) {
  const freq = 440 + 60 * Math.floor(i / segmentSamples);
  // 轻微渐入渐出避免爆音；正弦波幅度 0.4
  const second = i / sampleRate;
  const envelope = Math.min(1, second / 0.05) * Math.min(1, (durationSec - second) / 0.05);
  const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.4 * envelope;
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
}

const dataSize = data.length;
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + dataSize, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16); // PCM chunk 大小
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // 单声道
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28); // 字节率
header.writeUInt16LE(2, 32); // 块对齐
header.writeUInt16LE(16, 34); // 位深
header.write("data", 36);
header.writeUInt32LE(dataSize, 40);

const outPath = path.resolve(outArg);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.concat([header, data]));
console.log(`OK: ${outPath}（${durationSec}s / ${sampleRate}Hz / 16bit 单声道，频率台阶每 5 秒 +60Hz 自 440Hz 起）`);
