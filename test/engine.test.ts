import { describe, it, expect } from 'vitest';
import type { Box3, IldaFile, Project, SafetyReport } from '../src/core/types';
import { runSafetyCheck } from '../src/core/safety';
import { evaluateProjector } from '../src/core/timeline';
import { eyeMpeEnergy, eyeMpeIrradiance, irradianceAt, multipulseFactor, rayGeometry, waistFromSpec } from '../src/core/physics';
import { isMasked } from '../src/core/ilda';
import { fanFrame, makeProject, makeProjector, staticFrame } from './helpers';

const DEG = Math.PI / 180;

/** 单点观众区:盒子边长小于网格间距,保证唯一格心恰好位于 point */
function audienceAt(point: [number, number, number]): Box3[] {
  return [{
    id: 'a1', name: '观众区', min: point,
    max: [point[0] + 0.01, point[1] + 0.01, point[2] + 0.01] as [number, number, number]
  }];
}

function run(project: Project, files: Map<string, IldaFile>): SafetyReport {
  return runSafetyCheck(project, files);
}
function relErr(a: number, b: number) { return Math.abs(a - b) / Math.abs(b); }

describe('安全引擎 — 典型工况手算对照', () => {
  const lambda = 532;
  const w0 = waistFromSpec(5, 1, lambda);

  it('工况 B1:静态直射定点,单脉冲超标必须被标出,首步 ratio 与手算一致(62.59)', () => {
    // P=5W, z=30m: E=13398 W/m²;dt=50µs → H=0.6699 J/m²
    // 单脉冲 MPE(50µs)=1.0703e-2 → 首步 ratio 62.59(此时 n=1,无多脉冲修正)
    const pr = makeProjector({ pps: 20000 });
    // 时长仅一个时间步,保证只有 n=1 的单次评估,与手算严格同构
    const project = makeProject([pr], 5e-5, ['f1']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    const files = new Map([['f1', staticFrame([{ x: 0, y: 0 }])]]);
    const report = run(project, files);

    expect(report.violations.length).toBeGreaterThan(0);
    const v = report.violations[0];
    expect(v.timeSec).toBeCloseTo(0, 6);
    expect(v.cellId).toBe(0);
    const handE = irradianceAt(5, w0, lambda, 30, 0);
    const dt = 1 / 20000;
    const handRatio = (handE * dt) / eyeMpeEnergy(dt);
    expect(relErr(v.ratio, handRatio)).toBeLessThan(0.002);
    expect(relErr(v.ratio, 62.59)).toBeLessThan(0.02);
    expect(v.basis).toBe('eye-single');
    expect(report.maxIrradiance).toBeCloseTo(handE, 5);
  });

  it('工况 B2:极低功率 0.8mW,全部合格无违规(手算单步 ratio≈0.01)', () => {
    // E(30m)=13398×0.0008/5=2.1437;H=1.072e-4;ratio=0.0100
    const pr = makeProjector({ power: 0.0008, pps: 20000 });
    const project = makeProject([pr], 0.05, ['f1']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    const files = new Map([['f1', staticFrame([{ x: 0, y: 0 }])]]);
    const report = run(project, files);
    expect(report.violations).toHaveLength(0);
    expect(report.peakRatio[0]).toBeLessThan(1);
    const handE = irradianceAt(0.0008, w0, lambda, 30, 0);
    const dt = 5e-5;
    // 峰值比含多脉冲累积,但仍应 <1;单步比与手算对照
    const singleRatio = (handE * dt) / eyeMpeEnergy(dt);
    expect(relErr(singleRatio, 0.01002)).toBeLessThan(0.02);
    expect(report.peakRatio[0]).toBeLessThan(1);
  });

  it('工况 B3:长曝光累积,平均辐照度越过随窗长收紧的长窗 MPE(稳态 2.154 W/m²)', () => {
    // 取 E(30m)=2.5 W/m²:单脉冲比 2.5/214=0.0117 全程合格;
    // 长窗 MPE 随曝光时间收紧、t≥10s 锁定 2.154,故 2.5/2.154=1.1604 必然超标。
    const e30 = irradianceAt(5, w0, lambda, 30, 0);
    const P = (2.5 / e30) * 5;
    const pr = makeProjector({ power: P, pps: 20000 });
    const project = makeProject([pr], 12, ['f1']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    project.safety.timeStepSec = 0.01;
    const files = new Map([['f1', staticFrame([{ x: 0, y: 0 }])]]);
    const report = run(project, files);

    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0].basis).toBe('eye-average');
    // 稳态(t≥10s)峰值比与手算长窗比严格一致
    const handLongRatio = 2.5 / eyeMpeIrradiance(10);
    expect(relErr(report.peakRatio[0], handLongRatio)).toBeLessThan(0.002);
    expect(relErr(handLongRatio, 1.1604)).toBeLessThan(0.02);
  });

  it('工况 B4:离轴格点(光束中心不在此)同样全网格评估,单步超标必标出', () => {
    // 格点 (0.01,4,30),r=10mm;P=10W → E=13398×2×0.4113=11021
    const pr = makeProjector({ power: 10, pps: 20000 });
    const project = makeProject([pr], 5e-5, ['f1']);
    project.audienceBoxes = audienceAt([0.01, 4, 30]);
    const files = new Map([['f1', staticFrame([{ x: 0, y: 0 }])]]);
    const report = run(project, files);

    const handE = irradianceAt(10, waistFromSpec(5, 1, lambda), lambda, 30, 0.01);
    const dt = 5e-5;
    const handRatio = (handE * dt) / eyeMpeEnergy(dt);
    expect(handRatio).toBeGreaterThan(1);
    expect(report.violations).toHaveLength(1);
    expect(relErr(report.violations[0].ratio, handRatio)).toBeLessThan(0.002);
  });

  it('工况 B5:两台 2.5W 同点叠加,单步等效一台 5W,contributorIds 含两台', () => {
    const p1 = makeProjector({ id: 'P1', power: 2.5 });
    const p2 = makeProjector({ id: 'P2', power: 2.5, position: [0.001, 4, 0] });
    const project = makeProject([p1, p2], 5e-5, ['f1', 'f2']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    const files = new Map([
      ['f1', staticFrame([{ x: 0, y: 0 }])],
      ['f2', staticFrame([{ x: 0, y: 0 }])]
    ]);
    const report = run(project, files);
    expect(report.violations.length).toBeGreaterThan(0);
    const v = report.violations[0];
    expect(v.contributorIds.sort()).toEqual(['P1', 'P2']);
    const dt = 5e-5;
    const eSingle = irradianceAt(5, w0, lambda, 30, 0);
    const handRatio = (eSingle * dt) / eyeMpeEnergy(dt);
    // 两台机器相距 1mm,几何上有 ~0.4% 微差,2% 手算容差内
    expect(relErr(v.ratio, handRatio)).toBeLessThan(0.02);
  });

  it('工况 B6:灭光(blanking)片段不产生任何违规', () => {
    const pr = makeProjector({ pps: 20000 });
    const project = makeProject([pr], 0.05, ['f1']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    const files = new Map([['f1', staticFrame([{ x: 0, y: 0, status: 0x40 }])]]);
    const report = run(project, files);
    expect(report.violations).toHaveLength(0);
    expect(report.maxIrradiance).toBe(0);
  });

  it('工况 B7a:扇面扫描驻留触发多脉冲判据(eye-multipulse)', () => {
    // 800 点往返扇,pps=16000:光束周期性扫过观众点,窗内形成多个离散驻留
    const pr = makeProjector({ pps: 16000, scanAngleH: 40 });
    const project = makeProject([pr], 0.5, ['fan']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    const files = new Map([['fan', fanFrame(400)]]);
    const report = run(project, files);

    expect(report.violations.length).toBeGreaterThan(0);
    // 首个中心驻留脉冲(t≈200 点 ×62.5µs=12.5ms)即触发
    expect(report.violations[0].timeSec).toBeCloseTo(200 / 16000, 6);
    // 必须出现多脉冲判据(而不仅是单脉冲/平均)
    expect(report.violations.some(v => v.basis === 'eye-multipulse')).toBe(true);
  });

  it('工况 B7b:确定性多脉冲(n=25),单脉冲合格、多脉冲累积超标,与手算 n^-1/4 一致', () => {
    // 周期 10ms 的脉冲串:每 10 个时间步有 1 个指向观众格的脉冲,其余指最大角不命中。
    // 0.25s 滚动窗内恰有 n=25 个离散驻留。把功率调到单脉冲比 0.6(合格),
    // 则多脉冲比 = 0.6 × 25^0.25 = 1.457(超标),且单脉冲/平均窗均合格,
    // 保证 eye-multipulse 是唯一主导判据。
    const pps = 1000;
    const dt = 1 / pps;
    const pts = [];
    for (let k = 0; k < 10; k++) {
      pts.push(k === 0
        ? { x: 0, y: 0 }
        : { x: k % 2 === 0 ? 32767 : -32767, y: 0 });
    }
    const targetSingle = 0.6;
    const e30 = irradianceAt(5, w0, lambda, 30, 0);
    const P = ((targetSingle * eyeMpeEnergy(dt)) / dt / e30) * 5;
    const pr = makeProjector({ power: P, pps, scanAngleH: 40 });
    const project = makeProject([pr], 0.5, ['seq']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    project.safety.timeStepSec = dt;
    const files = new Map([['seq', staticFrame(pts)]]);
    const report = run(project, files);

    // 唯一主导判据必须是多脉冲
    expect(report.violations.every(v => v.basis === 'eye-multipulse')).toBe(true);
    // 手算:峰值 = 单脉冲比 / n^-1/4 = 单脉冲比 × n^0.25;25^0.25=2.2361
    const n = 25;
    const handPeak = targetSingle / multipulseFactor(n);
    expect(relErr(Math.max(...report.peakRatio), handPeak)).toBeLessThan(0.002);
    expect(relErr(handPeak, 1.3416)).toBeLessThan(0.02);
  });

  it('工况 B8:限区遮罩 — 违规方向中心被遮、边缘放行,且带 1.5° 外扩', () => {
    const pr = makeProjector({ pps: 20000 });
    const project = makeProject([pr], 0.05, ['f1']);
    project.audienceBoxes = audienceAt([0, 4, 30]);
    project.safety.maskRasterSize = 240;
    const files = new Map([['f1', staticFrame([{ x: 0, y: 0 }])]]);
    const report = run(project, files);
    const mask = report.masks[0];
    expect(mask.projectorId).toBe(pr.id);
    expect(isMasked(mask, 0, 0)).toBe(true);
    expect(isMasked(mask, 18 * DEG, 10 * DEG)).toBe(false);
    expect(isMasked(mask, 1 * DEG, 0)).toBe(true);
  });
});

describe('安全引擎 — 全网格穷举独立比对(不漏检证明)', () => {
  it('75 个观众格点 × 全时间步:引擎与独立穷举实现逐格一致(误差<2%),无漏检无误报', () => {
    const pr = makeProjector({ pps: 8000, scanAngleH: 40, power: 5 });
    const project = makeProject([pr], 0.4, ['fan']);
    project.audienceBoxes = [{ id: 'a1', name: '观众区', min: [-2, 3, 28], max: [2, 5, 32] }];
    project.safety.gridSpacing = 1;
    const files = new Map([['fan', fanFrame(200)]]);
    const report = run(project, files);

    const dt = report.timeStepSec;
    const steps = report.totalSteps;
    const waist = waistFromSpec(pr.beamDiameter, pr.divergence, pr.wavelength);
    const cellCount = report.cellCount;
    expect(cellCount).toBe(75);

    // 独立实现:不调用引擎累积逻辑,逐格逐步直接算
    const brutePeak = new Float32Array(cellCount);
    const mpeSingle = eyeMpeEnergy(dt);
    for (let cell = 0; cell < cellCount; cell++) {
      const p: [number, number, number] = [
        report.cellCenters[cell * 3],
        report.cellCenters[cell * 3 + 1],
        report.cellCenters[cell * 3 + 2]
      ];
      const hits: { t: number; h: number }[] = [];
      let peakRatio = 0;
      for (let step = 0; step < steps; step++) {
        const t = step * dt;
        const cmd = evaluateProjector(pr, project.timeline, files, t, dt);
        if (!cmd || cmd.blanked) continue;
        const { z, r } = rayGeometry(pr.position, cmd.direction, p);
        if (z <= 0) continue;
        const e = irradianceAt(pr.power, waist, pr.wavelength, z, r);
        if (e <= 0) continue;
        hits.push({ t, h: e * dt });
        const rSingle = (e * dt) / mpeSingle;
        // 细窗:仅保留最近 0.25s 的命中(与引擎滚动窗一致)
        const fineHits = hits.filter(x => t - x.t < 0.25 + dt);
        const fineT = Math.min(0.25, t + dt);
        const rFine = (fineHits.reduce((s, x) => s + x.h, 0) / fineT) / eyeMpeIrradiance(fineT);
        // 多脉冲:n = 细窗内的离散驻留数(不是全程)
        const n = fineHits.length;
        const rMulti = n >= 2 ? (e * dt) / (mpeSingle * multipulseFactor(n)) : 0;
        // 粗窗 10s
        const longHits = hits.filter(x => t - x.t < 10 + dt);
        const longT = Math.min(10, t + dt);
        const rLong = (longHits.reduce((s, x) => s + x.h, 0) / longT) / eyeMpeIrradiance(longT);
        peakRatio = Math.max(peakRatio, rSingle, rFine, rLong, rMulti);
      }
      brutePeak[cell] = peakRatio;
    }

    let flaggedByEngine = 0;
    for (let cell = 0; cell < cellCount; cell++) {
      if (brutePeak[cell] > 1e-6) {
        expect(relErr(report.peakRatio[cell], brutePeak[cell])).toBeLessThan(0.02);
      } else {
        // 高斯拖尾可能产生极小非零值,要求两边都在可忽略量级
        expect(report.peakRatio[cell]).toBeLessThan(1e-5);
      }
      if (brutePeak[cell] > 1) {
        flaggedByEngine++;
        expect(report.violations.some(v => v.cellId === cell)).toBe(true);
      }
    }
    for (const v of report.violations) expect(brutePeak[v.cellId]).toBeGreaterThan(1);
    expect(flaggedByEngine).toBeGreaterThan(0);
  });
});
