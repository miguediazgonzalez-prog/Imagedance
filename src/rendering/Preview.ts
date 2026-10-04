/** Vista previa en vivo: el mismo WarpRenderer del export, a ~30 fps en un canvas visible, con la música sonando por Web Audio (su reloj manda: imagen y sonido no se desfasan).
 *  El clip dura `dur` s y se repite en bucle. Cambiar fondo, BPM, canción o inicio es instantáneo: no hay que volver a analizar la foto. */
import type { Pt } from '../ai/FaceLandmarks'
import type { Mask } from '../ai/Segmenter'
import { danceAt, motionAt, parseInstruction, type AnimationInstruction, type DanceSpec } from '../ai/MotionPlanner'
import type { BgSpec } from './Backgrounds'
import { templateFrame, type TplPlay } from '../ai/MotionTemplate'
import { WarpRenderer } from './WarpRenderer'
let ctx: AudioContext | undefined
/** Llamar de forma síncrona dentro de un gesto del usuario (toque): iOS no deja arrancar audio de otra manera. */
export function unlockAudio(): AudioContext { ctx ??= new AudioContext(); if (ctx.state !== 'running') void ctx.resume(); return ctx }
const mod = (x: number, d: number) => ((x % d) + d) % d
export class Preview {
  private r: WarpRenderer; private raf = 0; private last = 0; private dead = false
  private spec: DanceSpec | null = null; private tp: TplPlay | null = null; private ins: AnimationInstruction = parseInstruction('', 5)
  private buf: AudioBuffer | null = null; private from = 0; private dur = 5; private node: AudioBufferSourceNode | null = null
  private since = 0; private still = 0; private playing = false   // posición local = (still + tiempo transcurrido desde play - latencia de salida) mod dur; `still` = posición al empezar/pausar
  constructor(canvas: HTMLCanvasElement, bmp: ImageBitmap, L: Pt[]) { this.r = new WarpRenderer(canvas, bmp, L); this.draw() }
  get isPlaying() { return this.playing }
  private raw() { return this.node ? ctx!.currentTime : performance.now() / 1000 }
  private lat() { const c = ctx as any; return this.node ? c.outputLatency || c.baseLatency || 0 : 0 }
  /** Segundo actual dentro del clip (0 = inicio del fragmento de música). */
  get time() { return this.playing ? mod(this.still + Math.max(0, this.raw() - this.since - this.lat()), this.dur) : this.still }
  private draw() {
    if (this.dead) return
    const t = this.time
    if (this.tp) { const f = templateFrame(t, this.tp, this.spec); this.r.render(f.face, t, f.body) }
    else if (this.spec) { const d = danceAt(t, this.spec); this.r.render(d.face, t, d.body) } else this.r.render(motionAt(t, this.ins), t)
  }
  private tick = (ms: number) => {
    if (this.dead || !this.playing) return
    this.raf = requestAnimationFrame(this.tick)
    if (ms - this.last < (this.r.isGpu ? 15 : 32)) return   // ~60 fps con la malla en GPU; ~30 fps si la deformación cae a CPU
    this.last = ms; this.draw()
  }
  play() {
    if (this.playing || this.dead) return
    this.playing = true
    if (this.buf) {
      const c = unlockAudio(), n = c.createBufferSource(); n.buffer = this.buf; n.loop = true; n.loopStart = this.from; n.loopEnd = Math.min(this.buf.duration, this.from + this.dur)
      n.connect(c.destination); n.start(0, Math.min(this.buf.duration - 0.01, this.from + this.still)); this.node = n
    }
    this.since = this.raw(); this.raf = requestAnimationFrame(this.tick)
  }
  pause() {
    if (!this.playing) return
    this.still = this.time; this.playing = false; cancelAnimationFrame(this.raf); this.stopNode(); this.draw()
  }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing }
  private stopNode() { if (this.node) { try { this.node.stop() } catch { /* ya parado */ } this.node.disconnect(); this.node = null } }
  /** Música y fragmento (reinicia el clip desde el principio). buf = null: sin música. */
  setClip(buf: AudioBuffer | null, from: number, dur: number) {
    const was = this.playing; this.pause()
    this.buf = buf; this.from = from; this.dur = Math.max(0.5, dur); this.still = 0; this.ins = parseInstruction('', this.dur)
    if (was) this.play(); else this.draw()
  }
  /** Coreografía (BPM, compás, energía): se aplica al vuelo, sin cortar el sonido. null = quieto. */
  setSpec(spec: DanceSpec | null) { this.spec = spec; if (!this.playing) this.draw() }
  /** Plantilla de movimiento de un vídeo (imitación): manda sobre la coreografía; la música sigue moviendo los fondos. null = sin plantilla. */
  setTemplate(tp: TplPlay | null) { this.tp = tp; if (!this.playing) this.draw() }
  /** Fondo + máscara de persona a la vez (sin fondo, la foto se ve tal cual y la máscara no se usa). */
  setBackground(bg?: BgSpec, mask?: Mask) { this.r.setBackground(bg); this.r.setMask(bg ? mask : undefined); if (!this.playing) this.draw() }
  /** Luz y sombra del fondo sobre la persona. */
  setIntegrate(on: boolean) { this.r.setIntegrate(on); if (!this.playing) this.draw() }
  dispose() { this.dead = true; cancelAnimationFrame(this.raf); this.stopNode(); this.r.dispose() }
}
