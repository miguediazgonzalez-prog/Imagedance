/** Encuadre de la foto: zoom, desplazamiento y giros de 90°. El recorte sale siempre cuadrado. */
export interface Crop { zoom: number; cx: number; cy: number; rot: number }
export const dims = (bm: ImageBitmap, rot: number) => (rot % 180 ? { w: bm.height, h: bm.width } : { w: bm.width, h: bm.height })
export const sideOf = (bm: ImageBitmap, c: Crop) => Math.min(dims(bm, c.rot).w, dims(bm, c.rot).h) / c.zoom
export function clampCrop(bm: ImageBitmap, c: Crop) {
  c.zoom = Math.min(5, Math.max(1, c.zoom)); const d = dims(bm, c.rot), s = sideOf(bm, c) / 2
  c.cx = Math.min(d.w - s, Math.max(s, c.cx)); c.cy = Math.min(d.h - s, Math.max(s, c.cy))
}
export function resetCrop(bm: ImageBitmap, c: Crop) { c.zoom = 1; c.rot = 0; c.cx = bm.width / 2; c.cy = bm.height / 2 }
export function rotateCrop(bm: ImageBitmap, c: Crop) { c.rot = (c.rot + 90) % 360; const d = dims(bm, c.rot); c.cx = d.w / 2; c.cy = d.h / 2; clampCrop(bm, c) }
export function drawCrop(bm: ImageBitmap, c: Crop, S: number, cv: HTMLCanvasElement = document.createElement('canvas')) {
  cv.width = cv.height = S; const x = cv.getContext('2d')!, d = dims(bm, c.rot), k = S / sideOf(bm, c)
  x.fillStyle = '#fff'; x.fillRect(0, 0, S, S)
  x.translate(S / 2, S / 2); x.scale(k, k); x.translate(-c.cx, -c.cy); x.translate(d.w / 2, d.h / 2); x.rotate((c.rot * Math.PI) / 180)
  x.drawImage(bm, -bm.width / 2, -bm.height / 2)
  return cv
}
