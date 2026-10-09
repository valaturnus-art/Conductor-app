const PL = require('./engine.js');
for (const style of ['calm','normal','rough']) {
  const e = PL.runSim(style, 90, 7), s = e.summary();
  console.log(`\n== ${style}: score ${s.score} | km ${s.km.toFixed(2)} | ${Math.round(s.durationS)}s | moy ${s.avgKmh.toFixed(0)} max ${s.maxKmh.toFixed(0)} | status ${e.status} recal ${e.recalCount}`);
  console.log(' axes', JSON.stringify(s.axes), 'counts', JSON.stringify(s.counts), 'over', s.overRatio.toFixed(3), 'jerk', s.jerkRms && s.jerkRms.toFixed(2));
  console.log(' events', e.events.map(x => `${x.kind}${x.sev}@${x.t.toFixed(0)}s ${x.peak.toFixed(1)}`).join(' | '));
  if (style === 'normal') {
    const R = new PL.Sim().R, trueF = [R[0][0], R[1][0], R[2][0]];
    console.log(' forward axis alignment (1 = parfait):', PL.dot(e.f, trueF).toFixed(4));
  }
}
// CSV round-trip
const sim = new PL.Sim({style:'normal'}); let csv = 't,ax,ay,az,speed\n';
while (!sim.done) { const o = sim.step(); csv += `${o.t.toFixed(3)},${o.ax.toFixed(4)},${o.ay.toFixed(4)},${o.az.toFixed(4)},${o.fix===null?'':o.fix.toFixed(3)}\n`; }
const rows = PL.parseCsv(csv); const e2 = PL.analyzeRows(rows, 90);
console.log('\nCSV rows', rows.length, 'score', e2.summary().score, 'events', e2.events.length);
// ms timestamps + semicolon
const csv2 = csv.split('\n').map((l,i)=> i===0? 'time;x;y;z;speed' : l.split(',').map((c,j)=> j===0? (parseFloat(c)*1000).toFixed(0): c.replace('.',',')).join(';')).join('\n');
const e3 = PL.analyzeRows(PL.parseCsv(csv2), 90); console.log('CSV ms/; score', e3.summary().score);
