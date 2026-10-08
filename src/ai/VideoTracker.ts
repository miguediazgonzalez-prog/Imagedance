/** Extrae una plantilla de movimiento de un vídeo, en el dispositivo: recorre el vídeo fotograma a fotograma y mide la cabeza (landmarks 3D + blendshapes de MediaPipe
 *  Face Landmarker) y el torso (MediaPipe Pose Landmarker). Si el modelo de pose no carga, la plantilla se hace solo con la cara. El vídeo no sale del dispositivo. */
import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { RIGID, buildTemplate, type ArmAng, type MotionTemplate, type RawFrame } from './MotionTemplate'
import { dirAngle, wrapPi } from './ArmSkin'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
import { POSE_MODEL } from './BodyPose'
export const TRACK_FPS = 24, TRACK_MAX_S = 60

export interface TrackResult { tpl: MotionTemplate; note: string }

async function makeFace(fs: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>) {
  let last: unknown
  for (const delegate of ['GPU', 'CPU'] as const) {
    try { return await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true }) } catch (e) { last = e }
  }
  throw new Error(`No se pudo cargar el detector facial (${last instanceof Error ? last.message : String(last)}).`)
}
async function makePose(fs: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>) {
  for (const delegate of ['GPU', 'CPU'] as const) {
    try { return await PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1 }) } catch { /* siguiente */ }
  }
  return null
}
const once = (el: HTMLVideoElement, ev: string, ms = 4000) => new Promise<void>((res, rej) => {
  const ok = () => { clearTimeout(tm); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); res() }
  const bad = () => { clearTimeout(tm); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); rej(new Error('No pude leer ese vídeo. Prueba con MP4 (H.264) o MOV.')) }
  const tm = setTimeout(() => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); rej(new Error('El vídeo tarda demasiado en responder. Prueba con uno más corto o en MP4.')) }, ms)
  el.addEventListener(ev, ok); el.addEventListener('error', bad)
})
const tick = () => new Promise<void>(r => setTimeout(r, 0))
/** Espera a tener imágenes. iOS no precarga vídeos fuera de pantalla: si no llegan solas, un play()/pause() silencioso (dentro del gesto del usuario) las trae. */
async function ready(v: HTMLVideoElement) {
  if (v.readyState >= 2) return
  v.load()
  try { await once(v, 'loadeddata', 4000) } catch {
    try { await v.play(); v.pause() } catch { /* sin autoplay */ }
    if (v.readyState < 2) await once(v, 'loadeddata', 12000)
  }
}

type LM = { x: number; y: number; visibility?: number }
const vis = (p: LM | undefined, t = 0.5) => !!p && (p.visibility ?? 0) > t
/** Ángulos de un brazo (hombro, codo, muñeca, meñique, índice) en píxeles; undefined si no se ve entero. */
function armAngles(P: LM[], [si, ei, wi, pi, ii]: number[], W: number, H: number): ArmAng | undefined {
  if (!vis(P[si]) || !vis(P[ei]) || !vis(P[wi])) return undefined
  const px = (p: LM) => ({ x: p.x * W, y: p.y * H }), s = px(P[si]), e = px(P[ei]), w = px(P[wi])
  if (Math.hypot(e.x - s.x, e.y - s.y) < 8 || Math.hypot(w.x - e.x, w.y - e.y) < 8) return undefined
  const u = dirAngle(s, e), f = dirAngle(e, w), a: ArmAng = { u, f }
  if (vis(P[pi], 0.4) && vis(P[ii], 0.4)) { const k = { x: (px(P[pi]).x + px(P[ii]).x) / 2, y: (px(P[pi]).y + px(P[ii]).y) / 2 }; if (Math.hypot(k.x - w.x, k.y - w.y) > 3) a.hd = wrapPi(dirAngle(w, k) - f) }
  return a
}
/** Analiza hasta TRACK_MAX_S segundos del vídeo (desde `from`). onProgress recibe 0..1. */
export async function trackVideo(file: File, onProgress: (p: number, msg: string) => void, from = 0, signal?: AbortSignal): Promise<TrackResult> {
  const url = URL.createObjectURL(file), v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
  let face: FaceLandmarker | undefined, pose: PoseLandmarker | null = null
  try {
    onProgress(0, 'Abriendo el vídeo…'); await ready(v)
    if (!v.videoWidth || !v.videoHeight) throw new Error('No pude leer las imágenes de ese vídeo.')
    const total = Number.isFinite(v.duration) ? v.duration : 0, t0 = Math.min(Math.max(0, from), Math.max(0, total - 1)), dur = Math.min(TRACK_MAX_S, total - t0)
    if (dur < 1) throw new Error('El vídeo es demasiado corto (necesito al menos 1 segundo).')
    onProgress(0, 'Cargando los modelos de rostro y cuerpo… (la primera vez se descargan)')
    const fs = await FilesetResolver.forVisionTasks(WASM); face = await makeFace(fs); pose = await makePose(fs)
    const n = Math.floor(dur * TRACK_FPS), W = v.videoWidth, H = v.videoHeight, raw: RawFrame[] = []
    let facesSeen = 0, posesSeen = 0
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new Error('Análisis cancelado.')
      const target = t0 + i / TRACK_FPS
      if (Math.abs(v.currentTime - target) > 1e-3 || v.readyState < 2) { v.currentTime = target; await once(v, 'seeked') }   // si ya está en ese instante no hay 'seeked' que esperar
      const ts = Math.round((i * 1000) / TRACK_FPS) + 1, f: RawFrame = {}
      const fr = face.detectForVideo(v, ts), L = fr.faceLandmarks[0]
      if (L && L.length >= 468) {
        const pts = new Float32Array(RIGID.length * 3); RIGID.forEach((k, j) => { pts[3 * j] = L[k].x * W; pts[3 * j + 1] = L[k].y * H; pts[3 * j + 2] = L[k].z * W })   // z en la escala del ancho, igual que FaceLandmarks.detect
        const bs: Record<string, number> = {}; for (const c of fr.faceBlendshapes[0]?.categories ?? []) bs[c.categoryName] = c.score
        let cx = 0, cy = 0; for (let j = 0; j < RIGID.length; j++) { cx += pts[3 * j] / RIGID.length; cy += pts[3 * j + 1] / RIGID.length }
        f.face = { pts, fw: Math.hypot((L[454].x - L[234].x) * W, (L[454].y - L[234].y) * H), cx, cy, bs }; facesSeen++
      }
      const P = pose?.detectForVideo(v, ts).landmarks[0]
      if (P && (P[11].visibility ?? 0) > 0.5 && (P[12].visibility ?? 0) > 0.5) {
        const lx = P[11].x * W, ly = P[11].y * H, rx = P[12].x * W, ry = P[12].y * H, sx = (lx + rx) / 2, sy = (ly + ry) / 2, sw = Math.hypot(lx - rx, ly - ry)
        // 11 = hombro izquierdo del sujeto (a la derecha de la pantalla), 12 = el derecho: la inclinación se mide de izquierda a derecha de la pantalla
        f.pose = { sx, sy, sw, tilt: Math.atan2(ly - ry, lx - rx) }
        if ((P[23].visibility ?? 0) > 0.5 && (P[24].visibility ?? 0) > 0.5) {
          const hx = ((P[23].x + P[24].x) / 2) * W, hy = ((P[23].y + P[24].y) / 2) * H
          if (hy > sy + 0.5 * sw) { f.pose.hx = hx; f.pose.hy = hy }   // caderas visibles y por debajo de los hombros
        }
        // Brazos y manos, por lado de la PANTALLA: el hombro con menor x es el de la izquierda
        const a11 = armAngles(P, [11, 13, 15, 17, 19], W, H), a12 = armAngles(P, [12, 14, 16, 18, 20], W, H)
        f.pose.arms = P[11].x < P[12].x ? { l: a11, r: a12 } : { l: a12, r: a11 }
        posesSeen++
      }
      raw.push(f)
      if (i % 3 === 0) { onProgress((i + 1) / n, `Analizando el vídeo… ${Math.round(((i + 1) / n) * 100)} %`); await tick() }
    }
    onProgress(1, 'Creando la plantilla…')
    const tpl = buildTemplate(raw, TRACK_FPS, file.name.replace(/\.[^.]+$/, '') || 'Plantilla')
    const note = `${tpl.dur.toFixed(1)} s · rostro en ${Math.round((facesSeen / n) * 100)} % de los fotogramas · ` +
      (!pose ? 'sin modelo de cuerpo: solo cabeza y expresión' : tpl.hasBody ? `torso ${posesSeen / n > 0.9 ? 'visible' : 'visible en parte'}` : 'no se ve el torso: solo cabeza y expresión') +
      (tpl.armL || tpl.armR ? ` · brazos: ${tpl.armL && tpl.armR ? 'los dos' : tpl.armL ? 'izquierdo de la pantalla' : 'derecho de la pantalla'}` : ' · brazos no visibles') +
      (tpl.period && (tpl.periodConf ?? 0) >= 0.2 ? ` · ciclo de ${tpl.period.toFixed(2)} s` : ' · sin ciclo repetido claro')
    return { tpl, note }
  } finally { face?.close(); pose?.close(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url) }
}
