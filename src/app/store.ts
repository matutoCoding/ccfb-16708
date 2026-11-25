/**
 * 全局应用状态:当前工程、素材库、自动保存、安全报告缓存。
 * ILDA 解析结果在内存里缓存(引擎和预览共用),原始字节存 IndexedDB。
 */
import { create } from 'zustand';
import type { AssetMeta, IldaFile, Project, SafetyReport } from '../core/types';
import { DEFAULT_SAFETY } from '../core/types';
import { parseIlda } from '../core/ilda';
import { db } from './storage';

const AUTOSAVE_MS = 1500;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newProject(name: string): Project {
  const now = Date.now();
  return {
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    stageBoxes: [{ id: uid('box'), name: '舞台', min: [-8, 0, -4], max: [8, 6, 4] }],
    audienceBoxes: [{ id: uid('box'), name: '观众区', min: [-10, 0, 8], max: [10, 3, 32] }],
    smokeZones: [
      { id: uid('box'), name: '薄烟区', min: [-8, 0, 4], max: [8, 6, 18], scatter: 0.02 },
      { id: uid('box'), name: '浓烟区', min: [-8, 0, 18], max: [8, 6, 32], scatter: 0.06 }
    ],
    projectors: [
      {
        id: uid('prjtr'),
        name: '激光器-1',
        position: [-3, 5, 0],
        orientation: [0, 0, 0],
        scanAngleH: 40,
        scanAngleV: 30,
        beamDiameter: 5,
        divergence: 1,
        power: 3,
        wavelength: 532,
        pps: 20000,
        maxSlewRate: 40,
        color: [0.2, 1, 0.3]
      }
    ],
    timeline: { durationSec: 60, tracks: [] },
    safety: { ...DEFAULT_SAFETY }
  };
}

interface AppState {
  project: Project | null;
  assets: AssetMeta[];
  ildaCache: Map<string, IldaFile>;
  report: SafetyReport | null;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  loadProject: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<Project>;
  duplicateProject: (id: string) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<void>;
  updateProject: (mutator: (p: Project) => void) => void;
  replaceProject: (p: Project) => void;
  refreshAssets: () => Promise<void>;
  importAssetBytes: (name: string, kind: 'ilda' | 'audio', bytes: Uint8Array, peaks?: number[]) => Promise<AssetMeta | undefined>;
  getIlda: (assetId: string) => Promise<IldaFile | undefined>;
  setReport: (r: SafetyReport | null) => void;
  flushSave: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

export const useStore = create<AppState>((set, get) => ({
  project: null,
  assets: [],
  ildaCache: new Map(),
  report: null,
  saveState: 'idle',

  async loadProject(id) {
    const p = await db.getProject(id);
    if (p) {
      set({ project: p, report: null });
      dirty = false;
    }
  },

  async createProject(name) {
    const p = newProject(name);
    await db.saveProject(p);
    set({ project: p, report: null });
    return p;
  },

  async duplicateProject(id) {
    const src = await db.getProject(id);
    if (!src) return null;
    const copy: Project = structuredClone(src);
    copy.id = uid('prj');
    copy.name = src.name + ' 副本';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    await db.saveProject(copy);
    set({ project: copy, report: null });
    return copy;
  },

  async deleteProject(id) {
    await db.deleteProject(id);
    if (get().project?.id === id) set({ project: null, report: null });
  },

  updateProject(mutator) {
    const p = get().project;
    if (!p) return;
    const draft = structuredClone(p);
    mutator(draft);
    draft.updatedAt = Date.now();
    set({ project: draft, saveState: 'saving' });
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void get().flushSave(); }, AUTOSAVE_MS);
  },

  replaceProject(p) {
    set({ project: p, saveState: 'saving' });
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void get().flushSave(); }, AUTOSAVE_MS);
  },

  async refreshAssets() {
    set({ assets: await db.listAssets() });
  },

  async importAssetBytes(name, kind, bytes, peaks) {
    const meta: AssetMeta = {
      id: uid('asset'),
      kind,
      name,
      importedAt: Date.now(),
      sizeBytes: bytes.length,
      peaks
    };
    if (kind === 'ilda') {
      try {
        const ilda = parseIlda(bytes);
        meta.frameCount = ilda.frames.length;
        const pointCount = ilda.frames.reduce((n, f) => n + f.points.length, 0);
        meta.frameRate = 30;
        meta.durationSec = pointCount / 20000; // 按默认 20k PPS 估算
        const cache = new Map(get().ildaCache);
        cache.set(meta.id, ilda);
        set({ ildaCache: cache });
      } catch (e) {
        meta.broken = true;
        meta.error = e instanceof Error ? e.message : String(e);
      }
    }
    await db.saveAsset(meta, bytes);
    await get().refreshAssets();
    return meta;
  },

  async getIlda(assetId) {
    const cache = get().ildaCache;
    const hit = cache.get(assetId);
    if (hit) return hit;
    const bytes = await db.getAssetBytes(assetId);
    if (!bytes) return undefined;
    const ilda = parseIlda(bytes);
    const next = new Map(cache);
    next.set(assetId, ilda);
    set({ ildaCache: next });
    return ilda;
  },

  setReport(r) {
    set({ report: r });
  },

  async flushSave() {
    const p = get().project;
    if (!p || !dirty) return;
    try {
      await db.saveProject(p);
      dirty = false;
      set({ saveState: 'saved' });
    } catch {
      set({ saveState: 'error' });
    }
  }
}));

export { uid };
