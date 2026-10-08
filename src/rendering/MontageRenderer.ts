/** Motor del montaje: anima a TODAS las personas de cada foto (un pase del deformador por persona, mezclados con un reparto suave) y las monta al ritmo de la música
 *  con el guion de Montage.ts: planos generales y primeros planos, cámara con golpe en cada beat, y transiciones (zoom, barrido, giro, destello, glitch RGB), sacudida y flash en los drops.
 *  Lo usan el export (worker u hilo principal) y la vista previa, así se ven idénticos. */
import type { Pt } from '../ai/FaceLandmarks'
import type { Mask } from '../ai/Segmenter'
import { danceAt, type DanceSpec } from '../ai/MotionPlanner'
import { bodyScaleFor, makePlay, templateFrame, type MotionTemplate, type SyncMode, type TplPlay } from '../ai/MotionTemplate'
import { faceOf, gridFor, layerAlphas, type Face } from '../ai/People'
import type { BgSpec } from './Backgrounds'
import { WarpRenderer } from './WarpRenderer'
import { cameraAt, restCam, shotAt, type Cam, type PhotoInfo, type Plan, type Shot, type Style } from './Montage'
import { reactiveFrom, type Reactive } from '../audio/Reactive'
import { drawTitles, type TitleCfg, type TitleEvent } from './Titles'
type Cv = HTMLCanvasElement | OffscreenCanvas
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type Src = Cv | ImageBitmap
/** Un vídeo corto como entrada: fotogramas JPEG (se decodifican al vuelo) a `fps`; sale como metraje sin deformar, en bucle. */
export interface MVideo { frames: Blob[]; fps: number }
export interface MPhoto { src: ImageBitmap; /** landmarks en píxeles de src, de izquierda a derecha */ faces: Pt[][]; bg?: BgSpec; mask?: Mask; video?: MVideo }
export interface TplCfg { tpl: MotionTemplate; mode: SyncMode; gain: number; mirror: boolean; startAt: number }
export interface MontageTitles { cfg: TitleCfg; events: TitleEvent[] }
/** `plan` = guion ya calculado (con favoritas, transiciones y ediciones): el mismo para la vista previa y para el export. */
export interface MontageInput { photos: MPhoto[]; ow: number; oh: number; fps: number; dur: number; spec: DanceSpec; style: Style; plan: Plan; tpl?: TplCfg; integrate?: boolean; titles?: MontageTitles; /** efectos que reaccionan al espectro */ react?: boolean }
const mk = (w: number, h: number): Cv => { if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
const c2d = (c: Cv) => c.getContext('2d') as Ctx
const rng = (s: number) => () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
const sm = (x: number) => { const q = Math.min(1, Math.max(0, x)); return q * q * (3 - 2 * q) }
export const infoOf = (photos: MPhoto[]): PhotoInfo[] => photos.map(p => ({ W: p.src.width, H: p.src.height, faces: p.faces.map(faceOf) }))

/** Una foto con sus personas: un WarpRenderer (y su contexto WebGL) por persona, creados solo cuando el plano activo los necesita. */
class Stage {
  readonly W: number; readonly H: number; readonly faces: Face[]; used = 0; frame: Src; readonly video?: MVideo; private vc = new Map<number, ImageBitmap>(); private vlast?: ImageBitmap
  private rs: (WarpRenderer | null)[] = []; private cv: (Cv | null)[] = []; private comp?: Cv; private tmp?: Cv; private al?: Cv[]; private lastT = NaN
  private specs: DanceSpec[] = []; private plays: (TplPlay | null)[] = []; readonly back: Cv
  constructor(readonly ph: MPhoto, private idx: number, public integrate: boolean) {
    this.W = ph.src.width; this.H = ph.src.height; this.faces = ph.faces.map(faceOf); this.frame = ph.src; this.video = ph.video?.frames.length ? ph.video : undefined
    const k = 40 / Math.max(this.W, this.H), bw = Math.max(2, Math.round(this.W * k)), bh = Math.max(2, Math.round(this.H * k))
    this.back = mk(bw, bh); c2d(this.back).drawImage(ph.src, 0, 0, bw, bh)   // fondo desenfocado para cuando la foto no llena el cuadro
  }
  get live() { return this.rs.filter(Boolean).length }
  private vidx(local: number) { const n = this.video!.frames.length; return ((Math.floor(Math.max(0, local) * this.video!.fps) % n) + n) % n }
  /** Decodifica el fotograma del vídeo que toca en `local` segundos (caché corta; el render síncrono lo recoge con vframe). */
  async load(local: number) {
    if (!this.video) return; const i = this.vidx(local); if (this.vc.has(i)) return
    this.vc.set(i, await createImageBitmap(this.video.frames[i]))
    if (this.vc.size > 14) { const k = this.vc.keys().next().value as number; if (this.vc.get(k) !== this.vlast) this.vc.get(k)?.close(); this.vc.delete(k) }
  }
  vframe(local: number): ImageBitmap { const f = this.vc.get(this.vidx(local)) ?? this.vlast ?? this.ph.src; this.vlast = f; return f }
  /** Cada persona baila una figura distinta (desfase de 16 beats = misma fase, otra figura) y, con plantilla, las vecinas se reflejan. */
  setSpec(spec: DanceSpec, tpl?: TplCfg) {
    const per = 60 / spec.bpm
    this.specs = this.faces.map((_, i) => ({ ...spec, secBase: (spec.secBase ?? 0) + i + 2 * this.idx, offset: spec.offset + i * 16 * per }))
    this.plays = this.faces.map((_, i) => (tpl ? makePlay(tpl.tpl, { mode: tpl.mode, gain: tpl.gain, mirror: tpl.mirror !== (i % 2 === 1), sc: bodyScaleFor(this.ph.faces[i], this.W, this.H), startAt: tpl.startAt, spec: this.specs[i], rig: null }) : null))
    this.lastT = NaN
  }
  private ensure(i: number): WarpRenderer {
    if (this.rs[i]) return this.rs[i]!
    const cv = mk(this.W, this.H), r = new WarpRenderer(cv, this.ph.src, this.ph.faces[i], this.ph.bg, this.ph.mask); r.setIntegrate(this.integrate)
    this.cv[i] = cv; return (this.rs[i] = r)
  }
  private alphas(): Cv[] {
    if (this.al) return this.al
    const { gw, gh } = gridFor(this.W, this.H)
    return (this.al = layerAlphas(this.faces, this.W, this.H, gw, gh).map(a => {
      const c = mk(gw, gh), d = new ImageData(gw, gh); for (let i = 0; i < a.length; i++) { d.data[4 * i] = d.data[4 * i + 1] = d.data[4 * i + 2] = 255; d.data[4 * i + 3] = a[i] }
      c2d(c).putImageData(d, 0, 0); return c
    }))
  }
  update(t: number) {
    if (t === this.lastT) return; this.lastT = t
    const P = this.faces.length; if (!P) { this.frame = this.ph.src; return }
    for (let i = 0; i < P; i++) { const m = this.plays[i] ? templateFrame(t, this.plays[i]!, this.specs[i]) : danceAt(t, this.specs[i]); this.ensure(i).render(m.face, t, m.body) }
    if (P === 1) { this.frame = this.cv[0]!; return }
    // Mezcla por capas: la persona 0 entera y cada una de las demás con su alfa de reparto → suma ponderada de los P pases
    this.comp ??= mk(this.W, this.H); this.tmp ??= mk(this.W, this.H)
    const cc = c2d(this.comp), tc = c2d(this.tmp), al = this.alphas(); cc.globalCompositeOperation = 'source-over'; cc.drawImage(this.cv[0]!, 0, 0)
    for (let k = 1; k < P; k++) {
      tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, this.W, this.H); tc.drawImage(this.cv[k]!, 0, 0)
      tc.globalCompositeOperation = 'destination-in'; tc.imageSmoothingEnabled = true; tc.drawImage(al[k - 1], 0, 0, this.W, this.H); cc.drawImage(this.tmp, 0, 0)
    }
    this.frame = this.comp
  }
  /** Libera los contextos WebGL (los navegadores limitan los vivos). */
  release() { for (const r of this.rs) r?.dispose(); this.rs = []; this.cv = []; this.lastT = NaN }
  /** Libera también los fotogramas de vídeo en caché. */
  free() { this.release(); for (const b of this.vc.values()) b.close(); this.vc.clear(); this.vlast = undefined }
}

export class Montage {
  private ctx: Ctx; private stages: Stage[]; private info: PhotoInfo[]; plan: Plan; private rests = new Map<number, Cam>(); private per = 0.5; private fid = 0; private rx: Reactive | null = null; private bump = 0
  private vig: Cv; private fxc?: { t: Cv; c: Cv[] }; private sx = 0; private sy = 0; private spec: DanceSpec; private style: Style; private tpl?: TplCfg
  constructor(private canvas: Cv, private inp: MontageInput, private maxCtx = 10) {
    canvas.width = inp.ow; canvas.height = inp.oh; this.ctx = c2d(canvas)
    this.info = infoOf(inp.photos); this.stages = inp.photos.map((p, i) => new Stage(p, i, inp.integrate ?? true))
    const v = mk(inp.ow, inp.oh), g = c2d(v), gr = g.createRadialGradient(inp.ow / 2, inp.oh / 2, Math.min(inp.ow, inp.oh) * 0.35, inp.ow / 2, inp.oh / 2, Math.hypot(inp.ow, inp.oh) * 0.55)
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.55)'); g.fillStyle = gr; g.fillRect(0, 0, inp.ow, inp.oh); this.vig = v
    this.spec = inp.spec; this.style = inp.style; this.tpl = inp.tpl; this.plan = inp.plan; this.replan()
  }
  get isGpu() { return true }
  private replan() {
    const s = this.spec; this.per = 60 / s.bpm; this.rests.clear(); this.rx = this.inp.react && s.bands ? reactiveFrom(s.bands, s.fps) : null
    for (const st of this.stages) st.setSpec(s, this.tpl)
  }
  /** BPM, compás, energía, estilo, plantilla, guion o títulos nuevos: se rehace lo que depende de ellos sin tocar las fotos. */
  update(spec: DanceSpec, style: Style, tpl: TplCfg | undefined, dur: number, plan: Plan, titles?: MontageTitles, react = this.inp.react) { this.spec = spec; this.style = style; this.tpl = tpl; this.plan = plan; this.inp = { ...this.inp, dur, plan, titles, react }; this.replan() }
  /** Fondo y recorte de una foto; los renderizadores se rehacen al vuelo. */
  setBackground(i: number, bg?: BgSpec, mask?: Mask) { const s = this.stages[i]; if (!s) return; s.ph.bg = bg; s.ph.mask = bg ? mask : undefined; s.release() }
  setIntegrate(on: boolean) { for (const s of this.stages) { s.integrate = on; s.release() } }
  private stage(i: number): Stage {
    const s = this.stages[i]; s.used = this.fid
    const need = s.live ? 0 : s.faces.length; let live = this.stages.reduce((a, x) => a + x.live, 0)
    if (live + need > this.maxCtx) for (const x of [...this.stages].sort((a, b) => a.used - b.used)) { if (live + need <= this.maxCtx) break; if (x !== s && x.used < this.fid && x.live) { live -= x.live; x.release() } }
    return s
  }
  private rest(k: number): Cam { let c = this.rests.get(k); if (!c) { const sh = this.plan.shots[k]; c = restCam(sh, this.info[sh.photo], this.inp.ow, this.inp.oh); this.rests.set(k, c) } return c }
  /** Dibuja un plano: fondo desenfocado si la foto no llena el cuadro + foto con la cámara del guion. x = efectos de la transición. */
  private layer(k: number, t: number, x: { ox?: number; scale?: number; rot?: number; alpha?: number } = {}) {
    const sh = this.plan.shots[k], st = this.stage(sh.photo), ph = this.info[sh.photo], { ow, oh } = this.inp, ctx = this.ctx
    st.update(t); if (st.video) st.frame = st.vframe(t - sh.t0 + k * 1.37)
    const cam = cameraAt(sh, this.rest(k), ph, ow, oh, t, this.per, this.spec.offset, this.bump), rot = cam.rot + (x.rot ?? 0), sc = x.scale ?? 1, s = cam.s * sc
    ctx.save(); ctx.globalAlpha = x.alpha ?? 1; ctx.translate(x.ox ?? 0, 0); ctx.beginPath(); ctx.rect(0, 0, ow, oh); ctx.clip()
    if (ow / s > ph.W || oh / s > ph.H || Math.abs(rot) > 5e-4) {
      const b = st.back, f = Math.max(ow / b.width, oh / b.height); ctx.drawImage(b, (ow - b.width * f) / 2, (oh - b.height * f) / 2, b.width * f, b.height * f); ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(0, 0, ow, oh)
    }
    ctx.translate(ow / 2 + this.sx, oh / 2 + this.sy); ctx.rotate(rot); ctx.scale(s, s); ctx.drawImage(st.frame as CanvasImageSource, -cam.cx, -cam.cy); ctx.restore()
  }
  private white(a: number) { if (a <= 0.003) return; const { ow, oh } = this.inp, c = this.ctx; c.save(); c.globalAlpha = Math.min(1, a); c.fillStyle = '#fff'; c.fillRect(0, 0, ow, oh); c.restore() }
  private black(a: number) { if (a <= 0.003) return; const { ow, oh } = this.inp, c = this.ctx; c.save(); c.globalAlpha = Math.min(1, a); c.fillStyle = '#000'; c.fillRect(0, 0, ow, oh); c.restore() }
  /** Separación de canales RGB + franjas desplazadas, con semilla por fotograma (la vista previa y el export dan lo mismo). */
  private glitch(a: number, t: number) {
    const { ow, oh, fps } = this.inp, ctx = this.ctx, r = rng(Math.floor(t * fps) * 7919 + 13)
    this.fxc ??= { t: mk(ow, oh), c: [mk(ow, oh), mk(ow, oh), mk(ow, oh)] }
    const { t: T, c } = this.fxc, tc = c2d(T); tc.globalCompositeOperation = 'source-over'; tc.drawImage(this.canvas as CanvasImageSource, 0, 0)
    c.forEach((cv, i) => { const g = c2d(cv); g.globalCompositeOperation = 'source-over'; g.drawImage(T as CanvasImageSource, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = ['#f00', '#0f0', '#00f'][i]; g.fillRect(0, 0, ow, oh) })
    const d = a * 0.035 * ow * (0.6 + 0.8 * r())
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ow, oh)
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(c[0] as CanvasImageSource, -d, 0); ctx.drawImage(c[1] as CanvasImageSource, 0, d * 0.2); ctx.drawImage(c[2] as CanvasImageSource, d, 0)
    ctx.globalCompositeOperation = 'source-over'
    for (let i = 0; i < 5; i++) { const y = r() * oh, h = (0.02 + 0.07 * r()) * oh, dx = (r() - 0.5) * 0.18 * ow * a; ctx.drawImage(T as CanvasImageSource, 0, y, ow, h, dx, y, ow, h) }
    ctx.restore()
  }
  private transition(sh: Shot, A: number, B: number, p: number, t: number) {
    const { ow } = this.inp, e = sm(p), q = p < 0.5 ? p * 2 : 2 - 2 * p
    switch (sh.trans) {
      case 'zoom': this.layer(A, t, { scale: 1 + 0.9 * e }); this.layer(B, t, { scale: 0.7 + 0.3 * e, alpha: e }); this.white(0.22 * Math.sin(Math.PI * p)); break
      case 'whip': {   // barrido horizontal con 4 copias desplazadas (desenfoque de movimiento)
        const span = ow * 0.1 * Math.sin(Math.PI * p), n = 4
        for (let i = 0; i < n; i++) this.layer(A, t, { ox: -sh.dir * e * ow + (i / (n - 1) - 0.5) * span, alpha: 1 / (i + 1) })
        for (let i = 0; i < n; i++) this.layer(B, t, { ox: sh.dir * (1 - e) * ow + (i / (n - 1) - 0.5) * span, alpha: 1 / (i + 1) })
        break
      }
      case 'spin': this.layer(A, t, { rot: sh.dir * e * 0.32, scale: 1 + 0.6 * e }); this.layer(B, t, { rot: -sh.dir * (1 - e) * 0.32, scale: 1.55 - 0.55 * e, alpha: e }); this.white(0.18 * Math.sin(Math.PI * p)); break
      case 'flash': this.layer(p < 0.5 ? A : B, t); this.white(sm(q)); break
      case 'glitch': this.layer(p < 0.5 ? A : B, t); this.glitch(Math.sin(Math.PI * p), t); break
      default: this.layer(B, t)
    }
  }
  /** Qué se ve en t: un plano, o una transición entre dos (A sale, B entra, p = avance 0..1). */
  private which(t: number): { A: number; B: number; p: number; sh: Shot } {
    const S = this.plan.shots, k = shotAt(S, t), nx = S[k + 1], cur = S[k]
    if (nx && nx.tr > 0 && t >= nx.t0 - nx.tr / 2) return { A: k, B: k + 1, p: (t - (nx.t0 - nx.tr / 2)) / nx.tr, sh: nx }
    if (k > 0 && cur.tr > 0 && t < cur.t0 + cur.tr / 2) return { A: k - 1, B: k, p: (t - (cur.t0 - cur.tr / 2)) / cur.tr, sh: cur }
    return { A: -1, B: k, p: 1, sh: cur }
  }
  /** Decodifica los fotogramas de vídeo que hacen falta en t. Llamar (y esperar) antes de render(t) cuando haya vídeos; si no los hay, no cuesta nada. */
  async prepare(t: number) {
    if (!this.stages.some(s => s.video)) return
    const w = this.which(t), S = this.plan.shots
    for (const k of w.A >= 0 ? [w.A, w.B] : [w.B]) { const st = this.stages[S[k].photo]; if (st.video) await st.load(t - S[k].t0 + k * 1.37) }
  }
  /** Dibuja el instante t (s desde el inicio del montaje) en el canvas de salida. */
  render(t: number) {
    const { ow, oh, dur, fps } = this.inp, ctx = this.ctx, w = this.which(t), idx = Math.max(0, Math.round(t * fps)), amp = { soft: 0.5, dynamic: 0.85, extreme: 1.15 }[this.style]; this.fid++
    const rx = this.rx, kick = rx ? rx.kick[Math.min(rx.kick.length - 1, idx)] : 0, hue = rx ? rx.hue[Math.min(rx.hue.length - 1, idx)] : 0
    this.bump = 0.035 * kick * amp   // el zoom también responde al bombo real, no solo al metrónomo
    // Sacudida en los impactos (cambios de sección, drops y golpes de percusión)
    let kx = 0, ky = 0; this.plan.impacts.forEach((m, i) => { const d = t - m.t; if (d >= 0 && d < 0.4) { const a = m.k * Math.exp(-14 * d); kx += a * Math.sin(d * 90 + i); ky += a * Math.cos(d * 77 + 2 * i) } })
    const sh = amp * 0.012 * ow; this.sx = sh * kx; this.sy = sh * ky
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ow, oh)
    if (w.A >= 0) this.transition(w.sh, w.A, w.B, w.p, t); else this.layer(w.B, t)
    // Flash en los impactos, acento en el primer tiempo del compás
    for (const m of this.plan.impacts) { const d = t - m.t; if (d >= 0 && d < 0.6) this.white(m.k * 0.85 * Math.exp(-9 * d)) }
    if (this.style !== 'soft') { const b = (t - this.spec.offset) / this.per - (this.spec.bar0 ?? 0), bib = ((b % 4) + 4) % 4; if (bib < 1) this.white((this.style === 'extreme' ? 0.09 : 0.05) * Math.exp(-9 * bib)) }
    // Color de la canción: el tono sigue el equilibrio graves/agudos y cambia de paleta en cada sección; el bombo da un destello tintado
    if (rx) {
      const sec = (this.spec.secBase ?? 0) + (this.spec.cuts ?? []).filter(c => c.t <= t).length, h = (hue + 53 * sec) % 360
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = 0.34 * amp; ctx.fillStyle = `hsl(${h},85%,52%)`; ctx.fillRect(0, 0, ow, oh)
      if (kick > 0.02) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, kick * 0.2 * amp); ctx.fillStyle = `hsl(${(h + 30) % 360},90%,50%)`; ctx.fillRect(0, 0, ow, oh) }
      ctx.restore()
    }
    ctx.drawImage(this.vig as CanvasImageSource, 0, 0)
    const T = this.inp.titles; if (T?.events.length) drawTitles(ctx, T.events, t, T.cfg, ow, oh, this.per, this.spec.offset)
    this.black(1 - Math.min(1, t / 0.3)); this.black((t - (dur - 0.7)) / 0.7)
  }
  dispose() { for (const s of this.stages) s.free() }
}
