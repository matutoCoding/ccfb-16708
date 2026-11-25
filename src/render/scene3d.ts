/**
 * WebGL2 三维场景渲染器。
 * 光束:沿射线方向的多段加色线段,亮度随路径烟雾散射积分增强(浓处亮),
 *       galvo 饱和时按 flicker 因子衰减并注入抖动 → 变形闪烁。
 * 烟雾:半透明体积箱。安全热力图:观众格点超标比着色。
 */
import { lookAt, perspective, v3, type Mat4 } from '../core/math';
import type { Box3, Project, SafetyReport, Vec3 } from '../core/types';
import { HEAT_FS, HEAT_VS, PREVIEW_FS, PREVIEW_VS, SCENE_FS, SCENE_VS, SMOKE_FS, SMOKE_VS } from './shaders';

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function uniformLoc(gl: WebGL2RenderingContext, p: WebGLProgram, name: string) {
  return gl.getUniformLocation(p, name);
}

/** 线段几何的可复用顶点缓冲(pos3 + color3 + alpha1) */
class LineMesh {
  private vbo: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private capacity: number;
  count = 0;
  constructor(private gl: WebGL2RenderingContext, capacity = 1 << 16) {
    this.capacity = capacity;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * 7 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);
  }
  upload(data: Float32Array) {
    const gl = this.gl;
    if (data.length > this.capacity * 7) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      this.capacity = data.length / 7;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    this.count = data.length / 7;
  }
  draw(mode: number) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(mode, 0, this.count);
    gl.bindVertexArray(null);
  }
}

export interface BeamRenderData {
  origin: Vec3;
  direction: Vec3;
  color: Vec3;
  /** 0..1 闪烁/功率因子 */
  flicker: number;
  /** 烟雾散射积分(沿线累积 σs),由场景查询给出 */
  scatterIntegral: number;
  /** 扫描饱和导致的角向抖动 (rad) */
  jitter: number;
}

export class SceneRenderer {
  private gl: WebGL2RenderingContext;
  private sceneProg: WebGLProgram;
  private smokeProg: WebGLProgram;
  private heatProg: WebGLProgram;
  private beamMesh: LineMesh;
  private boxMesh: LineMesh;
  private smokeVao: WebGLVertexArrayObject;
  private heatVao: WebGLVertexArrayObject;
  private heatVbo: WebGLBuffer;
  private heatRatioVbo: WebGLBuffer;
  camera = { target: [0, 3, 14] as Vec3, yaw: 0.6, pitch: 0.35, dist: 42 };

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.sceneProg = program(gl, SCENE_VS, SCENE_FS);
    this.smokeProg = program(gl, SMOKE_VS, SMOKE_FS);
    this.heatProg = program(gl, HEAT_VS, HEAT_FS);
    this.beamMesh = new LineMesh(gl, 1 << 15);
    this.boxMesh = new LineMesh(gl, 1 << 14);
    this.smokeVao = this.makeCubeVao();
    this.heatVao = gl.createVertexArray()!;
    this.heatVbo = gl.createBuffer()!;
    this.heatRatioVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.heatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatRatioVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private makeCubeVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const v = new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
    ]);
    const idx = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    const ibo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return vao;
  }

  resize() {
    const c = this.gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(c.clientWidth * dpr), h = Math.floor(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.gl.viewport(0, 0, c.width, c.height);
  }

  private viewProj(): Mat4 {
    const { target, yaw, pitch, dist } = this.camera;
    const eye: Vec3 = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw)
    ];
    const view = lookAt(eye, target, [0, 1, 0]);
    const aspect = (this.gl.canvas as HTMLCanvasElement).width / (this.gl.canvas as HTMLCanvasElement).height;
    return multiply(perspective((50 * Math.PI) / 180, aspect, 0.1, 400), view);
  }

  /** 查询某光束沿线上的烟雾散射积分(分段采样各烟雾箱) */
  static scatterAlong(project: Project, origin: Vec3, dir: Vec3, length: number): number {
    let integral = 0;
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * length;
      const p = v3.add(origin, v3.scale(dir, t));
      let s = 0;
      for (const z of project.smokeZones) {
        if (z.scatter && inside(p, z)) s = Math.max(s, z.scatter);
      }
      integral += s * (length / steps);
    }
    return integral;
  }

  render(project: Project, beams: BeamRenderData[], report: SafetyReport | null, beamLength = 60) {
    const gl = this.gl;
    this.resize();
    gl.clearColor(0.02, 0.025, 0.035, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = this.viewProj();

    // 1) 烟雾箱(半透明,先画)
    gl.useProgram(this.smokeProg);
    gl.uniformMatrix4fv(uniformLoc(gl, this.smokeProg, 'uViewProj'), false, vp);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.smokeVao);
    for (const z of project.smokeZones) {
      const center = v3.scale(v3.add(z.min, z.max), 0.5);
      const half = v3.scale(v3.sub(z.max, z.min), 0.5);
      const model = scaleTranslate(half, center);
      gl.uniformMatrix4fv(uniformLoc(gl, this.smokeProg, 'uModel'), false, model);
      gl.uniform1f(uniformLoc(gl, this.smokeProg, 'uScatter'), z.scatter ?? 0);
      gl.uniform3f(uniformLoc(gl, this.smokeProg, 'uTint'), 0.55, 0.6, 0.7);
      gl.drawElements(gl.LINES, 24, gl.UNSIGNED_SHORT, 0);
    }
    gl.depthMask(true);

    // 2) 场地箱体线框(舞台/观众区)
    this.renderBoxes(project, vp);

    // 3) 热力图(安全报告)
    if (report) this.renderHeat(report, vp);

    // 4) 光束(加色混合,后画)
    this.renderBeams(beams, vp, beamLength);
  }

  private renderBoxes(project: Project, vp: Mat4) {
    const gl = this.gl;
    const data: number[] = [];
    const push = (b: Box3, color: Vec3) => {
      const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
      const c: Vec3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      for (const [a, b2] of edges) for (const q of [c[a], c[b2]]) data.push(...q, ...color, 0.9);
    };
    project.stageBoxes.forEach(b => push(b, [0.4, 0.7, 1]));
    project.audienceBoxes.forEach(b => push(b, [1, 0.75, 0.3]));
    project.projectors.forEach(p => {
      // 激光器小坐标轴
      data.push(...p.position, 1, 1, 1, 1, ...v3.add(p.position, [0.4, 0, 0]), 1, 0.3, 0.3, 1);
      data.push(...p.position, 1, 1, 1, 1, ...v3.add(p.position, [0, 0.4, 0]), 0.3, 1, 0.3, 1);
    });
    this.boxMesh.upload(Float32Array.from(data));
    gl.useProgram(this.sceneProg);
    gl.uniformMatrix4fv(uniformLoc(gl, this.sceneProg, 'uViewProj'), false, vp);
    gl.uniform1f(uniformLoc(gl, this.sceneProg, 'uIntensity'), 1);
    this.boxMesh.draw(gl.LINES);
  }

  private renderHeat(report: SafetyReport, vp: Mat4) {
    const gl = this.gl;
    const n = report.cellCenters.length / 3;
    gl.bindVertexArray(this.heatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatVbo);
    gl.bufferData(gl.ARRAY_BUFFER, report.cellCenters, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatRatioVbo);
    gl.bufferData(gl.ARRAY_BUFFER, report.peakRatio, gl.DYNAMIC_DRAW);
    gl.useProgram(this.heatProg);
    gl.uniformMatrix4fv(uniformLoc(gl, this.heatProg, 'uViewProj'), false, vp);
    gl.uniform1f(uniformLoc(gl, this.heatProg, 'uScale'), 10);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindVertexArray(null);
  }

  private renderBeams(beams: BeamRenderData[], vp: Mat4, length: number) {
    const gl = this.gl;
    const data: number[] = [];
    const segs = 18;
    for (const b of beams) {
      // 带抖动的实际方向
      const jitterAngle = b.jitter;
      const jx = (Math.random() - 0.5) * jitterAngle;
      const jy = (Math.random() - 0.5) * jitterAngle;
      const dir = v3.norm([b.direction[0] + jx, b.direction[1] + jy, b.direction[2]]);
      // 烟雾散射 → 亮度增益(浓处亮),闪烁因子压暗
      const gain = 1 + b.scatterIntegral * 3.5;
      const baseAlpha = 0.16 * b.flicker;
      const col: Vec3 = [b.color[0] * gain, b.color[1] * gain, b.color[2] * gain];
      let prev = b.origin;
      for (let i = 1; i <= segs; i++) {
        const t = (i / segs) * length;
        const cur = v3.add(b.origin, v3.scale(dir, t));
        // 分段渐亮(烟雾中显形),末端淡出
        const fade = Math.sin((i / segs) * Math.PI);
        const a = baseAlpha * (0.3 + 0.7 * fade);
        data.push(...prev, ...col, a, ...cur, ...col, a);
        // 光束轴芯亮线
        data.push(...prev, ...col.map(x => Math.min(1, x * 1.4)), Math.min(1, a * 2.4),
          ...cur, ...col.map(x => Math.min(1, x * 1.4)), Math.min(1, a * 2.4));
        prev = cur;
      }
    }
    if (data.length === 0) return;
    this.beamMesh.upload(Float32Array.from(data));
    gl.useProgram(this.sceneProg);
    gl.uniformMatrix4fv(uniformLoc(gl, this.sceneProg, 'uViewProj'), false, vp);
    gl.uniform1f(uniformLoc(gl, this.sceneProg, 'uIntensity'), 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    this.beamMesh.draw(gl.LINES);
    gl.depthMask(true);
  }

  /** 简单轨道控制 */
  attachControls(canvas: HTMLCanvasElement, onViewChange?: () => void) {
    let dragging = false, lastX = 0, lastY = 0;
    const down = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const up = () => { dragging = false; };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      this.camera.yaw += (e.clientX - lastX) * 0.005;
      this.camera.pitch = Math.max(-1.3, Math.min(1.3, this.camera.pitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX; lastY = e.clientY;
      onViewChange?.();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.camera.dist = Math.max(8, Math.min(160, this.camera.dist * (1 + Math.sign(e.deltaY) * 0.08)));
      onViewChange?.();
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointermove', move);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointermove', move);
      canvas.removeEventListener('wheel', wheel);
    };
  }
}

function inside(p: Vec3, b: Box3): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] &&
    p[1] >= b.min[1] && p[1] <= b.max[1] &&
    p[2] >= b.min[2] && p[2] <= b.max[2];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

function scaleTranslate(half: Vec3, center: Vec3): Mat4 {
  const m = new Float32Array(16);
  m[0] = half[0]; m[5] = half[1]; m[10] = half[2]; m[15] = 1;
  m[12] = center[0]; m[13] = center[1]; m[14] = center[2];
  return m;
}

/** ILDA 二维点预览渲染器(素材库) */
export class PreviewRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private lastVertexCount = 0;
  lastError = 0;
  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.prog = program(gl, PREVIEW_VS, PREVIEW_FS);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
    gl.bindVertexArray(null);
  }
  render(points: { x: number; y: number; status: number; r: number; g: number; b: number }[]) {
    const gl = this.gl;
    const c = gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // clientWidth 在首帧布局前可能为 0,给兜底尺寸
    const cssW = c.clientWidth || 300;
    const cssH = c.clientHeight || 180;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.03, 0.035, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const data: number[] = [];
    const SCALE = 0.9; // 留边,避免贴到裁剪面
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if ((a.status & 0x40) || (b.status & 0x40)) continue;
      // 屏幕 Y 轴向下,ILDA Y 向上,需翻转
      data.push((a.x / 32767) * SCALE, (-a.y / 32767) * SCALE, a.r / 255, a.g / 255, a.b / 255);
      data.push((b.x / 32767) * SCALE, (-b.y / 32767) * SCALE, b.r / 255, b.g / 255, b.b / 255);
    }
    if (data.length === 0) return;
    const arr = new Float32Array(data);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    gl.useProgram(this.prog);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINES, 0, arr.length / 5);
    gl.bindVertexArray(null);
    const err = gl.getError();
    this.lastVertexCount = arr.length / 5;
    this.lastError = err;
  }
}
