const PL = require('./engine.js');
for (const style of ['calm','normal','rough']) {
  const e = PL.runSim(style, 7), s = e.summary();
  console.log(`\n== ${style}: score ${s.score} | km ${s.km.toFixed(2)} | ${Math.round(s.durationS)}s | moy ${s.avgKmh.toFixed(0)} max ${s.maxKmh.toFixed(0)} | status ${e.status} recal ${e.recalCount}`);
  console.log(' axes', JSON.stringify(s.axes), 'counts', JSON.stringify(s.counts), 'jerk', s.jerkRms && s.jerkRms.toFixed(2));
  console.log(' events', e.events.map(x => `${x.kind}${x.late ? '(tardif)' : ''}${x.sev}@${x.t.toFixed(0)}s ${x.peak.toFixed(1)}`).join(' | '));
  if (style === 'normal') {
    const R = new PL.Sim().R, trueF = [R[0][0], R[1][0], R[2][0]];
    console.log(' forward axis alignment (1 = parfait):', PL.dot(e.f, trueF).toFixed(4));
  }
}
// CSV round-trip
const sim = new PL.Sim({style:'normal'}); let csv = 't,ax,ay,az,speed\n';
while (!sim.done) { const o = sim.step(); csv += `${o.t.toFixed(3)},${o.ax.toFixed(4)},${o.ay.toFixed(4)},${o.az.toFixed(4)},${o.fix===null?'':o.fix.toFixed(3)}\n`; }
const rows = PL.parseCsv(csv); const e2 = PL.analyzeRows(rows);
console.log('\nCSV rows', rows.length, 'score', e2.summary().score, 'events', e2.events.length);
// ms timestamps + semicolon
const csv2 = csv.split('\n').map((l,i)=> i===0? 'time;x;y;z;speed' : l.split(',').map((c,j)=> j===0? (parseFloat(c)*1000).toFixed(0): c.replace('.',',')).join(';')).join('\n');
const e3 = PL.analyzeRows(PL.parseCsv(csv2)); console.log('CSV ms/; score', e3.summary().score);

// --- Affichage temps réel : sens du point et capteurs inversés (iOS) ---
function replay(sign) {
  const sim = new PL.Sim({ style: 'normal' }), e = new PL.Engine(), at = {};
  const want = [[13, 'accélération douce'], [42, 'ralentissement'], [101.7, 'virage à droite'], [151.2, 'freinage tardif'], [171.7, 'virage à gauche'], [112, 'accélération vive'], [30, 'régime stabilisé']];
  while (!sim.done) {
    const o = sim.step(); e.pushMotion(o.t, sign * o.ax, sign * o.ay, sign * o.az);
    if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading);
    for (const [tt, name] of want) if (Math.abs(o.t - tt) < 0.011) at[name] = [e.dLat, e.dLong];
  }
  return { e, at };
}
for (const sign of [1, -1]) {
  const { e, at } = replay(sign);
  console.log(`\n== capteurs ${sign === 1 ? 'Android' : 'inversés (iOS)'}: latSign ${e.latSign}, événements ${e.events.length}, score ${e.summary().score}`);
  for (const k in at) console.log(`  ${k.padEnd(22)} avant/arrière dLong ${at[k][1].toFixed(2).padStart(6)} → point ${at[k][1] < -0.5 ? 'AVANT' : at[k][1] > 0.5 ? 'ARRIÈRE' : 'centre'} | côté dLat ${at[k][0].toFixed(2).padStart(6)} → ${at[k][0] > 0.5 ? 'DROITE' : at[k][0] < -0.5 ? 'GAUCHE' : 'centre'}`);
}

// --- support grille d'aération + jauge verticale ---
{
  const assert = require('assert');
  const run = (mount, simMount, sign) => {
    const e = new PL.Engine({ mount }), s = new PL.Sim({ style: 'normal', seed: 7, mount: simMount });
    let first = null;
    while (!s.done) { const o = s.step(); e.pushMotion(o.t, sign * o.ax, sign * o.ay, sign * o.az); if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading); if (first === null && e.status === 'ready') first = o.t; }
    e.finish(); return { e, first };
  };
  for (const sign of [1, -1]) {
    const { e, first } = run('vent', 'vent', sign);
    assert(first < 2, 'vent: prêt immédiatement');
    const sh = e.events.filter(x => x.kind === 'shock');
    assert.deepStrictEqual(sh.map(x => Math.round(x.t) + ':' + x.side), ['62:left', '133:right', '188:both'], 'côtés des chocs');
    assert.strictEqual(e.events.filter(x => x.kind !== 'shock').length, 5, 'pas de faux événements dus aux chocs');
    assert.strictEqual(e.latSign, 1);
  }
  const { e: f, first: ff } = run('free', 'random', 1);
  assert(ff > 5 && f.status === 'ready', 'libre: calibration GPS');
  console.log('\nvent/libre + chocs OK');
}
