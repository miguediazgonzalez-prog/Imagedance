/** Encuadre de la foto: zoom, desplazamiento y giros de 90°. El recorte tiene la proporción ar = ancho/alto de la salida (1 = cuadrado, 9/16 = vertical). */
export interface Crop { zoom: number; cx: number; cy: number; rot: number }
export const dims = (bm: ImageBitmap, rot: number) => (rot % 180 ? { w: bm.height, h: bm.width } : { w: bm.width, h: bm.height })
/** Ventana de recorte en píxeles de la foto (ya girada): el mayor rectángulo de proporción ar que cabe, dividido por el zoom. */
export function winOf(bm: ImageBitmap, c: Crop, ar = 1) {
  const d = dims(bm, c.rot), h = Math.min(d.h, d.w / ar) / c.zoom
  return { w: h * ar, h }
}
export const sideOf = (bm: ImageBitmap, c: Crop) => winOf(bm, c, 1).w
export function clampCrop(bm: ImageBitmap, c: Crop, ar = 1) {
  c.zoom = Math.min(5, Math.max(1, c.zoom)); const d = dims(bm, c.rot), w = winOf(bm, c, ar), hw = w.w / 2, hh = w.h / 2
  c.cx = Math.min(d.w - hw, Math.max(hw, c.cx)); c.cy = Math.min(d.h - hh, Math.max(hh, c.cy))
}
export function resetCrop(bm: ImageBitmap, c: Crop, ar = 1) { c.zoom = 1; c.rot = 0; c.cx = bm.width / 2; c.cy = bm.height / 2; clampCrop(bm, c, ar) }
export function rotateCrop(bm: ImageBitmap, c: Crop, ar = 1) { c.rot = (c.rot + 90) % 360; const d = dims(bm, c.rot); c.cx = d.w / 2; c.cy = d.h / 2; clampCrop(bm, c, ar) }
/** Dibuja el encuadre en un canvas W×H (H = W si es cuadrado). La proporción del recorte es W/H. */
export function drawCrop(bm: ImageBitmap, c: Crop, W: number, H = W, cv: HTMLCanvasElement = document.createElement('canvas')) {
  cv.width = W; cv.height = H; const x = cv.getContext('2d')!, d = dims(bm, c.rot), k = W / winOf(bm, c, W / H).w
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H)
  x.translate(W / 2, H / 2); x.scale(k, k); x.translate(-c.cx, -c.cy); x.translate(d.w / 2, d.h / 2); x.rotate((c.rot * Math.PI) / 180)
  x.drawImage(bm, -bm.width / 2, -bm.height / 2)
  return cv
}
