/** Lanza el render en un Worker; si el navegador no soporta WebGL2 en OffscreenCanvas, cae al hilo principal (cediendo entre frames). */
import { runJob, type RenderJob } from './renderJob'
import { runMontage, type MontageJob } from './montageJob'
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

/** Montaje de varias fotos: igual que renderVideo (Worker, con respaldo al hilo principal). */
export async function renderMontage(job: MontageJob, onProgress: (p: number) => void): Promise<{ out: Out; where: 'worker' | 'main' }> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
    try {
      const xfer: Transferable[] = []
      const photos = await Promise.all(job.photos.map(async p => {
        const src = await createImageBitmap(p.src), bitmap = p.bg?.bitmap && (await createImageBitmap(p.bg.bitmap)), mask = p.mask && { ...p.mask, data: p.mask.data.slice() }
        xfer.push(src); if (bitmap) xfer.push(bitmap); if (mask) xfer.push(mask.data.buffer)
        return { ...p, src, bg: p.bg && { ...p.bg, bitmap }, mask }
      }))
      const audio = job.audio && { sampleRate: job.audio.sampleRate, mono: job.audio.mono.slice() }; if (audio) xfer.push(audio.mono.buffer)
      const out = await new Promise<Out>((res, rej) => {
        const w = new Worker(new URL('../workers/video.worker.ts', import.meta.url), { type: 'module' })
        w.onmessage = e => { if (e.data.p !== undefined) onProgress(e.data.p); else { w.terminate(); e.data.error ? rej(new Error(e.data.error)) : res(e.data.done) } }
        w.onerror = e => { w.terminate(); rej(new Error(e.message || 'Error en el worker')) }
        w.postMessage({ montage: { ...job, photos, audio } }, xfer)
      })
      return { out, where: 'worker' }
    } catch { /* respaldo */ }
  }
  return { out: await runMontage(job, document.createElement('canvas'), onProgress), where: 'main' }
}
