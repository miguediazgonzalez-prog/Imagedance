/** Recorte de persona (MediaPipe Image Segmenter, en el dispositivo). Devuelve una máscara 0..255 (255 = persona). */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { Pt } from './FaceLandmarks'
export interface Mask { data: Uint8Array; w: number; h: number }
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
// Primero el modelo multiclase (mejor con pelo); si no carga, el ligero de selfie. Ambos en storage.googleapis.com => se cachean para uso offline.
const MODELS = [
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'
]
let seg: ImageSegmenter | undefined
async function load(): Promise<ImageSegmenter> {
  const fs = await FilesetResolver.forVisionTasks(WASM); let last: unknown
  for (const modelAssetPath of MODELS) for (const delegate of ['GPU', 'CPU'] as const) {
    try { return await ImageSegmenter.createFromOptions(fs, { baseOptions: { modelAssetPath, delegate }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false }) }
    catch (e) { last = e }
  }
  throw new Error(`No se pudo cargar el modelo de recorte (${last instanceof Error ? last.message : String(last)}).`)
}
/** nose = punta de la nariz en píxeles de src: debe caer dentro de la persona, y eso fija la polaridad de la máscara sea cual sea el modelo. */
export async function segmentPerson(src: HTMLCanvasElement, nose: Pt): Promise<Mask> {
  seg ??= await load()
  const r = seg.segment(src), ms = r.confidenceMasks ?? []
  try {
    if (!ms.length) throw new Error('El recorte no devolvió ninguna máscara.')
    const labels = seg.getLabels(), bi = ms.length > 1 ? Math.max(0, labels.findIndex(l => /background|fondo/i.test(l))) : -1
    const m = ms[Math.max(0, bi)], w = m.width, h = m.height, raw = m.getAsFloat32Array()
    const p = new Float32Array(w * h); for (let i = 0; i < p.length; i++) p[i] = bi >= 0 ? 1 - raw[i] : raw[i]
    const nx = Math.min(w - 1, Math.max(0, Math.round((nose.x / src.width) * w))), ny = Math.min(h - 1, Math.max(0, Math.round((nose.y / src.height) * h)))
    if (p[ny * w + nx] < 0.5) for (let i = 0; i < p.length; i++) p[i] = 1 - p[i]
    const out = new Uint8Array(w * h); let fg = 0
    for (let i = 0; i < p.length; i++) { out[i] = Math.round(Math.min(1, Math.max(0, p[i])) * 255); if (p[i] > 0.5) fg++ }
    const frac = fg / p.length
    if (frac < 0.03 || frac > 0.98) throw new Error('No pude separar a la persona del fondo. Prueba con otra foto o deja el fondo original.')
    return { data: out, w, h }
  } finally { r.close() }
}
