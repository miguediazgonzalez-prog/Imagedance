/** Fondos del vídeo. Los de muestra son shaders procedurales (se animan con el tiempo y laten con el beat: P=1 en el golpe); «image» muestra la imagen elegida. */
export type BgId = 'neon' | 'disco' | 'retro' | 'aurora' | 'laser' | 'image'
export interface BgSpec { id: BgId; bitmap?: ImageBitmap }
export const BG_UI: { id: BgId; label: string; css: string }[] = [
  { id: 'neon', label: 'Neón', css: 'linear-gradient(135deg,#ff2ea6,#7a2cff,#00e5ff)' },
  { id: 'disco', label: 'Disco', css: 'conic-gradient(from 0deg,#ff2ea6,#ffd400,#00e5ff,#7a2cff,#ff2ea6)' },
  { id: 'retro', label: 'Retro', css: 'linear-gradient(#1a0040,#ff3d8b 60%,#ffb347)' },
  { id: 'aurora', label: 'Aurora', css: 'linear-gradient(160deg,#001133,#00e08a,#7a2cff)' },
  { id: 'laser', label: 'Láser', css: 'linear-gradient(135deg,#050010,#00ff7f 50%,#ff1aa8)' }
]
const FN: Record<BgId, string> = {
  neon: `vec3 bg(vec2 u){ vec2 p=u*2.-1.; float a=T*.35;
  float w=sin(p.x*3.+a*2.)+sin(p.y*3.-a*1.5)+sin((p.x+p.y)*2.5+a)+sin(length(p)*5.-a*3.);
  vec3 c=.5+.5*cos(6.2831*(w*.12+vec3(0.,.33,.67))+T*.4); c=mix(c,vec3(1.,.2,.8),.25);
  return c*(.6+.4*(1.-smoothstep(0.,1.4,length(p))))*(1.+.35*P); }`,
  disco: `vec3 bg(vec2 u){ vec2 p=u*2.-1.; vec2 q=p-vec2(0.,-1.3); vec3 c=vec3(.05,.02,.12)+vec3(.12,.04,.2)*(1.-u.y);
  for(int i=0;i<7;i++){ float fi=float(i); float th=1.5708+.95*sin(T*.7+fi*1.9); vec2 d=vec2(cos(th),sin(th));
    float al=dot(q,d), pe=q.x*d.y-q.y*d.x, w=.03+.1*max(al,0.);
    c+=exp(-(pe*pe)/(w*w))*step(0.,al)*(.55/(1.+al*.6))*(.55+.45*cos(fi*1.1+vec3(0.,2.1,4.2)+T*.5)); }
  return c*(.75+.9*P); }`,
  retro: `vec3 bg(vec2 u){ float y=u.y; vec3 c=mix(vec3(.06,0.,.22),vec3(1.,.22,.55),smoothstep(0.,.62,y)); c=mix(c,vec3(1.,.72,.2),smoothstep(.5,.62,y)*.7);
  float sun=1.-smoothstep(.2,.206,length(vec2(u.x-.5,y-.43)));
  float cut=(y>.43)?step((y-.43)*3.2,.5+.5*sin(y*110.-T*1.2)):1.;
  c=mix(c,mix(vec3(1.,.85,.2),vec3(1.,.2,.5),smoothstep(.23,.63,y)),sun*cut);
  if(y>.62){ float k=y-.62, dp=.1/max(k,.001), a1=(u.x-.5)*dp*2.5, a2=dp-T*.5;
    float lx=1.-smoothstep(0.,.03+fwidth(a1)*1.2,abs(fract(a1+.5)-.5)), ly=1.-smoothstep(0.,.03+fwidth(a2)*1.2,abs(fract(a2+.5)-.5));
    vec3 fl=mix(vec3(.1,0.,.2),vec3(.35,0.,.4),smoothstep(0.,.4,k));
    fl=mix(fl,vec3(1.,.2,.85)*1.3,max(lx,ly)*smoothstep(0.,.08,k)); fl+=vec3(1.,.4,.6)*.35*exp(-k*20.); c=fl; }
  return c*(1.+.3*P); }`,
  aurora: `vec3 bg(vec2 u){ vec3 c=mix(vec3(0.,.02,.1),vec3(.03,.12,.22),u.y);
  for(int i=0;i<3;i++){ float fi=float(i); float y=.28+.13*fi+.08*sin(u.x*4.+T*.5+fi*2.)+.05*sin(u.x*9.-T*.7+fi), d=u.y-y;
    float band=exp(-d*d*140.)*(.65+.35*sin(u.x*6.+T+fi*1.3))*((d>0.)?1.:1.4);
    c+=mix(vec3(.1,1.,.55),vec3(.65,.25,1.),fi/2.)*band*.85; }
  float s=h21(floor(u*90.)); c+=vec3(step(.995,s))*smoothstep(.6,.2,u.y)*(.5+.5*sin(T*2.+s*50.))*.8;
  return c*(1.+.3*P); }`,
  laser: `vec3 bg(vec2 u){ vec2 p=vec2(u.x*2.-1.,1.-u.y*2.); vec2 q=p-vec2(0.,-1.25);
  vec3 c=vec3(.02,0.,.05)+vec3(.14,0.,.22)*smoothstep(1.4,0.,length(p-vec2(0.,-.3)));
  for(int i=0;i<9;i++){ float fi=float(i); float th=1.5708+(fi-4.)*.2+.3*sin(T*(.9+.11*fi)+fi*2.); vec2 d=vec2(cos(th),sin(th));
    float al=dot(q,d), pe=abs(q.x*d.y-q.y*d.x), on=step(0.,al)*(.6+.4*sin(T*3.+fi*5.));
    vec3 col=(mod(fi,3.)<1.)?vec3(.1,1.,.3):(mod(fi,3.)<2.)?vec3(1.,.1,.7):vec3(.1,.8,1.);
    c+=col*(exp(-pe*110.)*1.1+exp(-pe*14.)*.18)*on; }
  return c*(.8+.7*P); }`,
  image: `vec3 bg(vec2 u){ vec2 q=(u-.5)*(1.-.05*P)+.5; return texture(img,q).rgb*(1.+.12*P); }`
}
/** Fragment shader completo del fondo elegido (uv con y hacia abajo, igual que la foto). */
export const bgFragment = (id: BgId) => `#version 300 es
precision highp float; in vec2 v; uniform float T; uniform float P; uniform sampler2D img; out vec4 o;
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
${FN[id]}
void main(){ o=vec4(clamp(bg(v),0.,1.),1.); }`
/** Recorta la imagen elegida a un cuadrado S×S (modo «cubrir») para usarla de fondo. */
export async function coverBitmap(src: ImageBitmap, S: number): Promise<ImageBitmap> {
  const c = document.createElement('canvas'); c.width = c.height = S
  const k = Math.max(S / src.width, S / src.height), w = src.width * k, h = src.height * k
  c.getContext('2d')!.drawImage(src, (S - w) / 2, (S - h) / 2, w, h)
  return createImageBitmap(c)
}
