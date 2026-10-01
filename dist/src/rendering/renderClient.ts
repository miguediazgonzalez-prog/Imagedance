/** Lanza el render en un Worker; si el navegador no soporta WebGL2 en OffscreenCanvas, cae al hilo principal (cediendo entre frames). */
import { runJob, type RenderJob } from './renderJob'
type Out = { blob: Blob; ext: string; audio: boolean; audioNote?: string; audioInfo?: string }
export async function renderVideo(job: RenderJob, onProgress: (p: number) => void): Promise<{ out: Out; where: 'worker' | 'main' }> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
    try {
      const copy = await createImageBitmap(job.src), audio = job.audio && { sampleRate: job.audio.sampleRate, mono: job.audio.mono.slice() }
      // Copias transferibles del fondo y la máscara (los originales se conservan por si hay que caer al hilo principal).
      const bg = job.bg && { ...job.bg, bitmap: job.bg.bitmap && (await createImageBitmap(job.bg.bitmap)) }, mask = job.mask && { ...job.mask, data: job.mask.data.slice() }
      const out = await new Promise<Out>((res, rej) => {
        const w = new Worker(new URL('../workers/video.worker.ts', import.meta.url), { type: 'module' })
        w.onmessage = e => { if (e.data.p !== undefined) onProgress(e.data.p); else { w.terminate(); e.data.error ? rej(new Error(e.data.error)) : res(e.data.done) } }
        w.onerror = e => { w.terminate(); rej(new Error(e.message || 'Error en el worker')) }
        const xfer: Transferable[] = [copy]; if (audio) xfer.push(audio.mono.buffer); if (bg?.bitmap) xfer.push(bg.bitmap); if (mask) xfer.push(mask.data.buffer)
        w.postMessage({ ...job, src: copy, audio, bg, mask }, xfer)
      })
      return { out, where: 'worker' }
    } catch { /* respaldo */ }
  }
  return { out: await runJob(job, document.createElement('canvas'), onProgress), where: 'main' }
}
