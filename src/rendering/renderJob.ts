/** Trabajo de render compartido: lo ejecuta el Worker (OffscreenCanvas) o, como respaldo, el hilo principal. */
import type { Pt } from '../ai/FaceLandmarks'
import type { Mask } from '../ai/Segmenter'
import { motionAt, danceAt, type AnimationInstruction, type VisemeFrame, type DanceSpec } from '../ai/MotionPlanner'
import { WarpRenderer } from './WarpRenderer'
import type { BgSpec } from './Backgrounds'
import { encodeAny, type OutKind } from './encode'
import { templateFrame, type TplPlay } from '../ai/MotionTemplate'
export interface RenderJob { src: ImageBitmap; lm: Pt[]; ins: AnimationInstruction; vis?: VisemeFrame[]; dur: number; fps: number; audio?: { mono: Float32Array; sampleRate: number }; dance?: DanceSpec; tpl?: TplPlay; bg?: BgSpec; mask?: Mask; integrate?: boolean; out?: OutKind }
export function runJob(j: RenderJob, canvas: HTMLCanvasElement | OffscreenCanvas, onProgress: (p: number) => void) {
  const r = new WarpRenderer(canvas, j.src, j.lm, j.bg, j.mask); r.setIntegrate(j.integrate ?? true); r.setArms(j.tpl?.rig ?? null)
  return encodeAny(j.out, canvas, Math.round(j.dur * j.fps), j.fps, i => {
    const t = i / j.fps
    if (j.tpl) { const f = templateFrame(t, j.tpl, j.dance); r.render(f.face, t, f.body) }
    else if (j.dance) { const d = danceAt(t, j.dance); r.render(d.face, t, d.body) } else r.render(motionAt(t, j.ins, j.vis), t)
  }, onProgress, j.audio)
}
