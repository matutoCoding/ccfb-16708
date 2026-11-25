import { useState } from 'react';
import { useStore, uid } from '../../app/store';
import { useToast } from '../toast';
import type { Box3, Projector, Vec3 } from '../../core/types';

type Tab = 'boxes' | 'projectors';

export function VenuePage() {
  const project = useStore(s => s.project)!;
  const update = useStore(s => s.updateProject);
  const [tab, setTab] = useState<Tab>('boxes');
  const toast = useToast(s => s.show);

  const vecInput = (label: string, value: Vec3, onChange: (v: Vec3) => void) => (
    <div className="field">
      <label>{label} (m) — X / Y / Z</label>
      <div className="row">
        {value.map((v, i) => (
          <input key={i} type="number" step="0.1" value={v}
            onChange={e => { const nv = [...value] as Vec3; nv[i] = +e.target.value; onChange(nv); }} />
        ))}
      </div>
    </div>
  );

  const BoxEditor = ({ box, kind, onDelete }: { box: Box3; kind: 'stage' | 'audience' | 'smoke'; onDelete?: () => void }) => (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 2 }}>
          <label>名称</label>
          <input value={box.name} onChange={e => update(p => {
            const list = kind === 'stage' ? p.stageBoxes : kind === 'audience' ? p.audienceBoxes : p.smokeZones;
            list.find(b => b.id === box.id)!.name = e.target.value;
          })} />
        </div>
        {onDelete && <button className="danger" style={{ flex: 0 }} onClick={onDelete}>删除</button>}
      </div>
      {vecInput('最小角点', box.min, v => update(p => {
        const list = kind === 'stage' ? p.stageBoxes : kind === 'audience' ? p.audienceBoxes : p.smokeZones;
        list.find(b => b.id === box.id)!.min = v;
      }))}
      {vecInput('最大角点', box.max, v => update(p => {
        const list = kind === 'stage' ? p.stageBoxes : kind === 'audience' ? p.audienceBoxes : p.smokeZones;
        list.find(b => b.id === box.id)!.max = v;
      }))}
      {kind === 'smoke' && (
        <div className="field">
          <label>烟雾体积散射系数 σs (1/m):薄烟约 0.02,浓烟约 0.06</label>
          <input type="number" step="0.005" min="0" max="0.3" value={box.scatter ?? 0}
            onChange={e => update(p => { p.smokeZones.find(b => b.id === box.id)!.scatter = +e.target.value; })} />
        </div>
      )}
    </div>
  );

  const addBox = (kind: 'stage' | 'audience' | 'smoke') => update(p => {
    const box: Box3 = {
      id: uid('box'), name: kind === 'stage' ? '新舞台' : kind === 'audience' ? '新观众区' : '新烟雾区',
      min: [0, 0, 0], max: [4, 4, 4], ...(kind === 'smoke' ? { scatter: 0.03 } : {})
    };
    if (kind === 'stage') p.stageBoxes.push(box);
    else if (kind === 'audience') p.audienceBoxes.push(box);
    else p.smokeZones.push(box);
  });

  const ProjectorEditor = ({ pr }: { pr: Projector }) => {
    const set = (patch: Partial<Projector>) => update(p => {
      Object.assign(p.projectors.find(x => x.id === pr.id)!, patch);
    });
    const num = (label: string, key: keyof Projector, step = 1, suffix = '') => (
      <div className="field">
        <label>{label}{suffix}</label>
        <input type="number" step={step} value={pr[key] as number}
          onChange={e => set({ [key]: +e.target.value } as Partial<Projector>)} />
      </div>
    );
    return (
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2 }}>
            <label>激光器名称</label>
            <input value={pr.name} onChange={e => set({ name: e.target.value })} />
          </div>
          <button className="danger" style={{ flex: 0 }}
            onClick={() => update(p => { p.projectors = p.projectors.filter(x => x.id !== pr.id); })}>删除</button>
        </div>
        {vecInput('出光口位置 (m)', pr.position, v => set({ position: v }))}
        <div className="field">
          <label>朝向 偏航/俯仰/横滚 (度)</label>
          <div className="row">
            {pr.orientation.map((v, i) => (
              <input key={i} type="number" step="0.5" value={+(v * 180 / Math.PI).toFixed(2)}
                onChange={e => {
                  const nv = [...pr.orientation] as Vec3;
                  nv[i] = +e.target.value * Math.PI / 180;
                  set({ orientation: nv });
                }} />
            ))}
          </div>
        </div>
        <div className="grid3">
          {num('水平全扫描角', 'scanAngleH', 1, ' (度)')}
          {num('垂直全扫描角', 'scanAngleV', 1, ' (度)')}
          {num('额定功率', 'power', 0.1, ' (W)')}
        </div>
        <div className="grid3">
          {num('光束直径', 'beamDiameter', 0.1, ' (mm)')}
          {num('全发散角', 'divergence', 0.1, ' (mrad)')}
          {num('波长', 'wavelength', 1, ' (nm)')}
        </div>
        <div className="grid3">
          {num('点速率 PPS', 'pps', 1000)}
          {num('振镜最大角速率', 'maxSlewRate', 1, ' (rad/s)')}
        </div>
      </div>
    );
  };

  return (
    <div>
      <h2 className="page-title">场地与设备</h2>
      <p className="page-sub">录入舞台/观众区三维范围、烟雾浓度分区,以及每台激光器的位置、朝向、扫描角与光束规格</p>
      <div className="row" style={{ maxWidth: 360, marginBottom: 16 }}>
        <button className={tab === 'boxes' ? 'primary' : ''} onClick={() => setTab('boxes')}>场地范围 / 烟雾</button>
        <button className={tab === 'projectors' ? 'primary' : ''} onClick={() => setTab('projectors')}>
          激光器 ({project.projectors.length})
        </button>
      </div>

      {tab === 'boxes' && (
        <>
          <h3>舞台范围</h3>
          {project.stageBoxes.map(b => <BoxEditor key={b.id} box={b} kind="stage"
            onDelete={() => update(p => { p.stageBoxes = p.stageBoxes.filter(x => x.id !== b.id); })} />)}
          <button onClick={() => addBox('stage')}>＋ 添加舞台范围</button>
          <h3 style={{ marginTop: 22 }}>观众区范围(安全评估采样区域)</h3>
          {project.audienceBoxes.map(b => <BoxEditor key={b.id} box={b} kind="audience"
            onDelete={() => update(p => { p.audienceBoxes = p.audienceBoxes.filter(x => x.id !== b.id); })} />)}
          <button onClick={() => addBox('audience')}>＋ 添加观众区</button>
          <h3 style={{ marginTop: 22 }}>烟雾浓度分区</h3>
          {project.smokeZones.map(b => <BoxEditor key={b.id} box={b} kind="smoke"
            onDelete={() => update(p => { p.smokeZones = p.smokeZones.filter(x => x.id !== b.id); })} />)}
          <button onClick={() => addBox('smoke')}>＋ 添加烟雾分区</button>
        </>
      )}

      {tab === 'projectors' && (
        <>
          {project.projectors.map(pr => <ProjectorEditor key={pr.id} pr={pr} />)}
          <button onClick={() => update(p => {
            p.projectors.push({
              id: uid('prjtr'), name: `激光器-${p.projectors.length + 1}`,
              position: [0, 5, 0], orientation: [0, 0, 0],
              scanAngleH: 40, scanAngleV: 30, beamDiameter: 5, divergence: 1,
              power: 3, wavelength: 532, pps: 20000, maxSlewRate: 40, color: [0.3, 1, 0.4]
            });
            toast('已添加激光器');
          })}>＋ 添加激光器</button>
        </>
      )}
    </div>
  );
}
