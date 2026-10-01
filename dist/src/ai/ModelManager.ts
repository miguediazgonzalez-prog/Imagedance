/** Estado del modelo cacheado (Cache API, lo rellena el service worker) y borrado de datos locales. */
const CACHE = 'ai-models'
export async function modelStatus(): Promise<number | null> {
  if (!('caches' in window) || !(await caches.has(CACHE))) return null
  let bytes = 0
  for (const r of await (await caches.open(CACHE)).matchAll()) bytes += (await r.clone().blob()).size
  return bytes ? bytes / 1048576 : null
}
export const clearLocalData = async () => { if ('caches' in window) await caches.delete(CACHE) }
