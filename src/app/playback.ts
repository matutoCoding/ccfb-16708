/**
 * 三维预演播放循环:逐帧对每台激光器做时间线求值、振镜动态模拟,
 * 输出 SceneRenderer 需要的光束数据。安全引擎用指令角度(不漏),
 * 预演用 galvo 实际角度(失真闪烁可视化)。
 */
import type { IldaFile, Project } from '../core/types';
import { evaluateProjector } from '../core/timeline';
import { createGalvoState, flickerFactor, stepGalvo, type GalvoState } from '../core/galvo';
import { compose, transformPoint, v3 } from '../core/math';
import { SceneRenderer, type BeamRenderData } from '../render/scene3d';

export class PlaybackEngine {
  private raf = 0;
  private last = 0;
  private galvo = new Map<string, GalvoState>();
  playing = false;
  time = 0;
  playbackRate = 1;
  /** 振镜失真模拟开关:false 时无限角速率,完美跟随指令 */
  galvoEnabled = true;
  onTime?: (t: number) => void;

  constructor(private scene: SceneRenderer) {}

  private ensureGalvo(project: Project) {
    for (const p of project.projectors) {
      if (!this.galvo.has(p.id)) this.galvo.set(p.id, createGalvoState());
    }
  }

  start(project: Project, files: Map<string, IldaFile>) {
    this.ensureGalvo(project);
    this.playing = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.playing) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.time += dt * this.playbackRate;
      if (this.time >= project.timeline.durationSec) {
        this.time = project.timeline.durationSec;
        this.playing = false;
        this.renderFrame(project, files, dt);
        this.onTime?.(this.time);
        return;
      }
      this.renderFrame(project, files, dt);
      this.onTime?.(this.time);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  seek(t: number, project: Project, files: Map<string, IldaFile>) {
    this.time = Math.max(0, Math.min(project.timeline.durationSec, t));
    this.renderFrame(project, files, 1 / 60);
    this.onTime?.(this.time);
  }

  stop(project: Project, files: Map<string, IldaFile>) {
    this.pause();
    this.time = 0;
    this.galvo.clear();
    this.ensureGalvo(project);
    this.renderFrame(project, files, 1 / 60);
    this.onTime?.(0);
  }

  /** 计算当前时刻的光束集合(galvo 实际输出) */
  renderFrame(project: Project, files: Map<string, IldaFile>, dt: number): BeamRenderData[] {
    this.ensureGalvo(project);
    const beams: BeamRenderData[] = [];
    const simDt = Math.max(1e-4, dt);
    for (const projector of project.projectors) {
      const cmd = evaluateProjector(projector, project.timeline, files, this.time, simDt);
      if (!cmd || cmd.blanked) continue;
      const state = this.galvo.get(projector.id)!;
      const next = this.galvoEnabled
        ? stepGalvo(state, cmd, projector.maxSlewRate, simDt)
        : { az: cmd.az, el: cmd.el, vz: 0, vl: 0, saturation: 0 };
      this.galvo.set(projector.id, next);

      // galvo 实际角度 → 世界方向
      const matrix = compose(projector.position, projector.orientation);
      const tanAz = Math.tan(next.az), tanEl = Math.tan(next.el);
      const local = v3.norm([tanAz, tanEl, 1]);
      const world = transformPoint(matrix, local);
      const direction = v3.norm(v3.sub(world, projector.position));

      const flicker = flickerFactor(next, Math.random());
      const scatterIntegral = SceneRenderer.scatterAlong(project, projector.position, direction, 60);
      // 饱和时角向抖动幅度
      const jitter = next.saturation * 0.012;
      beams.push({
        origin: projector.position,
        direction,
        color: [cmd.color[0] * projector.color[0], cmd.color[1] * projector.color[1], cmd.color[2] * projector.color[2]],
        flicker,
        scatterIntegral,
        jitter
      });
    }
    return beams;
  }

  get currentTime() { return this.time; }
}
