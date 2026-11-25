import { describe, it, expect } from 'vitest';
import {
  APERTURE_RADIUS_M, assertVisible, beamRadius, eyeMpeEnergy, eyeMpeIrradiance,
  halfDivergence, irradianceAt, multipulseFactor, rayGeometry, skinMpeEnergy, waistFromSpec
} from '../src/core/physics';

/**
 * 手算对照(工况 A:532nm, P=5W, 出射直径 5mm, 全发散 1mrad)
 * 束腰 w0 = λ/(π·θ_半) = 532e-9/(π·0.0005) = 3.3868e-4 m
 * 瑞利长度 zR = π·w0²/λ ≈ 0.6774 m
 * w(z) = w0·sqrt(1+(z/zR)²)
 * 孔径(7mm,a=0.0035)平均:E = P·(1-exp(-2a²/w²))/(π·a²)
 */
describe('物理内核 — 手算对照', () => {
  const lambda = 532;
  const P = 5;
  const w0 = waistFromSpec(5, 1, lambda);

  it('束腰半径与发散角自洽 (手算 3.3868e-4 m)', () => {
    const expected = 532e-9 / (Math.PI * 0.0005);
    expect(w0).toBeCloseTo(expected, 10);
    expect(relativeError(w0, 3.3868e-4)).toBeLessThan(0.002);
    expect(halfDivergence(w0, lambda)).toBeCloseTo(0.0005, 10);
  });

  it('z=30m:w=15.004mm, 捕获系数 0.10312, 轴上 E=13398 W/m²', () => {
    // 手算: w=3.3868e-4·sqrt(1+(30/0.6774)²)=0.015004
    //       cap=1-exp(-2·0.0035²/0.015004²)=0.10312
    //       E=5·0.10312/(π·0.0035²)=13398
    const w = beamRadius(w0, lambda, 30);
    expect(relativeError(w, 0.015004)).toBeLessThan(0.002);
    const cap = 1 - Math.exp((-2 * APERTURE_RADIUS_M * APERTURE_RADIUS_M) / (w * w));
    expect(relativeError(cap, 0.10312)).toBeLessThan(0.002);
    const expected = (P * cap) / (Math.PI * APERTURE_RADIUS_M * APERTURE_RADIUS_M);
    const got = irradianceAt(P, w0, lambda, 30, 0);
    expect(relativeError(got, expected)).toBeLessThan(1e-12);
    expect(relativeError(got, 13398)).toBeLessThan(0.002);
  });

  it('z=10m:w=5.0115mm, cap=0.62301, 轴上 E=80942 W/m²', () => {
    const w = beamRadius(w0, lambda, 10);
    expect(relativeError(w, 0.0050115)).toBeLessThan(0.002);
    const cap = 1 - Math.exp((-2 * APERTURE_RADIUS_M * APERTURE_RADIUS_M) / (w * w));
    expect(relativeError(cap, 0.62301)).toBeLessThan(0.002);
    const got = irradianceAt(P, w0, lambda, 10, 0);
    expect(relativeError(got, 80942)).toBeLessThan(0.002);
  });

  it('z=30m 离轴 r=10mm:高斯包络 exp(-0.8884)=0.41130', () => {
    // 手算: -2·0.01²/0.015004² = -0.8884 → exp = 0.41130
    const onAxis = irradianceAt(P, w0, lambda, 30, 0);
    const got = irradianceAt(P, w0, lambda, 30, 0.01);
    expect(relativeError(got / onAxis, 0.41130)).toBeLessThan(0.002);
    expect(relativeError(got, 0.41130 * 13398)).toBeLessThan(0.002);
  });

  it('出光口后方/零功率返回 0', () => {
    expect(irradianceAt(P, w0, lambda, 0, 0)).toBe(0);
    expect(irradianceAt(0, w0, lambda, 30, 0)).toBe(0);
  });

  it('射线几何 z/r(手算)', () => {
    const g = rayGeometry([0, 0, 0], [0, 0, 1], [0.6, 0, 30]);
    expect(g.z).toBeCloseTo(30, 10);
    expect(g.r).toBeCloseTo(0.6, 10);
  });
});

describe('MPE 限值 — 手算对照', () => {
  it('t=50µs 单脉冲:18·t^0.75 (手算 1.0703e-2 J/m²)', () => {
    // 手算: (5e-5)^0.75 = 5.946e-4; ×18 = 1.0703e-2
    const t = 5e-5;
    const expected = 18 * Math.pow(t, 0.75);
    expect(relativeError(eyeMpeEnergy(t), expected)).toBeLessThan(1e-12);
    expect(relativeError(eyeMpeEnergy(t), 1.0703e-2)).toBeLessThan(0.002);
  });

  it('t=0.25s:H=6.364 J/m², 等效 E=25.456 W/m²', () => {
    const H = 18 * Math.pow(0.25, 0.75);
    expect(relativeError(eyeMpeEnergy(0.25), H)).toBeLessThan(1e-12);
    expect(relativeError(eyeMpeIrradiance(0.25), 25.456)).toBeLessThan(0.002);
  });

  it('t=1s:10·t^(1/3)=10 J/m² (手算)', () => {
    expect(relativeError(eyeMpeEnergy(1), 10)).toBeLessThan(1e-12);
  });

  it('t=10s 与长窗常量 2.154 W/m² 连续,t>10 保持 2.154', () => {
    expect(relativeError(eyeMpeIrradiance(10), 2.15443)).toBeLessThan(0.002);
    expect(eyeMpeIrradiance(30)).toBeCloseTo(2.154, 6);
  });

  it('多脉冲修正 n=5000:n^-1/4 (手算 0.11892)', () => {
    const expected = Math.pow(5000, -0.25);
    expect(relativeError(multipulseFactor(5000), expected)).toBeLessThan(1e-12);
    expect(relativeError(multipulseFactor(5000), 0.11892)).toBeLessThan(0.002);
  });

  it('皮肤限值 t=1s:2000 J/m²;长时 1000 W/m²', () => {
    expect(relativeError(skinMpeEnergy(1), 2000)).toBeLessThan(1e-12);
    expect(skinMpeEnergy(20) / 20).toBeCloseTo(1000, 8);
  });

  it('非可见光拒绝评估', () => {
    expect(() => assertVisible(808)).toThrow();
    expect(() => assertVisible(532)).not.toThrow();
  });
});

function relativeError(got: number, expected: number): number {
  return Math.abs(got - expected) / Math.abs(expected);
}
