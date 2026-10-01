/** Detección de capacidades reales del navegador/dispositivo y elección del modo FAST / BALANCED / QUALITY. */
export interface Caps { webgl2: boolean; webgpu: boolean; simd: boolean; cores: number; memory?: number; webcodecs: boolean; worker: boolean; tier: 'fast' | 'balanced' | 'quality'; ok: boolean; problems: string[] }
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
export async function detectCaps(): Promise<Caps> {
  const webgl2 = !!document.createElement('canvas').getContext('webgl2')
  let webgpu = false
  try { webgpu = !!(await (navigator as any).gpu?.requestAdapter()) } catch { /* sin WebGPU */ }
  const simd = WebAssembly.validate(SIMD), cores = navigator.hardwareConcurrency || 4, memory = (navigator as any).deviceMemory as number | undefined
  const webcodecs = 'VideoEncoder' in window, worker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
  const problems: string[] = []
  if (!webgl2) problems.push('Este navegador no soporta WebGL2.')
  if (!webcodecs) problems.push('Este navegador no soporta WebCodecs, necesario para crear el vídeo. Prueba con Safari o Chrome actualizados.')
  // deviceMemory solo existe en Chrome; en Safari se decide por núcleos y WebGPU.
  const tier = cores >= 8 && (memory === undefined ? webgpu : memory >= 8) ? 'quality' : cores >= 6 || (memory ?? 0) >= 4 ? 'balanced' : 'fast'
  return { webgl2, webgpu, simd, cores, memory, webcodecs, worker, tier, ok: problems.length === 0, problems }
}
