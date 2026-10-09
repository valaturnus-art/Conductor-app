// Tests du moteur Pied Léger : node test.js
const assert = require('assert');
const PL = require('./engine.js');
const kinds = e => e.events.filter(x => x.kind !== 'shock').map(x => x.kind);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 1. Trois conducteurs simulés : ordre et écarts du score (notation exigeante).
const R = {}; for (const st of ['calm', 'normal', 'rough']) { R[st] = PL.runSim(st, 7); const s = R[st].summary(); console.log(`${st}: score ${s.score}`, JSON.stringify(s.axes), JSON.stringify(s.counts)); }
const sc = k => R[k].summary().score;
assert(sc('calm') >= 85 && sc('calm') <= 97, 'posé : exemplaire mais pas parfait');
assert(sc('normal') >= 40 && sc('normal') <= 70, 'normal : correct');
assert(sc('rough') <= 35, 'nerveux : bas');
assert(sc('calm') - sc('normal') >= 20 && sc('normal') - sc('rough') >= 15, 'écarts nets');
assert.deepStrictEqual(kinds(R.calm), [], 'posé : aucun faux événement');

// 2. Détecteurs : chaque comportement est reconnu au bon endroit.
const at = (e, k) => e.events.filter(x => x.kind === k).map(x => Math.round(x.t));
const n = R.normal, r = R.rough;
assert(at(n, 'swerve').some(t => near(t, 90, 3)), 'coup de volant ~89 s');
assert(at(n, 'fix').some(t => near(t, 140, 3)) && at(n, 'fix').some(t => near(t, 225, 3)), 'redressements ~140 et ~225 s');
assert(!at(n, 'fix').some(t => near(t, 89, 4)), 'pas de redressement parasite dans un coup de volant');
assert(!n.events.some(x => x.kind === 'corner' && near(x.t, 90, 2)), 'virage fondu dans le coup de volant');
assert(n.events.some(x => x.kind === 'brake' && x.late && near(x.t, 152, 3)), 'freinage tardif ~152 s');
assert(n.events.filter(x => x.kind === 'shift').length >= 1 && r.events.filter(x => x.kind === 'shift').length >= 4, 'passages de vitesse brusques');
assert(r.events.some(x => x.kind === 'shift' && x.sev === 2), 'passage très brusque sévère');
assert(r.events.some(x => x.kind === 'shock' && x.fast) && !n.events.some(x => x.fast), 'dos d’âne trop vite : nerveux seulement');
const sides = e => e.events.filter(x => x.kind === 'shock').map(x => Math.round(x.t) + ':' + x.side).join(' ');
assert.strictEqual(sides(n), '62:left 133:right 188:both', 'côtés des chocs');

// 3. Robustesse : orientation, signes iOS/Android, gyroscope absent, boîte automatique.
function run(sign, gs, mount = 'vent', simMount = 'vent') {
  const e = new PL.Engine({ mount }), s = new PL.Sim({ style: 'normal', seed: 7, mount: simMount });
  let first = null;
  while (!s.done) { const o = s.step(); e.pushMotion(o.t, sign * o.ax, sign * o.ay, sign * o.az, gs * o.gx, gs * o.gy, gs * o.gz); if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading); if (first === null && e.status === 'ready') first = o.t; }
  e.finish(); return { e, first };
}
for (const [sg, gs] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
  const { e, first } = run(sg, gs); assert(first < 2, 'grille : prêt tout de suite');
  assert.strictEqual(e.summary().score, sc('normal'), `signes ${sg}/${gs} : même score`);
  assert.strictEqual(e.latSign, 1);
}
const f = run(1, 1, 'free', 'random'); assert(f.first > 5 && f.e.status === 'ready' && Math.abs(f.e.summary().score - sc('normal')) <= 4, 'support libre : calibration GPS');
const ng = PL.runSim('normal', 7, 'vent', { gyro: false }).summary(); assert(!ng.gyro && ng.counts.fix === 0 && ng.counts.swerve >= 1, 'sans gyroscope : coups de volant par le latéral');
assert.strictEqual(PL.runSim('normal', 7, 'vent', { gearbox: 'auto' }).summary().counts.shift, 0, 'boîte auto : aucun passage de vitesse');
const bump = Array.from({ length: 8 }, (_, i) => PL.runSim('calm', i + 1).events.filter(x => x.kind !== 'shock').length);
assert(bump.filter(x => x > 0).length <= 1, 'posé : au plus un faux événement sur 8 graines');

// 4. Sens du disque (point = force ressentie) et CSV.
const e = PL.runSim('normal', 7), tr = e.series.length; assert(tr > 200);
const rows = []; { const s = new PL.Sim({ style: 'normal', seed: 7 }); while (!s.done) { const o = s.step(); rows.push([o.t, o.ax, o.ay, o.az, o.fix === null ? '' : o.fix, o.heading === null ? '' : o.heading, o.gx, o.gy, o.gz].join(',')); } }
const csv = 't,ax,ay,az,speed,heading,gx,gy,gz\n' + rows.join('\n');
const a = PL.analyzeRows(PL.parseCsv(csv), 'vent').summary();
assert(Math.abs(a.score - sc('normal')) <= 2 && a.gyro, 'CSV avec gyroscope');
const ms = PL.parseCsv(csv.replace(/\n(\d+\.?\d*),/g, (m, t) => '\n' + Math.round(t * 1000) + ',')); assert(ms.length === rows.length && ms[10].t < 1);
console.log('\nOK');
