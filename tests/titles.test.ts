/** Pruebas del guion de títulos (módulo puro): npm test */
import { planTitles, defaultTitles, hasTitles } from '../src/rendering/Titles'
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('✗', m) } else console.log('✓', m) }
const cfg = { ...defaultTitles(), intro: 'Verano 2026', sub: 'Los de siempre', phrases: ['Qué bien nos lo pasamos', 'Una vez más', 'Todo el mundo arriba', 'Nunca dejes de bailar'], outro: '@nosotros' }
ok(!hasTitles(defaultTitles()) && hasTitles(cfg), 'hasTitles')
for (const bpm of [90, 124, 170]) for (const dur of [12, 30, 60]) {
  const per = 60 / bpm, offset = 0.2, E = planTitles(cfg, { dur, bpm, offset, bar0: 2, cuts: [{ t: dur * 0.5, drop: true }] }), tag = `${bpm}bpm/${dur}s`
  ok(E.length >= 2, `${tag}: hay eventos (${E.length})`)
  ok(E.every(e => e.t0 >= 0 && e.t1 <= dur && e.t1 > e.t0), `${tag}: dentro del vídeo`)
  ok(E.every((e, i) => i === 0 || e.t0 >= E[i - 1].t1 - 1e-9), `${tag}: sin solaparse`)
  ok(E[0].kind === 'intro' && E[0].t0 < 0.5, `${tag}: la intro abre el vídeo`)
  ok(E.filter(e => e.kind === 'outro').length === 1 && E[E.length - 1].kind === 'outro', `${tag}: el cierre va el último`)
  const ph = E.filter(e => e.kind === 'phrase'); ok(ph.every(e => { const j = (e.t0 - offset) / per; return Math.abs(j - Math.round(j)) < 1e-6 }), `${tag}: cada frase entra en un beat`)
  ok(E.every(e => e.pace >= per / 2 - 1e-9 && e.pace <= per + 1e-9), `${tag}: una palabra por beat o medio beat`)
  if (dur >= 30) { const d = dur * 0.5; ok(ph.some(e => Math.abs(e.t0 - d) < 4 * per * 1.5 + per), `${tag}: una frase cae cerca del drop`) }
}
ok(planTitles(defaultTitles(), { dur: 30, bpm: 120, offset: 0 }).length === 0, 'sin texto: sin eventos')
ok(planTitles({ ...defaultTitles(), phrases: ['a', 'b', 'c', 'd', 'e', 'f'] }, { dur: 6, bpm: 120, offset: 0 }).every(e => e.t1 <= 6), 'clip corto: se recortan las frases que no caben')
console.log(fails ? `\n${fails} fallo(s)` : '\nTodo correcto'); process.exit(fails ? 1 : 0)
