/** Fondos del vídeo. Los de muestra son shaders procedurales (se animan con el tiempo y laten con el beat: P=1 en el golpe); «image» muestra la imagen elegida. */
export type BgId = 'neon' | 'disco' | 'retro' | 'aurora' | 'laser' | 'club' | 'galaxia' | 'atardecer' | 'fuego' | 'confeti' | 'ciudad' | 'tunel' | 'image'
export interface BgSpec { id: BgId; bitmap?: ImageBitmap }
export const BG_UI: { id: BgId; label: string; css: string }[] = [
  { id: 'neon', label: 'Neón', css: 'linear-gradient(135deg,#ff2ea6,#7a2cff,#00e5ff)' },
  { id: 'disco', label: 'Disco', css: 'conic-gradient(from 0deg,#ff2ea6,#ffd400,#00e5ff,#7a2cff,#ff2ea6)' },
  { id: 'retro', label: 'Retro', css: 'linear-gradient(#1a0040,#ff3d8b 60%,#ffb347)' },
  { id: 'aurora', label: 'Aurora', css: 'linear-gradient(160deg,#001133,#00e08a,#7a2cff)' },
  { id: 'laser', label: 'Láser', css: 'linear-gradient(135deg,#050010,#00ff7f 50%,#ff1aa8)' },
  { id: 'club', label: 'Ecualizador', css: 'linear-gradient(90deg,#14003a,#ff2ea6,#00e5ff,#ff2ea6,#14003a)' },
  { id: 'galaxia', label: 'Galaxia', css: 'radial-gradient(circle at 30% 30%,#7a2cff,#1a0050 55%,#02000f)' },
  { id: 'atardecer', label: 'Atardecer', css: 'linear-gradient(#3a1070,#ff6a4d 55%,#ffd36e 58%,#1a1050)' },
  { id: 'fuego', label: 'Fuego', css: 'linear-gradient(#150000,#c01800 55%,#ffd000)' },
  { id: 'confeti', label: 'Confeti', css: 'linear-gradient(135deg,#1e0540,#0a2a6a),radial-gradient(#ffd400 20%,transparent 21%)' },
  { id: 'ciudad', label: 'Ciudad', css: 'linear-gradient(#0a0030,#6a1080 70%,#1a0035 71%)' },
  { id: 'tunel', label: 'Túnel', css: 'radial-gradient(circle,#0a0020 20%,#7a2cff 60%,#00b8d4)' }
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
  club: `vec3 bg(vec2 u){ float n=26.; float i=floor(u.x*n), f=fract(u.x*n), y=1.-u.y;
  float h=.2+.38*(.5+.5*sin(T*(1.6+.37*mod(i,5.))+i*1.7))*(.65+.35*P)+.14*P*h21(vec2(i,floor(T*4.)));
  float bar=step(y,h)*step(.12,f)*step(f,.88)*step(.22,fract(y*20.));
  vec3 col=mix(vec3(.1,.9,1.),vec3(1.,.15,.6),clamp(y*1.7,0.,1.));
  vec3 c=vec3(.03,0.,.09)+vec3(.2,0.,.26)*smoothstep(.9,0.,y)*.6+vec3(.1,.02,.2)*P*smoothstep(.6,0.,y);
  c=mix(c,col,bar); c+=col*bar*.25*P; return c; }`,
  galaxia: `vec3 bg(vec2 u){ vec2 p=u*2.-1.; float n=fbm(p*1.6+vec2(T*.03,0.)); float m=fbm(p*3.+n*2.+vec2(0.,T*.05));
  vec3 c=mix(vec3(.02,0.,.08),vec3(.45,.1,.7),n); c=mix(c,vec3(.1,.7,1.),m*m*.85); c+=vec3(1.,.4,.8)*smoothstep(.55,.9,n*m*2.)*.35;
  float s=h21(floor(u*150.)); c+=vec3(step(.992,s))*(.55+.45*sin(T*3.+s*40.));
  return c*(.85+.3*P); }`,
  atardecer: `vec3 bg(vec2 u){ float y=u.y; vec3 sky=mix(vec3(.16,.05,.38),vec3(1.,.42,.3),smoothstep(0.,.58,y)); sky=mix(sky,vec3(1.,.82,.42),smoothstep(.42,.58,y)*.8);
  vec2 sp=vec2(u.x-.5,y-.5); float sd=length(sp); float sun=1.-smoothstep(.15,.156,sd); sky=mix(sky,vec3(1.,.86,.4),sun); sky+=vec3(1.,.5,.2)*.4*exp(-sd*5.)*(1.+.4*P);
  vec3 c=sky;
  if(y>.58){ float k=y-.58; vec3 sea=mix(vec3(.85,.32,.3),vec3(.04,.04,.24),smoothstep(0.,.42,k));
    float w=sin(u.x*38.*(1.+k*3.)+T*1.6+sin(k*60.-T)*2.)*.5+.5; float col=exp(-abs(u.x-.5)*6.)*clamp(1.-k*1.9,0.,1.);
    c=sea+vec3(1.,.8,.4)*step(.62,w)*col*(.8+.5*P); }
  return c*(1.+.2*P); }`,
  fuego: `vec3 bg(vec2 u){ float h=u.y; float f=fbm(vec2(u.x*5.,h*4.+T*1.5)+vec2(0.,fbm(vec2(u.x*3.,h*2.+T*.6))));
  float i=clamp(smoothstep(.15,1.,f*1.2+(h-.45)-.12+.15*P),0.,1.);
  vec3 c=vec3(.04,0.,0.)+vec3(i*1.4,i*i*.9,i*i*i*i*.25); return clamp(c,0.,1.); }`,
  confeti: `vec3 bg(vec2 u){ vec3 c=mix(vec3(.13,.02,.27),vec3(.02,.1,.32),u.y);
  for(int L=0;L<3;L++){ float fl=float(L); float sc=7.+fl*5.; vec2 q=u*sc; q.y-=T*(.6+.35*fl); q.x+=sin(T*.7+fl)*.4;
    vec2 id=floor(q), f=fract(q)-.5; float r=h21(id+fl*17.); float ang=T*(1.+r*3.)+r*6.2832;
    vec2 d=mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*f; vec2 a=abs(d*vec2(1.,1.6));
    float m=step(a.x,.17)*step(a.y,.3)*step(.4,r);
    vec3 col=.55+.45*cos(6.2832*(r*3.+vec3(0.,.33,.67))); c=mix(c,col,m*(.95-.2*fl)); }
  return c*(1.+.3*P); }`,
  ciudad: `vec3 bg(vec2 u){ vec3 c=mix(vec3(.03,0.,.14),vec3(.5,.06,.55),smoothstep(0.,.95,u.y));
  c+=vec3(.95,.95,1.)*(1.-smoothstep(.07,.075,length(u-vec2(.78,.2))));
  for(int L=0;L<3;L++){ float fl=float(L); float x=u.x*(6.+fl*4.)+fl*3.7; float id=floor(x), fx=fract(x);
    float top=1.-(.22+.28*h21(vec2(id,fl+3.))+.08*fl); float inside=step(top,u.y)*step(.04,fx)*step(fx,.96);
    vec3 bc=mix(vec3(.2,.04,.3),vec3(.03,0.,.07),fl/2.);
    vec2 wc=vec2(fx*5.,u.y*(26.+fl*8.)); vec2 wi=floor(wc); float lit=step(.55,h21(wi+id*7.+fl*11.))*step(.2,fract(wc.x))*step(.25,fract(wc.y));
    float fl2=.7+.3*sin(T*2.+h21(wi)*20.); vec3 win=mix(vec3(1.,.8,.4),vec3(.4,.9,1.),h21(wi+5.));
    vec3 col=bc+win*lit*fl2*(.55+.5*P)*(1.-fl*.25); c=mix(c,col,inside); }
  return c; }`,
  tunel: `vec3 bg(vec2 u){ vec2 p=u*2.-1.; float r=length(p), a=atan(p.y,p.x); float z=1./max(r,.05); float v=z*.6+T*1.2;
  float s=sin(v*6.2832)*.5+.5; float t=sin(a*4.+z*.5+T)*.5+.5; vec3 col=.5+.5*cos(6.2832*(vec3(0.,.33,.67)+v*.1+a*.15915+T*.05));
  vec3 c=col*(.2+.8*s*t)*smoothstep(0.,.35,r); return c*(.85+.5*P); }`,
  image: `vec3 bg(vec2 u){ vec2 q=(u-.5)*(1.-.05*P)+.5; return texture(img,q).rgb*(1.+.12*P); }`
}
/** Fragment shader completo del fondo elegido (uv con y hacia abajo, igual que la foto). */
export const bgFragment = (id: BgId) => `#version 300 es
precision highp float; in vec2 v; uniform float T; uniform float P; uniform sampler2D img; uniform float A; out vec4 o;
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int k=0;k<5;k++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
${FN[id]}
void main(){ o=vec4(clamp(bg(vec2((v.x-.5)*A+.5,v.y)),0.,1.),1.); }`  // A = ancho/alto: en lienzos no cuadrados se ve la franja central, sin deformar
/** Recorta la imagen elegida a W×H (modo «cubrir»; H = W si es cuadrada) para usarla de fondo. */
export async function coverBitmap(src: ImageBitmap, W: number, H = W): Promise<ImageBitmap> {
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const k = Math.max(W / src.width, H / src.height), w = src.width * k, h = src.height * k
  c.getContext('2d')!.drawImage(src, (W - w) / 2, (H - h) / 2, w, h)
  return createImageBitmap(c)
}
