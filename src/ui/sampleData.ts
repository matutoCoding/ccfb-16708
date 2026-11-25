/**
 * 首次启动把 public/sample-data 里的测试素材导入 IndexedDB。
 * 用 localStorage 标记只导一次;已存在同名素材则跳过。
 */
import { db } from '../app/storage';
import { useStore } from '../app/store';

const FLAG = 'lss-sample-bootstrapped-v1';
const ILDA_FILES = ['circle.ild', 'square.ild', 'triangle.ild', 'spiral.ild', 'star.ild', 'beam-sweep.ild'];

export async function bootstrapSampleData(toast: (m: string, k?: 'info' | 'ok' | 'bad') => void): Promise<void> {
  if (localStorage.getItem(FLAG)) return;
  try {
    const store = useStore.getState();
    for (const name of ILDA_FILES) {
      const res = await fetch(`./sample-data/${name}`);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      await store.importAssetBytes(name, 'ilda', buf);
    }
    const wavRes = await fetch('./sample-data/show-audio.wav');
    if (wavRes.ok) {
      const wav = new Uint8Array(await wavRes.arrayBuffer());
      const peaksRes = await fetch('./sample-data/audio-peaks.json');
      let peaks: number[] | undefined;
      if (peaksRes.ok) peaks = (await peaksRes.json()).peaks;
      await store.importAssetBytes('show-audio.wav', 'audio', wav, peaks);
    }
    localStorage.setItem(FLAG, '1');
    toast('已导入示例素材:6 个 ILDA 图形 + 1 段 60s 音频', 'ok');
  } catch (e) {
    toast('示例素材导入失败:' + (e instanceof Error ? e.message : String(e)), 'bad');
  }
}

/** 供设置页"恢复示例素材"手动触发 */
export async function reimportSampleData(toast: (m: string, k?: 'info' | 'ok' | 'bad') => void) {
  localStorage.removeItem(FLAG);
  await bootstrapSampleData(toast);
  await db.listAssets();
}
