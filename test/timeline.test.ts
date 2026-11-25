import { describe, it, expect } from 'vitest';
import { activeClip, evaluateProjector, sourcePointIndex } from '../src/core/timeline';
import { createGalvoState, stepGalvo, flickerFactor } from '../src/core/galvo';
import type { Timeline } from '../src/core/types';
import { fanFrame, makeProjector, staticFrame } from './helpers';

describe('时间线求值', () => {
  it('片段边界:片段内有效、片段外/静音为 undefined', () => {
    const tl: Timeline = {
      durationSec: 10,
      tracks: [{
        id: 't1', projectorId: 'P1',
        clips: [
          { id: 'c1', assetId: 'a', start: 2, duration: 3, inPoint: 0, rate: 1, muted: false },
          { id: 'c2', assetId: 'a', start: 6, duration: 1, inPoint: 0, rate: 1, muted: true }
        ]
      }]
    };
    const track = tl.tracks[0];
    expect(activeClip(track, 2.5)?.id).toBe('c1');
    expect(activeClip(track, 5.5)).toBeUndefined();
    expect(activeClip(track, 6.5)).toBeUndefined();
  });

  it('源点序号循环且随变速改变', () => {
    const file = staticFrame([{ x: 0 }, { x: 100 }, { x: 200 }, { x: 300 }]);
    const a = sourcePointIndex(file, 0, 10);
    expect(a.index).toBe(0);
    const b = sourcePointIndex(file, 0.25, 10);
    expect(b.index).toBe(2);
    const c = sourcePointIndex(file, 0.4, 10); // 位置 4 → 循环回 0
    expect(c.index).toBe(0);
  });

  it('指令角度与 ILDA 归一化坐标/扫描角一致', () => {
    const pr = makeProjector({ scanAngleH: 40, scanAngleV: 30, pps: 1000 });
    const tl: Timeline = {
      durationSec: 1,
      tracks: [{ id: 't', projectorId: 'P1', clips: [{ id: 'c', assetId: 'a', start: 0, duration: 1, inPoint: 0, rate: 1, muted: false }] }]
    };
    const files = new Map([['a', staticFrame([{ x: 32767, y: -32767 }])]]);
    const cmd = evaluateProjector(pr, tl, files, 0, 0.001)!;
    expect(cmd.az).toBeCloseTo(20 * Math.PI / 180, 5);
    expect(cmd.el).toBeCloseTo(-15 * Math.PI / 180, 5);
    expect(cmd.blanked).toBe(false);
  });

  it('变速 2x:有效点速率减半,相同物理时间推进两倍源点', () => {
    const pr = makeProjector({ pps: 1000 });
    const mk = (rate: number): Timeline => ({
      durationSec: 1,
      tracks: [{ id: 't', projectorId: 'P1', clips: [{ id: 'c', assetId: 'a', start: 0, duration: 1, inPoint: 0, rate, muted: false }] }]
    });
    const files = new Map([['a', fanFrame(100)]]);
    const slow = evaluateProjector(pr, mk(0.5), files, 0.1, 0.001)!;
    const fast = evaluateProjector(pr, mk(2), files, 0.1, 0.001)!;
    // 0.5x → 源时间 0.2s;2x → 源时间 0.05s,扇面位置不同
    expect(fast.az).not.toBeCloseTo(slow.az, 4);
  });
});

describe('振镜动态模拟', () => {
  it('小信号平滑跟随,无饱和', () => {
    let s = createGalvoState();
    const pr = makeProjector();
    for (let i = 0; i < 50; i++) {
      s = stepGalvo(s, {
        projectorId: pr.id, az: 0.01, el: 0, direction: [0, 0, 1], blanked: false, color: [1, 1, 1], slewRate: 5
      }, pr.maxSlewRate, 0.001);
    }
    expect(Math.abs(s.az - 0.01)).toBeLessThan(0.002);
    expect(s.saturation).toBeLessThan(0.05);
    expect(flickerFactor(s, 0.5)).toBeGreaterThan(0.95);
  });

  it('超速指令产生饱和与滞后(变形闪烁)', () => {
    let s = createGalvoState();
    const pr = makeProjector({ maxSlewRate: 10 });
    let lastAz = 0;
    for (let i = 0; i < 100; i++) {
      const az = (i % 2 === 0 ? 0.3 : -0.3);
      s = stepGalvo(s, {
        projectorId: pr.id, az, el: 0, direction: [0, 0, 1], blanked: false, color: [1, 1, 1], slewRate: 600
      }, 10, 0.001);
      lastAz = s.az;
    }
    expect(s.saturation).toBeGreaterThan(0.5);
    expect(Math.abs(lastAz)).toBeLessThan(0.3); // 跟不上指令幅度
    expect(flickerFactor(s, 1)).toBeLessThan(0.5);
  });
});
