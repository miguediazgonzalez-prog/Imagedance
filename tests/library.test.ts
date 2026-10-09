/** Pruebas de «Mi música» (IndexedDB simulada): npm test */
import 'fake-indexeddb/auto'
import { libAdd, libList, libRemove, libClear, libId, LIB_MAX_ITEMS, LIB_MAX_BYTES } from '../src/audio/Library'
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('✗', m) } else console.log('✓', m) }
const blob = (n: number, t = 'audio/mpeg') => new Blob([new Uint8Array(n).map((_, i) => i % 251)], { type: t })
await libClear()
ok((await libList()).length === 0, 'empieza vacía')
const a = await libAdd(blob(1000), 'a.mp3'); await new Promise(r => setTimeout(r, 5)); const b = await libAdd(blob(2000, 'audio/wav'), 'b.wav')
ok(a.added && b.added, 'se añaden dos canciones')
const l = await libList(); ok(l.length === 2 && l[0].name === 'b.wav' && l[1].name === 'a.mp3', 'más recientes primero')
ok(l[0].blob.size === 2000 && l[0].blob.type === 'audio/wav' && (await l[1].blob.arrayBuffer()).byteLength === 1000, 'el contenido y el tipo se conservan')
const again = await libAdd(blob(1000), 'a.mp3'); ok(!again.added && again.item.id === a.item.id && (await libList()).length === 2, 'la misma canción no se duplica')
ok(libId('a.mp3', 1000) === a.item.id && libId('a.mp3', 1001) !== a.item.id && libId('c.mp3', 1000) !== a.item.id, 'identificador estable por nombre y tamaño')
await libRemove(a.item.id); ok((await libList()).map(x => x.name).join() === 'b.wav', 'quitar una canción')
let err = ''; try { await libAdd({ size: LIB_MAX_BYTES + 1 } as Blob, 'enorme.wav') } catch (e) { err = (e as Error).message } ok(/pesa demasiado/.test(err), 'archivo enorme → error claro')
await libClear(); for (let i = 0; i < LIB_MAX_ITEMS; i++) await libAdd(blob(10 + i), `s${i}.mp3`)
err = ''; try { await libAdd(blob(999), 'extra.mp3') } catch (e) { err = (e as Error).message } ok(/está llena/.test(err) && (await libList()).length === LIB_MAX_ITEMS, 'biblioteca llena → error claro y no se pierde nada')
await libClear(); ok((await libList()).length === 0, 'vaciar')
// Sin IndexedDB (navegación privada…): funciona en memoria durante la sesión
const idb = (globalThis as any).indexedDB; delete (globalThis as any).indexedDB
await libAdd(blob(50), 'mem.mp3'); ok((await libList()).length === 1, 'sin IndexedDB: se guarda en memoria'); await libClear(); ok((await libList()).length === 0, 'sin IndexedDB: vaciar'); (globalThis as any).indexedDB = idb
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo correcto'); process.exit(fails ? 1 : 0)
