/** Brazos de la foto: hombro, codo, muñeca y mano con MediaPipe Pose (en el dispositivo). Devuelve null en cada lado cuyo brazo no se ve entero en la foto. */
import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import { makeJoints, type ArmJoints, type ArmRig } from './ArmSkin'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
export const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
let pl: PoseLandmarker | undefined
async function load(): Promise<PoseLandmarker> {
  const fs = await FilesetResolver.forVisionTasks(WASM); let last: unknown
  for (const delegate of ['GPU', 'CPU'] as const) {
    try { return await PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'IMAGE', numPoses: 1 }) } catch (e) { last = e }
  }
  throw new Error(`No se pudo cargar el modelo de cuerpo (${last instanceof Error ? last.message : String(last)}).`)
}
const seen = (p?: NormalizedLandmark, minVis = 0.5) => !!p && (p.visibility ?? 0) > minVis && p.x > -0.02 && p.x < 1.02 && p.y > -0.02 && p.y < 1.02
/** Un brazo: índices MediaPipe de hombro, codo, muñeca, meñique e índice. */
function arm(P: NormalizedLandmark[], [si, ei, wi, pi, ii]: number[], W: number, H: number): ArmJoints | null {
  if (!seen(P[si]) || !seen(P[ei]) || !seen(P[wi])) return null
  const px = (p: NormalizedLandmark) => ({ x: p.x * W, y: p.y * H })
  const kn = seen(P[pi], 0.4) && seen(P[ii], 0.4) ? { x: ((P[pi].x + P[ii].x) / 2) * W, y: ((P[pi].y + P[ii].y) / 2) * H } : undefined
  return makeJoints(px(P[si]), px(P[ei]), px(P[wi]), kn)
}
/** Esqueleto de brazos de la foto (lados de la PANTALLA). Si no hay persona o no se ven brazos, ambos lados son null. */
export async function detectArms(src: HTMLCanvasElement): Promise<ArmRig> {
  pl ??= await load()
  const r = pl.detect(src), P = r.landmarks[0]; if (!P) return { l: null, r: null }
  const subjL = arm(P, [11, 13, 15, 17, 19], src.width, src.height), subjR = arm(P, [12, 14, 16, 18, 20], src.width, src.height)
  // El "izquierdo" del sujeto cae a la derecha de la pantalla en una foto de frente: se asigna por posición del hombro, no por nombre
  const leftOnScreen = P[11].x < P[12].x
  return leftOnScreen ? { l: subjL, r: subjR } : { l: subjR, r: subjL }
}
