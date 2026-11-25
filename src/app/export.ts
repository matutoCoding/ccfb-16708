/**
 * 工程包导出/导入(.lspkg = zip):
 *   project.json    工程数据
 *   assets/<id>.<ext>  素材原始字节
 *   report/safety-report.json + masks/  安全报告(导出时附带)
 * 用 fflate 做纯浏览器 zip。
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { AssetMeta, Project, SafetyReport } from '../core/types';
import { encodeIlda, applyMaskToFrame, parseIlda } from '../core/ilda';
import { db } from './storage';

export interface ExportBundle {
  project: Project;
  assets: { meta: AssetMeta; bytes: Uint8Array }[];
  report?: SafetyReport;
}

async function collectBundle(project: Project, report?: SafetyReport): Promise<ExportBundle> {
  const metas = await db.listAssets();
  const used = new Set<string>();
  for (const tr of project.timeline.tracks) for (const c of tr.clips) used.add(c.assetId);
  const assets: { meta: AssetMeta; bytes: Uint8Array }[] = [];
  for (const meta of metas) {
    if (!used.has(meta.id) && meta.kind === 'ilda') continue;
    const bytes = await db.getAssetBytes(meta.id);
    if (bytes) assets.push({ meta, bytes });
  }
  return { project, assets, report };
}

export async function exportProjectZip(project: Project, report?: SafetyReport): Promise<Uint8Array> {
  const bundle = await collectBundle(project, report);
  const files: Record<string, Uint8Array> = {};
  files['project.json'] = strToU8(JSON.stringify(bundle.project, null, 2));
  for (const { meta, bytes } of bundle.assets) {
    const ext = meta.kind === 'ilda' ? 'ild' : 'wav';
    files[`assets/${meta.id}.${ext}`] = bytes;
  }
  if (bundle.report) {
    const serializable = {
      ...bundle.report,
      peakRatio: Array.from(bundle.report.peakRatio),
      cellCenters: Array.from(bundle.report.cellCenters),
      masks: bundle.report.masks.map(m => ({
        ...m,
        blocked: Array.from(m.blocked)
      }))
    };
    files['report/safety-report.json'] = strToU8(JSON.stringify(serializable, null, 2));
  }
  return zipSync(files, { level: 6 });
}

export function parseProjectZip(bytes: Uint8Array): ExportBundle {
  const archive = unzipSync(bytes);
  if (!archive['project.json']) throw new Error('工程包缺少 project.json,不是有效的 .lspkg 文件');
  const project = JSON.parse(strFromU8(archive['project.json'])) as Project;
  const assets: { meta: AssetMeta; bytes: Uint8Array }[] = [];
  for (const path of Object.keys(archive)) {
    const m = path.match(/^assets\/(.+)\.(ild|wav)$/);
    if (!m) continue;
    const data = archive[path];
    const meta: AssetMeta = {
      id: m[1],
      kind: m[2] === 'ild' ? 'ilda' : 'audio',
      name: m[1] + '.' + m[2],
      importedAt: Date.now(),
      sizeBytes: data.length
    };
    assets.push({ meta, bytes: data });
  }
  return { project, assets };
}

/**
 * 导出"带遮罩的 ILDA":对每台激光器,把对应轨道用到的 ILDA 帧按遮罩置 blanking,
 * 打包成 zip(每激光器一个 .ild)。
 */
export async function exportMaskedIlda(project: Project, report: SafetyReport): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const DEG = Math.PI / 180;
  for (const tr of project.timeline.tracks) {
    const mask = report.masks.find(m => m.projectorId === tr.projectorId);
    const projector = project.projectors.find(p => p.id === tr.projectorId);
    if (!mask || !projector) continue;
    const halfH = (projector.scanAngleH * DEG) / 2;
    const halfV = (projector.scanAngleV * DEG) / 2;
    const assetIds = [...new Set(tr.clips.map(c => c.assetId))];
    for (const assetId of assetIds) {
      const bytes = await db.getAssetBytes(assetId);
      if (!bytes) continue;
      let ild;
      try { ild = parseIlda(bytes); } catch { continue; }
      const masked = {
        ...ild,
        frames: ild.frames.map(f => applyMaskToFrame(f, mask, halfH, halfV))
      };
      files[`masked-${tr.projectorId}-${assetId}.ild`] = encodeIlda(masked);
    }
  }
  return zipSync(files, { level: 6 });
}

/** 安全评估报告导出为独立 JSON 文本 */
export function exportReportJson(report: SafetyReport): Uint8Array {
  const serializable = {
    ...report,
    peakRatio: Array.from(report.peakRatio),
    cellCenters: Array.from(report.cellCenters),
    masks: report.masks.map(m => ({ ...m, blocked: Array.from(m.blocked) }))
  };
  return strToU8(JSON.stringify(serializable, null, 2));
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/octet-stream'): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
