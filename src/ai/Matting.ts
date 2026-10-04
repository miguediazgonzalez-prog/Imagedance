/** Afinado del recorte: filtro guiado (He et al.) que pega el borde de la máscara al borde real de la imagen y la lleva a la resolución de la foto.
 *  La máscara del modelo es gruesa (el borde «sangra» unos píxeles y deja halo del fondo original); la luminancia de la foto es la guía. Sin DOM en refineMaskData (se prueba en Node). */
import type { Mask } from './Segmenter'
/** Media en ventana (2r+1)² con bordes recortados; dos pasadas con suma deslizante, O(n). */
function box(a: Float32Array, W: number, H: number, r: number): Float32Array {
  const t = new Float32Array(a.length), o = new Float32Array(a.length)
  for (let y = 0; y < H; y++) {
    const row = y * W; let s = 0
    for (let x = 0; x <= Math.min(r, W - 1); x++) s += a[row + x]
    for (let x = 0; x < W; x++) {
      const hi = Math.min(W - 1, x + r), lo = Math.max(0, x - r); t[row + x] = s / (hi - lo + 1)
      if (x + r + 1 < W) s += a[row + x + r + 1]; if (x - r >= 0) s -= a[row + x - r]
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0; for (let y = 0; y <= Math.min(r, H - 1); y++) s += t[y * W + x]
    for (let y = 0; y < H; y++) {
      const hi = Math.min(H - 1, y + r), lo = Math.max(0, y - r); o[y * W + x] = s / (hi - lo + 1)
      if (y + r + 1 < H) s += t[(y + r + 1) * W + x]; if (y - r >= 0) s -= t[(y - r) * W + x]
    }
  }
  return o
}
/** m (cualquier tamaño) → máscara W×H refinada con la luminancia de rgba (W×H). */
export function refineMaskData(m: Mask, rgba: Uint8ClampedArray | Uint8Array, W: number, H: number, r = Math.max(2, Math.round(0.012 * Math.max(W, H))), eps = 0.004): Mask {
  const n = W * H, I = new Float32Array(n), p = new Float32Array(n)
  for (let i = 0; i < n; i++) I[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255
  // máscara a W×H (bilineal)
  for (let y = 0; y < H; y++) {
    const fy = Math.min(m.h - 1, Math.max(0, ((y + 0.5) * m.h) / H - 0.5)), y0 = Math.floor(fy), y1 = Math.min(m.h - 1, y0 + 1), wy = fy - y0
    for (let x = 0; x < W; x++) {
      const fx = Math.min(m.w - 1, Math.max(0, ((x + 0.5) * m.w) / W - 0.5)), x0 = Math.floor(fx), x1 = Math.min(m.w - 1, x0 + 1), wx = fx - x0
      p[y * W + x] = ((m.data[y0 * m.w + x0] * (1 - wx) + m.data[y0 * m.w + x1] * wx) * (1 - wy) + (m.data[y1 * m.w + x0] * (1 - wx) + m.data[y1 * m.w + x1] * wx) * wy) / 255
    }
  }
  const Ip = new Float32Array(n), II = new Float32Array(n); for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i] }
  const mI = box(I, W, H, r), mp = box(p, W, H, r), mIp = box(Ip, W, H, r), mII = box(II, W, H, r), a = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0; i < n; i++) { const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i]; a[i] = cov / (v + eps); b[i] = mp[i] - a[i] * mI[i] }
  const ma = box(a, W, H, r), mb = box(b, W, H, r), out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.min(1, Math.max(0, ma[i] * I[i] + mb[i])) * 255)
  return { data: out, w: W, h: H }
}
/** Refina la máscara con la propia foto (canvas 2D de la talla de salida). */
export const refineMask = (m: Mask, src: HTMLCanvasElement) => refineMaskData(m, src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data, src.width, src.height)
