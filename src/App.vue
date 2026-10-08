<script setup lang="ts">
import { ref, shallowRef, reactive, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { detectCaps, type Caps } from './ai/Capabilities'
import DebugPanel from './components/DebugPanel.vue'
import { modelStatus, clearLocalData } from './ai/ModelManager'
import { clampCrop, resetCrop, rotateCrop, drawCrop, winOf } from './components/cropper'
import { detect, getDelegate, type Pt } from './ai/FaceLandmarks'
import { parseInstruction, type VisemeFrame, type DanceSpec } from './ai/MotionPlanner'
import { startRecording, decodeAudio, audioVisemes, textVisemes, speakPreview, toMono } from './audio/SpeechEngine'
import { renderVideo } from './rendering/renderClient'
import { analyzeTempo, beatOffset, energyFrames, type Tempo } from './audio/BeatDetector'
import { analyzeSpectral, analyzeBars, bestStart, bandFrames, type Spectral, type Bars } from './audio/Structure'
import { TRACKS, trackUrl, type Track } from './audio/Tracks'
import { segmentPerson, type Mask } from './ai/Segmenter'
import { refineMask } from './ai/Matting'
import { BG_UI, coverBitmap, type BgId, type BgSpec } from './rendering/Backgrounds'
import { Preview, unlockAudio } from './rendering/Preview'
import { trackVideo, TRACK_MAX_S } from './ai/VideoTracker'
import { detectArms } from './ai/BodyPose'
import type { ArmRig } from './ai/ArmSkin'
import { bodyScaleFor, makePlay, parseTemplate, serializeTemplate, type MotionTemplate, type SyncMode, type TplPlay } from './ai/MotionTemplate'
import { MontagePreview } from './rendering/MontagePreview'
import { renderMontage } from './rendering/renderClient'
import type { MPhoto, TplCfg } from './rendering/MontageRenderer'
import type { Style } from './rendering/Montage'
import { loadPhoto, prepare, disposePhoto, MAX_PHOTOS, type MPhotoRec } from './montage/photos'
const tiers = { fast: { s: 512, fps: 24, d: 5, dd: 60, label: 'Rápido · 512 px · 5 s' }, balanced: { s: 768, fps: 24, d: 7, dd: 60, label: 'Normal · 768 px · 7 s' }, quality: { s: 1024, fps: 30, d: 10, dd: 60, label: 'Alta · 1024 px · 10 s' } }
const tier = ref<keyof typeof tiers>('fast'), prompt = ref('')
// Formato de salida: cuadrado 1:1 o vertical 9:16 (redes). El vertical conserva el nº de píxeles de la talla elegida: 512→384×682, 768→576×1024, 1024→768×1366
const fmt = ref<'sq' | 'v'>('sq'), AR = computed(() => (fmt.value === 'v' ? 9 / 16 : 1))
const even = (n: number) => Math.round(n / 2) * 2
const dimsFor = (s: number) => (fmt.value === 'v' ? (() => { const W = even(0.75 * s); return { W, H: even((W * 16) / 9) } })() : { W: s, H: s })
const bitmap = ref<ImageBitmap | null>(null), photoUrl = ref(''), videoUrl = ref(''), out = ref<{ blob: Blob; ext: string; audio: boolean; audioNote?: string; audioInfo?: string } | null>(null)
const recording = ref(false), voiceBuf = ref<AudioBuffer | null>(null), voiceUrl = ref(''), speechText = ref(''), hasAudio = ref(false)
let rec: Awaited<ReturnType<typeof startRecording>> | null = null, aud: HTMLAudioElement | null = null
const BUILD = 'plantilla-1', diag = ref('')
let diagBase = ''
const busy = ref(false), status = ref(''), pct = ref(0), canShare = !!navigator.share
// Vista previa en vivo: mismo renderizador que el export, a 512 px y ~30 fps
const PV = 512, PV_FPS = 30, previewing = ref(false), pvBusy = ref(false), pvPlaying = ref(false), pvCv = ref<HTMLCanvasElement | null>(null)
let pvRig: ArmRig | null | undefined, pvRigBusy = false, pv: Preview | null = null, pvMask: Mask | undefined, pvSrc: HTMLCanvasElement | null = null, pvL: Pt[] | null = null, pvT = 0, pvA = false
const debug = new URLSearchParams(location.search).has('debug')
// Baile con música + fondo
const dance = ref(true), selTrack = ref(''), analyzing = ref(false), musicName = ref(''), musicUrl = ref(''), musicDur = ref(0), bpm = ref(0), startAt = ref(0)
const integrate = ref(true)   // luz y sombra del fondo sobre la persona
const bgId = ref<BgId | 'none'>('none'), bgBmp = ref<ImageBitmap | null>(null), lastDance = ref(false), playUrl = ref('')
let musicBuf: AudioBuffer | null = null, musicMono: Float32Array | null = null, tempo: Tempo | null = null, playFrom = 0, gridOrigin: number | null = null  // gridOrigin: instante de un beat conocido (canciones incluidas); null = hay que detectarlo
let enKey = '', enVal: number[] = []
const energyFor = (fps: number, t0: number, frames: number) => { const k = `${fps}|${t0}|${frames}`; if (k !== enKey) { enVal = energyFrames(musicMono!, musicBuf!.sampleRate, fps, t0, frames); enKey = k } return enVal }
// Estructura musical (compases y secciones): el espectro se calcula una vez por canción; los compases, al cambiar BPM o mover el 1
let spectral: Spectral | null = null, structP: Promise<void> | null = null, barsKey = '', g0Key = '', g0Val = 0
const barShift = ref(0), bars = shallowRef<Bars | null>(null)
function ensureStructure(): Promise<void> {
  if (spectral || !musicMono || !musicBuf) return Promise.resolve()
  const mono = musicMono, sr = musicBuf.sampleRate
  return (structP ??= analyzeSpectral(mono, sr).then(S => { if (mono === musicMono) spectral = S }).catch(() => {}).finally(() => { structP = null }))
}
/** Compases/secciones para el BPM actual (null mientras no haya espectro). Se cachea por BPM y desplazamiento del 1. */
function refreshBars() {
  if (!spectral || bpm.value <= 0 || !musicBuf) { bars.value = null; barsKey = ''; return null }
  const key = `${bpm.value}|${barShift.value}`; if (key === barsKey && bars.value) return bars.value
  const per = 60 / bpm.value
  if (gridOrigin === null && g0Key !== String(bpm.value)) { g0Val = beatOffset(tempo!, bpm.value, 0, Math.min(musicBuf.duration, 480)); g0Key = String(bpm.value) }   // fase global de la rejilla (tempo constante)
  const g0 = gridOrigin !== null ? ((gridOrigin % per) + per) % per : g0Val
  barsKey = key; return (bars.value = analyzeBars(spectral, bpm.value, g0, gridOrigin !== null, barShift.value))
}
/** Coreografía del fragmento [t0, t0+dur] de la canción actual (la usan el export y la vista previa, así se ven idénticos). */
function makeDance(fps: number, t0: number, dur: number, frames: number): DanceSpec {
  const per = 60 / bpm.value, offset = gridOrigin !== null ? (((gridOrigin - t0) % per) + per) % per : beatOffset(tempo!, bpm.value, t0, t0 + dur)
  const spec: DanceSpec = { bpm: bpm.value, offset, fps, energy: energyFor(fps, t0, frames) }, B = refreshBars()
  if (spectral) spec.bands = bandFrames(spectral, fps, t0, frames)   // graves/medios/agudos: los fondos reaccionan al espectro
  if (B && B.starts.length >= 4) {
    // Beat j de la rejilla global más cercano al primer beat del clip → qué beat del clip abre compás
    const j0 = Math.round((t0 + offset - B.g0) / per), cuts = B.cuts
    spec.bar0 = (((B.jD - j0) % 4) + 4) % 4
    spec.secBase = cuts.filter(c => c.t < t0 - 0.02).length
    spec.cuts = cuts.filter(c => c.t >= t0 - 0.02 && c.t < t0 + dur).map(c => ({ t: Math.max(0, c.t - t0), drop: c.drop }))
  }
  return spec
}
const structText = computed(() => {
  const B = bars.value; if (!B || B.starts.length < 4) return ''
  const conf = B.known ? 'exacto' : B.conf >= 0.6 ? 'confianza alta' : B.conf >= 0.3 ? 'confianza media' : 'confianza baja'
  const dr = B.cuts.filter(c => c.drop).length
  return `Primer tiempo del compás: ${conf}. ${B.cuts.length ? `${B.cuts.length} cambio${B.cuts.length > 1 ? 's' : ''} de sección${dr ? ` (${dr} drop${dr > 1 ? 's' : ''})` : ''}.` : 'Sin cambios de sección claros.'}`
})
function bestMoment() {
  const B = refreshBars(); if (!B) return
  startAt.value = Math.min(maxStart.value, Math.round(bestStart(B, Math.min(danceMax.value, musicDur.value)) * 2) / 2)
  status.value = 'Fragmento elegido: arranca en el cambio de sección más potente.'
}
const danceMax = computed(() => tiers[tier.value].dd)
const maxStart = computed(() => Math.max(0, musicDur.value - Math.min(danceMax.value, musicDur.value)))
const danceDur = computed(() => Math.max(1, Math.min(danceMax.value, musicDur.value - startAt.value)))
watch([tier, musicDur], () => { startAt.value = Math.min(startAt.value, maxStart.value) })
const tierLabel = (k: keyof typeof tiers) => { const [name] = tiers[k].label.split(' · '), D = dimsFor(tiers[k].s); return `${name} · ${fmt.value === 'v' ? `${D.W}×${D.H}` : `${D.W} px`} · ${dance.value ? `hasta ${tiers[k].dd}` : tiers[k].d} s` }
const setBpm = (v: number) => { bpm.value = Math.min(240, Math.max(40, Math.round(v * 10) / 10)); barShift.value = 0 }
function clearMusic() { if (musicUrl.value) URL.revokeObjectURL(musicUrl.value); musicUrl.value = ''; musicName.value = ''; selTrack.value = ''; gridOrigin = null; musicDur.value = 0; bpm.value = 0; startAt.value = 0; musicBuf = musicMono = tempo = null; aud = null; enKey = ''; spectral = null; structP = null; barsKey = ''; g0Key = ''; barShift.value = 0; bars.value = null }
/** Carga una canción (subida o incluida), la analiza y deja lista la edición. `known` = BPM exacto de las incluidas; `auto` = carga silenciosa al abrir la app. */
async function loadMusic(blob: Blob, name: string, known?: number, trackId = '', auto = false) {
  analyzing.value = true; stopMontagePreview(); clear(false); clearMusic(); if (!auto) status.value = 'Leyendo el audio…'
  try {
    const buf = await decodeAudio(blob); if (!auto) status.value = 'Calculando el ritmo…'; await new Promise(r => setTimeout(r, 30))
    musicBuf = buf; musicMono = toMono(buf); tempo = analyzeTempo(musicMono, buf.sampleRate); gridOrigin = known ? 0 : null
    musicUrl.value = URL.createObjectURL(blob); musicName.value = name; selTrack.value = trackId; musicDur.value = buf.duration; bpm.value = known ?? tempo.bpm
    if (!auto) status.value = known ? `${name}: ${known} BPM. Elige fondo, foto y pulsa Animar.` : tempo.conf < 0.08 ? 'No noto un pulso claro en este audio. Ajusta el BPM a mano si hace falta.' : `Ritmo detectado: ${tempo.bpm} BPM. Si baila a media velocidad o al doble, usa ÷2 / ×2.`
    pvLater(true); void ensureStructure().then(() => { refreshBars(); pvLater(false) })
  } catch { clearMusic(); if (!auto) status.value = 'No pude leer ese audio. Prueba con MP3, M4A, WAV u OGG.' } finally { analyzing.value = false }
}
async function pickMusic(e: Event) {
  const input = e.target as HTMLInputElement, f = input.files?.[0]; input.value = ''; if (!f) return
  await loadMusic(f, f.name)
}
async function pickTrack(t: Track, auto = false) {
  if (busy.value || analyzing.value) return
  analyzing.value = true; if (!auto) status.value = `Cargando ${t.name}…`
  try { const r = await fetch(trackUrl(t)); if (!r.ok) throw new Error(String(r.status)); await loadMusic(await r.blob(), t.name, t.bpm, t.id, auto) }
  catch { analyzing.value = false; if (!auto) status.value = 'No pude cargar esa canción (¿sin conexión?). Prueba otra o sube la tuya.' }
}
async function pickBg(e: Event) {
  const input = e.target as HTMLInputElement, f = input.files?.[0]; input.value = ''; if (!f) return
  try { bgBmp.value = await createImageBitmap(f); bgId.value = 'image'; status.value = '' } catch { status.value = 'No pude abrir esa imagen de fondo. Prueba con JPG, PNG o WebP.' }
}
// Imitar un vídeo: plantilla de movimientos (cabeza, expresión y torso) sacada de un vídeo de referencia y aplicada a la foto
const tpl = shallowRef<MotionTemplate | null>(null), tplOn = ref(true), tplGain = ref(1), tplMirror = ref(false), tplMode = ref<SyncMode>('beat')
const tplArms = ref(true), tplBusy = ref(false), tplPct = ref(0), tplNote = ref(''), refFile = shallowRef<File | null>(null)
let tplCtl: AbortController | null = null
const MODES: { id: SyncMode; label: string; hint: string }[] = [
  { id: 'beat', label: '🥁 Al ritmo', hint: 'Ajusta el ciclo de baile al BPM de la canción y hace coincidir el golpe con el beat.' },
  { id: 'video', label: '🎞 Como el vídeo', hint: 'Mismo tiempo que el vídeo original: úsalo con el audio del vídeo como música (botón de abajo).' },
  { id: 'free', label: '🔁 Tal cual', hint: 'Se repite en bucle a la velocidad original, sin ajustar nada.' }
]
const tplHint = computed(() => (tplMode.value === 'beat' && tpl.value && !(tpl.value.period && (tpl.value.periodConf ?? 0) >= 0.2)) ? 'Esta plantilla no tiene un ciclo repetido claro: en "Al ritmo" se reproduce tal cual.' : MODES.find(m => m.id === tplMode.value)!.hint)
/** Plantilla lista para reproducir sobre la foto actual (null si no hay o está desactivada). */
function tplPlay(L: Pt[], W: number, H: number, spec: DanceSpec | null, startAtS: number, rig?: ArmRig | null): TplPlay | null {
  return tpl.value && tplOn.value ? makePlay(tpl.value, { mode: tplMode.value, gain: tplGain.value, mirror: tplMirror.value, sc: bodyScaleFor(L, W, H), startAt: startAtS, spec, rig: tplArms.value ? rig : null }) : null
}
/** Brazos de la foto, solo si la plantilla trae brazos y se piden. Si el modelo de cuerpo falla, sigue sin brazos (cabeza y torso funcionan igual). */
const tplWantsArms = () => !!(tpl.value && tplOn.value && tplArms.value && (tpl.value.armL || tpl.value.armR))
async function armsOf(src: HTMLCanvasElement): Promise<ArmRig | null> {
  if (!tplWantsArms()) return null
  try { return await detectArms(src) } catch (e) { status.value = (e instanceof Error ? e.message : String(e)) + ' Sigo sin mover los brazos.'; return null }
}
const rigNote = (rig: ArmRig | null) => (!rig ? '' : rig.l && rig.r ? ' Mueve los dos brazos.' : rig.l || rig.r ? ' Solo se ve un brazo en la foto: mueve ese.' : ' En esta foto no se ven los brazos enteros (hombro, codo y muñeca): para moverlos, usa una foto de medio cuerpo con los brazos visibles.')
async function pickRefVideo(e: Event) {
  const input = e.target as HTMLInputElement, f = input.files?.[0]; input.value = ''; if (!f || tplBusy.value) return
  tplBusy.value = true; tplPct.value = 0; tplCtl = new AbortController(); stopPreview(); clear(false)
  try {
    const r = await trackVideo(f, (p, m) => { tplPct.value = Math.round(p * 100); status.value = m }, 0, tplCtl.signal)
    tpl.value = r.tpl; tplNote.value = r.note; refFile.value = f; tplOn.value = true
    status.value = `Plantilla lista (${r.note}). ${musicName.value ? 'Pulsa la vista previa o Animar.' : 'Elige una canción para que baile con ella.'}`
  } catch (err) { status.value = err instanceof Error ? err.message : String(err) } finally { tplBusy.value = false; tplCtl = null }
}
async function useRefAudio() {
  const f = refFile.value; if (!f || busy.value || analyzing.value) return
  await loadMusic(f, f.name); if (musicBuf) { tplMode.value = 'video'; status.value = `Usando el audio de «${f.name}». Los movimientos siguen el mismo tiempo que el vídeo (solo los primeros ${TRACK_MAX_S} s tienen plantilla; después se repite).` }
}
async function loadTplFile(e: Event) {
  const input = e.target as HTMLInputElement, f = input.files?.[0]; input.value = ''; if (!f) return
  try { tpl.value = parseTemplate(await f.text()); tplNote.value = `${tpl.value.dur.toFixed(1)} s${tpl.value.hasBody ? ' · con torso' : ' · solo cabeza y expresión'}`; refFile.value = null; tplOn.value = true; status.value = 'Plantilla cargada.' }
  catch (err) { status.value = err instanceof Error ? err.message : String(err) }
}
function saveTpl() {
  if (!tpl.value) return
  const a = document.createElement('a'), u = URL.createObjectURL(new Blob([serializeTemplate(tpl.value)], { type: 'application/json' }))
  a.href = u; a.download = `${tpl.value.name || 'plantilla'}.movimiento.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000)
}
function clearTpl() { tplCtl?.abort(); tpl.value = null; refFile.value = null; tplNote.value = '' }
// ───────────── Montaje: varias fotos, todas las personas de cada foto, un único vídeo ─────────────
const mont = ref(false), mPhotos = shallowRef<MPhotoRec[]>([]), mStyle = ref<Style>('dynamic'), mAdding = ref(false)
const STYLES: { id: Style; label: string; hint: string }[] = [
  { id: 'soft', label: '🎞 Elegante', hint: 'Planos largos, cámara suave y transiciones limpias.' },
  { id: 'dynamic', label: '⚡ Dinámico', hint: 'Cortes al compás, un zoom con cada beat y destellos en los cambios de sección.' },
  { id: 'extreme', label: '💥 Explosivo', hint: 'Cortes muy rápidos, cámara que golpea, glitch RGB y sacudida en los drops.' }
]
const mPeople = computed(() => mPhotos.value.reduce((n, p) => n + p.faces.length, 0))
const mHint = computed(() => !mPhotos.value.length ? 'Elige entre 1 y ' + MAX_PHOTOS + ' fotos: cada persona que se vea baila a su manera y el montaje corta al ritmo de la música.' : `${mPhotos.value.length} foto${mPhotos.value.length > 1 ? 's' : ''} · ${mPeople.value} persona${mPeople.value === 1 ? '' : 's'}. ${STYLES.find(x => x.id === mStyle.value)!.hint}`)
const tick = () => new Promise(r => setTimeout(r, 30))
async function addPhotos(e: Event) {
  const input = e.target as HTMLInputElement, files = [...(input.files ?? [])]; input.value = ''; if (!files.length || mAdding.value) return
  stopMontagePreview(); clear(false); mAdding.value = true
  try {
    const room = MAX_PHOTOS - mPhotos.value.length, take = files.slice(0, Math.max(0, room)), got: MPhotoRec[] = []; let bad = 0
    for (const [i, f] of take.entries()) {
      status.value = `Buscando personas en la foto ${i + 1} de ${take.length}… (la primera vez se descarga el modelo)`; await tick()
      try { got.push(await loadPhoto(f)) } catch { bad++ }
    }
    mPhotos.value = [...mPhotos.value, ...got]
    const none = got.filter(p => !p.faces.length).length
    status.value = [got.length ? `${got.length} foto${got.length > 1 ? 's' : ''} añadida${got.length > 1 ? 's' : ''}.` : '', none ? `${none} sin rostro detectado: saldrá como imagen fija con cámara.` : '', bad ? `${bad} no se pudo abrir (¿HEIC?; prueba JPG, PNG o WebP).` : '', files.length > take.length ? `Máximo ${MAX_PHOTOS} fotos.` : ''].filter(Boolean).join(' ')
  } catch (err) { status.value = err instanceof Error ? err.message : String(err) } finally { mAdding.value = false }
}
function removePhoto(id: number) { stopMontagePreview(); clear(false); const r = mPhotos.value.find(p => p.id === id); if (r) disposePhoto(r); mPhotos.value = mPhotos.value.filter(p => p.id !== id) }
function movePhoto(i: number, d: number) { const a = [...mPhotos.value], j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; mPhotos.value = a; mpvLater(false, true) }
function clearPhotos() { stopMontagePreview(); clear(false); mPhotos.value.forEach(disposePhoto); mPhotos.value = [] }
function setMont(v: boolean) { if (v === mont.value) return; stopPreview(); stopMontagePreview(); clear(false); mont.value = v; if (v) dance.value = true; status.value = '' }
const tplCfg = (t0: number): TplCfg | undefined => (tpl.value && tplOn.value ? { tpl: tpl.value, mode: tplMode.value, gain: tplGain.value, mirror: tplMirror.value, startAt: t0 } : undefined)
/** Fotos preparadas para el motor al tamaño pedido; con fondo elegido, también el recorte de las personas de cada foto (si una falla, esa foto sale sin cambiar el fondo). */
async function mPrep(long: number, withBg: boolean) {
  const prep: { cv: HTMLCanvasElement; faces: Pt[][] }[] = [], photos: MPhoto[] = [], id = bgId.value; let failed = ''
  for (const [i, r] of mPhotos.value.entries()) {
    const p = await prepare(r, long); let bg: BgSpec | undefined, mask: Mask | undefined
    if (withBg && id !== 'none' && p.faces.length) {
      status.value = `Separando a las personas del fondo… ${i + 1} de ${mPhotos.value.length}`; await tick()
      try { mask = refineMask(await segmentPerson(p.cv, p.faces[0][1]), p.cv); bg = id === 'image' ? { id, bitmap: await coverBitmap(bgBmp.value!, p.cv.width, p.cv.height) } : { id } } catch (e) { failed = e instanceof Error ? e.message : String(e) }
    }
    prep.push({ cv: p.cv, faces: p.faces }); photos.push({ src: p.src, faces: p.faces, bg, mask })
  }
  if (failed) status.value = failed
  return { prep, photos }
}
const closeAll = (ps: MPhoto[]) => ps.forEach(p => { p.src.close(); p.bg?.bitmap?.close() })
async function generateMontage() {
  if (!mPhotos.value.length || busy.value) return
  if (!musicBuf) { status.value = 'Sube primero la música con la que quieres que bailen.'; return }
  if (bgId.value === 'image' && !bgBmp.value) { status.value = 'Elige una imagen para el fondo o selecciona otro fondo.'; return }
  busy.value = true; stopMontagePreview(); clear(false); let photos: MPhoto[] = []
  try {
    const T = tiers[tier.value], D = dimsFor(T.s), long = Math.min(1800, Math.round(Math.max(D.W, D.H) * 1.35))
    status.value = 'Preparando las fotos…'; await tick()
    photos = (await mPrep(long, true)).photos
    const sr = musicBuf.sampleRate, frames = Math.floor(danceDur.value * T.fps), dur = frames / T.fps, t0 = startAt.value
    if (!spectral) { status.value = 'Analizando compases y secciones…'; await tick(); await ensureStructure() }
    const spec = makeDance(T.fps, t0, dur, frames)
    playUrl.value = musicUrl.value; playFrom = t0; aud = null; lastDance.value = true; speechText.value = ''
    status.value = 'Montando el vídeo…'
    const res = await renderMontage({ photos, ow: D.W, oh: D.H, fps: T.fps, dur, spec, style: mStyle.value, tpl: tplCfg(t0), integrate: integrate.value, audio: { mono: musicMono!.slice(Math.round(t0 * sr), Math.round((t0 + dur) * sr)), sampleRate: sr } }, p => (pct.value = Math.round(p * 100)))
    out.value = res.out; mode.value = `En uso: montaje · render ${res.where === 'worker' ? 'en worker' : 'en hilo principal'} · ${res.out.ext.toUpperCase()}`
    hasAudio.value = out.value.audio; videoUrl.value = URL.createObjectURL(out.value.blob); diagBase = `build ${BUILD} · ${out.value.audioInfo ? 'audio ' + out.value.audioInfo : 'audio: no codificado'}`; diag.value = diagBase
    status.value = hasAudio.value ? `Listo: montaje de ${mPhotos.value.length} foto${mPhotos.value.length > 1 ? 's' : ''} y ${mPeople.value} persona${mPeople.value === 1 ? '' : 's'} a ${bpm.value} BPM.` : 'Listo. Este dispositivo no mezcla audio en el vídeo: la música suena aparte en la vista previa y el archivo sale sin audio.' + (out.value.audioNote ? ` Motivo: ${out.value.audioNote}.` : '')
  } catch (e) { status.value = e instanceof Error ? e.message : String(e) } finally { closeAll(photos); busy.value = false }
}
// Vista previa en vivo del montaje (mismo motor que el export, a 512 px)
const mpCv = ref<HTMLCanvasElement | null>(null), mPreviewing = ref(false), mPvBusy = ref(false), mPlaying = ref(false)
let mpv: MontagePreview | null = null, mpvT = 0, mpvA = false, mpvPrep: { cv: HTMLCanvasElement; faces: Pt[][] }[] = [], mpvMasks = new Map<number, Mask>(), mpvGen = 0
function mpvSync(audio: boolean) {
  if (!mpv || !musicBuf || bpm.value <= 0) return
  const frames = Math.max(1, Math.floor(danceDur.value * PV_FPS)), dur = frames / PV_FPS
  if (audio) mpv.setClip(musicBuf, startAt.value, dur)
  mpv.setSpec(makeDance(PV_FPS, startAt.value, dur, frames), mStyle.value, tplCfg(startAt.value))
}
/** Agrupa cambios seguidos (p. ej. al arrastrar el deslizador de inicio). `rebuild` = cambió el orden de las fotos: hay que reabrir la vista previa. */
function mpvLater(audio: boolean, rebuild = false) {
  if (!mpv) return
  if (rebuild) { const was = mPlaying.value; stopMontagePreview(); if (was) void startMontagePreview(); return }
  mpvA ||= audio; clearTimeout(mpvT); mpvT = window.setTimeout(() => { const a = mpvA; mpvA = false; mpvSync(a) }, 120)
}
async function mpvBg() {
  const gen = mpvGen
  try {
    const id = bgId.value
    for (const [i, p] of mpvPrep.entries()) {
      if (!mpv || gen !== mpvGen) return
      if (id === 'none' || !p.faces.length || (id === 'image' && !bgBmp.value)) { mpv.setBackground(i, undefined); continue }
      if (!mpvMasks.has(i)) { status.value = `Separando a las personas del fondo… ${i + 1} de ${mpvPrep.length}`; await tick(); mpvMasks.set(i, refineMask(await segmentPerson(p.cv, p.faces[0][1]), p.cv)) }
      if (!mpv || gen !== mpvGen) return
      mpv.setBackground(i, id === 'image' ? { id, bitmap: await coverBitmap(bgBmp.value!, p.cv.width, p.cv.height) } : { id }, mpvMasks.get(i))
    }
    if (mpv && gen === mpvGen) status.value = 'Vista previa del montaje en vivo.'
  } catch (e) { status.value = e instanceof Error ? e.message : String(e); if (bgId.value !== 'none') bgId.value = 'none' }
}
async function startMontagePreview() {
  if (!mPhotos.value.length || busy.value || mPvBusy.value || mPreviewing.value) return
  unlockAudio(); mPvBusy.value = true
  try {
    if (!spectral) { status.value = 'Analizando compases y secciones…'; await ensureStructure() }
    const D = dimsFor(PV); status.value = 'Preparando las fotos…'; await tick()
    const { prep, photos } = await mPrep(Math.round(Math.max(D.W, D.H) * 1.3), false)
    const frames = Math.max(1, Math.floor(danceDur.value * PV_FPS)), dur = frames / PV_FPS
    mpvPrep = prep; mpvMasks = new Map(); mpvGen++; mPreviewing.value = true; await nextTick()
    mpv = new MontagePreview(mpCv.value!, { photos, ow: D.W, oh: D.H, fps: PV_FPS, dur, spec: makeDance(PV_FPS, startAt.value, dur, frames), style: mStyle.value, tpl: tplCfg(startAt.value), integrate: integrate.value })
    mpv.setClip(musicBuf, startAt.value, dur); await mpvBg()
    if (mpv) { mpv.play(); mPlaying.value = true; status.value = 'Vista previa del montaje en vivo: cambia estilo, música, BPM o fondo y se aplica al instante. Cuando te guste, pulsa Crear montaje.' }
  } catch (e) { stopMontagePreview(); status.value = e instanceof Error ? e.message : String(e) } finally { mPvBusy.value = false }
}
function stopMontagePreview() { clearTimeout(mpvT); mpvA = false; mpvGen++; mpv?.dispose(); mpv = null; mpvPrep = []; mpvMasks = new Map(); mPreviewing.value = false; mPlaying.value = false }
const mpvToggle = () => { mPlaying.value = mpv ? mpv.toggle() : false }
watch([bpm, barShift, tpl, tplOn, tplGain, tplMirror, tplMode, mStyle], () => mpvLater(false)); watch(startAt, () => mpvLater(true)); watch(tier, () => mpvLater(true)); watch(integrate, v => mpv?.setIntegrate(v)); watch([bgId, bgBmp], () => { if (mpv) void mpvBg() })
const caps = ref<Caps | null>(null), modelMb = ref<number | null>(null), mode = ref('')
const capsLine = computed(() => { const c = caps.value; return c ? `Modo recomendado: ${tiers[c.tier].label}. ${c.cores} núcleos${c.memory ? ` · ~${c.memory} GB` : ''} · WebGPU ${c.webgpu ? 'disponible' : 'no disponible'} · SIMD ${c.simd ? 'sí' : 'no'}` : '' })
const modelLine = computed(() => (modelMb.value ? `Modelo descargado: ${modelMb.value.toFixed(0)} MB · disponible offline` : 'El modelo facial se descargará la primera vez.'))
onMounted(() => { if (dance.value) pickTrack(TRACKS[0], true); detectCaps().then(c => { caps.value = c; tier.value = c.tier; if (!c.ok) status.value = c.problems.join(' ') }); modelStatus().then(v => (modelMb.value = v)) })
async function wipe() { if (!confirm('Se borrará el modelo descargado y las fotos actuales. ¿Continuar?')) return; clear(); clearPhotos(); clearVoice(); clearMusic(); bgBmp.value = null; bgId.value = 'none'; await clearLocalData(); modelMb.value = null; mode.value = ''; status.value = 'Datos locales borrados.' }
const crop = reactive({ zoom: 1, cx: 0, cy: 0, rot: 0 }), cv = ref<HTMLCanvasElement | null>(null)
const pts = new Map<number, { x: number; y: number }>(); let pinch0 = 1, zoom0 = 1
const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1 }
function down(e: PointerEvent) { cv.value?.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { pinch0 = gap(); zoom0 = crop.zoom } }
function move(e: PointerEvent) {
  const p = pts.get(e.pointerId), bm = bitmap.value; if (!p || !bm || !cv.value) return
  if (pts.size === 1) { const u = winOf(bm, crop, AR.value).w / cv.value.clientWidth; crop.cx -= (e.clientX - p.x) * u; crop.cy -= (e.clientY - p.y) * u }
  p.x = e.clientX; p.y = e.clientY
  if (pts.size === 2) crop.zoom = (zoom0 * gap()) / pinch0
}
const up = (e: PointerEvent) => { pts.delete(e.pointerId) }
watch(() => [crop.zoom, crop.cx, crop.cy, crop.rot, bitmap.value, videoUrl.value, previewing.value, fmt.value], () => { const bm = bitmap.value; if (!bm) return; clampCrop(bm, crop, AR.value); if (cv.value) { const D = dimsFor(512); drawCrop(bm, crop, D.W, D.H, cv.value) } }, { flush: 'post' })
async function pick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return
  try { bitmap.value = await createImageBitmap(f); stopPreview(); clear(false); resetCrop(bitmap.value, crop, AR.value); photoUrl.value = URL.createObjectURL(f); status.value = '' }
  catch { status.value = 'Este navegador no puede abrir ese formato (¿HEIC?). Prueba con JPG, PNG o WebP.' }
}
async function toggleRec() {
  if (!recording.value) { try { rec = await startRecording(); recording.value = true; status.value = 'Grabando… toca de nuevo para parar.' } catch { status.value = 'No tengo permiso para usar el micrófono.' } return }
  recording.value = false; const b = await rec!.stop(); rec = null
  try { voiceBuf.value = await decodeAudio(b); voiceUrl.value = URL.createObjectURL(b); aud = null; status.value = `Voz grabada (${voiceBuf.value.duration.toFixed(1)} s).` + (voiceBuf.value.duration > 9.2 ? ' Se recortará a 10 s.' : '') }
  catch { status.value = 'No pude leer la grabación.' }
}
function clearVoice() { voiceBuf.value = null; if (voiceUrl.value) URL.revokeObjectURL(voiceUrl.value); voiceUrl.value = ''; aud = null }
function onPlay(e: Event) {
  if (hasAudio.value) {
    const v = e.target as HTMLVideoElement
    v.muted = false
    setTimeout(() => { const a = v as any; diag.value = `${diagBase} · reproducción: muted=${v.muted} vol=${v.volume} pistas=${a.audioTracks?.length ?? '?'} bytesAudio=${a.webkitAudioDecodedByteCount ?? '?'}` }, 1500)
    return
  }
  if (playUrl.value) { aud ??= new Audio(playUrl.value); aud.currentTime = (e.target as HTMLVideoElement).currentTime + playFrom; aud.play() }
  else if (speechText.value) setTimeout(() => speakPreview(speechText.value), 500)
}
function onPause() { aud?.pause(); if ('speechSynthesis' in window) speechSynthesis.cancel() }
function clear(all = true) { diag.value = ''; if (videoUrl.value) URL.revokeObjectURL(videoUrl.value); videoUrl.value = ''; out.value = null; pct.value = 0; if (all) { stopPreview(); if (photoUrl.value) URL.revokeObjectURL(photoUrl.value); photoUrl.value = ''; bitmap.value = null; status.value = '' } }
async function generate() {
  const bm = bitmap.value; if (!bm || busy.value) return
  if (dance.value && !musicBuf) { status.value = 'Sube primero la música con la que quieres que baile.'; return }
  if (bgId.value === 'image' && !bgBmp.value) { status.value = 'Elige una imagen para el fondo o selecciona otro fondo.'; return }
  busy.value = true; stopPreview(); clear(false)
  try {
    const T = tiers[tier.value], D = dimsFor(T.s), src = drawCrop(bm, crop, D.W, D.H)
    status.value = 'Analizando rostro…'; await new Promise(r => setTimeout(r, 30))
    const L = await detect(src); if (!L) throw new Error('No detecto ningún rostro. Usa una foto frontal y bien iluminada.')
    let bg: BgSpec | undefined, mask: Mask | undefined
    if (bgId.value !== 'none') {
      status.value = 'Separando a la persona del fondo… (la primera vez se descarga el modelo)'; await new Promise(r => setTimeout(r, 30))
      mask = refineMask(await segmentPerson(src, L[1]), src)
      bg = bgId.value === 'image' ? { id: 'image', bitmap: await coverBitmap(bgBmp.value!, D.W, D.H) } : { id: bgId.value }
    }
    let rig: ArmRig | null = null
    if (dance.value && tplWantsArms()) { status.value = 'Buscando los brazos en la foto… (la primera vez se descarga el modelo de cuerpo)'; await new Promise(r => setTimeout(r, 30)); rig = await armsOf(src) }
    const input = await createImageBitmap(src); let job: Parameters<typeof renderVideo>[0], buf: AudioBuffer | null = null, ins = parseInstruction('', T.d)
    speechText.value = ''
    if (dance.value) {
      const sr = musicBuf!.sampleRate, frames = Math.floor(danceDur.value * T.fps), dur = frames / T.fps, t0 = startAt.value
      if (!spectral) { status.value = 'Analizando compases y secciones…'; await new Promise(r => setTimeout(r, 30)); await ensureStructure() }
      const spec = makeDance(T.fps, t0, dur, frames)
      ins = { duration: dur, eyeMovement: 'camera', intensity: 0.65 }
      job = { src: input, lm: L, ins, dur, fps: T.fps, audio: { mono: musicMono!.slice(Math.round(t0 * sr), Math.round((t0 + dur) * sr)), sampleRate: sr }, dance: spec, tpl: tplPlay(L, D.W, D.H, spec, t0, rig) ?? undefined, bg, mask, integrate: integrate.value }
      playUrl.value = musicUrl.value; playFrom = t0; aud = null
    } else {
      buf = voiceBuf.value
      const dur = buf ? Math.min(10, Math.max(T.d, Math.ceil(buf.duration + 0.8))) : T.d; ins = parseInstruction(prompt.value, dur); let vis: VisemeFrame[] | undefined
      if (buf) vis = audioVisemes(buf, T.fps, dur)
      else if (ins.speech) { speechText.value = ins.speech; vis = textVisemes(ins.speech, T.fps, dur) }
      const audio = buf ? { mono: toMono(buf), sampleRate: buf.sampleRate } : undefined
      job = { src: input, lm: L, ins, vis, dur, fps: T.fps, audio, bg, mask }
      playUrl.value = voiceUrl.value; playFrom = 0
    }
    lastDance.value = dance.value
    status.value = 'Renderizando vídeo…'
    const res = await renderVideo(job, p => (pct.value = Math.round(p * 100)))
    out.value = res.out; mode.value = `En uso: detector ${getDelegate()} · render ${res.where === 'worker' ? 'en worker' : 'en hilo principal'} · ${res.out.ext.toUpperCase()}`
    modelStatus().then(v => (modelMb.value = v))
    hasAudio.value = out.value.audio; videoUrl.value = URL.createObjectURL(out.value.blob); diagBase = `build ${BUILD} · ${out.value.audioInfo ? 'audio ' + out.value.audioInfo : 'audio: no codificado'}`; diag.value = diagBase
    const why = out.value.audioNote ? ` Motivo: ${out.value.audioNote}.` : ''
    status.value = dance.value ? (hasAudio.value ? `Listo: ${job.tpl ? `imita «${tpl.value!.name}» y baila` : 'baila'} a ${bpm.value} BPM con tu música.${job.tpl ? rigNote(rig) : ''}` : 'Listo. Este dispositivo no mezcla audio en el vídeo: la música suena aparte en la vista previa y el archivo sale sin audio.' + why)
      : buf ? (hasAudio.value ? 'Listo, con tu voz.' : 'Listo. Este dispositivo no mezcla audio en el vídeo: tu voz suena aparte en la vista previa y el archivo sale sin audio.' + why)
      : ins.speech ? 'Listo. La voz del texto solo suena en la vista previa (el navegador no deja capturarla): el archivo sale sin audio. Para llevar voz en el archivo, graba la tuya.' : 'Listo.'
  } catch (e) { status.value = e instanceof Error ? e.message : String(e) } finally { busy.value = false }
}
function pvSync(audio: boolean) {
  if (!pv) return
  if (!musicBuf || bpm.value <= 0) { pv.setClip(null, 0, 5); pv.setSpec(null); pv.setTemplate(null); return }
  const frames = Math.max(1, Math.floor(danceDur.value * PV_FPS)), dur = frames / PV_FPS
  if (audio) pv.setClip(musicBuf, startAt.value, dur)
  const spec = makeDance(PV_FPS, startAt.value, dur, frames)
  pv.setSpec(spec); pv.setTemplate(tplPlay(pvL!, pvSrc!.width, pvSrc!.height, spec, startAt.value, pvRig))
  if (pvRig === undefined && tplWantsArms() && !pvRigBusy) {   // los brazos de la foto se buscan una vez, sin parar la vista previa
    pvRigBusy = true; const src = pvSrc!
    armsOf(src).then(r => { if (pvSrc !== src) return; pvRig = r ?? null; if (r) status.value = 'Vista previa en vivo.' + rigNote(r); pvLater(false) }).finally(() => { pvRigBusy = false })
  }
}
/** Agrupa cambios seguidos (p. ej. al arrastrar el deslizador de inicio) para no reiniciar el sonido a cada pixel. */
function pvLater(audio: boolean) { if (!pv) return; pvA ||= audio; clearTimeout(pvT); pvT = window.setTimeout(() => { const a = pvA; pvA = false; pvSync(a) }, 120) }
/** Aplica el fondo elegido; la máscara de persona se calcula solo la primera vez que hace falta. */
async function pvBg() {
  if (!pv) return
  try {
    if (bgId.value !== 'none' && !pvMask) { status.value = 'Separando a la persona del fondo… (la primera vez se descarga el modelo)'; await new Promise(r => setTimeout(r, 30)); pvMask = refineMask(await segmentPerson(pvSrc!, pvL![1]), pvSrc!); status.value = '' }
    if (!pv) return
    const id = bgId.value
    if (id === 'none') pv.setBackground(undefined)
    else if (id === 'image') { if (bgBmp.value) pv.setBackground({ id, bitmap: await coverBitmap(bgBmp.value, pvSrc!.width, pvSrc!.height) }, pvMask) }
    else pv.setBackground({ id }, pvMask)
  } catch (e) { status.value = e instanceof Error ? e.message : String(e); if (bgId.value !== 'none') bgId.value = 'none' }
}
async function startPreview() {
  const bm = bitmap.value; if (!bm || busy.value || pvBusy.value || previewing.value) return
  unlockAudio()   // dentro del toque: luego no se podría arrancar el audio en iOS
  pvBusy.value = true
  try {
    status.value = 'Analizando rostro…'; await new Promise(r => setTimeout(r, 30))
    const D = dimsFor(PV), src = drawCrop(bm, crop, D.W, D.H), L = await detect(src); if (!L) throw new Error('No detecto ningún rostro. Usa una foto frontal y bien iluminada.')
    pvSrc = src; pvL = L; pvMask = undefined; previewing.value = true; await nextTick()
    pv = new Preview(pvCv.value!, await createImageBitmap(src), L); pv.setIntegrate(integrate.value)
    if (!spectral) { status.value = 'Analizando compases y secciones…'; await ensureStructure() }
    pvSync(true); await pvBg()
    if (pv) { pv.play(); pvPlaying.value = true; status.value = 'Vista previa en vivo: cambia fondo, canción o BPM y se aplica al instante. Cuando te guste, pulsa Animar.' }
  } catch (e) { stopPreview(); status.value = e instanceof Error ? e.message : String(e) } finally { pvBusy.value = false }
}
function stopPreview() { clearTimeout(pvT); pvA = false; pvRig = undefined; pv?.dispose(); pv = null; pvMask = undefined; pvSrc = null; pvL = null; previewing.value = false; pvPlaying.value = false }
const pvToggle = () => { pvPlaying.value = pv ? pv.toggle() : false }
const onHide = () => { if (!document.hidden) return; if (pv?.isPlaying) { pv.pause(); pvPlaying.value = false } if (mpv?.isPlaying) { mpv.pause(); mPlaying.value = false } }
onMounted(() => document.addEventListener('visibilitychange', onHide))
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', onHide); stopPreview(); stopMontagePreview(); mPhotos.value.forEach(disposePhoto) })
watch([bgId, bgBmp], () => { pvBg() }); watch(integrate, v => pv?.setIntegrate(v))
watch([tpl, tplOn, tplGain, tplMirror, tplMode, tplArms], () => pvLater(false)); watch(startAt, () => pvLater(true)); watch(tier, () => pvLater(true)); watch([bpm, barShift], () => pvLater(false))
watch(dance, v => { if (!v) stopPreview() })
function setFmt(f: 'sq' | 'v') { if (fmt.value === f) return; stopPreview(); stopMontagePreview(); clear(false); fmt.value = f; if (bitmap.value) resetCrop(bitmap.value, crop, AR.value) }
const fname = () => `foto-animada.${out.value!.ext}`
function save() { const a = document.createElement('a'); a.href = videoUrl.value; a.download = fname(); a.click() }
const share = () => navigator.share({ files: [new File([out.value!.blob], fname(), { type: out.value!.blob.type })] }).catch(() => {})
</script>
<template>
  <main>
    <h1>✨ Foto animada</h1>
    <div class="badge">🟢 Procesamiento en el dispositivo. Tu fotografía no se sube a ningún servidor.</div>
    <div v-if="caps" class="badge">{{ capsLine }}</div>
    <div class="badge">{{ modelLine }}</div>
    <div v-if="mode" class="badge">{{ mode }}</div>
    <div class="row seg" role="group" aria-label="Modo"><button :class="{ on: !mont }" :disabled="busy || pvBusy || mPvBusy" @click="setMont(false)">📷 Una foto</button><button :class="{ on: mont }" :disabled="busy || pvBusy || mPvBusy" @click="setMont(true)">🎬 Montaje (varias fotos)</button></div>
    <div class="frame" :class="{ v: fmt === 'v' }">
      <canvas v-if="mPreviewing" ref="mpCv" class="pv" aria-label="Vista previa del montaje" />
      <canvas v-else-if="previewing" ref="pvCv" class="pv" aria-label="Vista previa en vivo" />
      <video v-else-if="videoUrl" :src="videoUrl" controls playsinline :loop="lastDance ? hasAudio : !speechText && !voiceUrl" :autoplay="!hasAudio" :muted="!hasAudio" @play="onPlay" @pause="onPause" />
      <label v-else-if="mont && !mPhotos.length" class="empty">🎬<input type="file" accept="image/*,.heic" multiple hidden :disabled="mAdding" @change="addPhotos" /></label>
      <div v-else-if="mont" class="thumbs"><figure v-for="(p, i) in mPhotos" :key="p.id"><img :src="p.url" :alt="p.name" /><figcaption>{{ i + 1 }} · {{ p.faces.length ? '👤'.repeat(p.faces.length) : 'sin rostro' }}</figcaption></figure></div>
      <canvas v-else-if="bitmap" ref="cv" :width="dimsFor(512).W" :height="dimsFor(512).H" aria-label="Encuadre de la fotografía" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" />
      <label v-else class="empty">📷<input type="file" accept="image/*,.heic" hidden @change="pick" /></label>
    </div>
    <div v-if="!mont" class="row">
      <label class="btn">Elegir fotografía<input type="file" accept="image/*,.heic" hidden @change="pick" /></label>
      <button v-if="photoUrl" @click="clear()">Quitar</button>
      <button v-if="videoUrl || previewing" @click="stopPreview(); clear(false)">Ajustar encuadre</button>
    </div>
    <div v-if="!mont && bitmap && !videoUrl" class="row"><input type="range" min="1" max="5" step="0.05" v-model.number="crop.zoom" aria-label="Zoom" /><button @click="rotateCrop(bitmap, crop, AR)">↻ Girar</button></div>
    <div class="row seg" role="group" aria-label="Formato"><button :class="{ on: fmt === 'sq' }" :disabled="busy || pvBusy" @click="setFmt('sq')">Cuadrado 1:1</button><button :class="{ on: fmt === 'v' }" :disabled="busy || pvBusy" @click="setFmt('v')">Vertical 9:16</button></div>
    <div v-if="!mont && dance && bitmap && musicName" class="row">
      <button v-if="!previewing" :disabled="busy || pvBusy || analyzing" @click="startPreview">{{ pvBusy ? 'Preparando…' : '▶ Vista previa en vivo' }}</button>
      <template v-else><button @click="pvToggle">{{ pvPlaying ? '⏸ Pausa' : '▶ Seguir' }}</button><button @click="stopPreview">✕ Cerrar vista previa</button></template>
    </div>
    <div v-if="mont" class="bgs">
      <div class="row"><label class="btn">{{ mPhotos.length ? '➕ Añadir fotos' : '📷 Elegir fotos' }}<input type="file" accept="image/*,.heic" multiple hidden :disabled="busy || mPvBusy || mAdding || mPhotos.length >= MAX_PHOTOS" @change="addPhotos" /></label><button v-if="mPhotos.length" :disabled="busy || mAdding" @click="clearPhotos">Quitar todas</button><button v-if="videoUrl" @click="clear(false)">Volver a las fotos</button></div>
      <div v-if="mPhotos.length" class="mlist"><div v-for="(p, i) in mPhotos" :key="p.id" class="mrow"><img :src="p.url" :alt="p.name" /><span>{{ i + 1 }} · {{ p.faces.length ? p.faces.length + (p.faces.length === 1 ? ' persona' : ' personas') : 'sin rostro' }}</span><button :disabled="busy || i === 0" aria-label="Subir" @click="movePhoto(i, -1)">◀</button><button :disabled="busy || i === mPhotos.length - 1" aria-label="Bajar" @click="movePhoto(i, 1)">▶</button><button :disabled="busy" aria-label="Quitar" @click="removePhoto(p.id)">✕</button></div></div>
      <div class="row seg" role="group" aria-label="Estilo del montaje"><button v-for="s in STYLES" :key="s.id" :class="{ on: mStyle === s.id }" @click="mStyle = s.id">{{ s.label }}</button></div>
      <div class="st">{{ mHint }}</div>
      <div v-if="mPhotos.length && musicName" class="row">
        <button v-if="!mPreviewing" :disabled="busy || mPvBusy || analyzing || mAdding" @click="startMontagePreview">{{ mPvBusy ? 'Preparando…' : '▶ Vista previa del montaje' }}</button>
        <template v-else><button @click="mpvToggle">{{ mPlaying ? '⏸ Pausa' : '▶ Seguir' }}</button><button @click="stopMontagePreview">✕ Cerrar vista previa</button></template>
      </div>
    </div>
    <div v-if="!mont" class="row seg"><button :class="{ on: dance }" @click="dance = true">💃 Bailar con música</button><button :class="{ on: !dance }" @click="dance = false">💬 Instrucción</button></div>
    <template v-if="!dance">
      <label>¿Qué quieres que haga?
        <textarea v-model="prompt" placeholder="Que sonría, mire a la cámara y parpadee…" style="width:100%" /></label>
      <div class="row"><button :disabled="busy" @click="toggleRec">{{ recording ? '⏹ Parar' : '🎙 Grabar mi voz' }}</button><button v-if="voiceBuf" @click="clearVoice">Quitar voz</button></div>
    </template>
    <template v-else>
      <div class="bgs"><div class="st">Música incluida</div>
        <div class="chips"><button v-for="t in TRACKS" :key="t.id" :class="{ on: selTrack === t.id }" :disabled="busy || analyzing" @click="pickTrack(t)">{{ t.emoji }} {{ t.name }}</button></div></div>
      <div class="row"><label class="btn">{{ musicName && !selTrack ? '🎵 Cambiar la mía' : '🎵 Subir la mía' }}<input type="file" accept="audio/*,audio/mpeg,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac" hidden :disabled="busy || analyzing" @change="pickMusic" /></label><button v-if="musicName" :disabled="busy" @click="clearMusic">Quitar</button></div>
      <div v-if="musicName" class="music">
        <div class="st">🎵 {{ musicName }} · {{ musicDur.toFixed(0) }} s</div>
        <div class="row bpmrow"><button @click="setBpm(bpm / 2)">÷2</button><button @click="setBpm(bpm - 1)">−</button><b>{{ bpm }} BPM</b><button @click="setBpm(bpm + 1)">+</button><button @click="setBpm(bpm * 2)">×2</button></div>
        <div v-if="structText" class="st">{{ structText }}</div>
        <div v-if="bars" class="row"><button v-if="!bars.known || barShift" @click="barShift = (barShift + 1) % 4">🥁 Mover el 1</button><button v-if="maxStart > 0.5" @click="bestMoment">🎯 Mejor momento</button></div>
        <label v-if="maxStart > 0.5">Empezar en el segundo {{ startAt.toFixed(0) }} · baila {{ danceDur.toFixed(0) }} s<input type="range" min="0" :max="maxStart" step="0.5" v-model.number="startAt" style="width:100%" /></label>
      </div>
    </template>
    <div v-if="dance" class="bgs">
      <div class="st">🎬 Imitar un vídeo (plantilla de movimientos)</div>
      <div v-if="mont" class="st">En el montaje la plantilla mueve cabeza y torso de cada persona (los brazos solo funcionan con una foto).</div>
      <div class="row">
        <label class="btn">{{ tpl ? '🎬 Otro vídeo' : '🎬 Vídeo a imitar' }}<input type="file" accept="video/*" hidden :disabled="busy || tplBusy" @change="pickRefVideo" /></label>
        <label class="btn">📂 Abrir plantilla<input type="file" accept=".json,application/json" hidden :disabled="busy || tplBusy" @change="loadTplFile" /></label>
        <button v-if="tplBusy" @click="tplCtl?.abort()">Cancelar</button>
      </div>
      <div v-if="tplBusy" class="bar"><i :style="{ width: tplPct + '%' }" /></div>
      <template v-if="tpl">
        <div class="st">«{{ tpl.name }}» · {{ tplNote }}</div>
        <label class="st"><input type="checkbox" v-model="tplOn" /> Usar la plantilla</label>
        <template v-if="tplOn">
          <div class="row seg" role="group" aria-label="Sincronía"><button v-for="m in MODES" :key="m.id" :class="{ on: tplMode === m.id }" @click="tplMode = m.id">{{ m.label }}</button></div>
          <div class="st">{{ tplHint }}</div>
          <label class="st">Fuerza de la imitación: {{ tplGain.toFixed(1) }}×<input type="range" min="0.3" max="2" step="0.1" v-model.number="tplGain" style="width:100%" /></label>
          <label class="st"><input type="checkbox" v-model="tplMirror" /> Reflejar (si el vídeo era un selfie y salen al revés)</label>
          <label v-if="tpl.armL || tpl.armR" class="st"><input type="checkbox" v-model="tplArms" /> Mover brazos y manos (necesita que se vean en la foto)</label>
        </template>
        <div class="row"><button v-if="refFile" :disabled="busy || analyzing" @click="useRefAudio">🎵 Usar su audio</button><button @click="saveTpl">💾 Guardar plantilla</button><button @click="clearTpl">Quitar</button></div>
      </template>
    </div>
    <div class="bgs"><div class="st">Fondo del vídeo</div>
      <div class="chips">
        <button :class="{ on: bgId === 'none' }" @click="bgId = 'none'">Original</button>
        <button v-for="b in BG_UI" :key="b.id" class="chip" :class="{ on: bgId === b.id }" :style="{ background: b.css }" @click="bgId = b.id">{{ b.label }}</button>
        <label class="btn" :class="{ on: bgId === 'image' }">{{ bgBmp ? '🖼 Cambiar imagen' : '🖼 Mi imagen' }}<input type="file" accept="image/*,.heic" hidden @change="pickBg" /></label>
      </div>
      <label v-if="bgId !== 'none'" class="st"><input type="checkbox" v-model="integrate" /> ✨ Luz y sombra del fondo sobre la persona</label>
    </div>
    <select v-model="tier"><option v-for="(t, k) in tiers" :key="k" :value="k">{{ tierLabel(k) }}</option></select>
    <button v-if="mont" class="go" :disabled="!mPhotos.length || busy || analyzing || mAdding || !!(caps && !caps.ok)" @click="generateMontage">{{ busy ? 'Montando…' : '🎬 Crear montaje' }}</button>
    <button v-else class="go" :disabled="!bitmap || busy || analyzing || !!(caps && !caps.ok)" @click="generate">{{ busy ? 'Animando…' : 'Animar' }}</button>
    <div v-if="busy" class="bar"><i :style="{ width: pct + '%' }" /></div>
    <div class="st" role="status">{{ status }}</div>
    <div v-if="diag" class="st" style="font-size:.72rem;opacity:.75;word-break:break-all">{{ diag }}</div>
    <div v-if="videoUrl" class="row"><button :disabled="busy" @click="mont ? generateMontage() : generate()">Volver a generar</button><button @click="save">Guardar</button><button v-if="canShare" @click="share">Compartir</button></div>
    <DebugPanel v-if="debug && bitmap" :bitmap="bitmap" :crop="crop" :prompt="prompt" />
    <button class="lnk" @click="wipe">Borrar datos locales</button>
  </main>
</template>
<style scoped>
.seg .on{background:var(--ink);color:#fff}.music{display:grid;gap:8px}.bpmrow{align-items:center}.bpmrow b{text-align:center;font-size:1.15rem;flex:1.6}
.bgs{display:grid;gap:6px}.chips{display:flex;flex-wrap:wrap;gap:8px}.chips>*{flex:0 0 auto;padding:8px 12px}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(30%,1fr));gap:6px;padding:6px;width:100%;height:100%;overflow:auto;align-content:start}.thumbs figure{margin:0;position:relative;aspect-ratio:1}.thumbs img{width:100%;height:100%;object-fit:cover;border-radius:10px;display:block}
.thumbs figcaption{position:absolute;left:4px;bottom:4px;background:rgba(0,0,0,.65);color:#fff;font-size:.7rem;border-radius:8px;padding:1px 6px}
.mlist{display:grid;gap:6px}.mrow{display:flex;gap:6px;align-items:center}.mrow img{width:40px;height:40px;object-fit:cover;border-radius:8px}.mrow span{flex:1;font-size:.85rem}.mrow button{flex:0 0 auto;padding:6px 10px}
.chip{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.65)}.chips .on{outline:3px solid var(--acc);outline-offset:2px}
</style>
