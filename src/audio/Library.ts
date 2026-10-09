/** «Mi música»: las canciones que subes se guardan en el dispositivo (IndexedDB) para volver a elegirlas en otras sesiones.
 *  Se guardan como ArrayBuffer (más fiable que Blob en Safari). Si IndexedDB no está disponible (navegación privada…), funciona solo durante la sesión. */
export interface LibItem { id: string; name: string; added: number; size: number; blob: Blob }
interface Rec { id: string; name: string; added: number; size: number; type: string; data: ArrayBuffer }
export const LIB_MAX_ITEMS = 20, LIB_MAX_BYTES = 60 * 1048576
const DB = 'foto-animada', STORE = 'music', mem = new Map<string, Rec>()
const open = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((res, rej) => { const t = db.transaction(STORE, mode), q = f(t.objectStore(STORE)); t.oncomplete = () => { db.close(); res(q.result) }; t.onerror = t.onabort = () => { db.close(); rej(t.error) } })
}
const hasIdb = () => typeof indexedDB !== 'undefined' && !!indexedDB
async function all(): Promise<Rec[]> { if (hasIdb()) { try { return await run('readonly', s => s.getAll() as IDBRequest<Rec[]>) } catch { /* cae a memoria */ } } return [...mem.values()] }
async function put(r: Rec) { if (hasIdb()) { try { await run('readwrite', s => s.put(r)); return } catch { /* cae a memoria */ } } mem.set(r.id, r) }
const toItem = (r: Rec): LibItem => ({ id: r.id, name: r.name, added: r.added, size: r.size, blob: new Blob([r.data], { type: r.type }) })
/** Identificador estable: la misma canción (nombre + tamaño) no se guarda dos veces. */
export function libId(name: string, size: number) { let h = 2166136261; for (const c of `${name}|${size}`) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619) } return 'u-' + (h >>> 0).toString(36) }
/** Más recientes primero. */
export async function libList(): Promise<LibItem[]> { return (await all()).sort((a, b) => b.added - a.added).map(toItem) }
export async function libAdd(file: Blob, name: string): Promise<{ item: LibItem; added: boolean }> {
  if (file.size > LIB_MAX_BYTES) throw new Error(`«${name}» pesa demasiado para guardarla (máximo ${LIB_MAX_BYTES / 1048576} MB); se usa solo esta vez.`)
  const id = libId(name, file.size), cur = await all(), had = cur.find(r => r.id === id)
  if (had) return { item: toItem(had), added: false }
  if (cur.length >= LIB_MAX_ITEMS) throw new Error(`Mi música está llena (${LIB_MAX_ITEMS} canciones): quita alguna para guardar más. Esta se usa solo esta vez.`)
  const r: Rec = { id, name, added: Date.now(), size: file.size, type: file.type || 'audio/mpeg', data: await file.arrayBuffer() }
  await put(r); return { item: toItem(r), added: true }
}
export async function libRemove(id: string) { mem.delete(id); if (hasIdb()) { try { await run('readwrite', s => s.delete(id)) } catch { /* nada */ } } }
export async function libClear() { mem.clear(); if (hasIdb()) { try { await run('readwrite', s => s.clear()) } catch { /* nada */ } } }
