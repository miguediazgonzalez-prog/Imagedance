/** Deformación de malla 96x96 en WebGL2: la foto es la textura; cada frame desplaza vértices según FacialMotion (+ baile del cuerpo). Con máscara y fondo, la persona se compone sobre el fondo elegido.
 *  El lienzo puede ser cualquier ancho × alto (no solo cuadrado). Fondo y máscara se pueden cambiar en caliente (setBackground / setMask) para la vista previa en vivo. */
import type { Pt } from '../ai/FaceLandmarks'
import type { FacialMotion, BodyMotion } from '../ai/MotionPlanner'
import type { Mask } from '../ai/Segmenter'
import { bgFragment, bgGlsl, type BgId, type BgSpec } from './Backgrounds'
import { armDisp, armUniforms, type ArmRig } from '../ai/ArmSkin'
const N = 96
type GpuProg = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
/** Giro 3D de cabeza: radianes por unidad de headYaw / headPitch, fracción de fs que baja el pivote desde la línea de las orejas (hacia el cuello) y ganancia de la profundidad de los landmarks. */
const YAW_RAD = 0.35, PITCH_RAD = 0.3, PIVOT_DOWN = 0.3, DEPTH_GAIN = 1
/** Sombreado por giro: la luz es fija en pantalla (arriba-izquierda-delante) y solo se aplica el CAMBIO de iluminación respecto a la foto (en reposo no altera nada). SHADE_GAIN = intensidad. Cráneo: semiejes del elipsoide (× fs) que da profundidad al pelo y la frente. */
/** Suavizado de malla al girar: pasadas del filtro [1 2 1] y ángulo (rad) a partir del cual actúa al 100% (por debajo se mezcla, para no ablandar las expresiones con la cabeza quieta). */
/** Mirada compensada: los iris se desplazan en sentido contrario al giro de la cabeza para seguir mirando a cámara. 0 = los ojos giran con la cabeza (como antes), 1 = mirada fija en cámara. */
const GAZE_COMP = 0.6
const SMOOTH_PASSES = 2, SMOOTH_FULL = 0.12
const SHADE_GAIN = 1.2, LX = -0.45, LY = -0.55, LZ = 0.70, SKULL = { rx: 0.62, ry: 0.85, rz: 0.45, dy: -0.1 }
const g = (d: number, r: number) => Math.exp(-((d / r) ** 2))
interface PersonProg { p: WebGLProgram; T: WebGLUniformLocation | null; P: WebGLUniformLocation | null; S: WebGLUniformLocation | null; ig: WebGLUniformLocation | null }
interface BgProg { p: WebGLProgram; T: WebGLUniformLocation | null; P: WebGLUniformLocation | null; S: WebGLUniformLocation | null; pp?: PersonProg }
const MESH_VERT = `#version 300 es
in vec4 p; in vec2 uv; uniform vec2 WH; out vec2 v; out float sh; void main(){v=uv; sh=p.w; gl_Position=vec4(p.x/WH.x*2.-1.,1.-p.y/WH.y*2.,p.z,1.);}`
/** Pase de la persona sobre un fondo concreto (incluye el GLSL del fondo para tomar su luz): 1) quita el halo del fondo original trayendo color desde dentro del borde,
 *  2) luz envolvente: el borde interior de la persona recoge el color del fondo, 3) matiz ambiente, 4) sombra suave proyectada sobre el fondo. ig=0 desactiva 2–4. */
const personFrag = (id: BgId) => `#version 300 es
precision highp float; in vec2 v; in float sh; uniform sampler2D t; uniform sampler2D mk; uniform vec2 WH; uniform float ig; out vec4 o;
${bgGlsl(id)}
float mt(vec2 q){ return texture(mk,q).r; }
void main(){
  vec2 ou=1./WH; vec3 c=texture(t,v).rgb*sh; float m0=mt(v), a=smoothstep(.42,.70,m0);
  vec2 g=vec2(mt(v+vec2(2.*ou.x,0.))-mt(v-vec2(2.*ou.x,0.)), mt(v+vec2(0.,2.*ou.y))-mt(v-vec2(0.,2.*ou.y))); float gl=length(g);
  vec2 dir=gl>1e-4?g/gl:vec2(0.);                                   // apunta hacia dentro de la persona
  c=mix(c,texture(t,v+dir*5.*ou).rgb,(1.-abs(2.*m0-1.))*.85);        // 1) sin halo del fondo original
  float sA=0.;
  if(ig>.5){
    vec3 bc=bgx(vec2(gl_FragCoord.x/WH.x,1.-gl_FragCoord.y/WH.y));
    float acc=0.; for(int i=0;i<8;i++){ float an=.785398*float(i); acc+=mt(v+vec2(cos(an),sin(an))*7.*ou); } acc/=8.;
    float rim=a*clamp((1.-acc)*1.8,0.,1.);
    c=c*(1.-.25*rim)+bc*.5*rim;                                        // 2) luz envolvente
    c*=mix(vec3(1.),.7+.7*bc,.30);                                      // 3) matiz ambiente
    vec2 off=vec2(.016,.024)*WH.y*ou, sp=8.*ou; float sh=0.;
    for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++) sh+=mt(v-off+vec2(float(i),float(j))*sp); sh/=9.;
    sA=.30*smoothstep(.2,.8,sh);                                        // 4) sombra suave abajo a la derecha
  }
  float a2=a+(1.-a)*sA; if(a2<.004) discard; o=vec4(c*a/max(a2,1e-4),a2);                    // (con mezcla SRC_ALPHA: persona sobre sombra sobre fondo)
}`
const BG_VERT = `#version 300 es
out vec2 v; void main(){vec2 q=vec2(float(gl_VertexID&1),float(gl_VertexID>>1)); v=vec2(q.x,1.-q.y); gl_Position=vec4(q*2.-1.,0.,1.);}`
/** ---- Deformación en GPU: el mismo cálculo de warp()/smooth()/gaze() en shaders. La malla se calcula en una textura RGBA32F de (N+1)×(N+1) texels (x, y, z, sombra por vértice);
 *  el vértice de la malla solo la lee con texelFetch. Si el dispositivo no puede renderizar a float, se usa el camino CPU de siempre. */
const F = (n: number) => { const t = String(n); return n < 0 ? `(${/[.e]/.test(t) ? t : t + '.'})` : /[.e]/.test(t) ? t : t + '.' }
const MESH_VERT_GPU = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D pos; uniform vec2 WH; out vec2 v; out float sh;
void main(){ ivec2 q=ivec2(gl_VertexID%${N + 1}, gl_VertexID/${N + 1}); vec4 p=texelFetch(pos,q,0); v=vec2(q)/${F(N)}; sh=p.w; gl_Position=vec4(p.x/WH.x*2.-1.,1.-p.y/WH.y*2.,p.z,1.);}`
const PASS_VERT = `#version 300 es
void main(){vec2 q=vec2(float(gl_VertexID&1),float(gl_VertexID>>1)); gl_Position=vec4(q*2.-1.,0.,1.);}`
const PASS_HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; out vec4 o;
float g(float d,float r){float q=d/r; return exp(-q*q);}
`
const WARP_FRAG = PASS_HEAD + `uniform sampler2D S; uniform vec4 uE[2], uI[2], uB[2], uM[2]; uniform vec4 uP0, uP1, uC, uR0, uF, uBody, uA[6]; uniform vec2 uR1, uWH, uBody2;
vec2 rotA(vec2 p, vec2 c, float a){ float cs=cos(a), sn=sin(a); vec2 d=p-c; return c+vec2(d.x*cs-d.y*sn, d.x*sn+d.y*cs); }
float segD(vec2 p, vec2 a, vec2 b, out float t){ vec2 ab=b-a; t=dot(p-a,ab)/max(dot(ab,ab),1e-6); return length(p-(a+ab*clamp(t,0.,1.))); }
void main(){
  ivec2 q=ivec2(gl_FragCoord.xy); float x=float(q.x)/${F(N)}*uWH.x, y=float(q.y)/${F(N)}*uWH.y, X=x, Y=y, fs=uP1.w;
  for(int k=0;k<2;k++){ vec4 e=uE[k], ir=uI[k];
    if(e.w>0. && y<e.y) Y+=(e.y-y)*min(.92,e.w)*g(x-e.x,e.z*.6)*g(e.y-y,e.z*.45);
    float w=g(length(vec2(x-ir.x,y-ir.y)),e.z*.26); X+=ir.z*e.z*.13*w; Y+=ir.w*e.z*.1*w; }
  for(int k=0;k<2;k++){ vec4 b=uB[k]; Y-=b.z*fs*.03*g(length(vec2(x-b.x,y-b.y)),fs*.13); }
  for(int k=0;k<2;k++){ vec4 m=uM[k]; float w=g(length(vec2(x-m.x,y-m.y)),fs*.13); Y-=uP1.x*fs*.05*w; X+=(k==1?1.:-1.)*(uP1.x*.025+(uP1.y-.5)*.05-uP1.z*.03)*fs*w; }
  if(y>uP0.z) Y+=uP0.w*fs*.09*g(length(vec2(x-uP0.x,y-uP0.y)),fs*.13);
  for(int k=0;k<2;k++){ vec4 A0=uA[3*k], A1=uA[3*k+1], A2=uA[3*k+2];   // brazos y manos (misma fórmula que armDisp en ArmSkin.ts)
    if(A2.w>0.){ vec2 p0=vec2(x,y), S0=A0.xy, E0=A0.zw, W0=A1.xy, H0=A1.zw; float R=A2.w, tu, tf, th;
      float wu=exp(-pow(segD(p0,S0,E0,tu)/R,4.))*smoothstep(-.05,.3,tu), wf=exp(-pow(segD(p0,E0,W0,tf)/R,4.)), wh=exp(-pow(segD(p0,W0,H0,th)/(R*.7),4.)), sw=wu+wf+wh;
      if(sw>1e-4){ vec2 E1=rotA(E0,S0,A2.x), W1=rotA(rotA(W0,S0,A2.x),E1,A2.y), pu=rotA(p0,S0,A2.x), pf=rotA(pu,E1,A2.y), ph=rotA(pf,W1,A2.z), pn=(pu*wu+pf*wf+ph*wh)/sw;
        float inf=max(wu,max(wf,wh)); X+=inf*(pn.x-x); Y+=inf*(pn.y-y); } } }
  vec4 s=texelFetch(S,q,0); float hw=s.x, zb=s.y, Z=0., Sh=1.;
  if(hw>.002){
    vec2 P=uC.zw; float t0=uR0.x,t1=uR0.y,t2=uR0.z,t3=uR0.w,t4=uR1.x,t5=uR1.y, f=fs*6., dx=X-P.x, dy=Y-P.y;
    float x1=dx*t0+zb*t1, z1=-dx*t1+zb*t0, y2=dy*t2+z1*t3, z2=-dy*t3+z1*t2, k=(f-zb)/(f-z2);
    float ox=P.x+(x1*t4-y2*t5)*k, oy=P.y+(x1*t5+y2*t4)*k; X+=(ox-X)*hw; Y+=(oy-Y)*hw; Z=z2*hw;
    float nx=s.z, ny=s.w, nz=sqrt(max(0.,1.-nx*nx-ny*ny));
    float xa=nx*t0+nz*t1, za=-nx*t1+nz*t0, ya=ny*t2+za*t3, zz=-ny*t3+za*t2;
    Sh=clamp(1.+${F(SHADE_GAIN)}*hw*(((xa*t4-ya*t5)-nx-uF.x)*${F(LX)}+((xa*t5+ya*t4)-ny-uF.y)*${F(LY)}+(zz-nz-uF.z+1.)*${F(LZ)}),.6,1.4); }
  if(uBody2.y>.5){ float hg=pow(1.-y/uWH.y,1.2), hx=uWH.x*.5;
    X=hx+(X-hx)*uBody.x; Y=uWH.y-(uWH.y-Y)*uBody.x*uBody.y; float bx=X-hx, by=Y-uWH.y;
    X+=(bx*uBody.z-by*uBody.w-bx)*hg+uBody2.x*uWH.x*.05*hg; Y+=(bx*uBody.w+by*uBody.z-by)*hg; }
  o=vec4(X,Y,clamp(-Z/(fs*3.),-.98,.98),Sh);
}`
const SMOOTH_FRAG = PASS_HEAD + `uniform sampler2D T, S; uniform int horiz;
void main(){ ivec2 q=ivec2(gl_FragCoord.xy); vec4 c=texelFetch(T,q,0);
  if(q.x<1||q.y<1||q.x>=${N}||q.y>=${N}||texelFetch(S,q,0).x<.01){ o=c; return; }
  ivec2 d=horiz==1?ivec2(1,0):ivec2(0,1); o=(texelFetch(T,q-d,0)+2.*c+texelFetch(T,q+d,0))*.25; }`
const FINAL_FRAG = PASS_HEAD + `uniform sampler2D T, O; uniform float amt; uniform vec4 uE[2], uI[2]; uniform vec2 uG, uWH;
void main(){ ivec2 q=ivec2(gl_FragCoord.xy); vec4 org=texelFetch(O,q,0), c=org+(texelFetch(T,q,0)-org)*amt; vec2 b=vec2(q)/${F(N)}*uWH;
  for(int k=0;k<2;k++){ float ew=uE[k].z, wg=g(length(b-uI[k].xy),ew*.26); c.xy+=uG*ew*wg; }
  o=c; }`
export class WarpRenderer {
  private gl: WebGL2RenderingContext; private base: Float32Array; private cur: Float32Array
  private buf: WebGLBuffer; private n: number; private fs: number; private W: number; private H: number; private masked = false
  private hw!: Float32Array; private zb!: Float32Array; private n0!: Float32Array; private sm?: Float32Array; private so?: Float32Array
  private gpu = false; private G!: { tex: WebGLTexture[]; fbo: WebGLFramebuffer[]; S: WebGLTexture; pw: GpuProg; ps: GpuProg; pf: GpuProg; uE: Float32Array; uI: Float32Array; uB: Float32Array; uM: Float32Array }
  /** true si la deformación de la malla se calcula en la GPU (si no, en CPU). */
  get isGpu() { return this.gpu } private piv = { x: 0, y: 0 }; private tr = new Float64Array(6); private tmp = new Float64Array(3)
  private arms: ArmRig | null = null; private uA = new Float32Array(24); private bgs = new Map<BgId, BgProg>(); private bgp?: BgProg; private ig = 1; private bvao!: WebGLVertexArrayObject; private tMask!: WebGLTexture; private tBg!: WebGLTexture; private um: WebGLUniformLocation | null = null
  private vsMesh!: WebGLShader; private mp!: WebGLProgram; private mvao!: WebGLVertexArrayObject;
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, src: ImageBitmap, private L: Pt[], bg?: BgSpec, mask?: Mask, useGpu = true) {
    const W = (canvas.width = src.width), H = (canvas.height = src.height); this.W = W; this.H = H
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2', { antialias: true }); if (!gl) throw new Error('WebGL2 no disponible')
    this.gl = gl; this.fs = Math.hypot(L[234].x - L[454].x, L[234].y - L[454].y)
    const V = (N + 1) * (N + 1); this.base = new Float32Array(V * 2); this.cur = new Float32Array(V * 4)
    const uv = new Float32Array(V * 2), idx = new Uint32Array(N * N * 6); let q = 0
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const k = (j * (N + 1) + i) * 2; this.base[k] = (i / N) * W; this.base[k + 1] = (j / N) * H; uv[k] = i / N; uv[k + 1] = j / N }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.set([a, c, b, b, c, d], q); q += 6 }
    this.n = idx.length; this.initDepth(); this.gpu = useGpu && this.initGpu()
    const pr = gl.createProgram()!
    this.vsMesh = this.sh(gl.VERTEX_SHADER, this.gpu ? MESH_VERT_GPU : MESH_VERT); gl.attachShader(pr, this.vsMesh); gl.bindAttribLocation(pr, 0, 'p'); gl.bindAttribLocation(pr, 1, 'uv')
    gl.attachShader(pr, this.sh(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; in vec2 v; in float sh; uniform sampler2D t; uniform sampler2D mk; uniform float um; out vec4 o; void main(){vec4 c=texture(t,v); float al=um>.5?smoothstep(.38,.72,texture(mk,v).r):1.; if(al<.004) discard; o=vec4(c.rgb*sh, al);}`))
    gl.linkProgram(pr); gl.useProgram(pr); gl.uniform2f(gl.getUniformLocation(pr, 'WH'), W, H); this.mp = pr
    gl.uniform1i(gl.getUniformLocation(pr, 'mk'), 1); gl.uniform1i(gl.getUniformLocation(pr, 'pos'), 3); this.um = gl.getUniformLocation(pr, 'um')
    this.mvao = gl.createVertexArray()!; gl.bindVertexArray(this.mvao)
    this.buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, this.cur, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0)
    const ub = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ub); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Textura 1: máscara de persona (R8; sin máscara, 1×1 blanco). Textura 2: imagen de fondo elegida.
    const tex = (unit: number) => { gl.activeTexture(unit); const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t }
    this.tMask = tex(gl.TEXTURE1); this.tBg = tex(gl.TEXTURE2); gl.activeTexture(gl.TEXTURE0)
    this.bvao = gl.createVertexArray()!
    gl.useProgram(pr); gl.bindVertexArray(this.mvao)
    gl.viewport(0, 0, W, H)
    this.setBackground(bg); this.setMask(bg ? mask : undefined)
  }
  private sh(t: number, s: string) { const gl = this.gl, o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); return o }
  /** Cambia la máscara de persona (undefined = sin recorte). Sin fondo no tiene efecto visible: úsala junto a setBackground. */
  setMask(mask?: Mask) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tMask); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    if (mask) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.w, mask.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]))
    gl.activeTexture(gl.TEXTURE0); gl.useProgram(this.mp); gl.uniform1f(this.um, mask ? 1 : 0); this.masked = !!mask
  }
  /** Cambia el fondo (undefined = foto original). Los shaders se compilan una sola vez por fondo y se reutilizan. */
  setBackground(bg?: BgSpec) {
    const gl = this.gl
    if (!bg) { this.bgp = undefined; return }
    let b = this.bgs.get(bg.id)
    if (!b) {
      const p = gl.createProgram()!
      gl.attachShader(p, this.sh(gl.VERTEX_SHADER, BG_VERT)); gl.attachShader(p, this.sh(gl.FRAGMENT_SHADER, bgFragment(bg.id))); gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { const info = gl.getProgramInfoLog(p) || 'shader'; gl.deleteProgram(p); throw new Error(`Este dispositivo no pudo preparar el fondo (${info}).`) }
      gl.useProgram(p); gl.uniform1i(gl.getUniformLocation(p, 'img'), 2); gl.uniform1f(gl.getUniformLocation(p, 'A'), this.W / this.H)
      b = { p, T: gl.getUniformLocation(p, 'T'), P: gl.getUniformLocation(p, 'P'), S: gl.getUniformLocation(p, 'S') }
      const q = gl.createProgram()!   // si este pase no compila en algún dispositivo, la persona se pinta con el simple (sin luz ni sombra)
      gl.attachShader(q, this.vsMesh); gl.attachShader(q, this.sh(gl.FRAGMENT_SHADER, personFrag(bg.id))); gl.bindAttribLocation(q, 0, 'p'); gl.bindAttribLocation(q, 1, 'uv'); gl.linkProgram(q)
      if (gl.getProgramParameter(q, gl.LINK_STATUS)) {
        gl.useProgram(q); gl.uniform2f(gl.getUniformLocation(q, 'WH'), this.W, this.H); gl.uniform1i(gl.getUniformLocation(q, 't'), 0); gl.uniform1i(gl.getUniformLocation(q, 'mk'), 1); gl.uniform1i(gl.getUniformLocation(q, 'pos'), 3); gl.uniform1i(gl.getUniformLocation(q, 'img'), 2); gl.uniform1f(gl.getUniformLocation(q, 'A'), this.W / this.H)
        b.pp = { p: q, T: gl.getUniformLocation(q, 'T'), P: gl.getUniformLocation(q, 'P'), S: gl.getUniformLocation(q, 'S'), ig: gl.getUniformLocation(q, 'ig') }
      } else gl.deleteProgram(q)
      this.bgs.set(bg.id, b)
      gl.useProgram(this.mp); gl.bindVertexArray(this.mvao)
    }
    if (bg.id === 'image' && bg.bitmap) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tBg); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bg.bitmap); gl.activeTexture(gl.TEXTURE0) }
    this.bgp = b
  }
  /** Esqueleto de brazos de la foto (null = brazos quietos). Los giros de cada fotograma llegan en BodyMotion.arms. */
  setArms(rig: ArmRig | null) { this.arms = rig }
  /** Luz y sombra del fondo sobre la persona (solo con fondo y máscara). */
  setIntegrate(on: boolean) { this.ig = on ? 1 : 0 }
  /** Libera el contexto WebGL (la vista previa crea y destruye renderizadores; los navegadores limitan los contextos vivos). */
  dispose() { this.gl.getExtension('WEBGL_lose_context')?.loseContext() }
  /** Profundidad por vértice: media gaussiana de la z de los 478 landmarks (relativa al plano de las orejas, que es donde pasa el eje de giro), con un pequeño ancla a 0 para que fuera del rostro (pelo, cuello) quede plano. También precalcula el peso de cabeza. */
  private initDepth() {
    const { L, fs, base, W, H } = this, V = base.length / 2, c = L[1], zOf = (p: Pt) => p.z ?? 0
    const zEar = (zOf(L[234]) + zOf(L[454])) / 2, zr = L.map(p => (zOf(p) - zEar) * DEPTH_GAIN)
    this.piv = { x: (L[234].x + L[454].x) / 2, y: (L[234].y + L[454].y) / 2 + fs * PIVOT_DOWN }
    this.hw = new Float32Array(V); this.zb = new Float32Array(V); this.n0 = new Float32Array(V * 3)
    const ey = (L[234].y + L[454].y) / 2, cy = ey + SKULL.dy * fs, N1 = N + 1
    const s2 = (fs * 0.07) ** 2, cut = 3 * fs * 0.07
    for (let j = 0; j < V; j++) {
      const x = base[2 * j], y = base[2 * j + 1], w = Math.exp(-((Math.hypot(x - c.x, y - c.y) / (fs * 1.15)) ** 4)); this.hw[j] = w
      if (w < 0.01) continue
      let sw = 0, sz = 0
      for (let i = 0; i < L.length; i++) { const ex = x - L[i].x, ey = y - L[i].y; if (ex > cut || ex < -cut || ey > cut || ey < -cut) continue; const g = Math.exp(-(ex * ex + ey * ey) / s2); sw += g; sz += g * zr[i] }
      const q = 1 - ((x - this.piv.x) / (SKULL.rx * fs)) ** 2 - ((y - cy) / (SKULL.ry * fs)) ** 2, zs = q > 0 ? SKULL.rz * fs * Math.sqrt(q) : 0   // prior de cráneo: pelo y frente tienen volumen
      this.zb[j] = (sz + 0.1 * zs) / (sw + 0.1)
    }
    for (let j = 0; j < V; j++) {   // normales estáticas (diferencias centrales a ±2 celdas)
      if (this.hw[j] < 0.01) { this.n0[3 * j + 2] = 1; continue }
      const i = j % N1, r = (j - i) / N1, z = (a: number, b: number) => this.zb[Math.min(N, Math.max(0, b)) * N1 + Math.min(N, Math.max(0, a))]
      const gx = (z(i + 2, r) - z(i - 2, r)) / (4 * W / N), gy = (z(i, r + 2) - z(i, r - 2)) / (4 * H / N), il = 1 / Math.hypot(gx, gy, 1)
      this.n0[3 * j] = -gx * il; this.n0[3 * j + 1] = -gy * il; this.n0[3 * j + 2] = il
    }
  }
  /** Rotación 3D (guiñada → cabeceo → alabeo) alrededor del pivote, con perspectiva suave; en reposo es la identidad. Escribe [x, y, z] en this.tmp. */
  private project(x: number, y: number, z: number) {
    const t = this.tr, P = this.piv, o = this.tmp, f = this.fs * 6, dx = x - P.x, dy = y - P.y
    const x1 = dx * t[0] + z * t[1], z1 = -dx * t[1] + z * t[0], y2 = dy * t[2] + z1 * t[3], z2 = -dy * t[3] + z1 * t[2], k = (f - z) / (f - z2)
    o[0] = P.x + (x1 * t[4] - y2 * t[5]) * k; o[1] = P.y + (x1 * t[5] + y2 * t[4]) * k; o[2] = z2
  }
  /** Rellena `cur` (x, y, z por vértice): expresiones 2D, giro 3D de cabeza y baile del cuerpo. Sin WebGL (se puede probar aparte). */
  private warp(m: FacialMotion, b?: BodyMotion) {
    const { L, fs, base, cur, W, H, hw, zb, n0, tr } = this, rc = b ? Math.cos(b.roll) : 1, rs = b ? Math.sin(b.roll) : 0, o = this.tmp
    const ya = m.headYaw * YAW_RAD, pa = m.headPitch * PITCH_RAD
    this.tr.set([Math.cos(ya), Math.sin(ya), Math.cos(pa), Math.sin(pa), Math.cos(m.headRoll), Math.sin(m.headRoll)])
    const fy0 = tr[0] * tr[3], fx = tr[1] * tr[4] - fy0 * tr[5], fy = tr[1] * tr[5] + fy0 * tr[4], fz = tr[0] * tr[2]   // (0,0,1) girado: el giro de una superficie plana no se sombrea, solo el relieve
    const eyes = [{ o: L[33], i: L[133], u: L[159], d: L[145], ir: L[468], b: m.eyeBlinkRight }, { o: L[263], i: L[362], u: L[386], d: L[374], ir: L[473], b: m.eyeBlinkLeft }]
      .map(e => ({ ...e, cx: (e.o.x + e.i.x) / 2, cy: (e.u.y + e.d.y) / 2, w: Math.hypot(e.o.x - e.i.x, e.o.y - e.i.y) }))
    const brows = [{ p: L[105], v: m.eyebrowRight }, { p: L[334], v: m.eyebrowLeft }], mc = [L[61], L[291]], lip = L[14], mid = L[13]
    for (let j = 0; j < hw.length; j++) {
      const k = 2 * j, x = base[k], y = base[k + 1]; let X = x, Y = y, Z = 0, S = 1
      for (const e of eyes) {
        if (e.b > 0 && y < e.cy) Y += (e.cy - y) * Math.min(0.92, e.b) * g(x - e.cx, e.w * 0.6) * g(e.cy - y, e.w * 0.45)
        const w = g(Math.hypot(x - e.ir.x, y - e.ir.y), e.w * 0.26); X += m.eyeLookX * e.w * 0.13 * w; Y += m.eyeLookY * e.w * 0.1 * w
      }
      for (const b of brows) Y -= b.v * fs * 0.03 * g(Math.hypot(x - b.p.x, y - b.p.y), fs * 0.13)
      mc.forEach((p, i) => { const w = g(Math.hypot(x - p.x, y - p.y), fs * 0.13); Y -= m.mouthSmile * fs * 0.05 * w; X += (i ? 1 : -1) * (m.mouthSmile * 0.025 + (m.mouthWidth - 0.5) * 0.05 - m.lipRound * 0.03) * fs * w })
      if (y > mid.y) Y += m.mouthOpen * fs * 0.09 * g(Math.hypot(x - lip.x, y - lip.y), fs * 0.13)
      if (this.arms && b?.arms) for (const side of ['l', 'r'] as const) { const jt = this.arms[side], rt = b.arms[side]; if (jt && rt) { const d = armDisp(x, y, jt, rt); X += d[0]; Y += d[1] } }   // brazos y manos
      const w = hw[j]
      if (w > 0.002) { this.project(X, Y, zb[j]); X += (o[0] - X) * w; Y += (o[1] - Y) * w; Z = o[2] * w
        const a = n0[3 * j], bb = n0[3 * j + 1], c = n0[3 * j + 2], x1 = a * tr[0] + c * tr[1], z1 = -a * tr[1] + c * tr[0], y2 = bb * tr[2] + z1 * tr[3], z2 = -bb * tr[3] + z1 * tr[2]   // normal girada con la misma R
        S = Math.min(1.4, Math.max(0.6, 1 + SHADE_GAIN * w * (((x1 * tr[4] - y2 * tr[5]) - a - fx) * LX + ((x1 * tr[5] + y2 * tr[4]) - bb - fy) * LY + (z2 - c - fz + 1) * LZ))) }
      if (b) { // Cuerpo: zoom + aplastamiento desde la base, balanceo e inclinación ponderados por la altura (la base de la foto no se mueve).
        const hg = Math.pow(1 - y / H, 1.2)
        X = W / 2 + (X - W / 2) * b.zoom; Y = H - (H - Y) * b.zoom * b.squash
        const bx = X - W / 2, by = Y - H
        X += (bx * rc - by * rs - bx) * hg + b.swayX * W * 0.05 * hg; Y += (bx * rs + by * rc - by) * hg
      }
      cur[4 * j] = X; cur[4 * j + 1] = Y; cur[4 * j + 2] = Math.max(-0.98, Math.min(0.98, -Z / (fs * 3))); cur[4 * j + 3] = S
    }
  }
  /** Prepara el camino GPU. Devuelve false (y deja todo como estaba) si el dispositivo no puede renderizar a texturas float32 o algún shader no compila. */
  private initGpu(): boolean {
    const gl = this.gl, N1 = N + 1, V = N1 * N1
    if (!gl.getExtension('EXT_color_buffer_float')) return false
    const prog = (fs: string, names: string[]): GpuProg | null => {
      const p = gl.createProgram()!, a = this.sh(gl.VERTEX_SHADER, PASS_VERT), b = this.sh(gl.FRAGMENT_SHADER, fs); gl.attachShader(p, a); gl.attachShader(p, b); gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('GPU warp:', gl.getShaderInfoLog(b) || gl.getProgramInfoLog(p)); gl.deleteProgram(p); return null }
      return { p, u: Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)])) }
    }
    const pw = prog(WARP_FRAG, ['S', 'uE', 'uI', 'uB', 'uM', 'uP0', 'uP1', 'uC', 'uR0', 'uF', 'uBody', 'uR1', 'uWH', 'uBody2', 'uA'])
    const ps = prog(SMOOTH_FRAG, ['T', 'S', 'horiz']), pf = prog(FINAL_FRAG, ['T', 'O', 'amt', 'uE', 'uI', 'uG', 'uWH'])
    if (!pw || !ps || !pf) return false
    const mk = (unit: number, data: Float32Array | null) => {
      gl.activeTexture(unit); const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N1, N1, 0, gl.RGBA, gl.FLOAT, data)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t
    }
    const st = new Float32Array(V * 4); for (let j = 0; j < V; j++) { st[4 * j] = this.hw[j]; st[4 * j + 1] = this.zb[j]; st[4 * j + 2] = this.n0[3 * j]; st[4 * j + 3] = this.n0[3 * j + 1] }
    // Texturas: 0 = malla sin suavizar, 1 y 2 = ping-pong del suavizado, 3 = resultado final (unidad 3, la que lee el vértice). Estática en la unidad 6.
    const tex = [mk(gl.TEXTURE4, null), mk(gl.TEXTURE5, null), mk(gl.TEXTURE5, null), mk(gl.TEXTURE3, null)], S = mk(gl.TEXTURE6, st)
    const fbo = tex.map(t => { const f = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f })
    const ok = fbo.every((f) => { gl.bindFramebuffer(gl.FRAMEBUFFER, f); return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE })
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0)
    if (!ok || gl.getError() !== gl.NO_ERROR) { console.warn('GPU warp: sin render a float32, se usa CPU'); return false }
    this.G = { tex, fbo, S, pw, ps, pf, uE: new Float32Array(8), uI: new Float32Array(8), uB: new Float32Array(8), uM: new Float32Array(8) }
    return true
  }
  /** Rotación de la cabeza de este fotograma (alimenta tr; también lo usa el interior de la boca). */
  private rot(m: FacialMotion) {
    const ya = m.headYaw * YAW_RAD, pa = m.headPitch * PITCH_RAD
    this.tr.set([Math.cos(ya), Math.sin(ya), Math.cos(pa), Math.sin(pa), Math.cos(m.headRoll), Math.sin(m.headRoll)])
  }
  /** Equivalente en GPU de warp() + smooth() + gaze(): deja la malla final en la textura 3. */
  private gpuWarp(m: FacialMotion, b: BodyMotion | undefined, amt: number) {
    const { gl, G, L, fs, W, H, tr } = this, N1 = N + 1, pa = m.headPitch * PITCH_RAD, ya = m.headYaw * YAW_RAD
    this.rot(m)
    const eyes = [{ o: L[33], i: L[133], u: L[159], d: L[145], ir: L[468], b: m.eyeBlinkRight }, { o: L[263], i: L[362], u: L[386], d: L[374], ir: L[473], b: m.eyeBlinkLeft }]
    eyes.forEach((e, k) => { G.uE.set([(e.o.x + e.i.x) / 2, (e.u.y + e.d.y) / 2, Math.hypot(e.o.x - e.i.x, e.o.y - e.i.y), e.b], 4 * k); G.uI.set([e.ir.x, e.ir.y, m.eyeLookX, m.eyeLookY], 4 * k) })
    G.uB.set([L[105].x, L[105].y, m.eyebrowRight, 0, L[334].x, L[334].y, m.eyebrowLeft, 0]); G.uM.set([L[61].x, L[61].y, 0, 0, L[291].x, L[291].y, 0, 0])
    const fy0 = tr[0] * tr[3]
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.viewport(0, 0, N1, N1); gl.bindVertexArray(this.bvao)
    const bind = (unit: number, t: WebGLTexture) => { gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, t) }
    const pw = G.pw; gl.useProgram(pw.p); gl.bindFramebuffer(gl.FRAMEBUFFER, G.fbo[0]); bind(gl.TEXTURE6, G.S); gl.uniform1i(pw.u.S, 6)
    gl.uniform4fv(pw.u.uE, G.uE); gl.uniform4fv(pw.u.uI, G.uI); gl.uniform4fv(pw.u.uB, G.uB); gl.uniform4fv(pw.u.uM, G.uM)
    gl.uniform4f(pw.u.uP0, L[14].x, L[14].y, L[13].y, m.mouthOpen); gl.uniform4f(pw.u.uP1, m.mouthSmile, m.mouthWidth, m.lipRound, fs)
    gl.uniform4f(pw.u.uC, L[1].x, L[1].y, this.piv.x, this.piv.y); gl.uniform4f(pw.u.uR0, tr[0], tr[1], tr[2], tr[3]); gl.uniform2f(pw.u.uR1, tr[4], tr[5])
    gl.uniform4f(pw.u.uF, tr[1] * tr[4] - fy0 * tr[5], tr[1] * tr[5] + fy0 * tr[4], tr[0] * tr[2], 0); gl.uniform2f(pw.u.uWH, W, H)
    armUniforms(this.arms, b?.arms, this.uA); gl.uniform4fv(pw.u.uA, this.uA)
    gl.uniform4f(pw.u.uBody, b?.zoom ?? 1, b?.squash ?? 1, b ? Math.cos(b.roll) : 1, b ? Math.sin(b.roll) : 0); gl.uniform2f(pw.u.uBody2, b?.swayX ?? 0, b ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    let cur = 0
    if (amt > 0 && SMOOTH_PASSES > 0) {
      const ps = G.ps; gl.useProgram(ps.p); gl.uniform1i(ps.u.T, 4); gl.uniform1i(ps.u.S, 6)
      for (let p = 0; p < SMOOTH_PASSES * 2; p++) { const dst = cur === 1 ? 2 : 1; bind(gl.TEXTURE4, G.tex[cur]); gl.bindFramebuffer(gl.FRAMEBUFFER, G.fbo[dst]); gl.uniform1i(ps.u.horiz, p % 2 === 0 ? 1 : 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); cur = dst }
    }
    const pf = G.pf; gl.useProgram(pf.p); bind(gl.TEXTURE4, G.tex[cur]); bind(gl.TEXTURE5, G.tex[0]); gl.uniform1i(pf.u.T, 4); gl.uniform1i(pf.u.O, 5)
    gl.uniform1f(pf.u.amt, cur === 0 ? 0 : Math.min(1, amt)); gl.uniform4fv(pf.u.uE, G.uE); gl.uniform4fv(pf.u.uI, G.uI); gl.uniform2f(pf.u.uWH, W, H)
    gl.uniform2f(pf.u.uG, -GAZE_COMP * 0.4 * Math.sin(ya) * Math.cos(ya), -GAZE_COMP * 0.4 * Math.sin(pa) * Math.cos(pa))
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.fbo[3]); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(this.mvao)
  }
  /** Filtro [1 2 1]/4 separable sobre x, y, z y sombra de los vértices de la cabeza, mezclado con `amt` (0..1): apaga los picos que pliegan o estiran celdas en la silueta al girar. */
  private smooth(passes: number, amt: number) {
    if (amt <= 0 || passes <= 0) return
    const { cur, hw } = this, N1 = N + 1, tmp = (this.sm ??= new Float32Array(cur.length)), org = (this.so ??= new Float32Array(cur.length)); org.set(cur)
    for (let p = 0; p < passes; p++) for (let dir = 0; dir < 2; dir++) {
      tmp.set(cur); const st = dir ? N1 : 1
      for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) { const v = j * N1 + i; if (hw[v] < 0.01) continue
        for (let c = 0; c < 4; c++) cur[4 * v + c] = (tmp[4 * (v - st) + c] + 2 * tmp[4 * v + c] + tmp[4 * (v + st) + c]) * 0.25 }
    }
    if (amt < 1) for (let k = 0; k < cur.length; k++) cur[k] = org[k] + (cur[k] - org[k]) * amt
  }
  /** Compensación de mirada: se aplica DESPUÉS del suavizado (que si no se comería el desplazamiento del iris, que es de pocos píxeles). */
  private gaze(m: FacialMotion) {
    const { L, base, cur, W, H } = this, N1 = N + 1, ya = m.headYaw * YAW_RAD, pa = m.headPitch * PITCH_RAD, cw = W / N, ch = H / N
    const kx = -GAZE_COMP * 0.4 * Math.sin(ya) * Math.cos(ya), ky = -GAZE_COMP * 0.4 * Math.sin(pa) * Math.cos(pa)
    if (!kx && !ky) return
    for (const [o, i, ir] of [[L[33], L[133], L[468]], [L[263], L[362], L[473]]]) {
      const ew = Math.hypot(o.x - i.x, o.y - i.y), r = ew * 0.26, i0 = Math.round(ir.x / cw), j0 = Math.round(ir.y / ch), Rx = Math.ceil(2.4 * r / cw), Ry = Math.ceil(2.4 * r / ch)
      for (let j = Math.max(0, j0 - Ry); j <= Math.min(N, j0 + Ry); j++) for (let ii = Math.max(0, i0 - Rx); ii <= Math.min(N, i0 + Rx); ii++) {
        const v = j * N1 + ii, wg = g(Math.hypot(base[2 * v] - ir.x, base[2 * v + 1] - ir.y), r)
        cur[4 * v] += kx * ew * wg; cur[4 * v + 1] += ky * ew * wg
      }
    }
  }
  render(m: FacialMotion, t = 0, b?: BodyMotion) {
    const { L, fs, cur, gl } = this, c = L[1], lip = L[14], mid = L[13]
    const amt = Math.min(1, (Math.abs(m.headYaw * YAW_RAD) + Math.abs(m.headPitch * PITCH_RAD)) / SMOOTH_FULL)
    if (this.gpu) this.gpuWarp(m, b, amt)
    else { this.warp(m, b); this.smooth(SMOOTH_PASSES, amt); this.gaze(m); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, cur) }
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    const sBass = b?.bass ?? 0, sMid = b?.mid ?? 0, sTreb = b?.treble ?? 0, pulse = b?.pulse ?? 0
    if (this.bgp) { gl.useProgram(this.bgp.p); gl.bindVertexArray(this.bvao); gl.uniform1f(this.bgp.T, t); gl.uniform1f(this.bgp.P, pulse); gl.uniform3f(this.bgp.S, sBass, sMid, sTreb); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.bindVertexArray(this.mvao) }
    const pp = this.masked ? this.bgp?.pp : undefined
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL)   // la cabeza girada se oculta a sí misma (nariz sobre mejilla) según la profundidad de cada vértice
    if (this.masked && this.bgp) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA) }
    if (pp) { gl.useProgram(pp.p); gl.uniform1f(pp.T, t); gl.uniform1f(pp.P, pulse); gl.uniform3f(pp.S, sBass, sMid, sTreb); gl.uniform1f(pp.ig, this.ig) } else gl.useProgram(this.mp)
    gl.drawElements(gl.TRIANGLES, this.n, gl.UNSIGNED_INT, 0); gl.disable(gl.DEPTH_TEST)
  }
}
