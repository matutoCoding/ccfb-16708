import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../app/store';
import { SceneRenderer } from '../../render/scene3d';
import { PlaybackEngine } from '../../app/playback';
import type { IldaFile } from '../../core/types';

export function Preview3DPage() {
  const project = useStore(s => s.project)!;
  const getIlda = useStore(s => s.getIlda);
  const report = useStore(s => s.report);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneRenderer | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [showHeat, setShowHeat] = useState(true);
  const [smokeOn, setSmokeOn] = useState(true);
  const [galvoOn, setGalvoOn] = useState(true);
  const [webglError, setWebglError] = useState('');

  // 素材映射
  const files = useMemo(() => new Map<string, IldaFile>(), []);
  useEffect(() => {
    void (async () => {
      for (const tr of project.timeline.tracks) {
        for (const c of tr.clips) {
          if (!files.has(c.assetId)) {
            const f = await getIlda(c.assetId);
            if (f) files.set(c.assetId, f);
          }
        }
      }
    })();
  }, [project, getIlda, files]);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const scene = new SceneRenderer(canvasRef.current);
      const engine = new PlaybackEngine(scene);
      sceneRef.current = scene;
      engineRef.current = engine;
      const detach = scene.attachControls(canvasRef.current, () => draw());
      engine.onTime = t => setTime(t);
      const draw = () => {
        const viewProject = smokeOn ? project : { ...project, smokeZones: [] };
        const beams = engine.renderFrame(viewProject, files, 1 / 60);
        scene.render(viewProject, beams, showHeat ? report : null);
      };
      draw();
      let raf = 0;
      const tick = () => { draw(); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      return () => { cancelAnimationFrame(raf); detach(); engine.pause(); };
    } catch (e) {
      setWebglError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选项变化时重绘
  useEffect(() => {
    const scene = sceneRef.current, engine = engineRef.current;
    if (!scene || !engine) return;
    const viewProject = smokeOn ? project : { ...project, smokeZones: [] };
    const beams = engine.renderFrame(viewProject, files, 1 / 60);
    scene.render(viewProject, beams, showHeat ? report : null);
  }, [project, report, showHeat, smokeOn, files]);

  // galvo 开关接入播放引擎
  useEffect(() => {
    if (engineRef.current) engineRef.current.galvoEnabled = galvoOn;
  }, [galvoOn]);

  const togglePlay = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.playing) { engine.pause(); setPlaying(false); }
    else {
      if (engine.time >= project.timeline.durationSec) engine.time = 0;
      engine.start(project, files);
      setPlaying(true);
    }
  };

  const seek = (t: number) => {
    engineRef.current?.seek(t, project, files);
    setTime(t);
  };

  return (
    <div>
      <h2 className="page-title">三维预演</h2>
      <p className="page-sub">光束在烟雾中按散射系数显形(浓烟区更亮);扫描速度跟不上时图形变形、饱和闪烁</p>

      {webglError ? (
        <div className="card" style={{ color: 'var(--danger)' }}>WebGL2 初始化失败:{webglError}</div>
      ) : (
        <>
          <div className="canvas-wrap">
            <canvas ref={canvasRef} />
            <div className="hud">
              <div><span className="b">{project.projectors.length}</span> 台激光器 · <span className="b">{project.timeline.tracks.length}</span> 条轨道</div>
              <div style={{ marginTop: 4 }}>烟雾分区 {project.smokeZones.length} 个 · 观众格 {report?.cellCount ?? 0}</div>
              {report && <div style={{ marginTop: 4, color: report.violations.length ? 'var(--danger)' : 'var(--accent-2)' }}>
                {report.violations.length ? `检测到 ${report.violations.length} 段越界` : '当前无越界记录'}
              </div>}
            </div>
          </div>

          <div className="transport">
            <button className="primary" onClick={togglePlay}>{playing ? '⏸ 暂停' : '▶ 播放'}</button>
            <button onClick={() => { engineRef.current?.stop(project, files); setPlaying(false); setTime(0); }}>⏹ 停止</button>
            <span className="time mono">{time.toFixed(2)}s / {project.timeline.durationSec.toFixed(1)}s</span>
            <input type="range" min="0" max={project.timeline.durationSec} step="0.01" value={time}
              onChange={e => seek(+e.target.value)} style={{ flex: 1 }} />
            <label className="tag" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={smokeOn} onChange={e => setSmokeOn(e.target.checked)} /> 烟雾
            </label>
            <label className="tag" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={galvoOn} onChange={e => setGalvoOn(e.target.checked)} /> 振镜失真
            </label>
            <label className="tag" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={showHeat} onChange={e => setShowHeat(e.target.checked)} /> 安全热力图
            </label>
          </div>

          <div className="legend">
            <span style={{ color: '#6bb4ff' }}>舞台范围</span>
            <span style={{ color: '#ffbf4d' }}>观众区</span>
            <span style={{ color: '#8ce0c8' }}>安全格点(绿=合格)</span>
            <span style={{ color: '#ff4d4d' }}>超标格点(红)</span>
            <span className="muted">拖拽旋转视角 · 滚轮缩放</span>
          </div>
        </>
      )}
    </div>
  );
}
