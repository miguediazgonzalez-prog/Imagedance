<script setup lang="ts">
/** Panel de afinado (solo con ?debug=1): sliders de FacialMotion en vivo sobre la foto encuadrada + scrubber de la animación planificada. */
import { reactive, ref, watch } from 'vue'
import { detect } from '../ai/FaceLandmarks'
import { drawCrop, type Crop } from './cropper'
import { WarpRenderer } from '../rendering/WarpRenderer'
import { motionAt, parseInstruction, type FacialMotion } from '../ai/MotionPlanner'
const props = defineProps<{ bitmap: ImageBitmap; crop: Crop; prompt: string }>()
const DUR = 5, cv = ref<HTMLCanvasElement | null>(null), status = ref('Pulsa «Cargar rostro».'), t = ref(0)
const zero = (): FacialMotion => ({ eyeBlinkLeft: 0, eyeBlinkRight: 0, eyeLookX: 0, eyeLookY: 0, mouthSmile: 0, mouthOpen: 0, eyebrowLeft: 0, eyebrowRight: 0, headYaw: 0, headPitch: 0, headRoll: 0, mouthWidth: 0.5, lipRound: 0 })
const m = reactive<FacialMotion>(zero())
const ranges: [keyof FacialMotion, number, number][] = [['eyeBlinkLeft', 0, 1], ['eyeBlinkRight', 0, 1], ['eyeLookX', -1, 1], ['eyeLookY', -1, 1], ['mouthSmile', 0, 1], ['mouthOpen', 0, 1], ['mouthWidth', 0, 1], ['lipRound', 0, 1], ['eyebrowLeft', -1, 1], ['eyebrowRight', -1, 1], ['headYaw', -1, 1], ['headPitch', -1, 1], ['headRoll', -0.2, 0.2]]
let r: WarpRenderer | null = null
async function load() {
  status.value = 'Analizando rostro…'
  const src = drawCrop(props.bitmap, props.crop, 512), L = await detect(src)
  if (!L) { status.value = 'No detecto rostro en este encuadre.'; return }
  r = new WarpRenderer(cv.value!, await createImageBitmap(src), L); status.value = 'Listo: mueve los sliders.'; r.render(m)
}
watch(m, () => r?.render(m))
watch(t, v => Object.assign(m, motionAt(v, parseInstruction(props.prompt, DUR))))
const reset = () => { Object.assign(m, zero()); t.value = 0 }
const copy = () => navigator.clipboard?.writeText(JSON.stringify(m, null, 1))
</script>
<template>
  <section class="dbg">
    <canvas ref="cv" width="512" height="512" />
    <div class="row"><button @click="load">Cargar rostro</button><button @click="reset">Reiniciar</button><button @click="copy">Copiar JSON</button></div>
    <div class="st">{{ status }}</div>
    <label>Tiempo de la animación del texto: {{ t.toFixed(2) }} s<input type="range" min="0" :max="DUR" step="0.04" v-model.number="t" /></label>
    <label v-for="[k, lo, hi] in ranges" :key="k">{{ k }} {{ m[k].toFixed(2) }}<input type="range" :min="lo" :max="hi" step="0.01" v-model.number="m[k]" /></label>
  </section>
</template>
<style scoped>
.dbg{display:grid;gap:6px;font-size:.85rem;border-top:2px solid var(--ink);padding-top:12px}.dbg canvas{width:100%;aspect-ratio:1;border-radius:12px;background:#fff}.dbg label{display:grid;gap:2px}
</style>
