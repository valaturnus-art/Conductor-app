// Tests du module jeu/social : node game-test.js
const assert = require('assert');
const PL = require('./engine.js'), PG = require('./game.js');
const T0 = new Date(2026, 9, 5, 8, 0).getTime();   // lundi 5 octobre 2026, 8 h
const mk = (style, seed, ts, extra = {}) => { const e = PL.runSim(style, seed); return { id: style + seed + ts, ts, sum: e.summary(), events: e.events, ...extra }; };

// 1. Calendrier, niveaux, ligues
assert.strictEqual(PG.weekKey(T0), '2026-W41'); assert.strictEqual(PG.weekKey(new Date(2026, 9, 11, 23).getTime()), '2026-W41'); assert.strictEqual(PG.weekKey(new Date(2026, 9, 12, 1).getTime()), '2026-W42');
assert.strictEqual(PG.weekKey(new Date(2027, 0, 1).getTime()), '2026-W53');
assert.strictEqual(PG.levelOf(0).level, 1); assert.strictEqual(PG.levelOf(60).level, 2); assert(PG.levelOf(2100).level === 10 && PG.levelOf(2100).title === 'Tireur d’élite');
assert.strictEqual(PG.league(91).name, 'Galaxie'); assert.strictEqual(PG.league(59).name, 'Terre'); assert.strictEqual(PG.league(75).id, 'agate'); assert.strictEqual(PG.league(null), null);
assert.strictEqual(PG.dailyChallenges('2026-10-05').length, 3); assert.deepStrictEqual(PG.dailyChallenges('2026-10-05').map(c => c.id), PG.dailyChallenges('2026-10-05').map(c => c.id));
assert.notDeepStrictEqual(PG.dailyChallenges('2026-10-05').map(c => c.id), PG.dailyChallenges('2026-10-06').map(c => c.id));

// 2. Récompenses : qualité > kilomètres, badges, défis, série
const S = PG.newState(), trips = [];
const calm = mk('calm', 7, T0), rough = mk('rough', 7, T0 + 3600e3);
assert(PG.tripXP(calm) > 3 * PG.tripXP(rough), 'un trajet posé rapporte bien plus qu’un trajet nerveux');
const r1 = PG.award(S, trips, calm); trips.unshift(calm);
assert(r1.badges.includes('contact') && r1.badges.includes('velours'), 'premiers badges : ' + r1.badges);
assert(r1.xp > 0 && S.xp === r1.xp && calm.xp === r1.xp);
const r2 = PG.award(S, trips, rough); trips.unshift(rough);
assert(!r2.badges.includes('velours') && PG.streak(trips) === 0);
for (let i = 0; i < 5; i++) { const t = mk('calm', i + 1, T0 + (i + 2) * 3600e3); PG.award(S, trips, t); trips.unshift(t); }
assert.strictEqual(PG.streak(trips), 5); assert(S.badges.serie5, 'série de 5');
assert.strictEqual(S.feed[0].type, 'trip'); assert(S.nTrips === 7 && S.totalKm > 20);
console.log('XP', S.xp, '| niveau', JSON.stringify(PG.levelOf(S.xp)), '| badges', Object.keys(S.badges).join(' '));
console.log('jour', PG.dailyChallenges('2026-10-05').map(c => c.id).join(' '), '| faits', JSON.stringify(S.daily));
// défi de la semaine : seuil = semaine passée + 3
const lastWeek = [mk('normal', 7, T0 - 7 * 86400e3)];
assert.strictEqual(PG.weeklyGoal(lastWeek, T0).target, Math.max(70, lastWeek[0].sum.score + 3));
const wk = PG.weekStats(trips, '2026-W41'); assert(wk.n === 7 && wk.score > 60 && wk.league);
// coaching : l'axe le plus faible
const fo = PG.focus([mk('normal', 7, T0)]); assert(fo && fo.axis && fo.tip && fo.value < 85, JSON.stringify(fo));

// 3. Liens de partage : aller-retour, validation, amis, défis, bravos
const me = { id: 'moi12345', n: 'Victor', a: '🦊' }, cl = { id: 'clem6789', n: 'Clémence', a: '🦉' };
const c = PG.card(me, S, trips, T0 + 10 * 3600e3), link = PG.encode('c', c);
assert(link.length < 600, 'lien court : ' + link.length);
const back = PG.decode('#' + link); assert(back && back.n === 'Victor' && back.ws === wk.score && back.top.length === 3);
assert.strictEqual(PG.decode('#c=' + PG.b64e('{"v":1,"id":"x<script>","n":"<img src=x onerror=alert(1)>","a":"💣","s":999}')).n.includes('<'), false, 'nettoyage');
assert.strictEqual(PG.decode('#c=' + PG.b64e('{"v":1,"id":"abc","s":999}')).s, 100, 'bornes');
assert.strictEqual(PG.decode('#x=abc'), null); assert.strictEqual(PG.decode('#c=%%%%%%%%%%'), null);
const S2 = PG.newState();   // téléphone de Clémence
const rc = PG.receive(S2, back, cl, T0 + 11 * 3600e3); assert(rc.isNew && S2.friends.moi12345 && S2.feed[0].type === 'friend');
assert(PG.receive(S2, back, cl, T0 + 12 * 3600e3).isNew === false && S2.feed.length === 1, 'même carte rouverte : pas de doublon');
assert(PG.receive(S, back, me, T0).self, 'ma propre carte');
// Victor défie Clémence : 80 sur 5 km
const nd = PG.newDefi(me, 80, 3, T0); S.defis.unshift(nd.local);
const dmsg = PG.decode('#' + PG.encode('d', nd.link)); const rd = PG.receive(S2, dmsg, cl, T0 + 3600e3);
assert(rd.defi.status === 'open' && S2.defis.length === 1);
const t2 = mk('calm', 3, T0 + 2 * 3600e3), aw = PG.award(S2, [], t2);
assert(aw.defis.length === 1 && S2.defis[0].status === 'won' && S2.badges.defi, 'défi battu + badge');
// Clémence répond avec sa carte liée au défi → Victor voit la réponse
const reply = PG.decode('#' + PG.encode('c', PG.card(cl, S2, [t2], T0 + 3 * 3600e3, nd.local.id)));
const rr = PG.receive(S, reply, me, T0 + 4 * 3600e3); assert(rr.defi && rr.defi.status === 'answered' && rr.defi.answer.s === t2.sum.score);
// bravo
const k = PG.decode('#' + PG.encode('k', { from: cl, to: me.id, e: '🔥', re: trips[0].ts, s: trips[0].sum.score }));
assert(PG.receive(S, k, me, T0).kudos && S.feed[0].type === 'kudos'); assert(PG.receive(S, k, { id: 'autre' }, T0).notMe);
// 3 amis → badge social
for (const id of ['a1aaaaaa', 'b2bbbbbb']) PG.receive(S, PG.decode('#' + PG.encode('c', { id, n: id, a: '🐼', ts: T0, w: '2026-W41', ws: 70 })), me, T0);
assert(S.badges.bande, 'badge la bande');
const bd = PG.board(me, S, trips, T0 + 3600e3); assert(bd[0].ws >= bd[bd.length - 1].ws || bd[bd.length - 1].ws === null); assert(bd.some(r => r.me));
console.log('classement', bd.map(r => `${r.n}:${r.ws}`).join(' '));

// 4. Points noirs et trajets récurrents
const P = [43.2965, 5.3698];
const at = (dLat, dLon) => [P[0] + dLat, P[1] + dLon];
const tA = { id: 'A', ts: T0, events: [{ kind: 'brake', ll: at(0, 0) }, { kind: 'corner', ll: at(0.01, 0) }], from: at(0, 0), to: at(0.05, 0.05), sum: {} };
const tB = { id: 'B', ts: T0, events: [{ kind: 'brake', ll: at(0.0003, 0.0002) }, { kind: 'shock', ll: at(0.01, 0) }], from: at(0.001, 0), to: at(0.0501, 0.05), sum: {} };
const hs = PG.hotspots([tA, tB]); assert.strictEqual(hs.length, 1); assert(hs[0].kind === 'brake' && hs[0].trips === 2);
assert.deepStrictEqual(PG.sameRoute([tA, tB], tB).map(t => t.id), ['A']);
console.log('\nOK');
