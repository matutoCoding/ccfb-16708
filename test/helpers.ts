import type { IldaFile, IldaFrame, IldaPoint, Project, Projector, Vec3 } from '../src/core/types';
import { DEFAULT_SAFETY } from '../src/core/types';

export function staticFrame(points: Array<Partial<IldaPoint>>): IldaFile {
  const pts: IldaPoint[] = points.map((p, i) => ({
    x: p.x ?? 0,
    y: p.y ?? 0,
    z: p.z ?? 0,
    status: (p.status ?? 0) | (i === points.length - 1 ? 0x80 : 0),
    r: p.r ?? 255,
    g: p.g ?? 255,
    b: p.b ?? 255
  }));
  const frame: IldaFrame = { name: 'test', company: 'TEST', points: pts };
  return { format: 5, frames: [frame], warnings: [] };
}

/** 水平往返扫描扇:一个 ILDA 帧内从 -32767 扫到 +32767 再回来,全部点亮 */
export function fanFrame(samples = 400): IldaFile {
  const pts: IldaPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    pts.push({ x: Math.round(-32767 + (2 * 32767 * i) / samples), y: 0, z: 0, status: 0, r: 255, g: 0, b: 0 });
  }
  for (let i = 1; i < samples; i++) {
    pts.push({ x: Math.round(32767 - (2 * 32767 * i) / samples), y: 0, z: 0, status: 0, r: 255, g: 0, b: 0 });
  }
  pts[pts.length - 1].status |= 0x80;
  return { format: 5, frames: [{ name: 'fan', points: pts }], warnings: [] };
}

export function makeProjector(over: Partial<Projector> = {}): Projector {
  return {
    id: over.id ?? 'P1',
    name: over.name ?? '激光器1',
    position: over.position ?? ([0, 4, 0] as Vec3),
    orientation: over.orientation ?? ([0, 0, 0] as Vec3),
    scanAngleH: over.scanAngleH ?? 40,
    scanAngleV: over.scanAngleV ?? 30,
    beamDiameter: over.beamDiameter ?? 5,
    divergence: over.divergence ?? 1,
    power: over.power ?? 5,
    wavelength: over.wavelength ?? 532,
    pps: over.pps ?? 20000,
    maxSlewRate: over.maxSlewRate ?? 40,
    color: over.color ?? ([0.2, 1, 0.3] as Vec3)
  };
}

export function makeProject(
  projectors: Projector[],
  durationSec: number,
  assetIds: string[],
  gridSpacing = 0.25
): Project {
  return {
    id: 'test-project',
    name: '测试工程',
    createdAt: 0,
    updatedAt: 0,
    stageBoxes: [{ id: 's1', name: '舞台', min: [-8, 0, -4], max: [8, 6, 4] }],
    audienceBoxes: [{ id: 'a1', name: '观众区', min: [-0.2, 1.0, 29.8], max: [0.2, 1.4, 30.2] }],
    smokeZones: [],
    projectors,
    timeline: {
      durationSec,
      tracks: projectors.map((p, i) => ({
        id: `t${i}`,
        projectorId: p.id,
        clips: [{
          id: `c${i}`,
          assetId: assetIds[i],
          start: 0,
          duration: durationSec,
          inPoint: 0,
          rate: 1,
          muted: false
        }]
      }))
    },
    safety: { ...DEFAULT_SAFETY, gridSpacing }
  };
}
