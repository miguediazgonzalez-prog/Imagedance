/** Texto en español -> AnimationInstruction (reglas) -> FacialMotion por instante (keyframes suaves + ruido sutil). */
export interface AnimationInstruction { duration: number; headMovement?: string; eyeMovement?: string; facialExpression?: string; mouthMovement?: string; speech?: string; emotion?: string; intensity?: number }
export interface FacialMotion { eyeBlinkLeft: number; eyeBlinkRight: number; eyeLookX: number; eyeLookY: number; mouthSmile: number; mouthOpen: number; eyebrowLeft: number; eyebrowRight: number; headYaw: number; headPitch: number; headRoll: number; mouthWidth: number; lipRound: number }
export interface VisemeFrame { time: number; mouthOpen: number; mouthWidth: number; lipRound: number }
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
export function parseInstruction(text: string, duration: number): AnimationInstruction {
  const s = norm(text), ex: string[] = []
  const ins: AnimationInstruction = { duration, headMovement: 'subtle', eyeMovement: 'camera', emotion: 'neutral', intensity: 0.65 }
  const sp = text.match(/\bdi(?:ga|ce|gan)?\b\s*:?\s*["“«]?(.+?)["”»]?\s*\.?$/i)
  if (sp) { ins.speech = sp[1].trim(); ins.mouthMovement = 'speech' }
  if (/sonr|saluda/.test(s)) ex.push('smile')
  if (/\bri(e|a|an)\b|risa|carcaj|riendo/.test(s)) ex.push('laugh')
  if (/guin/.test(s)) ex.push('wink')
  if (ex.length) { ins.facialExpression = ex.join('+'); ins.emotion = 'friendly' }
  // "izquierda/derecha" = lado de la pantalla tal como lo ve quien mira el vídeo
  const dir = /izquierda/.test(s) ? 'left' : /derecha/.test(s) ? 'right' : 'camera'
  ins.eyeMovement = dir !== 'camera' && /despues|luego|vuelva|vuelve|otra vez/.test(s) ? dir + '>camera' : dir
  if (/mucho|muy |enorme|grande/.test(s)) ins.intensity = 0.9
  else if (/ligera|suave|poco/.test(s)) ins.intensity = 0.45
  return ins
}
const ss = (a: number, b: number, t: number) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x) }
export function motionAt(t: number, ins: AnimationInstruction, vis?: VisemeFrame[]): FacialMotion {
  const d = ins.duration, k = ins.intensity ?? 0.65, ex = ins.facialExpression ?? '', em = ins.eyeMovement ?? 'camera'
  const pulse = (t0: number, u: number, h: number, dn: number) => ss(t0, t0 + u, t) * (1 - ss(t0 + u + h, t0 + u + h + dn, t))
  const laugh = ex.includes('laugh'), smile = (ex.includes('smile') || laugh) ? Math.min(1, k * ss(0.2 * d, 0.4 * d, t) * (laugh ? 1.15 : 1)) : 0
  const lAmp = laugh ? ss(0.3 * d, 0.4 * d, t) * (1 - ss(0.85 * d, 0.95 * d, t)) : 0, lw = 0.55 + 0.45 * Math.sin(t * 6 * Math.PI)
  const nb = Math.max(0, ...[2.0, 4.4, 6.9, 9.2].filter(x => x < d - 0.5).map(x => pulse(x, 0.07, 0.02, 0.09)))
  const wink = ex.includes('wink') ? 0.95 * pulse(0.45 * d, 0.12, 0.25, 0.15) : 0
  const tgt = em.startsWith('left') ? -1 : em.startsWith('right') ? 1 : 0
  const lx = tgt * ss(0.15 * d, 0.3 * d, t) * (em.includes('>') ? 1 - ss(0.55 * d, 0.7 * d, t) : 1)
  let v = { mouthOpen: 0, mouthWidth: 0.5, lipRound: 0 }
  if (vis?.length) { const dt = vis.length > 1 ? vis[1].time - vis[0].time : 1 / 24; if (t >= vis[0].time - dt) v = vis[Math.min(vis.length - 1, Math.max(0, Math.round((t - vis[0].time) / dt)))] }
  return {
    eyeBlinkLeft: nb, eyeBlinkRight: Math.max(nb, wink),
    eyeLookX: lx + 0.02 * Math.sin(t * 3.1), eyeLookY: 0.02 * Math.sin(t * 2.3 + 1),
    mouthSmile: smile, mouthOpen: Math.max(0.3 * k * lAmp * lw, v.mouthOpen), mouthWidth: v.mouthWidth, lipRound: v.lipRound, eyebrowLeft: smile * 0.25, eyebrowRight: smile * 0.25,
    headYaw: lx * 0.8 + 0.03 * Math.sin(t * 0.9) + 0.02 * Math.sin(t * 2.3 + 1),
    headPitch: 0.025 * Math.sin(t * 1.1 + 0.5) + 0.25 * lAmp * Math.sin(t * 6 * Math.PI),
    headRoll: 0.012 * Math.sin(t * 0.7 + 2)
  }
}

/** Baile: el cuerpo se balancea desde la cintura (la base de la foto queda fija) y la cabeza cabecea al compás. Cada frase de 8 tiempos usa una figura distinta. */
export interface DanceSpec { bpm: number; offset: number; fps: number; energy: number[] }
export interface BodyMotion { swayX: number; roll: number; squash: number; zoom: number; pulse: number }
/** Figuras: sway = balanceo lateral, bob = rebote vertical, yaw = giro de cabeza, nod = cabeceo, roll = inclinación, lean = ladeo lento de 4 tiempos. */
const MOVES = [
  { sway: 1, bob: 0.6, yaw: 0.5, nod: 0.8, roll: 1, lean: 0 },      // balanceo clásico
  { sway: 0.35, bob: 1, yaw: 0.25, nod: 1.1, roll: 0.4, lean: 0 },  // rebote
  { sway: 0.7, bob: 0.5, yaw: 1, nod: 0.5, roll: 0.8, lean: 1 },    // mira a los lados y ladea
  { sway: 0.55, bob: 0.8, yaw: 0.4, nod: 0.7, roll: 1.2, lean: 0 }  // balanceo amplio
]
type Move = (typeof MOVES)[number]
const moveOf = (phrase: number): Move => MOVES[Math.imul(phrase + 7, 2654435761) >>> 30]
/** t en segundos del vídeo; offset = instante del primer beat. */
export function danceAt(t: number, d: DanceSpec): { face: FacialMotion; body: BodyMotion } {
  const b = (t - d.offset) / (60 / d.bpm), ph = b - Math.floor(b)
  const e = d.energy.length ? d.energy[Math.min(d.energy.length - 1, Math.max(0, Math.round(t * d.fps)))] : 1
  const amp = (0.4 + 0.6 * e) * Math.min(1, 120 / d.bpm) ** 0.6     // más suave con música floja y con tempos rápidos (menos tiempo para moverse)
  const cosDown = (0.5 + 0.5 * Math.cos(2 * Math.PI * ph)) ** 1.6      // 1 justo en el beat, 0 a contratiempo (suave: tolera un BPM algo desajustado)
  const sharp = Math.max(ss(0.8, 1, ph), Math.exp(-4 * ph) * (1 - ss(0.3, 0.6, ph)))  // anticipación corta + golpe seco en el beat + caída rápida
  const hit = 0.65 * cosDown + 0.35 * sharp
  const side = Math.cos(Math.PI * b)                                    // +1 / -1 alternando en cada beat
  const slow = Math.sin((Math.PI * b) / 2)                              // ciclo de 4 tiempos
  const pulse = Math.exp(-4 * ph)                                       // destello al golpe
  const q = b / 8, k = Math.floor(q), mix = ss(0.875, 1, q - k), A = moveOf(k), B = moveOf(k + 1)  // figura de la frase, fundida con la siguiente en el último tiempo
  const P = { sway: A.sway + (B.sway - A.sway) * mix, bob: A.bob + (B.bob - A.bob) * mix, yaw: A.yaw + (B.yaw - A.yaw) * mix, nod: A.nod + (B.nod - A.nod) * mix, roll: A.roll + (B.roll - A.roll) * mix, lean: A.lean + (B.lean - A.lean) * mix }
  const bl = (x: number) => ss(0, 0.07, x) * (1 - ss(0.09, 0.18, x))
  const blink = Math.max(bl((t + 0.9) % 3.3), bl((t + 2.1) % 5.7))
  return {
    face: {
      eyeBlinkLeft: blink, eyeBlinkRight: blink, eyeLookX: 0.02 * Math.sin(t * 3.1), eyeLookY: 0.02 * Math.sin(t * 2.3 + 1),
      mouthSmile: 0.5 + 0.25 * hit * amp, mouthOpen: 0.1 * hit * amp, eyebrowLeft: 0.15 + 0.15 * hit, eyebrowRight: 0.15 + 0.15 * hit,
      headYaw: 0.7 * amp * P.yaw * slow, headPitch: 0.9 * amp * P.nod * hit, headRoll: -0.1 * amp * P.roll * side - 0.05 * amp * P.lean * slow, mouthWidth: 0.55, lipRound: 0
    },
    body: { swayX: side * amp * P.sway, roll: 0.035 * amp * P.roll * side + 0.03 * amp * P.lean * slow, squash: 1 - 0.05 * amp * P.bob * hit, zoom: 1.05 + 0.01 * amp * hit, pulse }
  }
}
