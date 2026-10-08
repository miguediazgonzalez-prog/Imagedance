/** Todos los rostros de una foto (hasta MAX_PEOPLE). La detección de MediaPipe es pobre con caras pequeñas, así que además de la foto entera se prueban 4 recortes solapados. */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Pt } from './FaceLandmarks'
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
export const MAX_PEOPLE = 4
let lm: FaceLandmarker | undefined
async function load(): Promise<FaceLandmarker> {
  const fs = await FilesetResolver.forVisionTasks(WASM)
  for (const delegate of ['GPU', 'CPU'] as const) {
    try { return await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'IMAGE', numFaces: 8 }) }
    catch (e) { if (delegate === 'CPU') throw e }
  }
  throw new Error('No se pudo cargar el detector facial')
}
interface Cand { pts: Pt[]; cx: number; cy: number; fw: number }
/** Rostros en FRACCIONES de la foto (x/W, y/H, z/W), de izquierda a derecha. Se escalan a cualquier tamaño con scaleFace. */
export async function detectAll(src: HTMLCanvasElement): Promise<Pt[][]> {
  lm ??= await load()
  const W = src.width, H = src.height, cands: Cand[] = []
  const add = (faces: { x: number; y: number; z: number }[][], ox: number, oy: number, tw: number, th: number) => {
    for (const f of faces) {
      if (f.length < 478) continue
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0; for (const p of f) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
      // Una cara cortada por el borde de un recorte (que no es borde de la foto) sale con landmarks inventados: se descarta
      if ((x0 < 0.02 && ox > 1) || (x1 > 0.98 && ox + tw < W - 1) || (y0 < 0.02 && oy > 1) || (y1 > 0.98 && oy + th < H - 1)) continue
      const pts = f.map(p => ({ x: (ox + p.x * tw) / W, y: (oy + p.y * th) / H, z: (p.z * tw) / W }))
      const fw = Math.hypot((pts[454].x - pts[234].x) * W, (pts[454].y - pts[234].y) * H)
      if (fw < 0.035 * Math.max(W, H)) continue
      cands.push({ pts, fw, cx: ((pts[234].x + pts[454].x) / 2) * W, cy: ((pts[10].y + pts[152].y) / 2) * H })
    }
  }
  add(lm.detect(src).faceLandmarks, 0, 0, W, H)
  const long = Math.max(W, H), tw = Math.min(W, Math.round(0.62 * long)), th = Math.min(H, Math.round(0.62 * long))
  if (long >= 600) {
    const tile = document.createElement('canvas'); tile.width = tw; tile.height = th; const c = tile.getContext('2d')!
    for (const oy of th < H ? [0, H - th] : [0]) for (const ox of tw < W ? [0, W - tw] : [0]) { c.clearRect(0, 0, tw, th); c.drawImage(src, ox, oy, tw, th, 0, 0, tw, th); add(lm.detect(tile).faceLandmarks, ox, oy, tw, th) }
  }
  const kept: Cand[] = []
  for (const c of cands) if (!kept.some(k => Math.hypot(k.cx - c.cx, k.cy - c.cy) < 0.6 * Math.max(k.fw, c.fw))) kept.push(c)
  return kept.sort((a, b) => b.fw - a.fw).slice(0, MAX_PEOPLE).sort((a, b) => a.cx - b.cx).map(c => c.pts)
}
/** Fracciones → píxeles de una foto de W×H. */
export const scaleFace = (f: Pt[], W: number, H: number): Pt[] => f.map(p => ({ x: p.x * W, y: p.y * H, z: (p.z ?? 0) * W }))
