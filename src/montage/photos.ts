/** Fotos del montaje: se decodifican una vez (lado largo ≤ 1800 px para no llenar la memoria), se detectan todas sus caras y se preparan al tamaño que pida cada render. */
import type { Pt } from '../ai/FaceLandmarks'
import { detectAll, scaleFace } from '../ai/MultiFace'
export interface MPhotoRec { id: number; name: string; url: string; bmp: ImageBitmap; /** caras en fracciones de la foto, de izquierda a derecha */ faces: Pt[][] }
export const MAX_PHOTOS = 8
let uid = 0
/** La foto en un canvas de lado largo `long` (nunca se amplía). */
export function scaled(bmp: ImageBitmap, long: number): HTMLCanvasElement {
  const k = Math.min(1, long / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas'); c.width = Math.max(2, Math.round(bmp.width * k)); c.height = Math.max(2, Math.round(bmp.height * k))
  const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height); return c
}
export async function loadPhoto(file: File): Promise<MPhotoRec> {
  const orig = await createImageBitmap(file), cv = scaled(orig, 1800); orig.close()
  const faces = await detectAll(cv), bmp = await createImageBitmap(cv)
  return { id: ++uid, name: file.name, url: URL.createObjectURL(file), bmp, faces }
}
/** Foto lista para el motor (lado largo = `long`): canvas (para recortar el fondo), bitmap y caras en píxeles. */
export async function prepare(rec: MPhotoRec, long: number): Promise<{ cv: HTMLCanvasElement; src: ImageBitmap; faces: Pt[][] }> {
  const cv = scaled(rec.bmp, long); return { cv, src: await createImageBitmap(cv), faces: rec.faces.map(f => scaleFace(f, cv.width, cv.height)) }
}
export function disposePhoto(r: MPhotoRec) { URL.revokeObjectURL(r.url); r.bmp.close() }
