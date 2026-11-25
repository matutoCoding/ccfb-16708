import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../app/store';
import { runSafetyCheck, type EngineProgress } from '../../core/safety';
import { downloadBytes, exportMaskedIlda, exportReportJson } from '../../app/export';
import { useToast } from '../toast';
import type { IldaFile, SafetyReport, Violation } from '../../core/types';

export function SafetyPage() {
  const project = useStore(s => s.project)!;
  const getIlda = useStore(s => s.getIlda);
  const setReport = useStore(s => s.setReport);
  const report = useStore(s => s.report);
  const toast = useToast(s => s.show);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  const files = useMemo(() => new Map<string, IldaFile>(), []);

  const ensureFiles = async () => {
    for (const tr of project.timeline.tracks) for (const c of tr.clips) {
      if (!files.has(c.assetId)) {
        const f = await getIlda(c.assetId);
        if (f) files.set(c.assetId, f);
      }
    }
  };

  const run = async () => {
    setRunning(true);
    setProgress({ phase: '准备', percent: 0 });
    await ensureFiles();
    // 让进度条先绘制
    await new Promise(r => setTimeout(r, 30));
    try {
      const result = runSafetyCheck(project, files, p => setProgress(p));
      setReport(result);
      toast(result.violations.length === 0 ? '安全检查完成:未发现越界' : `安全检查完成:发现 ${result.violations.length} 段越界`,
        result.violations.length === 0 ? 'ok' : 'bad');
    } catch (e) {
      toast('检查失败:' + (e instanceof Error ? e.message : String(e)), 'bad');
    } finally {
      setRunning(false);
    }
  };

  const exportMasks = async () => {
    if (!report) return;
    const zip = await exportMaskedIlda(project, report);
    downloadBytes(zip, `${project.name}-masked-ilda.zip`, 'application/zip');
    toast('已导出带限区遮罩的 ILDA 文件', 'ok');
  };

  const exportReport = () => {
    if (!report) return;
    downloadBytes(exportReportJson(report), `${project.name}-safety-report.json`, 'application/json');
    toast('安全评估报告已导出', 'ok');
  };

  const maxRatio = report ? Math.max(0, ...Array.from(report.peakRatio)) : 0;

  return (
    <div>
      <h2 className="page-title">安全检查</h2>
      <p className="page-sub">
        按 IEC 60825-1:2014 对观众区所有网格点逐时间步评估(单脉冲 / 0.25s 平均 / 10s 长窗 / 多脉冲修正),
        任意点任意刻超标都会被标出
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <div style={{ flex: 2 }}>
            <div className="muted" style={{ fontSize: 13 }}>
              网格间距 {project.safety.gridSpacing}m · 时间步长 {project.safety.timeStepSec ?? '自适应(1/PPS)'}s ·
              MPE 告警比例 {project.safety.mpeFraction * 100}% · 遮罩外扩 {project.safety.maskMarginDeg}°
            </div>
            {running && progress && (
              <div className="progress-bar"><div style={{ width: `${progress.percent * 100}%` }} /></div>
            )}
          </div>
          <button className="primary" disabled={running} onClick={run} style={{ flex: 0 }}>
            {running ? '检查中…' : '▶ 跑完整节目安全检查'}
          </button>
        </div>
      </div>

      {report && <ReportSummary report={report} maxRatio={maxRatio} />}

      {report && (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="card" style={{ flex: 2 }}>
            <h3 style={{ marginTop: 0 }}>越界时间点清单({report.violations.length})</h3>
            <div className="scroll" style={{ maxHeight: 380 }}>
              <table>
                <thead><tr><th>起始 (s)</th><th>结束 (s)</th><th>激光器</th><th>位置 (m)</th><th>峰值 W/m²</th><th>超标倍数</th><th>判据</th></tr></thead>
                <tbody>
                  {report.violations.slice(0, 500).map((v, i) => (
                    <ViolationRow key={i} v={v} projectors={project.projectors.map(p => ({ id: p.id, name: p.name }))} />
                  ))}
                </tbody>
              </table>
              {report.violations.length > 500 && <p className="muted">仅显示前 500 条,完整数据见导出报告</p>}
            </div>
          </div>
          <div className="card" style={{ flex: 1 }}>
            <h3 style={{ marginTop: 0 }}>限区遮罩</h3>
            <p className="muted" style={{ fontSize: 12 }}>
              已为 {report.masks.length} 台激光器生成 {report.settings.maskRasterSize}×{report.settings.maskRasterSize} 角度遮罩栅格,
              违规方向自动置 blanking 并外扩 {report.settings.maskMarginDeg}°。
            </p>
            <MaskPreview report={report} />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={exportMasks}>导出带遮罩 ILDA</button>
              <button onClick={exportReport}>导出评估报告</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReportSummary({ report, maxRatio }: { report: SafetyReport; maxRatio: number }) {
  const danger = report.violations.length > 0;
  return (
    <div className="kpi">
      <div className={`item ${danger ? 'danger' : 'ok'}`}>
        <div className="v">{report.violations.length}</div><div className="k">越界区间数</div>
      </div>
      <div className="item"><div className="v">{report.cellCount}</div><div className="k">观众网格点</div></div>
      <div className="item"><div className="v">{report.totalSteps}</div><div className="k">评估时间步</div></div>
      <div className={`item ${maxRatio > 1 ? 'danger' : 'ok'}`}>
        <div className="v">{maxRatio.toFixed(2)}×</div><div className="k">最大超标比</div>
      </div>
      <div className="item"><div className="v">{report.maxIrradiance.toFixed(2)}</div><div className="k">峰值辐照度 W/m²</div></div>
    </div>
  );
}

function ViolationRow({ v, projectors }: { v: Violation; projectors: { id: string; name: string }[] }) {
  const name = projectors.find(p => p.id === v.projectorId)?.name ?? v.projectorId;
  const basisText = {
    'eye-single': '单脉冲', 'eye-average': '平均窗', 'eye-multipulse': '多脉冲', skin: '皮肤'
  }[v.basis];
  return (
    <tr className="violation-row" style={{ color: v.ratio > 1 ? undefined : undefined }}>
      <td className="mono">{v.timeSec.toFixed(4)}</td>
      <td className="mono">{v.endSec.toFixed(4)}</td>
      <td>{name}{v.contributorIds.length > 1 ? ` +${v.contributorIds.length - 1}` : ''}</td>
      <td className="mono muted">({v.point[0].toFixed(2)}, {v.point[1].toFixed(2)}, {v.point[2].toFixed(2)})</td>
      <td className="mono">{v.peakIrradiance.toFixed(2)}</td>
      <td style={{ color: 'var(--danger)', fontWeight: 600 }}>{v.ratio.toFixed(2)}×</td>
      <td><span className="tag warn">{basisText}</span></td>
    </tr>
  );
}

function MaskPreview({ report }: { report: SafetyReport }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const mask = report.masks[0];
    if (!mask) return;
    const n = mask.size;
    canvas.width = n; canvas.height = n;
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const blocked = mask.blocked[i] === 1;
      img.data[i * 4] = blocked ? 255 : 16;
      img.data[i * 4 + 1] = blocked ? 60 : 24;
      img.data[i * 4 + 2] = blocked ? 60 : 40;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [report]);
  return (
    <>
      <canvas ref={canvasRef} className="mask-canvas" />
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        红/亮区 = 禁止出光方向({report.masks[0] ? `${report.masks[0].azRange.map(a => (a * 180 / Math.PI).toFixed(1)).join('° ~ ')}° 方位角` : ''})
      </div>
    </>
  );
}
