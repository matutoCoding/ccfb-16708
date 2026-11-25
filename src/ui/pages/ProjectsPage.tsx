import { useEffect, useRef, useState } from 'react';
import { db } from '../../app/storage';
import { useStore } from '../../app/store';
import { downloadBytes, exportProjectZip, parseProjectZip } from '../../app/export';
import { useToast } from '../toast';
import type { Project } from '../../core/types';

export function ProjectsPage({ onOpen }: { onOpen: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const store = useStore();
  const toast = useToast(s => s.show);

  const refresh = async () => setProjects(await db.listProjects());
  useEffect(() => { void refresh(); }, []);

  const create = async () => {
    const p = await store.createProject(name.trim() || '未命名工程');
    setCreating(false);
    setName('');
    await refresh();
    store.loadProject(p.id).then(onOpen);
  };

  const duplicate = async (id: string) => {
    await store.duplicateProject(id);
    await refresh();
    toast('工程已复制', 'ok');
  };

  const remove = async (p: Project) => {
    if (!confirm(`确认删除工程「${p.name}」?此操作不可撤销。`)) return;
    await store.deleteProject(p.id);
    await refresh();
    toast('工程已删除');
  };

  const doExport = async (p: Project) => {
    const zip = await exportProjectZip(p);
    downloadBytes(zip, `${p.name}.lspkg`, 'application/zip');
    toast('工程包已导出(.lspkg)', 'ok');
  };

  const doImport = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const bundle = parseProjectZip(bytes);
      bundle.project.id = `prj-${Date.now().toString(36)}`;
      bundle.project.name += ' (导入)';
      await db.saveProject(bundle.project);
      for (const { meta, bytes: b } of bundle.assets) {
        const exists = await db.getAssetMeta(meta.id);
        if (!exists) await db.saveAsset(meta, b);
      }
      await refresh();
      toast('工程包已导入', 'ok');
    } catch (e) {
      toast('导入失败:' + (e instanceof Error ? e.message : String(e)), 'bad');
    }
  };

  return (
    <div>
      <h2 className="page-title">工程列表</h2>
      <p className="page-sub">工程自动保存到浏览器 IndexedDB,可打包为 .lspkg 导出/导入</p>
      <div className="row" style={{ marginBottom: 18, maxWidth: 520 }}>
        <button className="primary" onClick={() => setCreating(true)}>＋ 新建工程</button>
        <button style={{ flex: 0 }} onClick={() => fileInputRef.current?.click()}>导入工程包</button>
        <input ref={fileInputRef} type="file" accept=".lspkg,.zip" style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.[0]) void doImport(e.target.files[0]); e.target.value = ''; }} />
      </div>

      {creating && (
        <div className="dialog-backdrop" onClick={() => setCreating(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>新建工程</h3>
            <label>工程名称</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()} placeholder="例如:跨年音乐节主舞台" />
            <div className="actions">
              <button onClick={() => setCreating(false)}>取消</button>
              <button className="primary" onClick={create}>创建</button>
            </div>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty"><div className="big">🎆</div><p>还没有工程,点击「新建工程」开始</p></div>
      ) : (
        <div className="project-grid">
          {projects.map(p => (
            <div key={p.id} className="card project-card" onClick={() => store.loadProject(p.id).then(onOpen)}>
              <h3>{p.name}</h3>
              <div className="meta">
                <div>激光器 {p.projectors.length} 台 · 轨道 {p.timeline.tracks.length} 条</div>
                <div>更新于 {new Date(p.updatedAt).toLocaleString('zh-CN')}</div>
              </div>
              <div className="actions" onClick={e => e.stopPropagation()}>
                <button onClick={() => store.loadProject(p.id).then(onOpen)}>打开</button>
                <button onClick={() => duplicate(p.id)}>复制</button>
                <button onClick={() => doExport(p)}>导出</button>
                <button className="danger" onClick={() => remove(p)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
