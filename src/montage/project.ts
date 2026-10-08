/** Proyecto de montaje: un único archivo .montaje (ZIP) con las fotos, los fotogramas de los vídeos, el fondo y todos los ajustes (guion, títulos, estilo…).
 *  La música no va dentro: se recuerda su nombre (o la pista incluida) para volver a elegirla, y así se puede repetir el montaje con otra canción. */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { Pt } from '../ai/FaceLandmarks'
export interface ProjectPhoto { name: string; kind: 'image' | 'video'; fav: boolean; /** [cara][landmark] = [x, y, z] en fracciones */ faces: number[][][]; frames?: number; vfps?: number }
export interface ProjectSettings {
  fmt: string; tier: string; outFmt: string; style: string; titles: unknown; trans: string[]; edits: Record<string, unknown>; bgId: string; integrate: boolean; react: boolean
  track: string; musicName: string; startAt: number; tpl?: { on: boolean; mode: string; gain: number; mirror: boolean; json: string }
}
export interface Manifest { v: 1; app: 'foto-animada-montaje'; saved: string; settings: ProjectSettings; photos: ProjectPhoto[]; hasBg: boolean }
export const EXT = '.montaje'
const r4 = (x: number) => Math.round(x * 1e4) / 1e4
export const packFaces = (faces: Pt[][]): number[][][] => faces.map(f => f.map(p => [r4(p.x), r4(p.y), r4(p.z ?? 0)]))
export const unpackFaces = (faces: number[][][]): Pt[][] => faces.map(f => f.map(p => ({ x: p[0], y: p[1], z: p[2] })))
export const photoFile = (i: number) => `photos/${i}.jpg`
export const frameFile = (i: number, n: number) => `frames/${i}/${String(n).padStart(3, '0')}.jpg`
export function packProject(m: Manifest, files: Record<string, Uint8Array>): Uint8Array {
  const z: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = { 'project.json': [strToU8(JSON.stringify(m)), { level: 6 }] }
  for (const [k, v] of Object.entries(files)) z[k] = [v, { level: 0 }]   // los JPEG ya están comprimidos
  return zipSync(z as never)
}
const bad = (m: string): never => { throw new Error(`Proyecto no válido: ${m}.`) }
export function unpackProject(bytes: Uint8Array): { manifest: Manifest; files: Record<string, Uint8Array> } {
  let files: Record<string, Uint8Array>; try { files = unzipSync(bytes) } catch { return bad('no es un archivo .montaje') }
  if (!files['project.json']) bad('falta project.json')
  let m: Manifest; try { m = JSON.parse(strFromU8(files['project.json'])) } catch { return bad('project.json ilegible') }
  if (!m || m.v !== 1 || m.app !== 'foto-animada-montaje') bad('versión o aplicación desconocida')
  if (!Array.isArray(m.photos) || !m.photos.length || m.photos.length > 24) bad('lista de fotos vacía o demasiado larga')
  m.photos.forEach((p, i) => {
    if (!files[photoFile(i)]) bad(`falta la foto ${i + 1}`)
    if (!Array.isArray(p.faces) || p.faces.some(f => !Array.isArray(f) || f.length < 478 || f.some(q => !Array.isArray(q) || q.length < 3 || q.some(x => !Number.isFinite(x))))) bad(`caras de la foto ${i + 1} incorrectas`)
    if (p.kind === 'video') { if (!(p.frames! >= 1) || !(p.vfps! > 0)) bad(`datos del vídeo ${i + 1}`); for (let n = 0; n < p.frames!; n++) if (!files[frameFile(i, n)]) bad(`faltan fotogramas del vídeo ${i + 1}`) }
  })
  if (!m.settings || typeof m.settings !== 'object') bad('faltan los ajustes')
  if (m.hasBg && !files['bg.jpg']) bad('falta la imagen de fondo')
  return { manifest: m, files }
}
