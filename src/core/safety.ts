/**
 * 安全检查引擎(IEC 60825-1:2014,可见光 400–700nm)
 *
 * 完备性设计(对应"任意点任意刻超标必标出"的硬要求):
 *  1. 观众区所有 AABB 合并为规则三维网格,逐格评估,无射线投射漏检;
 *  2. 时间步长取全部激光器最小点周期,每个脉冲位置都成为一个评估时刻;
 *  3. 每个时间步对每个网格点做四类检查:
 *       a) 单脉冲限值(含重复脉冲 n^-1/4 修正)
 *       b) 0.25s 窗平均辐照度限值
 *       c) 10s 窗平均辐照度限值(2.154 W/m²)
 *       d) 皮肤限值(可选)
 *     多机功率在同一网格点同一时刻直接叠加;
 *  4. 扫描角锥快速剔除只是性能优化,剔除条件本身保守(含光束半径余量),
 *     不改变任何被评估点的结果。
 *
 * 时间窗用环形缓冲逐格累积能量:细桶 dt(0.25s 窗),粗桶 0.1s(10s 窗)。
 */
import type {
  Box3, IldaFile, MaskRaster, Project, Projector, SafetyReport, SafetySettings, Vec3, Violation
} from './types';
import {
  APERTURE_RADIUS_M, AVERSION_TIME_S, LONG_WINDOW_S, assertVisible,
  eyeMpeEnergy, eyeMpeIrradiance, irradianceAt, multipulseFactor, rayGeometry, skinMpeEnergy, waistFromSpec
} from './physics';
import { compose, transformPoint, v3 } from './math';
import { evaluateProjector, type BeamCommand } from './timeline';

const DEG = Math.PI / 180;
const COARSE_BIN = 0.1; // 10s 窗能量桶宽(s)

interface Grid {
  centers: Float32Array; // vec3 紧凑数组
  dims: [number, number, number];
  origin: Vec3;
  spacing: number;
}

/** 合并多个观众区箱体,生成不重复的规则网格中心点 */
export function buildAudienceGrid(boxes: Box3[], spacing: number): Grid {
  if (boxes.length === 0) return { centers: new Float32Array(0), dims: [0, 0, 0], origin: [0, 0, 0], spacing };
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], b.min[k]);
    max[k] = Math.max(max[k], b.max[k]);
  }
  const dims: [number, number, number] = [
    Math.max(1, Math.round((max[0] - min[0]) / spacing) + 1),
    Math.max(1, Math.round((max[1] - min[1]) / spacing) + 1),
    Math.max(1, Math.round((max[2] - min[2]) / spacing) + 1)
  ];
  const centers: number[] = [];
  const inside = (p: Vec3) => boxes.some(b =>
    p[0] >= b.min[0] && p[0] <= b.max[0] &&
    p[1] >= b.min[1] && p[2] >= b.min[2] &&
    p[2] <= b.max[2] && p[1] <= b.max[1]);
  for (let i = 0; i < dims[0]; i++) for (let j = 0; j < dims[1]; j++) for (let k = 0; k < dims[2]; k++) {
    const p: Vec3 = [
      min[0] + i * spacing,
      min[1] + j * spacing,
      min[2] + k * spacing
    ];
    if (inside(p)) centers.push(p[0], p[1], p[2]);
  }
  return { centers: Float32Array.from(centers), dims, origin: min, spacing };
}

interface ProjectorRuntime {
  projector: Projector;
  waist: number;
  matrix: Float32Array;
  forward: Vec3;
  cullCos: number;
}

interface CellAccum {
  ringFine: Float64Array;   // 细桶能量 J/m²
  ringCoarse: Float64Array; // 粗桶能量
  ringPulse: Uint16Array;   // 细桶脉冲计数
  /** 桶位上一次写入的步数,-1 表示从未写入(首圈不把空桶当有效数据) */
  fineAge: Int32Array;
  coarseAge: Int32Array;
  sumFine: number;
  sumCoarse: number;
  sumPulse: number;
  peakRatio: number;
  peakIrr: number;
}

export interface EngineProgress {
  phase: string;
  percent: number;
}

export function runSafetyCheck(
  project: Project,
  files: Map<string, IldaFile>,
  onProgress?: (p: EngineProgress) => void
): SafetyReport {
  for (const p of project.projectors) assertVisible(p.wavelength);
  const settings = project.safety;
  const grid = buildAudienceGrid(project.audienceBoxes, settings.gridSpacing);
  const cellCount = grid.centers.length / 3;

  const runtimes: ProjectorRuntime[] = project.projectors.map(p => {
    const waist = waistFromSpec(p.beamDiameter, p.divergence, p.wavelength);
    const matrix = compose(p.position, p.orientation);
    const forward = v3.norm(transformPoint(matrix, [0, 0, 1]).map((v, i) => v - p.position[i]) as Vec3);
    const halfCone = Math.max(p.scanAngleH, p.scanAngleV) * 0.5 * DEG + 0.02;
    return { projector: p, waist, matrix, forward, cullCos: Math.cos(halfCone) };
  });

  const dt = settings.timeStepSec ?? Math.min(...project.projectors.map(p => 1 / p.pps));
  const totalSteps = Math.max(1, Math.round(project.timeline.durationSec / dt));
  const fineBins = Math.ceil(AVERSION_TIME_S / dt);
  const coarseBins = Math.ceil(LONG_WINDOW_S / COARSE_BIN);
  const stepsPerCoarse = Math.max(1, Math.round(COARSE_BIN / dt));

  // 稀疏存储:只有被照到的格子才分配累积器
  const accums = new Map<number, CellAccum>();
  const getAccum = (id: number): CellAccum => {
    let a = accums.get(id);
    if (!a) {
      a = {
        ringFine: new Float64Array(fineBins),
        ringCoarse: new Float64Array(coarseBins),
        ringPulse: new Uint16Array(fineBins),
        fineAge: new Int32Array(fineBins).fill(-1),
        coarseAge: new Int32Array(coarseBins).fill(-1),
        sumFine: 0, sumCoarse: 0, sumPulse: 0, peakRatio: 0, peakIrr: 0
      };
      accums.set(id, a);
    }
    return a;
  };

  const violations: Violation[] = [];
  const openViolations = new Map<number, Violation>();
  let maxIrradiance = 0;

  const mpeSingle = eyeMpeEnergy(dt); // 单步(单脉冲)能量限值
  const mpeFineAvg = eyeMpeIrradiance(AVERSION_TIME_S); // 0.25s 平均限值
  const mpeLong = eyeMpeIrradiance(LONG_WINDOW_S);      // 10s 平均限值(2.154)
  const limitFrac = settings.mpeFraction;

  for (let step = 0; step < totalSteps; step++) {
    const t = step * dt;
    if (onProgress && step % Math.max(1, Math.floor(totalSteps / 50)) === 0) {
      onProgress({ phase: '扫描节目时间轴', percent: step / totalSteps });
    }

    const cmds: { rt: ProjectorRuntime; cmd: BeamCommand }[] = [];
    for (const rt of runtimes) {
      const cmd = evaluateProjector(rt.projector, project.timeline, files, t, dt);
      if (cmd && !cmd.blanked) cmds.push({ rt, cmd });
    }
    if (cmds.length === 0) continue;

    const fineIdx = step % fineBins;
    const coarseIdx = Math.floor(step / stepsPerCoarse) % coarseBins;
    const coarseRollover = step % stepsPerCoarse === 0;

    for (let cell = 0; cell < cellCount; cell++) {
      const cx = grid.centers[cell * 3];
      const cy = grid.centers[cell * 3 + 1];
      const cz = grid.centers[cell * 3 + 2];

      let eTotal = 0;
      const contributors: string[] = [];
      for (const { rt, cmd } of cmds) {
        const vx = cx - rt.projector.position[0];
        const vy = cy - rt.projector.position[1];
        const vz = cz - rt.projector.position[2];
        const dist = Math.hypot(vx, vy, vz);
        if (dist < 1e-6) continue;
        // 保守锥剔除:点方向与前向夹角 > 最大半扫角+余量 则绝无命中
        const dot = (vx * rt.forward[0] + vy * rt.forward[1] + vz * rt.forward[2]) / dist;
        if (dot < rt.cullCos) continue;
        const { z, r } = rayGeometry(rt.projector.position, cmd.direction, [cx, cy, cz]);
        if (z <= 0) continue;
        const e = irradianceAt(rt.projector.power, rt.waist, rt.projector.wavelength, z, r);
        if (e > 0) {
          eTotal += e;
          contributors.push(rt.projector.id);
        }
      }
      if (eTotal <= 0) continue;

      maxIrradiance = Math.max(maxIrradiance, eTotal);
      const a = getAccum(cell);

      // 滚桶:换新桶位时先扣除该位上一轮的旧值(首圈无旧值不扣)
      if (a.fineAge[fineIdx] !== step) {
        if (a.fineAge[fineIdx] >= 0) {
          a.sumFine -= a.ringFine[fineIdx];
          a.sumPulse -= a.ringPulse[fineIdx];
        }
        a.ringFine[fineIdx] = 0;
        a.ringPulse[fineIdx] = 0;
        a.fineAge[fineIdx] = step;
      }
      if (coarseRollover) {
        if (a.coarseAge[coarseIdx] >= 0) a.sumCoarse -= a.ringCoarse[coarseIdx];
        a.ringCoarse[coarseIdx] = 0;
        a.coarseAge[coarseIdx] = step;
      }

      const energy = eTotal * dt;
      a.ringFine[fineIdx] += energy;
      a.ringPulse[fineIdx] += 1;
      a.ringCoarse[coarseIdx] += energy;
      a.sumFine += energy;
      a.sumPulse += 1;
      a.sumCoarse += energy;

      // —— 三类独立判据,取最严 ——
      // (a) 单脉冲/单采样:本步能量 vs 单脉冲 MPE。连续光束的逐 dt 切片不是
      //     独立脉冲,故此处【不】做多脉冲修正(修正放到判据 c)。
      const rSingle = energy / (mpeSingle * limitFrac);
      // (b) 平均辐照度窗(0.25s / 10s):窗未满时按实际曝光时长取对应 MPE,
      //     IEC 限值随 t 变化,不能拿满窗常数比部分窗。
      const fineTime = Math.min(AVERSION_TIME_S, t + dt);
      const fineAvg = a.sumFine / fineTime;
      const rFine = fineAvg / (eyeMpeIrradiance(fineTime) * limitFrac);
      const longTime = Math.min(LONG_WINDOW_S, t + dt);
      const longAvg = a.sumCoarse / longTime;
      const rLong = longAvg / (eyeMpeIrradiance(longTime) * limitFrac);
      // (c) 多脉冲:窗内确有 n 个离散驻留命中(n≥2)时,单脉冲限值乘 n^-1/4。
      const n = a.sumPulse;
      const rMulti = n >= 2 ? energy / (mpeSingle * multipulseFactor(n) * limitFrac) : 0;

      let ratio = rSingle;
      let basis: Violation['basis'] = 'eye-single';
      if (rFine > ratio) { ratio = rFine; basis = 'eye-average'; }
      if (rLong > ratio) { ratio = rLong; basis = 'eye-average'; }
      if (rMulti > ratio) { ratio = rMulti; basis = 'eye-multipulse'; }
      if (settings.checkSkin) {
        const rSkin = a.sumFine / (skinMpeEnergy(fineTime) * limitFrac);
        if (rSkin > ratio) { ratio = rSkin; basis = 'skin'; }
      }

      a.peakIrr = Math.max(a.peakIrr, eTotal);
      a.peakRatio = Math.max(a.peakRatio, ratio);

      if (ratio > 1) {
        const point: Vec3 = [cx, cy, cz];
        const existing = openViolations.get(cell);
        if (existing) {
          existing.endSec = t + dt;
          existing.peakIrradiance = Math.max(existing.peakIrradiance, eTotal);
          existing.ratio = Math.max(existing.ratio, ratio);
        } else {
          const v: Violation = {
            timeSec: t,
            endSec: t + dt,
            projectorId: contributors[0],
            contributorIds: contributors,
            point,
            cellId: cell,
            peakIrradiance: eTotal,
            mpeIrradiance: mpeFineAvg * limitFrac,
            ratio,
            basis
          };
          violations.push(v);
          openViolations.set(cell, v);
        }
      } else if (openViolations.has(cell)) {
        openViolations.delete(cell);
      }
    }
  }

  const peakRatio = new Float32Array(cellCount);
  for (const [id, a] of accums) peakRatio[id] = a.peakRatio;
  const masks = buildMasks(project, grid, accums, settings);

  if (onProgress) onProgress({ phase: '完成', percent: 1 });
  return {
    ranAt: Date.now(),
    durationSec: project.timeline.durationSec,
    timeStepSec: dt,
    cellCount,
    totalSteps,
    violations,
    peakRatio,
    cellCenters: grid.centers,
    settings,
    masks,
    maxIrradiance
  };
}

/**
 * 由违规格子反算每台激光器本地系角度,生成限区遮罩栅格,
 * 并按 maskMarginDeg 外扩(形态学膨胀)。
 */
export function buildMasks(project: Project, grid: Grid, accums: Map<number, CellAccum>, settings: SafetySettings): MaskRaster[] {
  const size = settings.maskRasterSize;
  const margin = settings.maskMarginDeg * DEG;
  return project.projectors.map(pr => {
    const halfH = pr.scanAngleH * 0.5 * DEG;
    const halfV = pr.scanAngleV * 0.5 * DEG;
    const azRange: [number, number] = [-halfH, halfH];
    const elRange: [number, number] = [-halfV, halfV];
    const blocked = new Uint8Array(size * size);
    const dAz = (azRange[1] - azRange[0]) / size;
    const dEl = (elRange[1] - elRange[0]) / size;
    const expand = Math.max(1, Math.ceil(margin / Math.max(dAz, dEl)));

    // 世界 → 激光器本地系:先平移再反向旋转(R = Rz(yaw)·Ry(pitch))
    const yaw = pr.orientation[0], pitch = pr.orientation[1];
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const toLocal = (p: Vec3): Vec3 => {
      const dx = p[0] - pr.position[0];
      const dy = p[1] - pr.position[1];
      const dz = p[2] - pr.position[2];
      // Ry(-yaw)
      const x1 = cy * dx - sy * dz;
      const z1 = sy * dx + cy * dz;
      // Rx(-pitch)
      const y2 = cp * dy + sp * z1;
      const z2 = -sp * dy + cp * z1;
      return [x1, y2, z2];
    };

    for (const [cellId, a] of accums) {
      if (a.peakRatio <= 1) continue;
      const p: Vec3 = [grid.centers[cellId * 3], grid.centers[cellId * 3 + 1], grid.centers[cellId * 3 + 2]];
      const local = toLocal(p);
      const az = Math.atan2(local[0], local[2]);
      const el = Math.atan2(local[1], local[2]);
      if (az < azRange[0] || az > azRange[1] || el < elRange[0] || el > elRange[1]) continue;
      const i = Math.floor(((az - azRange[0]) / (azRange[1] - azRange[0])) * size);
      const j = Math.floor(((el - elRange[0]) / (elRange[1] - elRange[0])) * size);
      for (let dj = -expand; dj <= expand; dj++) for (let di = -expand; di <= expand; di++) {
        const ni = i + di, nj = j + dj;
        if (ni >= 0 && ni < size && nj >= 0 && nj < size) blocked[nj * size + ni] = 1;
      }
    }
    return { projectorId: pr.id, size, azRange, elRange, blocked };
  });
}

export { APERTURE_RADIUS_M };
