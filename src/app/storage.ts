/**
 * IndexedDB 持久化(原生封装,无第三方依赖)。
 * 单个数据库 lss-db,一次升级建立全部 object store;
 * 连接在收到版本变更通知时自动关闭,避免多标签页阻塞升级。
 */
import type { AssetMeta, Project } from '../core/types';

const DB_NAME = 'lss-db';
const DB_VERSION = 3;
const STORES = {
  projects: 'projects',
  assetMeta: 'asset-meta',
  assetBlobs: 'asset-blobs'
} as const;
type StoreName = keyof typeof STORES;

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 升级被其他标签页阻塞,请关闭多余标签后刷新'));
  });
  return dbPromise;
}

function request<T>(store: StoreName, mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORES[store], mode);
    const req = fn(tx.objectStore(STORES[store]));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  // —— 工程 ——
  async listProjects(): Promise<Project[]> {
    const all = await request<Project[]>('projects', 'readonly', s => s.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  getProject(id: string): Promise<Project | undefined> {
    return request<Project | undefined>('projects', 'readonly', s => s.get(id));
  },
  async saveProject(p: Project): Promise<void> {
    p.updatedAt = Date.now();
    await request('projects', 'readwrite', s => s.put(p, p.id));
  },
  deleteProject(id: string): Promise<void> {
    return request('projects', 'readwrite', s => s.delete(id));
  },

  // —— 素材 ——
  async listAssets(): Promise<AssetMeta[]> {
    const all = await request<AssetMeta[]>('assetMeta', 'readonly', s => s.getAll());
    return all.sort((a, b) => b.importedAt - a.importedAt);
  },
  getAssetMeta(id: string): Promise<AssetMeta | undefined> {
    return request<AssetMeta | undefined>('assetMeta', 'readonly', s => s.get(id));
  },
  async saveAsset(meta: AssetMeta, bytes: Uint8Array): Promise<void> {
    await request('assetMeta', 'readwrite', s => s.put(meta, meta.id));
    await request('assetBlobs', 'readwrite', s => s.put(bytes, meta.id));
  },
  getAssetBytes(id: string): Promise<Uint8Array | undefined> {
    return request<Uint8Array | undefined>('assetBlobs', 'readonly', s => s.get(id));
  },
  async deleteAsset(id: string): Promise<void> {
    await request('assetMeta', 'readwrite', s => s.delete(id));
    await request('assetBlobs', 'readwrite', s => s.delete(id));
  },
  allAssetIds(): Promise<IDBValidKey[]> {
    return request<IDBValidKey[]>('assetMeta', 'readonly', s => s.getAllKeys());
  }
};

/** 重置数据库(设置/排障用) */
export async function resetDatabase(): Promise<void> {
  const db = await openDb();
  db.close();
  dbPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库删除被阻塞'));
  });
}
