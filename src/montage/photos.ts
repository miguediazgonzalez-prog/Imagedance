/** Elementos del montaje: fotos (se detectan todas sus caras) y vídeos cortos (se guardan como fotogramas JPEG que se decodifican al vuelo).
 *  Se decodifican una vez con lado largo ≤ 2200 px y se preparan al tamaño que pida cada render. */
import type { Pt } from '../ai/FaceLandmarks'
import { detectAll, scaleFace } from '../ai/MultiFace'
export interface MPhotoRec {
  id: number; name: string; url: string; bmp: ImageBitmap; kind: 'image' | 'video'; fav: boolean
  /** caras en fracciones de la foto, de izquierda a derecha (los vídeos no llevan) */ faces: Pt[][]
  /** JPEG de la foto (o del primer fotograma): para miniatura y para guardar el proyecto */ blob: Blob
  frames?: Blob[]; vfps?: number
}
export const MAX_PHOTOS = 8
export const VIDEO_MAX_S = 6, VIDEO_FPS = 15
let uid = 0
type Sized = CanvasImageSource & { width: number; height: number }
/** La imagen en un canvas de lado largo `long` (nunca se amplía). */
export function scaled(src: Sized, long: number): HTMLCanvasElement {
  const k = Math.min(1, long / Math.max(src.width, src.height)), c = document.createElement('canvas'); c.width = Math.max(2, Math.round(src.width * k)); c.height = Math.max(2, Math.round(src.height * k))
  const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height); return c
}
const jpeg = (c: HTMLCanvasElement, q: number) => new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('No se pudo comprimir la imagen.'))), 'image/jpeg', q))
export async function loadPhoto(file: File): Promise<MPhotoRec> {
  const orig = await createImageBitmap(file), cv = scaled(orig, 2200); orig.close()
  const bmp = await createImageBitmap(cv), blob = await jpeg(cv, 0.92), faces = await detectAll(scaled(bmp, 1280))
  return { id: ++uid, name: file.name, url: URL.createObjectURL(blob), bmp, kind: 'image', fav: false, faces, blob }
}
const seek = (v: HTMLVideoElement, t: number) => new Promise<void>(res => { const to = setTimeout(done, 2500); function done() { v.removeEventListener('seeked', done); clearTimeout(to); res() } v.addEventListener('seeked', done); v.currentTime = Math.min(t, Math.max(0, v.duration - 0.01)) })
/** Vídeo corto → los primeros VIDEO_MAX_S s a VIDEO_FPS fps, como JPEG de lado largo ≤ 720. Sale como metraje (sin deformar) en bucle. */
export async function loadVideo(file: File, onProgress: (p: number) => void): Promise<MPhotoRec> {
  const url = URL.createObjectURL(file), v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
  try {
    await new Promise<void>((res, rej) => { const to = setTimeout(() => rej(new Error('El vídeo tarda demasiado en abrirse.')), 20000); v.onloadeddata = () => { clearTimeout(to); res() }; v.onerror = () => { clearTimeout(to); rej(new Error('No se pudo abrir el vídeo (formato no compatible; prueba MP4 H.264).')) } })
    if (!v.videoWidth) throw new Error('El vídeo no tiene imagen.')
    const dur = Math.min(Number.isFinite(v.duration) ? v.duration : VIDEO_MAX_S, VIDEO_MAX_S), n = Math.max(2, Math.floor(dur * VIDEO_FPS)), k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight))
    const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(v.videoWidth * k)); c.height = Math.max(2, Math.round(v.videoHeight * k)); const g = c.getContext('2d')!, frames: Blob[] = []
    for (let i = 0; i < n; i++) { await seek(v, i / VIDEO_FPS); g.drawImage(v, 0, 0, c.width, c.height); frames.push(await jpeg(c, 0.82)); onProgress((i + 1) / n) }
    return { id: ++uid, name: file.name, url: URL.createObjectURL(frames[0]), bmp: await createImageBitmap(frames[0]), kind: 'video', fav: false, faces: [], blob: frames[0], frames, vfps: VIDEO_FPS }
  } finally { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load() }
}
/** Elemento listo para el motor (lado largo = `long`): canvas (para recortar el fondo), bitmap y caras en píxeles. Los vídeos van a su tamaño. */
export async function prepare(rec: MPhotoRec, long: number): Promise<{ cv: HTMLCanvasElement; src: ImageBitmap; faces: Pt[][] }> {
  if (rec.kind === 'video') { const cv = document.createElement('canvas'); cv.width = cv.height = 2; return { cv, src: await createImageBitmap(rec.bmp), faces: [] } }
  const cv = scaled(rec.bmp, long); return { cv, src: await createImageBitmap(cv), faces: rec.faces.map(f => scaleFace(f, cv.width, cv.height)) }
}
export function disposePhoto(r: MPhotoRec) { URL.revokeObjectURL(r.url); r.bmp.close() }
/** Reconstruye un elemento desde un proyecto guardado (sin volver a detectar caras). */
export async function restorePhoto(o: { name: string; kind: 'image' | 'video'; fav: boolean; faces: Pt[][]; blob: Blob; frames?: Blob[]; vfps?: number }): Promise<MPhotoRec> {
  return { id: ++uid, name: o.name, url: URL.createObjectURL(o.blob), bmp: await createImageBitmap(o.blob), kind: o.kind, fav: o.fav, faces: o.faces, blob: o.blob, frames: o.frames, vfps: o.vfps }
}
