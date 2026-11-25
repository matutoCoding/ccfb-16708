import { describe, it, expect } from 'vitest';
import { applyMaskToFrame, encodeIlda, ILDA_BLANKING_BIT, IldaParseError, parseIlda } from '../src/core/ilda';
import type { IldaFile, MaskRaster } from '../src/core/types';

function sampleFile(): IldaFile {
  return {
    format: 5,
    warnings: [],
    frames: [
      {
        name: 'square',
        company: 'UNIT',
        points: [
          { x: -10000, y: -10000, z: 0, status: 0, r: 255, g: 0, b: 0 },
          { x: 10000, y: -10000, z: 0, status: 0, r: 0, g: 255, b: 0 },
          { x: 10000, y: 10000, z: 0, status: 0, r: 0, g: 0, b: 255 },
          { x: -10000, y: 10000, z: 0, status: 0, r: 255, g: 255, b: 0 }
        ]
      }
    ]
  };
}

describe('ILDA 编解码', () => {
  it('真彩帧 roundtrip:点坐标/颜色/帧数一致', () => {
    const bytes = encodeIlda(sampleFile());
    const parsed = parseIlda(bytes);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0].name).toBe('square');
    expect(parsed.frames[0].points).toHaveLength(4);
    const p = parsed.frames[0].points;
    expect(p[0]).toMatchObject({ x: -10000, y: -10000, r: 255, g: 0, b: 0 });
    expect(p[2]).toMatchObject({ x: 10000, y: 10000, r: 0, g: 0, b: 255 });
    // 末点带 last-point 状态位
    expect(p[3].status & 0x80).toBe(0x80);
  });

  it('多帧 + 终止段', () => {
    const f = sampleFile();
    f.frames.push({ name: 'second', points: f.frames[0].points.map(p => ({ ...p })) });
    const parsed = parseIlda(encodeIlda(f));
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[1].name).toBe('second');
  });

  it('格式 0(3D 索引色 + 调色板段)可解析', () => {
    // 手工拼:format-2 调色板(2 色)+ format-0 帧(1 个点)
    const buf = new ArrayBuffer(32 + 6 + 32 + 32);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const enc = (s: string, off: number, len: number) => {
      u8.set(new TextEncoder().encode(s).slice(0, len), off);
    };
    // 调色板头
    dv.setUint32(0, 0x494c4441); dv.setUint8(8, 2);
    enc('pal', 9, 8); enc('CO', 17, 8);
    dv.setUint16(25, 2); dv.setUint16(27, 0); dv.setUint16(29, 1);
    u8[32] = 255; u8[33] = 0; u8[34] = 0;
    u8[35] = 0; u8[36] = 255; u8[37] = 0;
    // 帧头 format 0,1 记录
    dv.setUint32(38, 0x494c4441); dv.setUint8(46, 0);
    enc('frm', 47, 8);
    dv.setUint16(63, 1);
    // 点记录 32 字节: x,y,z,status,colorIdx
    dv.setInt16(70, 1234); dv.setInt16(72, -5678); dv.setInt16(74, 99);
    dv.setUint8(76, 0); dv.setUint8(77, 1); // 绿色索引
    const parsed = parseIlda(u8);
    expect(parsed.format).toBe(0);
    const pt = parsed.frames[0].points[0];
    expect(pt.x).toBe(1234);
    expect(pt.y).toBe(-5678);
    expect(pt.z).toBe(99);
    expect([pt.r, pt.g, pt.b]).toEqual([0, 255, 0]);
  });

  it('坏文件:魔数错误 / 截断 / 空数据均给出中文错误', () => {
    expect(() => parseIlda(new Uint8Array(100).fill(1))).toThrow(IldaParseError);
    const good = encodeIlda(sampleFile());
    expect(() => parseIlda(good.slice(0, good.length - 40))).toThrow(/截断|损坏|没有任何图形帧/);
    expect(() => parseIlda(new Uint8Array(4))).toThrow(/32 字节/);
  });

  it('遮罩写回:遮罩格内点被置 blanking', () => {
    const halfH = (20 * Math.PI) / 180;
    const halfV = (15 * Math.PI) / 180;
    const size = 100;
    const mask: MaskRaster = {
      projectorId: 'P1',
      size,
      azRange: [-halfH, halfH],
      elRange: [-halfV, halfV],
      blocked: new Uint8Array(size * size)
    };
    mask.blocked[50 * size + 50] = 1; // 中心格
    const f = sampleFile();
    const out = applyMaskToFrame(f.frames[0], mask, halfH, halfV);
    // 中心点(0,0)被遮;四角不在中心格
    const centerPoint = { x: 0, y: 0, z: 0, status: 0, r: 1, g: 1, b: 1 };
    const outCenter = applyMaskToFrame({ name: 'c', points: [centerPoint] }, mask, halfH, halfV);
    expect(outCenter.points[0].status & ILDA_BLANKING_BIT).toBe(ILDA_BLANKING_BIT);
    expect(out.points[0].status & ILDA_BLANKING_BIT).toBe(0);
  });
});
