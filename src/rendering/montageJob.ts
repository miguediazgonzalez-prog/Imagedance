/** Trabajo de montaje compartido: lo ejecuta el Worker (OffscreenCanvas) o, como respaldo, el hilo principal. */
import { Montage, type MontageInput } from './MontageRenderer'
import { encodeAny, type OutKind } from './encode'
export interface MontageJob extends MontageInput { audio?: { mono: Float32Array; sampleRate: number }; out?: OutKind }
export async function runMontage(j: MontageJob, canvas: HTMLCanvasElement | OffscreenCanvas, onProgress: (p: number) => void) {
  const m = new Montage(canvas, j), frames = Math.round(j.dur * j.fps)
  try { return await encodeAny(j.out, canvas, frames, j.fps, async i => { await m.prepare(i / j.fps); m.render(i / j.fps) }, onProgress, j.out === 'gif' ? undefined : j.audio) } finally { m.dispose() }
}
