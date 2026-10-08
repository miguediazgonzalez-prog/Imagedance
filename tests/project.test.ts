/** Pruebas del archivo de proyecto (módulo puro): npm test */
import { packProject, unpackProject, packFaces, unpackFaces, photoFile, frameFile, type Manifest } from '../src/montage/project'
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('✗', m) } else console.log('✓', m) }
const face = Array.from({ length: 478 }, (_, i) => ({ x: (i % 50) / 50 + 1e-7, y: (i % 33) / 33, z: -0.01 * (i % 7) }))
const m: Manifest = { v: 1, app: 'foto-animada-montaje', saved: '2026-10-08T00:00:00Z', hasBg: true, photos: [{ name: 'a.jpg', kind: 'image', fav: true, faces: packFaces([face, face]) }, { name: 'v.mp4', kind: 'video', fav: false, faces: [], frames: 3, vfps: 15 }],
  settings: { fmt: 'v', tier: 'balanced', outFmt: 'mp4', style: 'dynamic', titles: { intro: 'Hola' }, trans: ['whip'], edits: { 2: { photo: 1 } }, bgId: 'none', integrate: true, react: true, track: 'x', musicName: 'canción.mp3', startAt: 12.5 } }
const files: Record<string, Uint8Array> = { [photoFile(0)]: new Uint8Array([1, 2, 3]), [photoFile(1)]: new Uint8Array([4]), 'bg.jpg': new Uint8Array([9, 9]) }
for (let n = 0; n < 3; n++) files[frameFile(1, n)] = new Uint8Array([n, n])
const bytes = packProject(m, files), back = unpackProject(bytes)
ok(JSON.stringify(back.manifest) === JSON.stringify(m), 'el manifiesto sobrevive intacto')
ok(back.files[photoFile(0)].join() === '1,2,3' && back.files['bg.jpg'].length === 2 && back.files[frameFile(1, 2)].join() === '2,2', 'los archivos sobreviven')
const f2 = unpackFaces(back.manifest.photos[0].faces); ok(f2.length === 2 && f2[0].length === 478 && Math.abs(f2[0][10].x - face[10].x) < 1e-4 && Math.abs(f2[0][99].z - face[99].z) < 1e-4, 'las caras se guardan con 4 decimales')
const throws = (f: () => unknown, m: string) => { try { f(); ok(false, m) } catch (e) { ok(e instanceof Error && /Proyecto no válido/.test(e.message), m) } }
throws(() => unpackProject(new Uint8Array([1, 2, 3])), 'basura → error claro')
throws(() => unpackProject(packProject({ ...m, v: 2 as 1 }, files)), 'versión desconocida → error')
throws(() => unpackProject(packProject(m, { [photoFile(0)]: files[photoFile(0)] })), 'falta una foto → error')
const noFrames = { ...files }; delete noFrames[frameFile(1, 1)]; throws(() => unpackProject(packProject(m, noFrames)), 'faltan fotogramas → error')
throws(() => unpackProject(packProject({ ...m, photos: [{ ...m.photos[0], faces: [[[0, 0, 0]]] }] }, files)), 'caras con pocos puntos → error')
const noBg = { ...files }; delete noBg['bg.jpg']; throws(() => unpackProject(packProject(m, noBg)), 'falta el fondo → error')
ok(bytes.length < 4000, `archivo pequeño (${bytes.length} B)`)
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo correcto'); process.exit(fails ? 1 : 0)
