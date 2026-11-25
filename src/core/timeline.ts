/**
 * 时间线求值:把全局时刻映射到每台激光器当前应输出的 ILDA 点。
 * 片段源时间 = 入点 + (全局时间 - 片段起点)/速率,源素材按点速率循环。
 */
import type { Clip, IldaFile, Projector, Timeline, Track, Vec3 } from './types';
import { v3 } from './math';

export interface BeamCommand {
  projectorId: string;
  /** 本地系方位角/俯仰角 (弧度) */
  az: number;
  el: number;
  /** 世界系光束方向 */
  direction: Vec3;
  blanked: boolean;
  color: Vec3;
  /** 本拍需求角速率 (rad/s) */
  slewRate: number;
}

export function activeClip(track: Track, t: number): Clip | undefined {
  return track.clips.find(c => !c.muted && t >= c.start && t < c.start + c.duration);
}

export function totalIldaPoints(file: IldaFile): number {
  return file.frames.reduce((n, f) => n + f.points.length, 0);
}

/** 源素材内的点序号(循环播放)与点内插值系数 u */
export function sourcePointIndex(file: IldaFile, sourceTime: number, pps: number): { index: number; u: number; total: number } {
  const total = totalIldaPoints(file);
  if (total === 0) return { index: 0, u: 0, total: 0 };
  const pos = ((sourceTime * pps) % total + total) % total;
  const index = Math.floor(pos);
  return { index, u: pos - index, total };
}

export function flattenPoints(file: IldaFile) {
  const out: { x: number; y: number; z: number; status: number; r: number; g: number; b: number }[] = [];
  for (const f of file.frames) for (const p of f.points) out.push(p);
  return out;
}

const DEG = Math.PI / 180;

/**
 * 求某台激光器在全局时刻 t 的指令光束(振镜输入端,不含机械滞后)。
 * 安全引擎以此为准——指令会到的地方都纳入评估,不依赖模拟失真,保证不漏。
 */
export function evaluateProjector(
  projector: Projector,
  timeline: Timeline,
  files: Map<string, IldaFile>,
  t: number,
  dt: number
): BeamCommand | undefined {
  const track = timeline.tracks.find(tr => tr.projectorId === projector.id);
  if (!track) return undefined;
  const clip = activeClip(track, t);
  if (!clip) return undefined;
  const file = files.get(clip.assetId);
  if (!file) return undefined;

  const sourceTime = clip.inPoint + (t - clip.start) / clip.rate;
  const effPps = projector.pps / clip.rate;
  const { index, u, total } = sourcePointIndex(file, sourceTime, effPps);
  if (total === 0) return undefined;
  const pts = flattenPoints(file);
  const p0 = pts[index];
  const p1 = pts[(index + 1) % total];

  const halfH = (projector.scanAngleH * DEG) / 2;
  const halfV = (projector.scanAngleV * DEG) / 2;
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const nx = lerp(p0.x, p1.x) / 32767;
  const ny = lerp(p0.y, p1.y) / 32767;
  const az = nx * halfH;
  const el = ny * halfV;

  // 本地系前向 +Z,角度为小角度近似的精确版(用 tan)
  const dirLocal = v3.norm([Math.tan(az), Math.tan(el), 1]);
  const sy = Math.sin(projector.orientation[1]); // pitch
  const cy = Math.cos(projector.orientation[1]);
  const sz = Math.sin(projector.orientation[0]); // yaw
  const cz = Math.cos(projector.orientation[0]);
  // R = Rz(yaw)·Ry(pitch),roll 对光束轴无实际意义(轴旋转对称),忽略
  const direction: Vec3 = [
    cz * dirLocal[0] + sz * cy * dirLocal[2] + sz * sy * dirLocal[1],
    cy * dirLocal[1] - sy * dirLocal[2],
    -sz * dirLocal[0] + cz * cy * dirLocal[2] + cz * sy * dirLocal[1]
  ];

  // 需求角速率:相邻点角度差 / 点周期
  const az0 = (p0.x / 32767) * halfH, az1 = (p1.x / 32767) * halfH;
  const el0 = (p0.y / 32767) * halfV, el1 = (p1.y / 32767) * halfV;
  const pointPeriod = 1 / effPps;
  const slewRate = Math.hypot(az1 - az0, el1 - el0) / pointPeriod;

  const blanked = ((p0.status & 0x40) !== 0) || (p0.r + p0.g + p0.b === 0);
  return {
    projectorId: projector.id,
    az,
    el,
    direction: v3.norm(direction),
    blanked,
    color: [p0.r / 255, p0.g / 255, p0.b / 255],
    slewRate
  };
}
