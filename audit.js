// Audit d'alignement : ce que le conducteur voit en direct = ce que l'historique enregistre. node audit.js
const assert = require('assert');
const PL = require('./engine.js');
const key = e => e.kind + '@' + e.t.toFixed(2);
let n = 0;
for (const style of ['calm', 'normal', 'rough']) for (const seed of [1, 7, 12]) for (const [mount, sm] of [['vent', 'vent'], ['free', 'random']]) for (const hum of [0, 1]) {
  const e = new PL.Engine({ mount }), s = new PL.Sim({ style, seed, mount: sm, hum });
  const live = [], toast = []; let seq = 0;
  while (!s.done) {
    const o = s.step(); e.pushMotion(o.t, o.ax, o.ay, o.az, o.gx, o.gy, o.gz); if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading);
    if (e.evSeq !== seq) { seq = e.evSeq; live.push(key(e.lastEvent)); toast.push(e.lastEvent); }
  }
  e.finish(); if (e.evSeq !== seq) { live.push(key(e.lastEvent)); }
  const fin = e.events.map(key);
  // 1. aucun événement n'est jamais retiré ni inventé après coup
  assert.strictEqual(e.events.length, e.evSeq, `${style}/${seed}/${mount}/${hum}: ${e.events.length} événements pour ${e.evSeq} annoncés`);
  for (const k of live) assert(fin.includes(k), `${style}/${seed}/${mount}/${hum}: ${k} vu en direct mais absent de l'historique`);
  for (const k of fin) assert(live.includes(k), `${k} dans l'historique sans être passé en direct`);
  // 2. l'enregistrement (JSON) restitue les mêmes événements, et les compteurs du bilan collent à la liste
  const back = JSON.parse(JSON.stringify(e.events)); assert.deepStrictEqual(back.map(key), fin);
  const sum = e.summary(), c = k => e.events.filter(x => x.kind === k).length;
  assert.strictEqual(sum.counts.brake, c('brake')); assert.strictEqual(sum.counts.corner, c('corner')); assert.strictEqual(sum.counts.accel, c('accel'));
  assert.strictEqual(sum.counts.swerve, c('swerve')); assert.strictEqual(sum.counts.fix, c('fix')); assert.strictEqual(sum.counts.shock, c('shock'));
  assert(sum.coverage > 0.99);
  n++;
}
console.log(`${n} sessions : direct = historique pour chaque événement`);

// 3. Le bruit moteur n'allume ni la jauge ni les événements ; les vrais chocs sortent quand même.
for (const hum of [0.3, 0.6, 1]) {
  const e = new PL.Engine({ mount: 'vent' }), s = new PL.Sim({ style: 'calm', seed: 3, mount: 'vent', hum });
  let maxFlat = 0, maxDot = 0;
  while (!s.done) {
    const o = s.step(); e.pushMotion(o.t, o.ax, o.ay, o.az, o.gx, o.gy, o.gz); if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading);
    const near = [62, 133, 188, 231].some(t => o.t > t - 1 && o.t < t + 3);
    if (!near && o.t > 5) maxFlat = Math.max(maxFlat, Math.abs(e.zL), Math.abs(e.zR));
    if (o.t > 5) maxDot = Math.max(maxDot, Math.hypot(e.dLat, e.dLong));
  }
  e.finish();
  const sh = e.events.filter(x => x.kind === 'shock').map(x => Math.round(x.t) + ':' + x.side).join(' ');
  console.log(`bruit ${hum} : jauge hors chocs max ${maxFlat.toFixed(2)} m/s² | point max ${maxDot.toFixed(2)} | chocs ${sh} | autres ${e.events.filter(x => x.kind !== 'shock').length}`);
  assert(maxFlat < (hum <= 0.3 ? 1.5 : hum <= 0.6 ? 2.5 : 3.5), 'jauge calme hors chocs'); if (hum <= 0.6) assert.strictEqual(sh, '62:left 133:right 188:both');
  if (hum <= 0.3) assert.strictEqual(e.events.filter(x => x.kind !== 'shock').length, 0, 'aucun faux événement avec le bruit moteur');
}

console.log('OK');
