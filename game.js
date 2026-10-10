/* Bille — jeu et social sans serveur (pur, sans DOM) : billes (XP), niveaux, billes rares (badges), défis, ligues, amis par liens. */
const PG = (() => {
  'use strict';
  const DAY = 86400000;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const p2 = n => String(n).padStart(2, '0');

  /* ---------- Calendrier (heure locale) ---------- */
  const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  function weekKey(ts) {   // semaine ISO : AAAA-Wnn
    const d = new Date(ts); d.setHours(12, 0, 0, 0);
    const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd + 3);
    const y = d.getFullYear(), j4 = new Date(y, 0, 4, 12); const w = 1 + Math.round(((d - j4) / DAY - 3 + ((j4.getDay() + 6) % 7)) / 7);
    return `${y}-W${p2(w)}`;
  }
  const weekEnd = ts => { const d = new Date(ts); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() + 6 - wd); d.setHours(23, 59, 59, 999); return d.getTime(); };

  /* ---------- Niveaux ---------- */
  // XP cumulée pour atteindre le niveau L : 60 × (L−1)^1,6. Un bon trajet rapporte 40 à 80 XP.
  const need = L => Math.round(60 * Math.pow(Math.max(0, L - 1), 1.6));
  const TITLES = [[1, 'Petite bille'], [3, 'Joueur de cour'], [6, 'Pointeur'], [10, 'Tireur d’élite'], [15, 'Maître du calot'], [20, 'Légende de la cour']];
  function levelOf(xp) {
    let L = 1; while (need(L + 1) <= xp) L++;
    const a = need(L), b = need(L + 1);
    return { level: L, title: TITLES.filter(t => t[0] <= L).pop()[1], cur: xp - a, span: b - a, pct: (xp - a) / (b - a), next: b };
  }

  /* ---------- Ligues (score pondéré par les km de la semaine) ---------- */
  // Ligues = les billes de la cour d'école, de la plus commune à la plus rare.
  const LEAGUES = [[90, 'Galaxie', 'galaxie'], [80, 'Œil-de-chat', 'oeil'], [70, 'Agate', 'agate'], [60, 'Verre', 'verre'], [0, 'Terre', 'terre']];
  const league = s => { if (s === null || s === undefined) return null; const l = LEAGUES.find(x => s >= x[0]); return { name: l[1], id: l[2], min: l[0] }; };
  function weekStats(trips, wk) {
    const ts = trips.filter(t => weekKey(t.ts) === wk && t.sum);
    let km = 0, w = 0; for (const t of ts) { const k = Math.max(t.sum.km, 0.5); km += t.sum.km; w += k * t.sum.score; }
    const wsum = ts.reduce((s, t) => s + Math.max(t.sum.km, 0.5), 0);
    const score = ts.length ? Math.round(w / wsum) : null;
    return { wk, n: ts.length, km: Math.round(km * 10) / 10, score, league: league(score) };
  }

  /* ---------- Série : trajets consécutifs ≥ 70 (on récompense la qualité, pas le fait de rouler plus) ---------- */
  function streak(trips) {   // trips : du plus récent au plus ancien
    let cur = 0; for (const t of trips) { if (t.sum.score >= 70) cur++; else break; }
    return cur;
  }

  /* ---------- Badges ---------- */
  const noKind = (t, ...k) => !t.events.some(e => k.includes(e.kind));
  const BADGES = [
    { id: 'contact', icon: '🔑', name: 'Contact', desc: 'Premier trajet noté', test: () => true },
    { id: 'velours', icon: '🪶', name: 'Velours', desc: 'Un trajet ≥ 85', test: t => t.sum.score >= 85 && t.sum.km >= 2 },
    { id: 'diamant', icon: '💎', name: 'Diamant', desc: 'Un trajet ≥ 95 sur 5 km', test: t => t.sum.score >= 95 && t.sum.km >= 5 },
    { id: 'soie', icon: '🧈', name: 'Freins de soie', desc: '10 km sans freinage brusque', test: t => t.sum.km >= 10 && noKind(t, 'brake') && !t.events.some(e => e.fast) },
    { id: 'flow', icon: '🌊', name: 'Flow', desc: '10 min d’affilée sans à-coup', test: t => (t.sum.streakBest || 0) >= 600 },
    { id: 'cordeau', icon: '🧭', name: 'Au cordeau', desc: '15 km sans virage serré', test: t => t.sum.km >= 15 && noKind(t, 'corner') },
    { id: 'mainferme', icon: '✋', name: 'Main ferme', desc: '10 km sans coup de volant ni redressement', test: t => t.sum.km >= 10 && noKind(t, 'swerve', 'fix') },
    { id: 'boite', icon: '⚙️', name: 'Boîte de velours', desc: '8 passages de vitesse, aucun brusque', test: t => (t.sum.counts.shift || 0) >= 8 && !t.sum.counts.shiftHarsh },
    { id: 'clous', icon: '🚦', name: 'Dans les clous', desc: '10 km de limitations connues, aucun excès', test: t => (t.sum.limKm || 0) >= 10 && !t.sum.counts.speed },
    { id: 'eco', icon: '🍃', name: 'Sobre', desc: 'Éco-dynamisme ≥ 80 sur 5 km', test: t => t.sum.eco && t.sum.eco.score >= 80 && t.sum.km >= 5 },
    { id: 'nuit', icon: '🌙', name: 'Nuit sereine', desc: 'Trajet de nuit ≥ 80 (22 h – 6 h)', test: t => { const h = new Date(t.ts).getHours(); return (h >= 22 || h < 6) && t.sum.score >= 80 && t.sum.km >= 3; } },
    { id: 'progres', icon: '📈', name: 'Déclic', desc: '+15 points sur ta moyenne des 5 derniers', test: (t, prev) => prev.length >= 3 && t.sum.score - avg(prev.slice(0, 5).map(x => x.sum.score)) >= 15 },
    { id: 'serie5', icon: '🔥', name: 'Série de 5', desc: '5 trajets ≥ 70 d’affilée', test: (t, prev, G) => G.streak >= 5 },
    { id: 'serie15', icon: '☄️', name: 'Série de 15', desc: '15 trajets ≥ 70 d’affilée', test: (t, prev, G) => G.streak >= 15 },
    { id: 'zen', icon: '📵', name: 'Zéro écran', desc: '10 trajets d’affilée sans toucher au téléphone', test: (t, prev, G) => G.noPhoneRun >= 10 },
    { id: 'dosdane', icon: '🐢', name: 'Dos d’âne en douceur', desc: '10 dos d’âne passés lentement', test: (t, prev, G) => G.softBumps >= 10 },
    { id: 'cent', icon: '💯', name: 'Centurion', desc: '100 km notés', test: (t, prev, G) => G.totalKm >= 100 },
    { id: 'marathon', icon: '🛣️', name: 'Grand voyageur', desc: '1 000 km notés', test: (t, prev, G) => G.totalKm >= 1000 },
    { id: 'bande', icon: '🤝', name: 'La bande', desc: '3 amis ajoutés', social: true, test: (t, prev, G) => G.friends >= 3 },
    { id: 'defi', icon: '🏆', name: 'Défi relevé', desc: 'Battre le défi d’un ami', social: true, test: (t, prev, G) => G.defisWon >= 1 }
  ];
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const badge = id => BADGES.find(b => b.id === id);

  /* ---------- Défis du jour : 3 tirés au sort chaque jour (graine = date) ---------- */
  const CH = [
    { id: 'score80', text: 'Un trajet ≥ 80', xp: 40, test: t => t.sum.score >= 80 && t.sum.km >= 2 },
    { id: 'nobrake', text: 'Aucun freinage brusque (3 km min.)', xp: 40, test: t => t.sum.km >= 3 && !t.sum.counts.brake && !t.sum.counts.fast },
    { id: 'flow5', text: '5 min d’affilée sans à-coup', xp: 30, test: t => (t.sum.streakBest || 0) >= 300 },
    { id: 'corner85', text: 'Virages ≥ 85 (3 km min.)', xp: 30, test: t => t.sum.km >= 3 && t.sum.axes.virages >= 85 },
    { id: 'smooth80', text: 'Fluidité ≥ 80 (3 km min.)', xp: 30, test: t => t.sum.km >= 3 && t.sum.axes.fluidite >= 80 },
    { id: 'steady', text: 'Aucun coup de volant ni redressement (3 km min.)', xp: 30, test: t => t.sum.km >= 3 && !t.sum.counts.swerve && !t.sum.counts.fix },
    { id: 'limits', text: 'Aucun excès de vitesse (3 km de limitations connues)', xp: 40, test: t => (t.sum.limKm || 0) >= 3 && !t.sum.counts.speed },
    { id: 'nophone', text: 'Pas touche au téléphone en roulant (3 km min.)', xp: 30, test: t => t.sum.km >= 3 && !t.sum.counts.phone },
    { id: 'eco70', text: 'Éco-dynamisme ≥ 70 (3 km min.)', xp: 30, test: t => t.sum.km >= 3 && t.sum.eco && t.sum.eco.score >= 70 },
    { id: 'accel85', text: 'Accélération ≥ 85 (3 km min.)', xp: 30, test: t => t.sum.km >= 3 && t.sum.axes.acceleration >= 85 }
  ];
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  function dailyChallenges(day) {
    const pool = CH.slice(), out = []; let h = hash('pl:' + day);
    while (out.length < 3) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
    return out;
  }
  // Défi de la semaine : faire mieux que la semaine passée (comme les défis à seuil qui ont réduit les excès dans l'étude NTUA 2025).
  function weeklyGoal(trips, now) {
    const prev = weekStats(trips, weekKey(now - 7 * DAY));
    const target = clamp(prev.score === null ? 75 : prev.score + 3, 70, 95);
    return { wk: weekKey(now), target, minKm: 30, minTrips: 3, xp: 150 };
  }

  /* ---------- Coaching : l'axe le plus faible des derniers trajets, sa tendance, un conseil ---------- */
  const TIPS = {
    freinage: ['Freinage', 'Lève le pied dès que tu vois le feu ou la file : freine plus tôt, moins fort.'],
    acceleration: ['Accélération', 'Enfonce l’accélérateur en 2 secondes, pas d’un coup.'],
    virages: ['Virages', 'Ralentis avant le virage, ré-accélère à la sortie.'],
    trajectoire: ['Volant', 'Regarde loin devant : moins de corrections, pas de coup de volant.'],
    fluidite: ['Fluidité', 'Embrayage en douceur, et laisse plus de distance devant toi.'],
    vitesse: ['Vitesse', 'Cale ton allure sur la limitation, surtout en sortie de zone 50.']
  };
  function focus(trips) {   // du plus récent au plus ancien
    const last = trips.slice(0, 5), prev = trips.slice(5, 10);
    if (!last.length) return null;
    const mean = (ts, k) => { const v = ts.map(t => t.sum.axes[k]).filter(x => x !== null && x !== undefined); return v.length ? avg(v) : null; };
    let best = null;
    for (const k of Object.keys(TIPS)) {
      const m = mean(last, k); if (m === null) continue;
      if (!best || m < best.value) best = { axis: k, value: Math.round(m) };
    }
    if (!best) return null;
    const p = mean(prev, best.axis);
    return { ...best, label: TIPS[best.axis][0], tip: TIPS[best.axis][1], trend: p === null ? null : Math.round(best.value - p), ok: best.value >= 85 };
  }

  /* ---------- Points noirs : lieux où tu reproduis le même défaut d'un trajet à l'autre ---------- */
  const SCORING = ['brake', 'accel', 'corner', 'swerve', 'fix', 'speed', 'phone'];
  const R = 6371000, toRad = Math.PI / 180;
  const dist = (a, b) => { const x = (b[1] - a[1]) * toRad * Math.cos((a[0] + b[0]) / 2 * toRad), y = (b[0] - a[0]) * toRad; return Math.hypot(x, y) * R; };
  function hotspots(trips, radius = 70) {
    const pts = [];
    for (const t of trips) for (const e of t.events || []) if (e.ll && (SCORING.includes(e.kind) || e.fast)) pts.push({ ll: e.ll, kind: e.fast ? 'brake' : e.kind, trip: t.id });
    const cl = [];
    for (const p of pts) {
      let c = cl.find(c => dist(c.ll, p.ll) <= radius);
      if (!c) { c = { ll: p.ll.slice(), n: 0, trips: new Set(), kinds: {} }; cl.push(c); }
      c.ll = [(c.ll[0] * c.n + p.ll[0]) / (c.n + 1), (c.ll[1] * c.n + p.ll[1]) / (c.n + 1)];
      c.n++; c.trips.add(p.trip); c.kinds[p.kind] = (c.kinds[p.kind] || 0) + 1;
    }
    return cl.filter(c => c.trips.size >= 2).map(c => ({ ll: [+c.ll[0].toFixed(5), +c.ll[1].toFixed(5)], n: c.n, trips: c.trips.size,
      kind: Object.entries(c.kinds).sort((a, b) => b[1] - a[1])[0][0], kinds: c.kinds })).sort((a, b) => b.n - a.n);
  }

  /* ---------- Trajets récurrents : même départ et même arrivée (300 m) ---------- */
  function sameRoute(trips, trip, r = 300) {
    if (!trip.from || !trip.to) return [];
    return trips.filter(t => t.id !== trip.id && t.from && t.to && dist(t.from, trip.from) <= r && dist(t.to, trip.to) <= r);
  }

  /* ---------- Récompenses d'un trajet terminé ---------- */
  // Le XP vient de la qualité : un trajet sous 40 ne rapporte rien, la distance ne compte que jusqu'à 20 km.
  const tripXP = t => Math.round(Math.max(0, t.sum.score - 40) * (0.5 + Math.min(t.sum.km, 20) / 20));
  function newState() {
    return { v: 1, xp: 0, badges: {}, daily: {}, weekly: {}, totalKm: 0, nTrips: 0, softBumps: 0, noPhoneRun: 0, defisWon: 0, feed: [], friends: {}, defis: [], seen: {} };
  }
  /** Met l'état à jour avec un trajet terminé (trips = historique AVANT ce trajet, du plus récent au plus ancien). */
  function award(S, trips, t, now = t.ts) {
    const out = { items: [], badges: [], challenges: [], weekly: false, defis: [], xp0: S.xp };
    S.totalKm += t.sum.km; S.nTrips++;
    S.softBumps += t.events.filter(e => e.kind === 'shock' && e.side === 'both' && !e.fast).length;
    S.noPhoneRun = t.sum.counts.phone ? 0 : S.noPhoneRun + 1;
    const base = tripXP(t); if (base) out.items.push({ label: `Trajet noté ${t.sum.score}`, xp: base });
    // défis du jour
    const day = dayKey(t.ts), done = S.daily[day] || (S.daily[day] = []);
    for (const c of dailyChallenges(day)) if (!done.includes(c.id) && c.test(t)) { done.push(c.id); out.challenges.push(c.id); out.items.push({ label: 'Défi : ' + c.text, xp: c.xp }); }
    for (const k of Object.keys(S.daily)) if (k < dayKey(now - 14 * DAY)) delete S.daily[k];
    // défi de la semaine
    const all = [t, ...trips], wg = weeklyGoal(all, t.ts), ws = weekStats(all, wg.wk);
    if (!S.weekly[wg.wk] && ws.n >= wg.minTrips && ws.km >= wg.minKm && ws.score >= wg.target) { S.weekly[wg.wk] = true; out.weekly = true; out.items.push({ label: `Défi de la semaine : ${wg.target}+ sur ${wg.minKm} km`, xp: wg.xp }); }
    // défis d'amis acceptés
    for (const d of S.defis) {
      if (d.status !== 'open' || d.mine) continue;
      if (t.ts > d.until) { d.status = 'expired'; continue; }
      if (t.sum.km >= d.km && t.sum.score > d.target) { d.status = 'won'; d.won = { score: t.sum.score, km: t.sum.km, ts: t.ts }; S.defisWon++; out.defis.push(d); out.items.push({ label: `Défi de ${d.from.n} battu`, xp: 100 }); }
    }
    // badges
    const G = { streak: streak(all), noPhoneRun: S.noPhoneRun, softBumps: S.softBumps, totalKm: S.totalKm, friends: Object.keys(S.friends).length, defisWon: S.defisWon };
    for (const b of BADGES) if (!S.badges[b.id] && b.test(t, trips, G)) { S.badges[b.id] = t.ts; out.badges.push(b.id); out.items.push({ label: 'Badge ' + b.name, xp: 50 }); }
    out.xp = out.items.reduce((s, i) => s + i.xp, 0);
    const L0 = levelOf(S.xp).level; S.xp += out.xp; const L1 = levelOf(S.xp).level;
    if (L1 > L0) out.levelUp = { from: L0, to: L1 };
    t.xp = out.xp; t.badges = out.badges;
    pushFeed(S, { type: 'trip', ts: t.ts, id: t.id, score: t.sum.score, km: t.sum.km, xp: out.xp, badges: out.badges, levelUp: out.levelUp ? out.levelUp.to : 0 });
    return out;
  }
  /** Badges sociaux (débloqués hors trajet, ex. au 3e ami). */
  function socialBadges(S, ts) {
    const G = { friends: Object.keys(S.friends).length, defisWon: S.defisWon }, got = [];
    for (const b of BADGES) if (b.social && !S.badges[b.id] && b.test(null, [], G)) { S.badges[b.id] = ts; S.xp += 50; got.push(b.id); }
    return got;
  }
  const pushFeed = (S, item) => { S.feed.unshift(item); if (S.feed.length > 120) S.feed.length = 120; };

  /* ---------- Liens de partage : carte, défi, bravo (aucun serveur, aucune position) ---------- */
  const b64e = s => { const b = typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s))); return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const b64d = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64').toString('utf8') : decodeURIComponent(escape(atob(s))); };
  const AVATARS = ['🦊', '🐼', '🦉', '🐢', '🐺', '🦁', '🐸', '🐙', '🦄', '🐝', '🐧', '🐯'];
  const str = (x, n) => typeof x === 'string' ? x.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '';
  const num = (x, lo, hi) => Number.isFinite(+x) ? clamp(+x, lo, hi) : null;
  const who = p => ({ id: str(p && p.id, 16), n: str(p && p.n, 24) || 'Anonyme', a: AVATARS.includes(p && p.a) ? p.a : '🚗' });
  function encode(kind, obj) { return kind + '=' + b64e(JSON.stringify({ v: 1, ...obj })); }
  /** Lit un lien reçu. Tout est revalidé : un lien peut être modifié par n'importe qui. */
  function decode(hash) {
    const m = /^#?([cdk])=([A-Za-z0-9_-]{8,3000})$/.exec(hash || ''); if (!m) return null;
    let o; try { o = JSON.parse(b64d(m[2])); } catch (e) { return null; }
    if (!o || o.v !== 1 || typeof o !== 'object') return null;
    if (m[1] === 'c') {
      const p = who(o); if (!p.id) return null;
      return { k: 'c', ...p, lv: num(o.lv, 1, 99) || 1, s: num(o.s, 0, 100), km: num(o.km, 0, 5000), ts: num(o.ts, 0, 9e15) || 0, w: str(o.w, 8),
        ws: num(o.ws, 0, 100), wk: num(o.wk, 0, 1e5), wn: num(o.wn, 0, 999), st: num(o.st, 0, 9999) || 0, b: num(o.b, 0, 99) || 0,
        top: Array.isArray(o.top) ? o.top.filter(id => badge(id)).slice(0, 3) : [], r: str(o.r, 16) || null };
    }
    if (m[1] === 'd') {
      const from = who(o.from); if (!from.id || !str(o.id, 16)) return null;
      return { k: 'd', id: str(o.id, 16), from, target: num(o.g && o.g.s, 50, 99) || 80, km: num(o.g && o.g.km, 1, 200) || 5, until: num(o.u, 0, 9e15) || 0 };
    }
    const from = who(o.from); if (!from.id) return null;
    return { k: 'k', from, to: str(o.to, 16), e: ['👏', '🔥', '💪', '🎉', '😎'].includes(o.e) ? o.e : '👏', re: num(o.re, 0, 9e15) || 0, s: num(o.s, 0, 100) };
  }
  /** Carte de profil partageable (aucune position, aucun détail de trajet). */
  function card(profile, S, trips, now, reply) {
    const last = trips[0], wk = weekKey(now), ws = weekStats(trips, wk);
    const top = Object.entries(S.badges).sort((a, b) => b[1] - a[1]).map(x => x[0]).filter(id => badge(id)).slice(0, 3);
    return { id: profile.id, n: profile.n, a: profile.a, lv: levelOf(S.xp).level, s: last ? last.sum.score : null, km: last ? Math.round(last.sum.km * 10) / 10 : null,
      ts: last ? last.ts : now, w: wk, ws: ws.score, wk: ws.km, wn: ws.n, st: streak(trips), b: Object.keys(S.badges).length, top, ...(reply ? { r: reply } : {}) };
  }
  /** Intègre un lien reçu dans l'état local. Renvoie ce qu'il faut annoncer. */
  function receive(S, msg, me, now) {
    if (!msg) return null;
    if (msg.k === 'c') {
      if (msg.id === me.id) return { self: true };
      const old = S.friends[msg.id], isNew = !old;
      if (old && old.ts > msg.ts) return { friend: old, isNew: false, stale: true };
      S.friends[msg.id] = { ...msg, got: now };
      const key = 'c' + msg.id + ':' + msg.ts;
      if (!S.seen[key]) { S.seen[key] = now; pushFeed(S, { type: 'friend', ts: now, id: msg.id, n: msg.n, a: msg.a, score: msg.s, ws: msg.ws, isNew, r: msg.r }); }
      let defi = null;
      if (msg.r) { defi = S.defis.find(d => d.id === msg.r && d.mine); if (defi && defi.status === 'open') { defi.status = 'answered'; defi.answer = { n: msg.n, a: msg.a, s: msg.s }; } }
      return { friend: S.friends[msg.id], isNew, defi, badges: socialBadges(S, now) };
    }
    if (msg.k === 'd') {
      if (msg.from.id === me.id) return { self: true };
      let d = S.defis.find(x => x.id === msg.id);
      if (!d) { d = { id: msg.id, from: msg.from, target: msg.target, km: msg.km, until: msg.until, status: msg.until < now ? 'expired' : 'open', got: now }; S.defis.unshift(d); pushFeed(S, { type: 'defi', ts: now, id: d.id, n: d.from.n, a: d.from.a, target: d.target, km: d.km }); }
      if (!S.friends[msg.from.id]) S.friends[msg.from.id] = { ...msg.from, k: 'c', lv: 1, s: null, ts: 0, w: '', ws: null, b: 0, top: [], st: 0, got: now };
      return { defi: d, badges: socialBadges(S, now) };
    }
    if (msg.to && msg.to !== me.id) return { notMe: true, kudos: msg };
    const key = 'k' + msg.from.id + ':' + msg.re + msg.e;
    if (!S.seen[key]) { S.seen[key] = now; pushFeed(S, { type: 'kudos', ts: now, n: msg.from.n, a: msg.from.a, e: msg.e, s: msg.s }); }
    return { kudos: msg };
  }
  function newDefi(profile, target, km, now) {
    const id = Math.random().toString(36).slice(2, 10);
    return { local: { id, mine: true, from: { id: profile.id, n: profile.n, a: profile.a }, target, km, until: weekEnd(now + 3 * DAY), status: 'open', got: now },
      link: { id, from: { id: profile.id, n: profile.n, a: profile.a }, g: { s: target, km }, u: weekEnd(now + 3 * DAY) } };
  }
  /** Classement de la semaine : moi + amis (score de semaine partagé), du meilleur au moins bon. */
  function board(me, S, trips, now) {
    const wk = weekKey(now), mine = weekStats(trips, wk);
    const rows = [{ id: me.id, n: me.n, a: me.a, ws: mine.score, wk: mine.km, lv: levelOf(S.xp).level, me: true }];
    for (const f of Object.values(S.friends)) rows.push({ id: f.id, n: f.n, a: f.a, ws: f.w === wk ? f.ws : null, wk: f.w === wk ? f.wk : null, lv: f.lv, stale: f.w !== wk });
    rows.sort((a, b) => (b.ws === null ? -1 : b.ws) - (a.ws === null ? -1 : a.ws) || (b.wk || 0) - (a.wk || 0));
    return rows;
  }

  return { dayKey, weekKey, weekEnd, need, levelOf, LEAGUES, league, weekStats, streak, BADGES, badge, CH, dailyChallenges, weeklyGoal, focus, TIPS, hotspots, dist, sameRoute,
    tripXP, newState, award, socialBadges, AVATARS, encode, decode, card, receive, newDefi, board, b64e, b64d };
})();
if (typeof module !== 'undefined') module.exports = PG;
