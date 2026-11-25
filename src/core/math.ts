/**
 * 轻量三维数学库:vec3 与列主序 mat4,纯函数 + 可复用缓冲,
 * 同时供安全引擎(CPU)与渲染层使用。
 */
import type { Vec3 } from './types';

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]
};

export type Mat4 = Float32Array;

export function identity4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function rotationX(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  const m = identity4();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}
export function rotationY(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  const m = identity4();
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}
export function rotationZ(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  const m = identity4();
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}
export function translation4(t: Vec3): Mat4 {
  const m = identity4();
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

/** R = Rz(roll)·Ry(yaw)·Rx(pitch),再平移 */
export function compose(position: Vec3, orientation: Vec3): Mat4 {
  const r = multiply4(multiply4(rotationZ(orientation[2]), rotationY(orientation[0])), rotationX(orientation[1]));
  r[12] = position[0];
  r[13] = position[1];
  r[14] = position[2];
  return r;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

export function transformDir(m: Mat4, d: Vec3): Vec3 {
  return v3.norm([
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2]
  ]);
}

/** 透视投影(WebGL 兼容,无限远裁剪由渲染层处理) */
export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far * nf;
  m[11] = -1;
  m[14] = far * near * nf;
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = v3.norm(v3.sub(eye, target));
  const x = v3.norm(v3.cross(up, z));
  const y = v3.cross(z, x);
  const m = identity4();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -v3.dot(x, eye);
  m[13] = -v3.dot(y, eye);
  m[14] = -v3.dot(z, eye);
  return m;
}

/** 世界点在激光器本地系下的方位角/俯仰角(弧度) */
export function worldToLocalAngles(worldToLocal: Mat4, point: Vec3): { az: number; el: number } {
  const local = transformPoint(worldToLocal, point);
  return {
    az: Math.atan2(local[0], local[2]),
    el: Math.atan2(local[1], local[2])
  };
}
