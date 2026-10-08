/** GIF animado: paleta global de 256 colores sacada de fotogramas repartidos por todo el clip (sin parpadeo de color entre fotogramas) + un solo pase de escritura. Sin audio. */
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import type { Draw, EncodeOut } from './VideoEncoder'
type Cv = HTMLCanvasElement | OffscreenCanvas
const wait = () => new Promise(r => setTimeout(r, 0))
const mk = (w: number, h: number): Cv => { if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
export async function encodeGif(canvas: Cv, frames: number, fps: number, draw: Draw, onProgress: (p: number) => void): Promise<EncodeOut> {
  const w = canvas.width, h = canvas.height, tmp = mk(w, h), tc = tmp.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  const grab = async (i: number) => { await draw(i); tc.drawImage(canvas as CanvasImageSource, 0, 0); return tc.getImageData(0, 0, w, h).data }   // copia por un 2D: el canvas de origen puede ser WebGL
  const N = Math.min(frames, 8), sample: number[] = []
  for (let k = 0; k < N; k++) { const d = await grab(Math.round(((k + 0.5) * frames) / N - 0.5)); for (let j = 0; j < d.length; j += 16) sample.push(d[j], d[j + 1], d[j + 2], 255) }
  const palette = quantize(new Uint8Array(sample), 256, { format: 'rgb444' }), gif = GIFEncoder(), delay = Math.round(1000 / fps)
  for (let i = 0; i < frames; i++) {
    const idx = applyPalette(await grab(i), palette, 'rgb444')
    gif.writeFrame(idx, w, h, { palette: i === 0 ? palette : undefined, delay, repeat: 0 })
    onProgress((i + 1) / frames); if (i % 2 === 0) await wait()
  }
  gif.finish()
  return { blob: new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }), ext: 'gif', audio: false, audioNote: 'El GIF no lleva sonido' }
}
