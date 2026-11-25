import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../app/store';
import { db } from '../../app/storage';
import { useToast } from '../toast';
import { PreviewRenderer } from '../../render/scene3d';
import type { AssetMeta } from '../../core/types';

export function AssetsPage() {
  const assets = useStore(s => s.assets);
  const refresh = useStore(s => s.refreshAssets);
  const importBytes = useStore(s => s.importAssetBytes);
  const getIlda = useStore(s => s.getIlda);
  const toast = useToast(s => s.show);
  const [selected, setSelected] = useState<AssetMeta | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = /\.(wav|mp3|ogg)$/i.test(file.name) ? 'audio' : 'ilda';
      const meta = await importBytes(file.name, kind, bytes);
      if (meta?.broken) toast(`「${file.name}」解析失败:${meta.error}`, 'bad');
      else toast(`「${file.name}」导入成功`, 'ok');
    }
  };

  const remove = async (a: AssetMeta) => {
    await db.deleteAsset(a.id);
    await refresh();
    if (selected?.id === a.id) setSelected(null);
    toast('素材已删除');
  };

  return (
    <div>
      <h2 className="page-title">素材库</h2>
      <p className="page-sub">支持 ILDA 格式 0/1/3/4/5(含调色板段),坏文件会给出明确错误;音频用于时间线波形对齐</p>
      <label className="card" style={{ display: 'block', cursor: 'pointer', marginBottom: 18, borderStyle: 'dashed', textAlign: 'center' }}>
        <input type="file" multiple accept=".ild,.lda,.wav,.mp3,.ogg" style={{ display: 'none' }}
          onChange={e => onFiles(e.target.files)} />
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 26 }}>📥</div>
          点击或拖入文件导入(ILDA / WAV)
        </div>
      </label>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 2 }}>
          <table>
            <thead><tr><th>名称</th><th>类型</th><th>规模</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {assets.map(a => (
                <tr key={a.id} style={{ cursor: 'pointer', background: selected?.id === a.id ? 'var(--bg-3)' : undefined }}
                  onClick={() => setSelected(a)}>
                  <td>{a.name}</td>
                  <td><span className="tag">{a.kind === 'ilda' ? 'ILDA' : '音频'}</span></td>
                  <td className="muted">
                    {a.kind === 'ilda' ? `${a.frameCount ?? 0} 帧` : `${a.durationSec?.toFixed(1) ?? '?'}s`}
                    {' · '}{(a.sizeBytes / 1024).toFixed(1)} KB
                  </td>
                  <td>{a.broken ? <span className="tag bad">损坏</span> : <span className="tag ok">正常</span>}</td>
                  <td><button className="danger" onClick={e => { e.stopPropagation(); void remove(a); }}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {assets.length === 0 && <div className="empty">暂无素材</div>}
        </div>
        <div style={{ flex: 1 }} className="card">
          <PreviewPanel asset={selected} getIlda={getIlda} />
        </div>
      </div>
    </div>
  );
}

function PreviewPanel({ asset, getIlda }: {
  asset: AssetMeta | null;
  getIlda: ReturnType<typeof useStore.getState>['getIlda'];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const pointsRef = useRef<{ x: number; y: number; status: number; r: number; g: number; b: number }[]>([]);

  // canvas 始终挂载,确保 renderer 在真实布局尺寸下创建
  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      rendererRef.current = new PreviewRenderer(canvasRef.current);
      const ro = new ResizeObserver(() => {
        if (pointsRef.current.length) rendererRef.current?.render(pointsRef.current);
      });
      ro.observe(canvasRef.current);
      return () => ro.disconnect();
    } catch { /* WebGL2 不可用 */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!asset || asset.kind !== 'ilda' || asset.broken) { pointsRef.current = []; return; }
      const ilda = await getIlda(asset.id);
      if (!ilda || cancelled) return;
      const frame = ilda.frames[0];
      const step = Math.max(1, Math.floor(frame.points.length / 4000));
      pointsRef.current = frame.points.filter((_, i) => i % step === 0);
      // 等待布局完成后再绘制,保证拿到真实 clientWidth
      requestAnimationFrame(() => {
        if (!cancelled) rendererRef.current?.render(pointsRef.current);
      });
    })();
    return () => { cancelled = true; };
  }, [asset, getIlda]);

  const showCanvas = !!asset && asset.kind === 'ilda' && !asset.broken;
  return (
    <div>
      {asset && <h3 style={{ marginTop: 0 }}>{asset.name}</h3>}
      {!asset && <div className="empty" style={{ padding: 20 }}>选择左侧素材查看预览</div>}
      {asset?.broken && (
        <>
          <h3 style={{ color: 'var(--danger)' }}>⚠ 坏文件</h3>
          <p className="muted">{asset.name}</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--warn)', fontSize: 12 }}>{asset.error}</pre>
        </>
      )}
      {asset?.kind === 'audio' && (
        <>
          <p className="muted">{asset.durationSec?.toFixed(1)}s · {(asset.sizeBytes / 1024 / 1024).toFixed(2)} MB</p>
          <Waveform peaks={asset.peaks ?? []} />
        </>
      )}
      {asset?.kind === 'ilda' && !asset.broken && (
        <p className="muted">{asset.frameCount} 帧 · 建议帧率 {asset.frameRate} fps</p>
      )}
      <canvas ref={canvasRef} className="preview-canvas" style={{ display: showCanvas ? 'block' : 'none' }} />
    </div>
  );
}

export function Waveform({ peaks, height = 90 }: { peaks: number[]; height?: number }) {
  if (peaks.length === 0) return <div className="muted">无波形数据</div>;
  return (
    <div style={{ position: 'relative', height, background: 'var(--bg)', borderRadius: 8, overflow: 'hidden' }}>
      {peaks.map((v, i) => (
        <div key={i} className="bar" style={{
          left: `${(i / peaks.length) * 100}%`,
          height: `${Math.max(2, v * 100)}%`,
          opacity: 0.4 + v * 0.6
        }} />
      ))}
    </div>
  );
}
