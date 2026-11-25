import { useMemo, useRef, useState } from 'react';
import { useStore, uid } from '../../app/store';
import { useToast } from '../toast';
import { Waveform } from './AssetsPage';
import type { AssetMeta, Clip } from '../../core/types';

export function TimelinePage() {
  const project = useStore(s => s.project)!;
  const update = useStore(s => s.updateProject);
  const assets = useStore(s => s.assets);
  const toast = useToast(s => s.show);
  const [selectedClip, setSelectedClip] = useState<{ trackId: string; clipId: string } | null>(null);
  const audioAsset = assets.find(a => a.kind === 'audio');
  const ildaAssets = assets.filter(a => a.kind === 'ilda' && !a.broken);
  const pxPerSec = 14;
  const laneRef = useRef<HTMLDivElement>(null);

  const duration = project.timeline.durationSec;

  const addTrack = (projectorId: string) => update(p => {
    if (p.timeline.tracks.some(t => t.projectorId === projectorId)) {
      toast('该激光器已有轨道', 'bad'); return;
    }
    p.timeline.tracks.push({ id: uid('track'), projectorId, clips: [] });
  });

  const addClip = (trackId: string, assetId: string) => update(p => {
    const track = p.timeline.tracks.find(t => t.id === trackId)!;
    const last = track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const meta = assets.find(a => a.id === assetId);
    const clipDuration = Math.min(8, meta?.durationSec ?? 8);
    track.clips.push({
      id: uid('clip'), assetId, start: last, duration: clipDuration,
      inPoint: 0, rate: 1, muted: false
    });
    track.clips.sort((a, b) => a.start - b.start);
  });

  const updateClip = (trackId: string, clipId: string, patch: Partial<Clip>) => update(p => {
    const clip = p.timeline.tracks.find(t => t.id === trackId)!.clips.find(c => c.id === clipId)!;
    Object.assign(clip, patch);
  });

  const splitClip = (trackId: string, clipId: string, atSec: number) => update(p => {
    const track = p.timeline.tracks.find(t => t.id === trackId)!;
    const clip = track.clips.find(c => c.id === clipId)!;
    if (atSec <= clip.start || atSec >= clip.start + clip.duration) return;
    const leftDur = atSec - clip.start;
    const rightDur = clip.duration - leftDur;
    clip.duration = leftDur;
    track.clips.push({
      ...clip, id: uid('clip'), start: atSec, duration: rightDur,
      inPoint: clip.inPoint + leftDur * clip.rate
    });
    track.clips.sort((a, b) => a.start - b.start);
    toast('片段已在播放头处切开', 'ok');
  });

  const removeClip = (trackId: string, clipId: string) => update(p => {
    const track = p.timeline.tracks.find(t => t.id === trackId)!;
    track.clips = track.clips.filter(c => c.id !== clipId);
    setSelectedClip(null);
  });

  const timeFromEvent = (e: React.MouseEvent): number => {
    const rect = laneRef.current!.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left) / pxPerSec);
  };

  const selClip = useMemo(() => {
    if (!selectedClip) return null;
    const tr = project.timeline.tracks.find(t => t.id === selectedClip.trackId);
    return tr?.clips.find(c => c.id === selectedClip.clipId) ?? null;
  }, [selectedClip, project]);

  const assetColor = (assetId: string) => {
    const idx = ildaAssets.findIndex(a => a.id === assetId);
    const hues = [210, 160, 280, 20, 120, 330];
    return `hsl(${hues[idx % hues.length]},65%,55%)`;
  };

  return (
    <div>
      <h2 className="page-title">时间线编排</h2>
      <p className="page-sub">每轨对应一台激光器;片段可拖动、切开、拼接、变速,并与音频波形对齐</p>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2 }}>
            <label>为激光器添加轨道</label>
            <select value="" onChange={e => e.target.value && addTrack(e.target.value)}>
              <option value="">选择激光器…</option>
              {project.projectors.filter(p => !project.timeline.tracks.some(t => t.projectorId === p.id))
                .map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>节目总时长 (s)</label>
            <input type="number" min="1" step="1" value={duration}
              onChange={e => update(p => { p.timeline.durationSec = Math.max(1, +e.target.value); })} />
          </div>
        </div>
      </div>

      <div className="card scroll" style={{ padding: 0 }}>
        {/* 时间刻度 + 音频波形 */}
        <div className="ruler" ref={laneRef} style={{ width: duration * pxPerSec, marginLeft: 150 }}>
          {Array.from({ length: Math.floor(duration) + 1 }, (_, i) => (
            <div key={i} className="tick" style={{ left: i * pxPerSec }}>{i}s</div>
          ))}
          {audioAsset && (
            <div className="waveform" style={{ top: 4, height: 20 }}>
              {(audioAsset.peaks ?? []).map((v, i, arr) => (
                <div key={i} className="bar" style={{
                  left: `${(i / arr.length) * 100}%`,
                  height: `${Math.max(1, v * 100)}%`
                }} />
              ))}
            </div>
          )}
        </div>

        {project.timeline.tracks.length === 0 && <div className="empty">还没有轨道,先在上方为激光器添加轨道</div>}

        {project.timeline.tracks.map(track => {
          const pr = project.projectors.find(p => p.id === track.projectorId);
          return (
            <div key={track.id} className="timeline-track" style={{ width: '100%' }}>
              <div className="timeline-label">
                <div style={{ fontWeight: 600 }}>{pr?.name ?? '未知激光器'}</div>
                <select style={{ marginTop: 6, padding: 4 }} value=""
                  onChange={e => e.target.value && addClip(track.id, e.target.value)}>
                  <option value="">＋ 添加片段</option>
                  {ildaAssets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="timeline-lane" style={{ width: duration * pxPerSec }}
                onDoubleClick={e => {
                  if (!selectedClip) return;
                  splitClip(track.id, selectedClip.clipId, timeFromEvent(e));
                }}>
                {track.clips.map(clip => {
                  const meta = assets.find(a => a.id === clip.assetId);
                  const isSel = selectedClip?.clipId === clip.id;
                  return (
                    <div key={clip.id}
                      className="clip"
                      style={{
                        left: clip.start * pxPerSec,
                        width: clip.duration * pxPerSec,
                        background: assetColor(clip.assetId),
                        opacity: clip.muted ? 0.4 : 0.92,
                        outline: isSel ? '2px solid #fff' : 'none'
                      }}
                      onClick={e => { e.stopPropagation(); setSelectedClip({ trackId: track.id, clipId: clip.id }); }}
                      draggable
                      onDragEnd={e => {
                        const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                        const start = Math.max(0, (e.clientX - rect.left) / pxPerSec - clip.duration / 2);
                        updateClip(track.id, clip.id, { start: Math.min(start, duration - clip.duration) });
                      }}>
                      {meta?.name}{clip.rate !== 1 ? ` ${clip.rate}×` : ''}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selClip && selectedClip && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>片段属性</h3>
          <div className="grid3">
            <div className="field"><label>起点 (s)</label>
              <input type="number" step="0.1" value={selClip.start}
                onChange={e => updateClip(selectedClip.trackId, selClip.id, { start: +e.target.value })} /></div>
            <div className="field"><label>时长 (s)</label>
              <input type="number" step="0.1" min="0.1" value={selClip.duration}
                onChange={e => updateClip(selectedClip.trackId, selClip.id, { duration: +e.target.value })} /></div>
            <div className="field"><label>源入点 (s)</label>
              <input type="number" step="0.1" min="0" value={selClip.inPoint}
                onChange={e => updateClip(selectedClip.trackId, selClip.id, { inPoint: +e.target.value })} /></div>
            <div className="field"><label>变速倍率</label>
              <input type="number" step="0.1" min="0.1" max="8" value={selClip.rate}
                onChange={e => updateClip(selectedClip.trackId, selClip.id, { rate: +e.target.value })} /></div>
          </div>
          <div className="row" style={{ maxWidth: 460 }}>
            <button onClick={() => updateClip(selectedClip.trackId, selClip.id, { muted: !selClip.muted })}>
              {selClip.muted ? '取消灭光' : '灭光(静音)'}
            </button>
            <button onClick={() => splitClip(selectedClip.trackId, selClip.id, selClip.start + selClip.duration / 2)}>
              从中间切开
            </button>
            <button className="danger" onClick={() => removeClip(selectedClip.trackId, selClip.id)}>删除片段</button>
          </div>
        </div>
      )}
    </div>
  );
}
