/** Detección de 478 landmarks con MediaPipe Face Landmarker (WASM + GPU, con caída a CPU). */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
/** z = profundidad relativa en píxeles (MediaPipe la da en la escala del ancho); opcional por si hay landmarks sin profundidad. */
export interface Pt { x: number; y: number; z?: number }
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
let lm: FaceLandmarker | undefined, used = 'CPU'
export const getDelegate = () => used
async function load(): Promise<FaceLandmarker> {
  const fs = await FilesetResolver.forVisionTasks(WASM)
  for (const delegate of ['GPU', 'CPU'] as const) {
    try { const l = await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'IMAGE', numFaces: 1 }); used = delegate; return l }
    catch (e) { if (delegate === 'CPU') throw e }
  }
  throw new Error('No se pudo cargar el detector facial')
}
/** Devuelve landmarks en píxeles del canvas, o null si no hay rostro. */
export async function detect(src: HTMLCanvasElement): Promise<Pt[] | null> {
  lm ??= await load()
  const f = lm.detect(src).faceLandmarks[0]
  return f ? f.map(p => ({ x: p.x * src.width, y: p.y * src.height, z: p.z * src.width })) : null
}
