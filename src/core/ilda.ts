/**
 * ILDA Image Data Transfer Format 编解码(大端二进制)
 *
 * 支持解析:格式 0(3D 索引色)、1(2D 索引色)、2(调色板)、3/5(3D 真彩)、4(2D 真彩)
 * 状态字 bit6 = blanking(1 灭光),bit7 = 末点
 * 坏文件:魔数错误、截断、未知格式 → 抛错并带中文原因;非致命问题进 warnings。
 */
import type { IldaFile, IldaFrame, IldaPoint, MaskRaster } from './types';

const HEADER_SIZE = 32;
const MAGIC = 0x494c4441; // "ILDA"

/** ILDA 标准 64 色调色板(索引色文件未附 format-2 调色板时的兜底) */
const DEFAULT_PALETTE: [number, number, number][] = (() => {
  const p: [number, number, number][] = [];
  for (let i = 0; i < 64; i++) {
    const h = (i / 64) * 360;
    const c = h < 60 ? [255, Math.round((h / 60) * 255), 0]
      : h < 120 ? [Math.round(((120 - h) / 60) * 255), 255, 0]
      : h < 180 ? [0, 255, Math.round(((h - 120) / 60) * 255)]
      : h < 240 ? [0, Math.round(((240 - h) / 60) * 255), 255]
      : h < 300 ? [Math.round(((h - 240) / 60) * 255), 0, 255]
      : [255, 0, Math.round(((360 - h) / 60) * 255)];
    p.push([c[0], c[1], c[2]]);
  }
  return p;
})();

export class IldaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IldaParseError';
  }
}

interface SectionHeader {
  format: number;
  name: string;
  company: string;
  records: number;
  frameNo: number;
  totalFrames: number;
}

function readHeader(dv: DataView, offset: number): SectionHeader {
  const magic = dv.getUint32(offset);
  if (magic !== MAGIC) throw new IldaParseError('魔数不是 "ILDA",文件已损坏或不是 ILDA 文件');
  const format = dv.getUint8(offset + 8);
  const buf = dv.buffer as ArrayBuffer;
  const name = decodeAscii(buf, offset + 9, 8);
  const company = decodeAscii(buf, offset + 17, 8);
  const records = dv.getUint16(offset + 25);
  const frameNo = dv.getUint16(offset + 27);
  const totalFrames = dv.getUint16(offset + 29);
  return { format, name, company, records, frameNo, totalFrames };
}

function decodeAscii(buf: ArrayBuffer, offset: number, len: number): string {
  const bytes = new Uint8Array(buf, offset, len);
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { end = i; break; }
  return new TextDecoder('ascii').decode(bytes.slice(0, end));
}

function encodeAscii(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const src = new TextEncoder().encode(s);
  out.set(src.slice(0, len));
  return out;
}

const RECORD_SIZE: Record<number, number> = { 0: 32, 1: 28, 3: 36, 4: 32, 5: 36 };

export function parseIlda(data: Uint8Array): IldaFile {
  if (data.byteLength < HEADER_SIZE) throw new IldaParseError(`文件长度 ${data.byteLength} 字节,小于 ILDA 32 字节文件头`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const warnings: string[] = [];
  const frames: IldaFrame[] = [];
  let palette: [number, number, number][] = DEFAULT_PALETTE;
  let format: 0 | 1 | 4 | 5 = 5;
  let offset = 0;

  while (offset + HEADER_SIZE <= data.byteLength) {
    const h = readHeader(dv, offset);
    offset += HEADER_SIZE;
    if (h.records === 0) break; // 终止段

    if (h.format === 2) {
      // 调色板段:每记录 3 字节 BGR? ILDA 规定为 RGB 顺序
      const need = h.records * 3;
      if (offset + need > data.byteLength) throw new IldaParseError('调色板段被截断');
      const pal: [number, number, number][] = [];
      for (let i = 0; i < h.records; i++) {
        pal.push([data[offset], data[offset + 1], data[offset + 2]]);
        offset += 3;
      }
      palette = pal;
      continue;
    }

    const recSize = RECORD_SIZE[h.format];
    if (!recSize) throw new IldaParseError(`不支持的 ILDA 格式码 ${h.format}(仅支持 0/1/2/3/4/5)`);
    if (offset + h.records * recSize > data.byteLength) {
      throw new IldaParseError(`帧 "${h.name}" 声明 ${h.records} 个点,文件数据不足,已截断损坏`);
    }
    if (![0, 1, 4, 5].includes(h.format)) format = 5 as const;
    else format = h.format as 0 | 1 | 4 | 5;

    const points: IldaPoint[] = [];
    for (let i = 0; i < h.records; i++) {
      const p = offset + i * recSize;
      const x = dv.getInt16(p);
      const y = dv.getInt16(p + 2);
      let z = 0, status = 0, r = 255, g = 255, b = 255;
      if (h.format === 0) {
        z = dv.getInt16(p + 4);
        status = dv.getUint8(p + 6);
        const idx = dv.getUint8(p + 7);
        const c = palette[idx] ?? [255, 255, 255];
        [r, g, b] = c;
      } else if (h.format === 1) {
        status = dv.getUint8(p + 4);
        const idx = dv.getUint8(p + 5);
        const c = palette[idx] ?? [255, 255, 255];
        [r, g, b] = c;
      } else if (h.format === 4) {
        status = dv.getUint8(p + 4);
        r = dv.getUint8(p + 5); g = dv.getUint8(p + 6); b = dv.getUint8(p + 7);
      } else {
        // 3 / 5:3D 真彩
        z = dv.getInt16(p + 4);
        status = dv.getUint8(p + 6);
        r = dv.getUint8(p + 7); g = dv.getUint8(p + 8); b = dv.getUint8(p + 9);
      }
      points.push({ x, y, z, status, r, g, b });
    }
    if (points.length === 0) warnings.push(`帧 "${h.name}" 没有任何点`);
    frames.push({ name: h.name || `Frame ${frames.length + 1}`, company: h.company, points });
    offset += h.records * recSize;
  }

  if (frames.length === 0) throw new IldaParseError('文件中没有任何图形帧(只有文件头或调色板)');
  return { format, frames, warnings };
}

/** 序列化为 ILDA;优先真彩格式(2D→4,3D→5) */
export function encodeIlda(file: IldaFile): Uint8Array {
  const threeD = file.frames.some(f => f.points.some(p => p.z !== 0));
  const format = threeD ? 5 : 4;
  const recSize = format === 5 ? 36 : 32;
  const total = file.frames.length;
  // 每帧 = 32 字节帧头 + 点记录,另加一个 32 字节终止段
  const size = file.frames.reduce(
    (s, f) => s + HEADER_SIZE + f.points.length * recSize,
    0
  ) + HEADER_SIZE;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  const writeHeader = (name: string, company: string, records: number, frameNo: number) => {
    // 标准 32 字节:4 魔数 + 4 预留 + 1 格式 + 8 名称 + 8 公司 + 2 记录 + 2 帧号 + 2 总帧 + 1 扫描头
    dv.setUint32(offset, MAGIC);
    offset += 8; // 跳过 4 字节预留(零填充)
    dv.setUint8(offset, format); offset += 1;
    const nb = encodeAscii(name, 8); bytes.set(nb, offset); offset += 8;
    const cb = encodeAscii(company || 'LSS', 8); bytes.set(cb, offset); offset += 8;
    dv.setUint16(offset, records); offset += 2;
    dv.setUint16(offset, frameNo); offset += 2;
    dv.setUint16(offset, total); offset += 2;
    dv.setUint8(offset, 0); offset += 1; // scanner head
  };

  file.frames.forEach((frame, fi) => {
    writeHeader(frame.name, frame.company ?? '', frame.points.length, fi);
    frame.points.forEach((pt, pi) => {
      const status = pi === frame.points.length - 1 ? (pt.status | 0x80) : pt.status;
      dv.setInt16(offset, pt.x);
      dv.setInt16(offset + 2, pt.y);
      if (format === 5) {
        dv.setInt16(offset + 4, pt.z);
        dv.setUint8(offset + 6, status);
        dv.setUint8(offset + 7, pt.r);
        dv.setUint8(offset + 8, pt.g);
        dv.setUint8(offset + 9, pt.b);
        // 36 字节记录:尾部 26 字节保留(已被 ArrayBuffer 零填充)
      } else {
        dv.setUint8(offset + 4, status);
        dv.setUint8(offset + 5, pt.r);
        dv.setUint8(offset + 6, pt.g);
        dv.setUint8(offset + 7, pt.b);
        // 32 字节记录:尾部 24 字节保留
      }
      offset += recSize;
    });
  });
  writeHeader('', '', 0, 0); // 终止段
  return bytes;
}

export const ILDA_BLANKING_BIT = 0x40;

/**
 * 按限区遮罩改写帧数据:落在遮罩格内的点亮 blanking。
 * 角度为激光器本地系方位/俯仰角(弧度)。
 */
export function applyMaskToFrame(frame: IldaFrame, mask: MaskRaster, halfH: number, halfV: number): IldaFrame {
  const points = frame.points.map(p => {
    const az = (p.x / 32767) * halfH;
    const el = (p.y / 32767) * halfV;
    const blocked = isMasked(mask, az, el);
    const status = blocked ? (p.status | ILDA_BLANKING_BIT) : (p.status & ~ILDA_BLANKING_BIT);
    return { ...p, status };
  });
  return { ...frame, points };
}

export function isMasked(mask: MaskRaster, az: number, el: number): boolean {
  const { azRange, elRange, size, blocked } = mask;
  if (az < azRange[0] || az > azRange[1] || el < elRange[0] || el > elRange[1]) return false;
  const i = Math.floor(((az - azRange[0]) / (azRange[1] - azRange[0])) * size);
  const j = Math.floor(((el - elRange[0]) / (elRange[1] - elRange[0])) * size);
  return blocked[Math.min(size - 1, j) * size + Math.min(size - 1, i)] === 1;
}
