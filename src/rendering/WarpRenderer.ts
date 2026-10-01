/** Deformación de malla 96x96 en WebGL2: la foto es la textura; cada frame desplaza vértices según FacialMotion (+ baile del cuerpo). Con máscara y fondo, la persona se compone sobre el fondo elegido. */
import type { Pt } from '../ai/FaceLandmarks'
import type { FacialMotion, BodyMotion } from '../ai/MotionPlanner'
import type { Mask } from '../ai/Segmenter'
import { bgFragment, type BgSpec } from './Backgrounds'
const N = 96
const g = (d: number, r: number) => Math.exp(-((d / r) ** 2))
export class WarpRenderer {
  private gl: WebGL2RenderingContext; private base: Float32Array; private cur: Float32Array
  private buf: WebGLBuffer; private n: number; private fs: number; private S: number; private masked = false
  private bp?: WebGLProgram; private bvao?: WebGLVertexArrayObject; private bT: WebGLUniformLocation | null = null; private bP: WebGLUniformLocation | null = null
  private mp!: WebGLProgram; private mvao!: WebGLVertexArrayObject; private ip!: WebGLProgram; private ivao!: WebGLVertexArrayObject; private ie!: WebGLUniformLocation
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, src: ImageBitmap, private L: Pt[], bg?: BgSpec, mask?: Mask) {
    const S = (canvas.width = canvas.height = src.width); this.S = S
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2', { antialias: true }); if (!gl) throw new Error('WebGL2 no disponible')
    this.gl = gl; this.fs = Math.hypot(L[234].x - L[454].x, L[234].y - L[454].y)
    const V = (N + 1) * (N + 1); this.base = new Float32Array(V * 2); this.cur = new Float32Array(V * 2)
    const uv = new Float32Array(V * 2), idx = new Uint32Array(N * N * 6); let q = 0
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const k = (j * (N + 1) + i) * 2; this.base[k] = (i / N) * S; this.base[k + 1] = (j / N) * S; uv[k] = i / N; uv[k + 1] = j / N }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.set([a, c, b, b, c, d], q); q += 6 }
    this.n = idx.length
    const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); return o }
    const pr = gl.createProgram()!
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, `#version 300 es
in vec2 p; in vec2 uv; uniform float S; out vec2 v; void main(){v=uv; gl_Position=vec4(p.x/S*2.-1.,1.-p.y/S*2.,0.,1.);}`))
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; in vec2 v; uniform sampler2D t; uniform sampler2D mk; uniform float um; out vec4 o; void main(){vec4 c=texture(t,v); o=vec4(c.rgb, um>.5?smoothstep(.38,.72,texture(mk,v).r):1.);}`))
    gl.linkProgram(pr); gl.useProgram(pr); gl.uniform1f(gl.getUniformLocation(pr, 'S'), S); this.mp = pr
    gl.uniform1i(gl.getUniformLocation(pr, 'mk'), 1); gl.uniform1f(gl.getUniformLocation(pr, 'um'), mask ? 1 : 0); this.masked = !!mask
    this.mvao = gl.createVertexArray()!; gl.bindVertexArray(this.mvao)
    this.buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, this.base, gl.DYNAMIC_DRAW)
    const lp = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0)
    const ub = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ub); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
    const lu = gl.getAttribLocation(pr, 'uv'); gl.enableVertexAttribArray(lu); gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Textura 1: máscara de persona (R8; sin máscara, 1×1 blanco). Textura 2: imagen de fondo elegida.
    const tex = (unit: number) => { gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE) }
    tex(gl.TEXTURE1); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    if (mask) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.w, mask.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]))
    if (bg?.id === 'image' && bg.bitmap) { tex(gl.TEXTURE2); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bg.bitmap) }
    gl.activeTexture(gl.TEXTURE0)
    // Interior de la boca: elipse oscura y suave que tapa el hueco entre labios al abrir (sin dientes inventados).
    const ip = (this.ip = gl.createProgram()!)
    gl.attachShader(ip, sh(gl.VERTEX_SHADER, `#version 300 es
uniform float S; out vec2 px; void main(){vec2 q=vec2(float(gl_VertexID&1),float(gl_VertexID>>1)); px=vec2(q.x,1.-q.y)*S; gl_Position=vec4(q*2.-1.,0.,1.);}`))
    gl.attachShader(ip, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; in vec2 px; uniform vec4 e; out vec4 o; void main(){float d=length((px-e.xy)/e.zw); o=vec4(.17,.06,.08,.92*(1.-smoothstep(.75,1.,d)));}`))
    gl.linkProgram(ip); gl.useProgram(ip); gl.uniform1f(gl.getUniformLocation(ip, 'S'), S); this.ie = gl.getUniformLocation(ip, 'e')!
    this.ivao = gl.createVertexArray()!
    if (bg) { // Fondo: cuadrado a pantalla completa con el shader del fondo elegido.
      const bp = (this.bp = gl.createProgram()!)
      gl.attachShader(bp, sh(gl.VERTEX_SHADER, `#version 300 es
out vec2 v; void main(){vec2 q=vec2(float(gl_VertexID&1),float(gl_VertexID>>1)); v=vec2(q.x,1.-q.y); gl_Position=vec4(q*2.-1.,0.,1.);}`))
      gl.attachShader(bp, sh(gl.FRAGMENT_SHADER, bgFragment(bg.id))); gl.linkProgram(bp)
      if (!gl.getProgramParameter(bp, gl.LINK_STATUS)) throw new Error(`Este dispositivo no pudo preparar el fondo (${gl.getProgramInfoLog(bp) || 'shader'}).`)
      gl.useProgram(bp); gl.uniform1i(gl.getUniformLocation(bp, 'img'), 2); this.bT = gl.getUniformLocation(bp, 'T'); this.bP = gl.getUniformLocation(bp, 'P'); this.bvao = gl.createVertexArray()!
    }
    gl.useProgram(pr); gl.bindVertexArray(this.mvao)
    gl.viewport(0, 0, S, S)
  }
  render(m: FacialMotion, t = 0, b?: BodyMotion) {
    const { L, fs, base, cur, gl, S } = this, c = L[1], cs = Math.cos(m.headRoll), sn = Math.sin(m.headRoll), rc = b ? Math.cos(b.roll) : 1, rs = b ? Math.sin(b.roll) : 0
    const eyes = [{ o: L[33], i: L[133], u: L[159], d: L[145], ir: L[468], b: m.eyeBlinkRight }, { o: L[263], i: L[362], u: L[386], d: L[374], ir: L[473], b: m.eyeBlinkLeft }]
      .map(e => ({ ...e, cx: (e.o.x + e.i.x) / 2, cy: (e.u.y + e.d.y) / 2, w: Math.hypot(e.o.x - e.i.x, e.o.y - e.i.y) }))
    const brows = [{ p: L[105], v: m.eyebrowRight }, { p: L[334], v: m.eyebrowLeft }], mc = [L[61], L[291]], lip = L[14], mid = L[13]
    for (let k = 0; k < cur.length; k += 2) {
      const x = base[k], y = base[k + 1]; let X = x, Y = y
      for (const e of eyes) {
        if (e.b > 0 && y < e.cy) Y += (e.cy - y) * Math.min(0.92, e.b) * g(x - e.cx, e.w * 0.6) * g(e.cy - y, e.w * 0.45)
        const w = g(Math.hypot(x - e.ir.x, y - e.ir.y), e.w * 0.26); X += m.eyeLookX * e.w * 0.13 * w; Y += m.eyeLookY * e.w * 0.1 * w
      }
      for (const b of brows) Y -= b.v * fs * 0.03 * g(Math.hypot(x - b.p.x, y - b.p.y), fs * 0.13)
      mc.forEach((p, i) => { const w = g(Math.hypot(x - p.x, y - p.y), fs * 0.13); Y -= m.mouthSmile * fs * 0.05 * w; X += (i ? 1 : -1) * (m.mouthSmile * 0.025 + (m.mouthWidth - 0.5) * 0.05 - m.lipRound * 0.03) * fs * w })
      if (y > mid.y) Y += m.mouthOpen * fs * 0.09 * g(Math.hypot(x - lip.x, y - lip.y), fs * 0.13)
      const dx = X - c.x, dy = Y - c.y, w = Math.exp(-((Math.hypot(x - c.x, y - c.y) / (fs * 1.15)) ** 4))
      X += (c.x + dx * cs - dy * sn - X) * w + m.headYaw * fs * 0.09 * w
      Y += (c.y + dx * sn + dy * cs - Y) * w + m.headPitch * fs * 0.05 * w
      if (b) { // Cuerpo: zoom + aplastamiento desde la base, balanceo e inclinación ponderados por la altura (la base de la foto no se mueve).
        const hg = Math.pow(1 - y / S, 1.2)
        X = S / 2 + (X - S / 2) * b.zoom; Y = S - (S - Y) * b.zoom * b.squash
        const bx = X - S / 2, by = Y - S
        X += (bx * rc - by * rs - bx) * hg + b.swayX * S * 0.05 * hg; Y += (bx * rs + by * rc - by) * hg
      }
      cur[k] = X; cur[k + 1] = Y
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, cur)
    gl.disable(gl.BLEND); gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.bp) { gl.useProgram(this.bp); gl.bindVertexArray(this.bvao!); gl.uniform1f(this.bT, t); gl.uniform1f(this.bP, b?.pulse ?? 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.useProgram(this.mp); gl.bindVertexArray(this.mvao) }
    if (this.masked) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA) }
    gl.drawElements(gl.TRIANGLES, this.n, gl.UNSIGNED_INT, 0)
    const gap = m.mouthOpen * fs * 0.09
    if (gap > 1.5) {
      gl.useProgram(this.ip); gl.bindVertexArray(this.ivao); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      const dz = Math.max(0, lip.y - mid.y)
      gl.uniform4f(this.ie, lip.x, (mid.y + lip.y + gap) / 2, Math.hypot(L[78].x - L[308].x, L[78].y - L[308].y) * 0.42 * (1 - m.lipRound * 0.35), (gap + dz) / 2 + fs * 0.012)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disable(gl.BLEND); gl.useProgram(this.mp); gl.bindVertexArray(this.mvao)
    }
  }
}
