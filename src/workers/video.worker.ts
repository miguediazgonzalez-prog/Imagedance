/** Render + codificación fuera del hilo principal. Mensajes: {p} progreso, {done} resultado, {error}. Entrada: un RenderJob (una foto) o {montage} (varias fotos). */
import { runJob, type RenderJob } from '../rendering/renderJob'
import { runMontage, type MontageJob } from '../rendering/montageJob'
const ctx = self as unknown as Worker
ctx.onmessage = async (e: MessageEvent<RenderJob | { montage: MontageJob }>) => {
  try {
    const d = e.data, p = (x: number) => ctx.postMessage({ p: x })
    ctx.postMessage({ done: 'montage' in d ? await runMontage(d.montage, new OffscreenCanvas(d.montage.ow, d.montage.oh), p) : await runJob(d, new OffscreenCanvas(d.src.width, d.src.height), p) })
  } catch (err) { ctx.postMessage({ error: err instanceof Error ? err.message : String(err) }) }
}
