/** Vista previa en vivo del montaje: el mismo motor del export (Montage) en un canvas visible, con la música sonando por Web Audio (su reloj manda).
 *  El clip dura `dur` s y se repite en bucle. Cambiar BPM, estilo, plantilla o inicio rehace el guion al instante, sin volver a analizar las fotos. */
import type { DanceSpec } from '../ai/MotionPlanner'
import type { Mask } from '../ai/Segmenter'
import type { BgSpec } from './Backgrounds'
import { Montage, type MontageInput, type MontageTitles, type TplCfg } from './MontageRenderer'
import type { Plan, Style } from './Montage'
import { unlockAudio } from './Preview'
const mod = (x: number, d: number) => ((x % d) + d) % d
export class MontagePreview {
  private m: Montage; private raf = 0; private last = 0; private dead = false; private buf: AudioBuffer | null = null; private from = 0; private dur: number
  private node: AudioBufferSourceNode | null = null; private since = 0; private still = 0; private playing = false
  constructor(canvas: HTMLCanvasElement, inp: MontageInput) { this.m = new Montage(canvas, inp); this.dur = inp.dur; void this.draw() }
  get isPlaying() { return this.playing }
  private ctx() { return unlockAudio() }
  private raw() { return this.node ? this.ctx().currentTime : performance.now() / 1000 }
  private lat() { const c = this.ctx() as any; return this.node ? c.outputLatency || c.baseLatency || 0 : 0 }
  get time() { return this.playing ? mod(this.still + Math.max(0, this.raw() - this.since - this.lat()), this.dur) : this.still }
  private drawing = false
  /** Decodifica los fotogramas de vídeo que haga falta y dibuja; si aún hay un dibujo en curso se salta este (no se acumulan). */
  private async draw() { if (this.dead || this.drawing) return; this.drawing = true; try { const t = this.time; await this.m.prepare(t); if (!this.dead) this.m.render(t) } finally { this.drawing = false } }
  private tick = (ms: number) => {
    if (this.dead || !this.playing) return
    this.raf = requestAnimationFrame(this.tick)
    if (ms - this.last < 30) return   // ~30 fps: cada fotograma son varios pases de deformación
    this.last = ms; void this.draw()
  }
  play() {
    if (this.playing || this.dead) return
    this.playing = true
    if (this.buf) {
      const c = this.ctx(), n = c.createBufferSource(); n.buffer = this.buf; n.loop = true; n.loopStart = this.from; n.loopEnd = Math.min(this.buf.duration, this.from + this.dur)
      n.connect(c.destination); n.start(0, Math.min(this.buf.duration - 0.01, this.from + this.still)); this.node = n
    }
    this.since = this.raw(); this.raf = requestAnimationFrame(this.tick)
  }
  pause() { if (!this.playing) return; this.still = this.time; this.playing = false; cancelAnimationFrame(this.raf); this.stopNode(); void this.draw() }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing }
  private stopNode() { if (this.node) { try { this.node.stop() } catch { /* ya parado */ } this.node.disconnect(); this.node = null } }
  /** Música y fragmento (reinicia el clip). */
  setClip(buf: AudioBuffer | null, from: number, dur: number) { const was = this.playing; this.pause(); this.buf = buf; this.from = from; this.dur = Math.max(0.5, dur); this.still = 0; if (was) this.play() }
  /** Guion nuevo (BPM, compás, energía, estilo, plantilla, ediciones, títulos). */
  setSpec(spec: DanceSpec, style: Style, tpl: TplCfg | undefined, plan: Plan, titles?: MontageTitles, react?: boolean) { this.m.update(spec, style, tpl, this.dur, plan, titles, react); if (!this.playing) void this.draw() }
  /** Salta a t (s) dentro del clip. */
  seek(t: number) { const was = this.playing; this.pause(); this.still = Math.min(this.dur - 0.01, Math.max(0, t)); if (was) this.play(); else void this.draw() }
  get duration() { return this.dur }
  setBackground(i: number, bg?: BgSpec, mask?: Mask) { this.m.setBackground(i, bg, mask); if (!this.playing) void this.draw() }
  setIntegrate(on: boolean) { this.m.setIntegrate(on); if (!this.playing) void this.draw() }
  dispose() { this.dead = true; cancelAnimationFrame(this.raf); this.stopNode(); this.m.dispose() }
}
