<script setup lang="ts">
import { ref, reactive, watch, computed, onMounted } from 'vue'
import { detectCaps, type Caps } from './ai/Capabilities'
import DebugPanel from './components/DebugPanel.vue'
import { modelStatus, clearLocalData } from './ai/ModelManager'
import { clampCrop, resetCrop, rotateCrop, drawCrop, sideOf } from './components/cropper'
import { detect, getDelegate } from './ai/FaceLandmarks'
import { parseInstruction, type VisemeFrame, type DanceSpec } from './ai/MotionPlanner'
import { startRecording, decodeAudio, audioVisemes, textVisemes, speakPreview, toMono } from './audio/SpeechEngine'
import { renderVideo } from './rendering/renderClient'
import { analyzeTempo, beatOffset, energyFrames, type Tempo } from './audio/BeatDetector'
import { segmentPerson, type Mask } from './ai/Segmenter'
import { BG_UI, coverBitmap, type BgId, type BgSpec } from './rendering/Backgrounds'
const tiers = { fast: { s: 512, fps: 24, d: 5, dd: 10, label: 'Rápido · 512 px · 5 s' }, balanced: { s: 768, fps: 24, d: 7, dd: 15, label: 'Normal · 768 px · 7 s' }, quality: { s: 1024, fps: 30, d: 10, dd: 20, label: 'Alta · 1024 px · 10 s' } }
const tier = ref<keyof typeof tiers>('fast'), prompt = ref('')
const bitmap = ref<ImageBitmap | null>(null), photoUrl = ref(''), videoUrl = ref(''), out = ref<{ blob: Blob; ext: string; audio: boolean; audioNote?: string } | null>(null)
const recording = ref(false), voiceBuf = ref<AudioBuffer | null>(null), voiceUrl = ref(''), speechText = ref(''), hasAudio = ref(false)
let rec: Awaited<ReturnType<typeof startRecording>> | null = null, aud: HTMLAudioElement | null = null
const busy = ref(false), status = ref(''), pct = ref(0), canShare = !!navigator.share
const debug = new URLSearchParams(location.search).has('debug')
// Baile con música + fondo
const dance = ref(false), analyzing = ref(false), musicName = ref(''), musicUrl = ref(''), musicDur = ref(0), bpm = ref(0), startAt = ref(0)
const bgId = ref<BgId | 'none'>('none'), bgBmp = ref<ImageBitmap | null>(null), lastDance = ref(false), playUrl = ref('')
let musicBuf: AudioBuffer | null = null, musicMono: Float32Array | null = null, tempo: Tempo | null = null, playFrom = 0
const danceMax = computed(() => tiers[tier.value].dd)
const maxStart = computed(() => Math.max(0, musicDur.value - Math.min(danceMax.value, musicDur.value)))
const danceDur = computed(() => Math.max(1, Math.min(danceMax.value, musicDur.value - startAt.value)))
watch([tier, musicDur], () => { startAt.value = Math.min(startAt.value, maxStart.value) })
const tierLabel = (k: keyof typeof tiers) => (dance.value ? `${tiers[k].label.split(' · ').slice(0, 2).join(' · ')} · hasta ${tiers[k].dd} s` : tiers[k].label)
const setBpm = (v: number) => (bpm.value = Math.min(240, Math.max(40, Math.round(v * 10) / 10)))
function clearMusic() { if (musicUrl.value) URL.revokeObjectURL(musicUrl.value); musicUrl.value = ''; musicName.value = ''; musicDur.value = 0; bpm.value = 0; startAt.value = 0; musicBuf = musicMono = tempo = null; aud = null }
async function pickMusic(e: Event) {
  const input = e.target as HTMLInputElement, f = input.files?.[0]; input.value = ''; if (!f) return
  analyzing.value = true; clear(false); clearMusic(); status.value = 'Leyendo el audio…'
  try {
    const buf = await decodeAudio(f); status.value = 'Calculando el ritmo…'; await new Promise(r => setTimeout(r, 30))
    musicBuf = buf; musicMono = toMono(buf); tempo = analyzeTempo(musicMono, buf.sampleRate)
    musicUrl.value = URL.createObjectURL(f); musicName.value = f.name; musicDur.value = buf.duration; bpm.value = tempo.bpm
    status.value = tempo.conf < 0.08 ? 'No noto un pulso claro en este audio. Ajusta el BPM a mano si hace falta.' : `Ritmo detectado: ${tempo.bpm} BPM. Si baila a media velocidad o al doble, usa ÷2 / ×2.`
  } catch { clearMusic(); status.value = 'No pude leer ese audio. Prueba con MP3, M4A, WAV u OGG.' } finally { analyzing.value = false }
}
async function pickBg(e: Event) {
  const input = e.target as HTMLInputElement, f = input.files?.[0]; input.value = ''; if (!f) return
  try { bgBmp.value = await createImageBitmap(f); bgId.value = 'image'; status.value = '' } catch { status.value = 'No pude abrir esa imagen de fondo. Prueba con JPG, PNG o WebP.' }
}
const caps = ref<Caps | null>(null), modelMb = ref<number | null>(null), mode = ref('')
const capsLine = computed(() => { const c = caps.value; return c ? `Modo recomendado: ${tiers[c.tier].label}. ${c.cores} núcleos${c.memory ? ` · ~${c.memory} GB` : ''} · WebGPU ${c.webgpu ? 'disponible' : 'no disponible'} · SIMD ${c.simd ? 'sí' : 'no'}` : '' })
const modelLine = computed(() => (modelMb.value ? `Modelo descargado: ${modelMb.value.toFixed(0)} MB · disponible offline` : 'El modelo facial se descargará la primera vez.'))
onMounted(() => { detectCaps().then(c => { caps.value = c; tier.value = c.tier; if (!c.ok) status.value = c.problems.join(' ') }); modelStatus().then(v => (modelMb.value = v)) })
async function wipe() { if (!confirm('Se borrará el modelo descargado y la foto actual. ¿Continuar?')) return; clear(); clearVoice(); clearMusic(); bgBmp.value = null; bgId.value = 'none'; await clearLocalData(); modelMb.value = null; mode.value = ''; status.value = 'Datos locales borrados.' }
const crop = reactive({ zoom: 1, cx: 0, cy: 0, rot: 0 }), cv = ref<HTMLCanvasElement | null>(null)
const pts = new Map<number, { x: number; y: number }>(); let pinch0 = 1, zoom0 = 1
const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1 }
function down(e: PointerEvent) { cv.value?.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { pinch0 = gap(); zoom0 = crop.zoom } }
function move(e: PointerEvent) {
  const p = pts.get(e.pointerId), bm = bitmap.value; if (!p || !bm || !cv.value) return
  if (pts.size === 1) { const u = sideOf(bm, crop) / cv.value.clientWidth; crop.cx -= (e.clientX - p.x) * u; crop.cy -= (e.clientY - p.y) * u }
  p.x = e.clientX; p.y = e.clientY
  if (pts.size === 2) crop.zoom = (zoom0 * gap()) / pinch0
}
const up = (e: PointerEvent) => { pts.delete(e.pointerId) }
watch(() => [crop.zoom, crop.cx, crop.cy, crop.rot, bitmap.value, videoUrl.value], () => { const bm = bitmap.value; if (!bm) return; clampCrop(bm, crop); if (cv.value) drawCrop(bm, crop, 512, cv.value) }, { flush: 'post' })
async function pick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return
  try { bitmap.value = await createImageBitmap(f); clear(false); resetCrop(bitmap.value, crop); photoUrl.value = URL.createObjectURL(f); status.value = '' }
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
  if (hasAudio.value) return
  if (playUrl.value) { aud ??= new Audio(playUrl.value); aud.currentTime = (e.target as HTMLVideoElement).currentTime + playFrom; aud.play() }
  else if (speechText.value) setTimeout(() => speakPreview(speechText.value), 500)
}
function onPause() { aud?.pause(); if ('speechSynthesis' in window) speechSynthesis.cancel() }
function clear(all = true) { if (videoUrl.value) URL.revokeObjectURL(videoUrl.value); videoUrl.value = ''; out.value = null; pct.value = 0; if (all) { if (photoUrl.value) URL.revokeObjectURL(photoUrl.value); photoUrl.value = ''; bitmap.value = null; status.value = '' } }
async function generate() {
  const bm = bitmap.value; if (!bm || busy.value) return
  if (dance.value && !musicBuf) { status.value = 'Sube primero la música con la que quieres que baile.'; return }
  if (bgId.value === 'image' && !bgBmp.value) { status.value = 'Elige una imagen para el fondo o selecciona otro fondo.'; return }
  busy.value = true; clear(false)
  try {
    const T = tiers[tier.value], src = drawCrop(bm, crop, T.s)
    status.value = 'Analizando rostro…'; await new Promise(r => setTimeout(r, 30))
    const L = await detect(src); if (!L) throw new Error('No detecto ningún rostro. Usa una foto frontal y bien iluminada.')
    let bg: BgSpec | undefined, mask: Mask | undefined
    if (bgId.value !== 'none') {
      status.value = 'Separando a la persona del fondo… (la primera vez se descarga el modelo)'; await new Promise(r => setTimeout(r, 30))
      mask = await segmentPerson(src, L[1])
      bg = bgId.value === 'image' ? { id: 'image', bitmap: await coverBitmap(bgBmp.value!, T.s) } : { id: bgId.value }
    }
    const input = await createImageBitmap(src); let job: Parameters<typeof renderVideo>[0], buf: AudioBuffer | null = null, ins = parseInstruction('', T.d)
    speechText.value = ''
    if (dance.value) {
      const sr = musicBuf!.sampleRate, frames = Math.floor(danceDur.value * T.fps), dur = frames / T.fps, t0 = startAt.value
      const spec: DanceSpec = { bpm: bpm.value, offset: beatOffset(tempo!, bpm.value, t0, t0 + dur), fps: T.fps, energy: energyFrames(musicMono!, sr, T.fps, t0, frames) }
      ins = { duration: dur, eyeMovement: 'camera', intensity: 0.65 }
      job = { src: input, lm: L, ins, dur, fps: T.fps, audio: { mono: musicMono!.slice(Math.round(t0 * sr), Math.round((t0 + dur) * sr)), sampleRate: sr }, dance: spec, bg, mask }
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
    hasAudio.value = out.value.audio; videoUrl.value = URL.createObjectURL(out.value.blob); const why = out.value.audioNote ? ` Motivo: ${out.value.audioNote}.` : ''
    status.value = dance.value ? (hasAudio.value ? `Listo: baila a ${bpm.value} BPM con tu música.` : 'Listo. Este dispositivo no mezcla audio en el vídeo: la música suena aparte en la vista previa y el archivo sale sin audio.' + why)
      : buf ? (hasAudio.value ? 'Listo, con tu voz.' : 'Listo. Este dispositivo no mezcla audio en el vídeo: tu voz suena aparte en la vista previa y el archivo sale sin audio.' + why)
      : ins.speech ? 'Listo. La voz del texto solo suena en la vista previa (el navegador no deja capturarla): el archivo sale sin audio. Para llevar voz en el archivo, graba la tuya.' : 'Listo.'
  } catch (e) { status.value = e instanceof Error ? e.message : String(e) } finally { busy.value = false }
}
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
    <div class="frame">
      <video v-if="videoUrl" :src="videoUrl" controls playsinline :loop="lastDance ? hasAudio : !speechText && !voiceUrl" :autoplay="!hasAudio" :muted="!hasAudio" @play="onPlay" @pause="onPause" />
      <canvas v-else-if="bitmap" ref="cv" width="512" height="512" aria-label="Encuadre de la fotografía" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" />
      <label v-else class="empty">📷<input type="file" accept="image/*,.heic" hidden @change="pick" /></label>
    </div>
    <div class="row">
      <label class="btn">Elegir fotografía<input type="file" accept="image/*,.heic" hidden @change="pick" /></label>
      <button v-if="photoUrl" @click="clear()">Quitar</button>
      <button v-if="videoUrl" @click="clear(false)">Ajustar encuadre</button>
    </div>
    <div v-if="bitmap && !videoUrl" class="row"><input type="range" min="1" max="5" step="0.05" v-model.number="crop.zoom" aria-label="Zoom" /><button @click="rotateCrop(bitmap, crop)">↻ Girar</button></div>
    <div class="row seg"><button :class="{ on: !dance }" @click="dance = false">💬 Instrucción</button><button :class="{ on: dance }" @click="dance = true">💃 Bailar con música</button></div>
    <template v-if="!dance">
      <label>¿Qué quieres que haga?
        <textarea v-model="prompt" placeholder="Que sonría, mire a la cámara y parpadee…" style="width:100%" /></label>
      <div class="row"><button :disabled="busy" @click="toggleRec">{{ recording ? '⏹ Parar' : '🎙 Grabar mi voz' }}</button><button v-if="voiceBuf" @click="clearVoice">Quitar voz</button></div>
    </template>
    <template v-else>
      <div class="row"><label class="btn">{{ musicName ? '🎵 Cambiar música' : '🎵 Subir música' }}<input type="file" accept="audio/*,audio/mpeg,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac" hidden :disabled="busy || analyzing" @change="pickMusic" /></label><button v-if="musicName" :disabled="busy" @click="clearMusic">Quitar</button></div>
      <div v-if="musicName" class="music">
        <div class="st">🎵 {{ musicName }} · {{ musicDur.toFixed(0) }} s</div>
        <div class="row bpmrow"><button @click="setBpm(bpm / 2)">÷2</button><button @click="setBpm(bpm - 1)">−</button><b>{{ bpm }} BPM</b><button @click="setBpm(bpm + 1)">+</button><button @click="setBpm(bpm * 2)">×2</button></div>
        <label v-if="maxStart > 0.5">Empezar en el segundo {{ startAt.toFixed(0) }} · baila {{ danceDur.toFixed(0) }} s<input type="range" min="0" :max="maxStart" step="0.5" v-model.number="startAt" style="width:100%" /></label>
      </div>
    </template>
    <div class="bgs"><div class="st">Fondo del vídeo</div>
      <div class="chips">
        <button :class="{ on: bgId === 'none' }" @click="bgId = 'none'">Original</button>
        <button v-for="b in BG_UI" :key="b.id" class="chip" :class="{ on: bgId === b.id }" :style="{ background: b.css }" @click="bgId = b.id">{{ b.label }}</button>
        <label class="btn" :class="{ on: bgId === 'image' }">{{ bgBmp ? '🖼 Cambiar imagen' : '🖼 Mi imagen' }}<input type="file" accept="image/*,.heic" hidden @change="pickBg" /></label>
      </div>
    </div>
    <select v-model="tier"><option v-for="(t, k) in tiers" :key="k" :value="k">{{ tierLabel(k) }}</option></select>
    <button class="go" :disabled="!bitmap || busy || analyzing || !!(caps && !caps.ok)" @click="generate">{{ busy ? 'Animando…' : 'Animar' }}</button>
    <div v-if="busy" class="bar"><i :style="{ width: pct + '%' }" /></div>
    <div class="st" role="status">{{ status }}</div>
    <div v-if="videoUrl" class="row"><button :disabled="busy" @click="generate">Volver a generar</button><button @click="save">Guardar</button><button v-if="canShare" @click="share">Compartir</button></div>
    <DebugPanel v-if="debug && bitmap" :bitmap="bitmap" :crop="crop" :prompt="prompt" />
    <button class="lnk" @click="wipe">Borrar datos locales</button>
  </main>
</template>
<style scoped>
.seg .on{background:var(--ink);color:#fff}.music{display:grid;gap:8px}.bpmrow{align-items:center}.bpmrow b{text-align:center;font-size:1.15rem;flex:1.6}
.bgs{display:grid;gap:6px}.chips{display:flex;flex-wrap:wrap;gap:8px}.chips>*{flex:0 0 auto;padding:8px 12px}
.chip{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.65)}.chips .on{outline:3px solid var(--acc);outline-offset:2px}
</style>
