/** Trabajo de montaje compartido: lo ejecuta el Worker (OffscreenCanvas) o, como respaldo, el hilo principal. */
import { Montage, type MontageInput } from './MontageRenderer'
import { encodeVideo } from './VideoEncoder'
export interface MontageJob extends MontageInput { audio?: { mono: Float32Array; sampleRate: number } }
export async function runMontage(j: MontageJob, canvas: HTMLCanvasElement | OffscreenCanvas, onProgress: (p: number) => void) {
  const m = new Montage(canvas, j), frames = Math.round(j.dur * j.fps)
  try { return await encodeVideo(canvas, frames, j.fps, i => m.render(i / j.fps), onProgress, j.audio) } finally { m.dispose() }
}
