/** Render + codificación fuera del hilo principal. Mensajes: {p} progreso, {done} resultado, {error}. */
import { runJob, type RenderJob } from '../rendering/renderJob'
const ctx = self as unknown as Worker
ctx.onmessage = async (e: MessageEvent<RenderJob>) => {
  try { ctx.postMessage({ done: await runJob(e.data, new OffscreenCanvas(e.data.src.width, e.data.src.height), p => ctx.postMessage({ p })) }) }
  catch (err) { ctx.postMessage({ error: err instanceof Error ? err.message : String(err) }) }
}
