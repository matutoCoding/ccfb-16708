import { useEffect, useState } from 'react';
import { useStore } from '../app/store';
import { ToastHost, useToast } from './toast';
import { ProjectsPage } from './pages/ProjectsPage';
import { VenuePage } from './pages/VenuePage';
import { AssetsPage } from './pages/AssetsPage';
import { TimelinePage } from './pages/TimelinePage';
import { Preview3DPage } from './pages/Preview3DPage';
import { SafetyPage } from './pages/SafetyPage';
import { SettingsPage } from './pages/SettingsPage';
import { bootstrapSampleData } from './sampleData';

export type PageKey = 'projects' | 'venue' | 'assets' | 'timeline' | 'preview3d' | 'safety' | 'settings';

const NAV: { key: PageKey; label: string; icon: string }[] = [
  { key: 'projects', label: '工程列表', icon: '🗂' },
  { key: 'venue', label: '场地与设备', icon: '🏛' },
  { key: 'assets', label: '素材库', icon: '🎞' },
  { key: 'timeline', label: '时间线编排', icon: '🎚' },
  { key: 'preview3d', label: '三维预演', icon: '🌫' },
  { key: 'safety', label: '安全检查', icon: '🛡' },
  { key: 'settings', label: '设置', icon: '⚙️' }
];

export function App() {
  const [page, setPage] = useState<PageKey>('projects');
  const project = useStore(s => s.project);
  const saveState = useStore(s => s.saveState);
  const refreshAssets = useStore(s => s.refreshAssets);
  const flushSave = useStore(s => s.flushSave);
  const toast = useToast(s => s.show);

  useEffect(() => {
    void refreshAssets();
    void bootstrapSampleData(toast).then(() => refreshAssets());
    const onHide = () => void flushSave();
    window.addEventListener('beforeunload', onHide);
    return () => window.removeEventListener('beforeunload', onHide);
  }, [refreshAssets, flushSave, toast]);

  const current = NAV.find(n => n.key === page)!;
  const needProject = page !== 'projects' && !project;

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="brand">
          激光秀工作室
          <small>编排 · 三维预演 · 安全评估</small>
        </div>
        {NAV.map(n => (
          <div key={n.key} className={`nav-item ${page === n.key ? 'active' : ''}`} onClick={() => setPage(n.key)}>
            <span>{n.icon}</span><span>{n.label}</span>
          </div>
        ))}
      </nav>
      <div className="main">
        <header className="topbar">
          <span className="title">{current.label}</span>
          {project && <span className="tag">{project.name}</span>}
          {project && (
            <span className={`save-pill ${saveState === 'saved' ? 'saved' : saveState === 'error' ? 'error' : ''}`}>
              {saveState === 'saving' ? '自动保存中…' : saveState === 'saved' ? '已自动保存' : saveState === 'error' ? '保存失败' : '就绪'}
            </span>
          )}
        </header>
        <main className="content">
          {needProject ? (
            <div className="empty">
              <div className="big">🗂</div>
              <p>请先在「工程列表」打开或新建一个工程</p>
              <button className="primary" onClick={() => setPage('projects')}>去工程列表</button>
            </div>
          ) : (
            <>
              {page === 'projects' && <ProjectsPage onOpen={() => setPage('venue')} />}
              {page === 'venue' && <VenuePage />}
              {page === 'assets' && <AssetsPage />}
              {page === 'timeline' && <TimelinePage />}
              {page === 'preview3d' && <Preview3DPage />}
              {page === 'safety' && <SafetyPage />}
              {page === 'settings' && <SettingsPage />}
            </>
          )}
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
