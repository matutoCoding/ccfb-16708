/**
 * 光束物理与 IEC 60825-1:2014 照射量限值
 *
 * 光束模型:基模高斯光束(TEM00),1/e² 直径口径
 *   w(z) = w0·sqrt(1 + (z/zR)²),  zR = π·w0²/λ
 *   轴上辐照度 E(0,z) = 2P / (π·w(z)²)
 *   离轴 E(r,z) = E(0,z)·exp(-2r²/w²)
 * 安全侧采用精确高斯式(相比 NOHD 惯用的线性远场式 w0+θz,近场给出更高辐照度,更保守)。
 *
 * 人眼孔径平均:IEC 60825-1 可见光用 7 mm 孔径(半径 a=3.5mm),
 *   孔内功率 P_a = P·(1 - exp(-2a²/w²)),孔径平均辐照度 = P_a/(πa²)。
 *
 * MPE(400–700nm,点光源 α≤1.5mrad,眼):
 *   t ≤ 0.25s : H_MPE = 18·t^0.75 J/m²            (等效 E_MPE = 18·t^-0.25 W/m²)
 *   0.25<t≤10s: H_MPE = 10·t^(1/3) J/m²
 *   t > 10s   : E_MPE = 2.154 W/m² 常量(与上一档在 t=10 连续)
 * 重复脉冲修正(热效应,视网膜):单脉冲限值乘 n^-1/4,n = 评定窗内脉冲数。
 * 皮肤限值(可选,400–700nm):
 *   t ≤ 10s : H_MPE = 2000·t^0.25 J/m²; t>10s : E_MPE = 1000 W/m²
 */

export const APERTURE_RADIUS_M = 0.0035; // 7 mm 人眼孔径
export const AVERSION_TIME_S = 0.25;
export const LONG_WINDOW_S = 10;

/** 瑞利长度 zR (m) */
export function rayleighRange(w0: number, wavelengthNm: number): number {
  const lambda = wavelengthNm * 1e-9;
  return (Math.PI * w0 * w0) / lambda;
}

/** 高斯光束在传播距离 z 处的 1/e² 半径 (m) */
export function beamRadius(w0: number, wavelengthNm: number, z: number): number {
  const zR = rayleighRange(w0, wavelengthNm);
  return w0 * Math.sqrt(1 + (z / zR) * (z / zR));
}

/** 远场半发散角 (rad),与高斯式自洽:θ = λ/(π·w0) */
export function halfDivergence(w0: number, wavelengthNm: number): number {
  const lambda = wavelengthNm * 1e-9;
  return lambda / (Math.PI * w0);
}

/**
 * 目标点处的孔径平均辐照度 (W/m²)。
 * @param P 光束总功率 W
 * @param w0 束腰 1/e² 半径 m
 * @param wavelengthNm 波长
 * @param z 沿光束传播距离 m(<=0 返回 0)
 * @param r 目标点到光束轴的垂直距离 m
 */
export function irradianceAt(P: number, w0: number, wavelengthNm: number, z: number, r: number): number {
  if (z <= 0 || P <= 0) return 0;
  const w = beamRadius(w0, wavelengthNm, z);
  // 轴上:7mm 孔径平均
  const pAperture = P * (1 - Math.exp((-2 * APERTURE_RADIUS_M * APERTURE_RADIUS_M) / (w * w)));
  const eOnAxis = pAperture / (Math.PI * APERTURE_RADIUS_M * APERTURE_RADIUS_M);
  // 离轴按高斯包络衰减
  return eOnAxis * Math.exp((-2 * r * r) / (w * w));
}

/** 给定激光器出光口径直径(mm)与全发散角(mrad),反推束腰半径 m(按远场自洽) */
export function waistFromSpec(beamDiameterMm: number, divergenceFullMrad: number, wavelengthNm: number): number {
  const lambda = wavelengthNm * 1e-9;
  const thetaHalf = (divergenceFullMrad * 1e-3) / 2;
  // θ = λ/(π w0) → w0 = λ/(π θ)
  return lambda / (Math.PI * thetaHalf);
}

/** 眼 MPE:能量密度限值 H (J/m²),曝光时间 t 秒,可见光 */
export function eyeMpeEnergy(t: number): number {
  if (t <= 0) throw new Error('曝光时间必须为正');
  if (t <= AVERSION_TIME_S) {
    return 18 * Math.pow(t, 0.75);
  }
  if (t <= LONG_WINDOW_S) {
    return 10 * Math.cbrt(t);
  }
  // t>10: 恒辐照度 2.154 W/m² → H = 2.154·t
  return 2.154 * t;
}

/** 眼 MPE:等效平均辐照度限值 E (W/m²) */
export function eyeMpeIrradiance(t: number): number {
  return eyeMpeEnergy(t) / t;
}

/** 重复脉冲修正系数 n^-1/4 */
export function multipulseFactor(n: number): number {
  return n <= 1 ? 1 : Math.pow(n, -0.25);
}

/** 皮肤 MPE 能量密度 (J/m²) */
export function skinMpeEnergy(t: number): number {
  if (t <= LONG_WINDOW_S) return 2000 * Math.pow(t, 0.25);
  return 1000 * t;
}

export function assertVisible(wavelengthNm: number): void {
  if (wavelengthNm < 400 || wavelengthNm > 700) {
    throw new Error(`MPE 表仅覆盖可见光 400–700nm,收到 ${wavelengthNm}nm`);
  }
}

/**
 * 射线(段)到点的几何关系。
 * @returns z 沿射线距离(负表示点在出光口后方),r 垂直距离
 */
export function rayGeometry(origin: ArrayLike<number>, dir: ArrayLike<number>, point: ArrayLike<number>): { z: number; r: number } {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const z = dx * dir[0] + dy * dir[1] + dz * dir[2];
  const px = dx - z * dir[0];
  const py = dy - z * dir[1];
  const pz = dz - z * dir[2];
  return { z, r: Math.hypot(px, py, pz) };
}
