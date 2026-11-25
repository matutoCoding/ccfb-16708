/**
 * 振镜(galvo)动态模拟:速率受限跟随 + 二阶滞后 + 饱和闪烁。
 * 仅用于三维预演的失真可视化;安全引擎始终按指令角度评估(更保守、不漏检)。
 */
import type { BeamCommand } from './timeline';

export interface GalvoState {
  az: number;
  el: number;
  /** 实际角速度 */
  vz: number;
  vl: number;
  /** 0..1,饱和程度(用于闪烁亮度衰减) */
  saturation: number;
}

export function createGalvoState(): GalvoState {
  return { az: 0, el: 0, vz: 0, vl: 0, saturation: 0 };
}

/**
 * 一阶速率限制 + 临界阻尼二阶近似。
 * 当需求角速率超过 maxSlewRate,实际角度滞后 → 图形被拉伸/压缩(变形);
 * 持续饱和时输出亮度按饱和程度抖动衰减 → 现场看到的闪烁。
 */
export function stepGalvo(state: GalvoState, cmd: BeamCommand, maxSlewRate: number, dt: number): GalvoState {
  const w = 1 - Math.exp(-dt / 0.0008); // 振镜小信号时间常数 ~0.8ms
  const desiredVz = (cmd.az - state.az) / Math.max(dt, 1e-6);
  const desiredVl = (cmd.el - state.el) / Math.max(dt, 1e-6);
  let vz = state.vz + (desiredVz - state.vz) * w;
  let vl = state.vl + (desiredVl - state.vl) * w;

  const speed = Math.hypot(vz, vl);
  const sat = Math.min(1, Math.max(0, (speed - maxSlewRate * 0.9) / (maxSlewRate * 0.1)));
  if (speed > maxSlewRate) {
    const k = maxSlewRate / speed;
    vz *= k;
    vl *= k;
  }
  const az = state.az + vz * dt;
  const el = state.el + vl * dt;
  // 饱和状态缓慢累积、快速恢复
  const saturation = state.saturation + (sat - state.saturation) * (sat > state.saturation ? 0.5 : 0.08);
  return { az, el, vz, vl, saturation };
}

/** 闪烁因子:饱和越深亮度越低,叠加与点速率相关的抖动相位由渲染层传入 */
export function flickerFactor(state: GalvoState, jitter: number): number {
  const base = 1 - state.saturation * 0.75;
  return Math.max(0.08, base * (1 - state.saturation * 0.35 * jitter));
}
