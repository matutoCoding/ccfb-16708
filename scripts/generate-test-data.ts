/**
 * 测试素材生成:
 *  - ILDA 图形若干(圆、方、三角、螺旋、文字轮廓)+ 一段水平光束扫射
 *  - 一段 60s WAV 音频(带节拍的合成音乐 + 波形峰值包络)
 * 输出到 public/sample-data/,应用首启自动导入。
 * 运行:npm run gen:testdata
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeIlda } from '../src/core/ilda.ts';
import type { IldaFile, IldaPoint } from '../src/core/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'sample-data');
mkdirSync(OUT, { recursive: true });

const SCALE = 30000;
const pt = (x: number, y: number, rgb: [number, number, number], blanked = false): IldaPoint => ({
  x: Math.round(x * SCALE), y: Math.round(y * SCALE), z: 0,
  status: blanked ? 0x40 : 0, r: rgb[0], g: rgb[1], b: rgb[2]
});

/** 在两点间补点,模拟真实 ILDA 点密度 */
function line(x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number], n = 120): IldaPoint[] {
  const out: IldaPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(pt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rgb));
  }
  return out;
}

function circle(rgb: [number, number, number], r = 0.8, n = 600): IldaPoint[] {
  const out: IldaPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(pt(Math.cos(a) * r, Math.sin(a) * r, rgb));
  }
  return out;
}

function square(rgb: [number, number, number]): IldaPoint[] {
  const c = [
    ...line(-0.8, -0.8, 0.8, -0.8, rgb),
    ...line(0.8, -0.8, 0.8, 0.8, rgb),
    ...line(0.8, 0.8, -0.8, 0.8, rgb),
    ...line(-0.8, 0.8, -0.8, -0.8, rgb)
  ];
  return c;
}

function triangle(rgb: [number, number, number]): IldaPoint[] {
  return [
    ...line(0, 0.9, -0.9, -0.7, rgb),
    ...line(-0.9, -0.7, 0.9, -0.7, rgb),
    ...line(0.9, -0.7, 0, 0.9, rgb)
  ];
}

function spiral(rgb: [number, number, number]): IldaPoint[] {
  const out: IldaPoint[] = [];
  const n = 800;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = t * Math.PI * 8;
    const r = 0.05 + t * 0.85;
    out.push(pt(Math.cos(a) * r, Math.sin(a) * r, [
      Math.round(rgb[0] * (0.4 + 0.6 * t)),
      Math.round(rgb[1] * (0.4 + 0.6 * t)),
      Math.round(rgb[2] * (0.4 + 0.6 * t))
    ]));
  }
  return out;
}

function star(rgb: [number, number, number]): IldaPoint[] {
  const out: IldaPoint[] = [];
  const verts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 0.9 : 0.38;
    verts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  for (let i = 0; i < 10; i++) {
    const [x0, y0] = verts[i];
    const [x1, y1] = verts[(i + 1) % 10];
    out.push(...line(x0, y0, x1, y1, rgb, 60));
  }
  return out;
}

/** 水平光束扫射:往返慢速横扫,带灭光回扫段 */
function beamSweep(): IldaPoint[] {
  const out: IldaPoint[] = [];
  const n = 1000;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // 0..0.45 正向扫,0.45..0.55 灭光回扫,0.55..1 反向扫
    let x: number, blanked: boolean;
    if (t < 0.45) { x = -0.95 + (t / 0.45) * 1.9; blanked = false; }
    else if (t < 0.55) { x = 0.95 - ((t - 0.45) / 0.1) * 1.9; blanked = true; }
    else { x = -0.95 + ((t - 0.55) / 0.45) * 1.9; blanked = false; }
    out.push(pt(x, 0, [255, 60, 40], blanked));
  }
  return out;
}

function save(name: string, frameName: string, points: IldaPoint[]) {
  const file: IldaFile = { format: 5, frames: [{ name: frameName, company: 'LSS-GEN', points }], warnings: [] };
  const bytes = encodeIlda(file);
  writeFileSync(join(OUT, name), bytes);
  console.log(`生成 ${name}: ${points.length} 点, ${bytes.length} 字节`);
}

save('circle.ild', 'Circle', circle([0, 200, 255]));
save('square.ild', 'Square', square([255, 80, 0]));
save('triangle.ild', 'Triangle', triangle([0, 255, 120]));
save('spiral.ild', 'Spiral', spiral([255, 0, 255]));
save('star.ild', 'Star', star([255, 220, 0]));
save('beam-sweep.ild', 'BeamSweep', beamSweep());

// —— 60s WAV 音频:120 BPM 节拍 + 和声垫,44.1kHz 16bit 单声道 ——
const sampleRate = 44100;
const duration = 60;
const total = sampleRate * duration;
const pcm = new Int16Array(total);
const beat = 60 / 120; // 0.5s
for (let i = 0; i < total; i++) {
  const t = i / sampleRate;
  // 底鼓:每拍一个衰减正弦
  const phase = t % beat;
  const kick = Math.sin(2 * Math.PI * 60 * phase) * Math.exp(-phase * 18) * 0.55;
  // 和声垫:A 小调和弦 A2/C3/E3
  const pad =
    (Math.sin(2 * Math.PI * 110 * t) +
      Math.sin(2 * Math.PI * 130.81 * t) * 0.8 +
      Math.sin(2 * Math.PI * 164.81 * t) * 0.6) / 3 * 0.16;
  // 高频闪烁
  const shimmer = Math.sin(2 * Math.PI * 880 * t) * 0.03 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t));
  const s = Math.max(-1, Math.min(1, kick + pad + shimmer));
  pcm[i] = Math.round(s * 30000);
}

const wav = new ArrayBuffer(44 + pcm.byteLength);
const dv = new DataView(wav);
const u8 = new Uint8Array(wav);
const writeStr = (off: number, s: string) => { for (let k = 0; k < s.length; k++) dv.setUint8(off + k, s.charCodeAt(k)); };
writeStr(0, 'RIFF');
dv.setUint32(4, 36 + pcm.byteLength, true);
writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
dv.setUint32(16, 16, true);
dv.setUint16(20, 1, true); // PCM
dv.setUint16(22, 1, true); // mono
dv.setUint32(24, sampleRate, true);
dv.setUint32(28, sampleRate * 2, true);
dv.setUint16(32, 2, true);
dv.setUint16(34, 16, true);
writeStr(36, 'data');
dv.setUint32(40, pcm.byteLength, true);
new Int16Array(wav, 44).set(pcm);
writeFileSync(join(OUT, 'show-audio.wav'), u8);
console.log(`生成 show-audio.wav: ${duration}s, ${u8.length} 字节`);

// 波形峰值包络(时间线显示用),每 50ms 一个峰
const peaks: number[] = [];
const win = Math.floor(sampleRate * 0.05);
for (let i = 0; i < total; i += win) {
  let m = 0;
  for (let k = i; k < Math.min(total, i + win); k++) m = Math.max(m, Math.abs(pcm[k]));
  peaks.push(m / 32768);
}
writeFileSync(join(OUT, 'audio-peaks.json'), JSON.stringify({ sampleRate, duration, peaks }));
console.log(`生成 audio-peaks.json: ${peaks.length} 个峰值点`);
