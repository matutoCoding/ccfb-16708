/**
 * 全局领域模型与类型定义
 *
 * 坐标约定:
 *  - 世界坐标:右手系,Y 轴向上,单位米;舞台中心通常在原点
 *  - 激光器本地系:光束前向 = +Z,上 = +Y,右 = +X
 *  - ILDA 归一化坐标 nx,ny ∈ [-1,1],映射到 ±半扫描角
 *  - 所有角度在计算中使用弧度,UI 层使用度
 */

export type Vec3 = [number, number, number];

/** 轴对齐三维箱体(舞台/观众区/烟雾分区共用) */
export interface Box3 {
  id: string;
  name: string;
  min: Vec3;
  max: Vec3;
  /** 烟雾区专用:体积散射系数 σs (1/m),0 表示无烟 */
  scatter?: number;
}

export type VenueObjectKind = 'stage' | 'audience' | 'smoke';

/** 激光器规格与位姿 */
export interface Projector {
  id: string;
  name: string;
  /** 出光口位置 (m) */
  position: Vec3;
  /** 欧拉角 yaw/pitch/roll (弧度),旋转矩阵 R = Rz(roll)·Ry(yaw)·Rx(pitch) */
  orientation: Vec3;
  /** 水平全扫描角 (度) */
  scanAngleH: number;
  /** 垂直全扫描角 (度) */
  scanAngleV: number;
  /** 出射光束直径 (mm,1/e²) */
  beamDiameter: number;
  /** 全角发散角 (mrad,1/e²,行业手册惯例为全角) */
  divergence: number;
  /** 额定光功率 (W) */
  power: number;
  /** 主波长 (nm),用于 MPE 查表 */
  wavelength: number;
  /** 输出点速率 PPS */
  pps: number;
  /** 振镜最大角速率 (rad/s),决定跟速失真 */
  maxSlewRate: number;
  /** 显示颜色 (sRGB 0..1) */
  color: Vec3;
}

/** ILDA 点:坐标为 ILDA 原始 16bit 范围,status 为 ILDA 状态位 */
export interface IldaPoint {
  x: number; // -32768..32767
  y: number;
  z: number;
  status: number; // bit6=blanking(1=灭光)
  r: number; // 0..255
  g: number;
  b: number;
}

export interface IldaFrame {
  name: string;
  company?: string;
  points: IldaPoint[];
}

export interface IldaFile {
  format: 0 | 1 | 4 | 5;
  frames: IldaFrame[];
  /** 解析时发现的问题(非致命) */
  warnings: string[];
}

export type AssetKind = 'ilda' | 'audio';

export interface AssetMeta {
  id: string;
  kind: AssetKind;
  name: string;
  importedAt: number;
  /** ILDA:每帧建议播放帧率;音频:采样率 */
  frameRate?: number;
  durationSec?: number;
  /** ILDA 帧数 / 音频保留空 */
  frameCount?: number;
  /** 音频波形峰值包络(归一化 0..1),时间线画波形用 */
  peaks?: number[];
  /** 解析失败的坏文件标记 */
  broken?: boolean;
  error?: string;
  sizeBytes: number;
}

export interface Clip {
  id: string;
  assetId: string;
  /** 时间线上的起始时刻 (s) */
  start: number;
  /** 时间线持续时长 (s) */
  duration: number;
  /** 源素材入点 (s) */
  inPoint: number;
  /** 变速倍率,>1 加速 */
  rate: number;
  /** 静音/灭光(本片段不输出) */
  muted: boolean;
}

export interface Track {
  id: string;
  /** 绑定的激光器 id */
  projectorId: string;
  clips: Clip[];
}

export interface Timeline {
  durationSec: number;
  tracks: Track[];
}

/** 安全标准参数(IEC 60825-1:2014,可见光 400–700nm) */
export interface SafetySettings {
  /** 告警阈值占 MPE 的比例,1 = 达到 MPE 即报警,0.8 = 留 20% 余量 */
  mpeFraction: number;
  /** 观众区采样网格间距 (m) */
  gridSpacing: number;
  /** 遮罩在违规方向外扩的角度余量 (度) */
  maskMarginDeg: number;
  /** 遮罩角度栅格分辨率(每扫描角的格数) */
  maskRasterSize: number;
  /** 安全评估时间步长 (s),缺省按各激光器 1/pps 取最小值 */
  timeStepSec?: number;
  /** 是否同时评估皮肤照射限值 */
  checkSkin: boolean;
}

export interface MaskRaster {
  projectorId: string;
  /** 栅格格数 N×N */
  size: number;
  /** 栅格覆盖的方位角范围 [azMin,azMax] (弧度,激光器本地系) */
  azRange: [number, number];
  elRange: [number, number];
  /** 长度 size*size,true = 遮罩(禁止出光) */
  blocked: Uint8Array;
}

export interface Violation {
  /** 首次越界时刻 (s) */
  timeSec: number;
  /** 越界持续区间结束 (s) */
  endSec: number;
  projectorId: string;
  /** 多机叠加时参与的激光器 */
  contributorIds: string[];
  /** 观众区网格点 (m,世界坐标) */
  point: Vec3;
  cellId: number;
  /** 峰值辐照度 W/m² */
  peakIrradiance: number;
  /** 对应限值 W/m²(等效辐照度) */
  mpeIrradiance: number;
  /** 超标倍数 */
  ratio: number;
  basis: 'eye-single' | 'eye-average' | 'eye-multipulse' | 'skin';
}

export interface SafetyReport {
  ranAt: number;
  durationSec: number;
  timeStepSec: number;
  cellCount: number;
  totalSteps: number;
  violations: Violation[];
  /** 每个观众网格点的峰值超标比(0..N),用于热力图 */
  peakRatio: Float32Array;
  cellCenters: Float32Array; // vec3 数组
  settings: SafetySettings;
  masks: MaskRaster[];
  /** 全场最大辐照度 W/m² */
  maxIrradiance: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  stageBoxes: Box3[];
  audienceBoxes: Box3[];
  smokeZones: Box3[];
  projectors: Projector[];
  timeline: Timeline;
  safety: SafetySettings;
}

export const DEFAULT_SAFETY: SafetySettings = {
  mpeFraction: 1.0,
  gridSpacing: 0.25,
  maskMarginDeg: 1.5,
  maskRasterSize: 240,
  checkSkin: false
};
