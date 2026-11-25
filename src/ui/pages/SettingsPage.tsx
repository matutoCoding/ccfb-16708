import { useState } from 'react';
import { useStore } from '../../app/store';
import { downloadBytes, exportProjectZip } from '../../app/export';
import { useToast } from '../toast';
import { reimportSampleData } from '../sampleData';

export function SettingsPage() {
  const project = useStore(s => s.project)!;
  const update = useStore(s => s.updateProject);
  const flushSave = useStore(s => s.flushSave);
  const toast = useToast(s => s.show);
  const [exporting, setExporting] = useState(false);

  const set = (patch: Partial<typeof project.safety>) => update(p => Object.assign(p.safety, patch));

  const doExport = async () => {
    setExporting(true);
    try {
      await flushSave();
      const zip = await exportProjectZip(project);
      downloadBytes(zip, `${project.name}.lspkg`, 'application/zip');
      toast('工程包已导出(含全部素材)', 'ok');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <h2 className="page-title">设置</h2>
      <p className="page-sub">安全评估参数、工程数据与存储</p>

      <div className="card" style={{ marginBottom: 16, maxWidth: 720 }}>
        <h3 style={{ marginTop: 0 }}>安全评估参数(IEC 60825-1:2014,可见光 400–700nm)</h3>
        <div className="grid2">
          <div className="field">
            <label>观众区网格间距 (m)— 越小越精细、计算越慢</label>
            <input type="number" step="0.05" min="0.05" max="2" value={project.safety.gridSpacing}
              onChange={e => set({ gridSpacing: +e.target.value })} />
          </div>
          <div className="field">
            <label>MPE 告警比例(1.0 = 达到限值即报警;0.8 = 留 20% 余量)</label>
            <input type="number" step="0.05" min="0.1" max="1" value={project.safety.mpeFraction}
              onChange={e => set({ mpeFraction: +e.target.value })} />
          </div>
          <div className="field">
            <label>遮罩外扩余量 (度)</label>
            <input type="number" step="0.5" min="0" max="10" value={project.safety.maskMarginDeg}
              onChange={e => set({ maskMarginDeg: +e.target.value })} />
          </div>
          <div className="field">
            <label>遮罩角度栅格分辨率 (N×N)</label>
            <input type="number" step="20" min="60" max="480" value={project.safety.maskRasterSize}
              onChange={e => set({ maskRasterSize: +e.target.value })} />
          </div>
          <div className="field">
            <label>时间步长 (s),留空 = 自适应取最小 1/PPS</label>
            <input type="number" step="0.001" min="0.0001" placeholder="自适应"
              value={project.safety.timeStepSec ?? ''}
              onChange={e => set({ timeStepSec: e.target.value ? +e.target.value : undefined })} />
          </div>
          <div className="field">
            <label>同时评估皮肤照射限值</label>
            <select value={project.safety.checkSkin ? '1' : '0'}
              onChange={e => set({ checkSkin: e.target.value === '1' })}>
              <option value="0">否(仅眼睛 MPE)</option>
              <option value="1">是(眼睛 + 皮肤)</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, maxWidth: 720 }}>
        <h3 style={{ marginTop: 0 }}>工程数据</h3>
        <p className="muted">工程自动保存于浏览器 IndexedDB(库名 lss-db),关闭页面不丢失。打包导出为 .lspkg(zip)可备份或迁移。</p>
        <div className="row" style={{ maxWidth: 480 }}>
          <button className="primary" disabled={exporting} onClick={doExport}>
            {exporting ? '打包中…' : '打包导出工程 (.lspkg)'}
          </button>
          <button onClick={() => { void flushSave(); toast('已立即保存', 'ok'); }}>立即保存</button>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 720 }}>
        <h3 style={{ marginTop: 0 }}>示例素材</h3>
        <p className="muted">重新导入内置的 6 个 ILDA 图形与 60s 测试音频(已存在则追加一份)。</p>
        <button onClick={() => void reimportSampleData(toast)}>恢复示例素材</button>
      </div>

      <div className="card" style={{ maxWidth: 720, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>计算方法说明</h3>
        <ul className="muted" style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 18 }}>
          <li>光束:基模高斯,TEM00,1/e² 口径;w(z)=w₀√(1+(z/zR)²),瑞利长度 zR=πw₀²/λ</li>
          <li>人眼孔径平均:7mm 孔径,孔内功率 Pₐ=P(1−e^(−2a²/w²))</li>
          <li>眼 MPE(可见光):t≤0.25s 为 18·t^0.75 J/m²;0.25–10s 为 10·t^(1/3);t&gt;10s 恒 2.154 W/m²</li>
          <li>重复脉冲:单脉冲限值乘 n^(−1/4),n 为 0.25s 评定窗内离散驻留数</li>
          <li>完备性:观众区全网格 × 全时间步 × 全激光器功率叠加,锥剔除仅为性能优化且保守</li>
        </ul>
      </div>
    </div>
  );
}
