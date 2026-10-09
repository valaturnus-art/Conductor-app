/* Pied Léger — moteur d'analyse de conduite (pur, sans DOM). */
const PL = (() => {
  'use strict';
  const G = 9.81;
  const CFG = {
    brake:  { mod: 2.9, sev: 4.4 },   // m/s², freinage brusque (~0,3 g)
    accel:  { mod: 2.5, sev: 3.5 },   // accélération vive
    corner: { mod: 2.8, sev: 4.0 },   // accélération latérale en virage
    shock:  { mod: 5, sev: 8 },       // m/s², choc vertical (nid-de-poule, dos-d'âne)
    shockRefractory: 1.0, minShockSpeed: 3, shockHz: 12,
    rollGain: 2.5,                    // répartition gauche/droite d'un choc (roulis vu du téléphone)
    sideRatio: 0.15,                  // sous ce rapport latéral/vertical : choc des deux côtés (dos d'âne)
    lateLead: -0.5,                   // m/s² : freinage « tardif » si on ne levait pas déjà le pied
    minEventS: 0.3, minCornerSpeed: 3, stopSpeed: 0.5, movingSpeed: 1,
    lpHz: 1.5, displayHz: 4, hysteresis: 0.7
  };
  const W = { freinage: .32, virages: .26, acceleration: .24, fluidite: .18 };

  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const unit = a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/n, a[1]/n, a[2]/n]; };
  const madd = (a, s, b) => [a[0]+s*b[0], a[1]+s*b[1], a[2]+s*b[2]];
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  class Engine {
    constructor(opts = {}) { this.mount = opts.mount === 'free' ? 'free' : 'vent'; this.reset(); }

    reset() {
      this.t0 = null; this.tPrev = null; this.t = 0;
      this.g = null; this.gBuf = []; this.gCal = null;
      this.speed = null; this.fix = null; this.dist = 0;
      this.movingS = 0; this.maxV = 0;
      this.basis = null; this.f = null;
      this.cal = { n: 0, sx: 0, sy: 0, den: 0 };
      this.hAcc = [0, 0]; this.hN = 0;
      this.fl = [0, 0, 0, 0];
      this.aLong = 0; this.aLat = 0;
      this.open = {}; this.events = [];
      this.series = []; this.nextSeriesT = 0;
      this.trail = []; this.nextTrailT = 0;
      this.hist = []; this.vz = 0; this.shock = null; this.lastShock = -9;
      // Affichage temps réel : valeurs peu filtrées, activité des capteurs, sens gauche/droite
      this.rs = 1; this.ventOk = false; this.fSource = null;
      this.vh = 0; this.vzSlow = 0; this.lz = 0; this.lzSlow = 0; this.zL = 0; this.zR = 0; this.pk = [0, 0];
      this.fd = [0, 0, 0, 0]; this.dLong = 0; this.dLat = 0; this.liveMag = 0;
      this.latSign = 1; this.latAcc = 0; this.latN = 0; this.latCal = { sum: 0, den: 0, n: 0 }; this.prevHead = null;
      this.tickT = null; this.prevA = [0, 0]; this.jerkSq = 0; this.jerkT = 0;
      this.recalCount = 0;
      this.status = 'init'; // init -> calibrating -> ready
    }

    /** Téléphone vertical sur la grille : l'avant du véhicule est derrière l'écran (−z), projeté à l'horizontale. */
    _applyPrior(u) {
      const z = [0, 0, 1], zh = madd(z, -dot(z, u), u), n = Math.hypot(zh[0], zh[1], zh[2]);
      if (n < 0.2) return false;
      this.f = [-zh[0] / n, -zh[1] / n, -zh[2] / n]; this.fSource = 'prior'; this.status = 'ready';
      return true;
    }

    _newBasis(u) {
      const a = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const e1 = unit(madd(a, -dot(a, u), u));
      this.basis = { u, e1, e2: cross(u, e1) };
      this.cal = { n: 0, sx: 0, sy: 0, den: 0 };
      this.hAcc = [0, 0]; this.hN = 0;
    }

    /** Accéléromètre, gravité incluse (m/s²), t en secondes. */
    pushMotion(t, ax, ay, az) {
      if (this.t0 === null) this.t0 = t;
      const ts = t - this.t0;
      const dt = this.tPrev === null ? 0.02 : clamp(t - this.tPrev, 0.001, 0.2);
      this.tPrev = t; this.t = ts;
      const r = [this.rs * ax, this.rs * ay, this.rs * az];

      // 1. Gravité : moyenne initiale, puis suivi lent (rapide à l'arrêt).
      if (!this.g) {
        this.gBuf.push(r);
        if (this.gBuf.length >= 25) {
          const s = [0, 0, 0];
          for (const v of this.gBuf) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
          // Portrait, haut de l'écran vers le haut : la gravité mesurée est surtout selon y. Son signe donne la
          // convention du navigateur (Android : +, iOS : −) : on normalise tout pour avoir « haut = +gravité ».
          let rs = 1; this.ventOk = false;
          const m = Math.hypot(s[0], s[1], s[2]);
          if (this.mount === 'vent' && m > 0 && Math.abs(s[1]) / m >= 0.7) { rs = s[1] < 0 ? -1 : 1; this.ventOk = true; }
          this.rs = rs; this.g = [rs * s[0] / 25, rs * s[1] / 25, rs * s[2] / 25]; this.gBuf = null;
          this.gCal = unit(this.g); this.status = 'calibrating';
          this._newBasis(this.gCal);
          if (this.ventOk) this._applyPrior(this.gCal);
        }
        return;
      }
      // À l'arrêt, la gravité se met à jour vite, mais seulement si le téléphone est calme :
      // sinon un démarrage (la vitesse GPS arrive avec 1 s de retard) serait pris pour de la gravité.
      const stopped = this.speed !== null && this.speed < CFG.stopSpeed;
      const dev = Math.hypot(r[0] - this.g[0], r[1] - this.g[1], r[2] - this.g[2]);
      let tau = 300;
      if (stopped) {
        if (dev <= 0.35) { this.devT = 0; tau = 1; }
        else { this.devT = (this.devT || 0) + dt; tau = this.devT > 2 ? 0.5 : Infinity; }   // téléphone reposé dans une autre position
      } else this.devT = 0;
      const kg = tau === Infinity ? 0 : 1 - Math.exp(-dt / tau);
      for (let i = 0; i < 3; i++) this.g[i] += (r[i] - this.g[i]) * kg;
      const u = unit(this.g);

      // Téléphone déplacé : on oublie l'axe avant et on recalibre.
      if (this.f && dot(u, this.gCal) < 0.94) {
        this.f = null; this.fSource = null; this.basis = null; this.gCal = u; this.open = {};
        this.status = 'calibrating'; this.recalCount++;
        if (this.ventOk) this._applyPrior(u);
      }
      if (!this.basis || dot(u, this.basis.u) < 0.996) this._newBasis(u);

      // 2. Accélération linéaire et projection sur les axes du véhicule.
      const lin = [r[0]-this.g[0], r[1]-this.g[1], r[2]-this.g[2]];
      if (this.basis) {   // le GPS affine toujours l'axe avant, même quand une orientation a priori existe
        this.hAcc[0] += dot(lin, this.basis.e1); this.hAcc[1] += dot(lin, this.basis.e2); this.hN++;
      }
      let aL = 0, aT = 0;
      if (this.f) {
        const fp = unit(madd(this.f, -dot(this.f, u), u));
        aL = dot(lin, fp); aT = dot(lin, cross(u, fp));
      }
      if (this.f) { this.latAcc += aT; this.latN++; }
      const aTs = aT * this.latSign;                 // + = le véhicule accélère vers la gauche
      const al = 1 - Math.exp(-2 * Math.PI * CFG.lpHz * dt), F = this.fl;
      F[0] += al * (aL - F[0]); F[1] += al * (F[0] - F[1]);
      F[2] += al * (aTs - F[2]); F[3] += al * (F[2] - F[3]);
      this.aLong = F[1]; this.aLat = F[3];
      const ad = 1 - Math.exp(-2 * Math.PI * CFG.displayHz * dt), D = this.fd;
      D[0] += ad * (aL - D[0]); D[1] += ad * (D[0] - D[1]);
      D[2] += ad * (aTs - D[2]); D[3] += ad * (D[2] - D[3]);
      this.dLong = D[1]; this.dLat = D[3];
      const hm = Math.sqrt(Math.max(0, dot(lin, lin) - dot(lin, u) ** 2));
      this.liveMag += (hm - this.liveMag) * (1 - Math.exp(-dt / 0.3));

      // 3. Temps cumulés selon la vitesse GPS.
      const v = this.speed;
      if (v !== null) {
        const kmh = v * 3.6;
        if (v > CFG.movingSpeed) this.movingS += dt;
        if (kmh > this.maxV) this.maxV = kmh;
      }

      // 4. Chocs de chaussée : vertical et latéral peu filtrés (12 Hz), sans la composante lente.
      // Une roue gauche qui monte fait pivoter la caisse vers la droite : le haut du véhicule, donc le
      // téléphone, part vers la droite. Le signe du latéral, comparé au vertical, donne le côté.
      const ks = 1 - Math.exp(-2 * Math.PI * CFG.shockHz * dt);
      this.vz += (dot(lin, u) - this.vz) * ks;
      this.vzSlow += (this.vz - this.vzSlow) * (1 - Math.exp(-dt / 1.5));
      this.vh = this.vz - this.vzSlow;
      this.lz += (aTs - this.lz) * ks;
      this.lzSlow += (this.lz - this.lzSlow) * (1 - Math.exp(-dt / 0.8));
      const sR = -(this.lz - this.lzSlow);   // + : vers la droite
      this.zL = 0.5 * (this.vh + CFG.rollGain * sR); this.zR = 0.5 * (this.vh - CFG.rollGain * sR);
      const dk = Math.exp(-dt / 1.2);
      this.pk[0] = Math.max(this.pk[0] * dk, Math.abs(this.zL)); this.pk[1] = Math.max(this.pk[1] * dk, Math.abs(this.zR));
      if (v !== null) this._shockCheck(this.vh, sR, v, ts);

      // Événements de conduite.
      if (this.f && v !== null) {
        this._detect('brake', -this.aLong, v, ts);
        this._detect('accel', this.aLong, v, ts);
        if (v >= CFG.minCornerSpeed) this._detect('corner', Math.abs(this.aLat), v, ts);
        else this._close('corner', ts);
      }

      // 5. Séries pour l'affichage et la fluidité (à-coups à 2 Hz).
      if (ts >= this.nextSeriesT) { this.series.push({ t: Math.round(ts), v: (v || 0) * 3.6 }); this.nextSeriesT = ts + 1; }
      if (ts >= this.nextTrailT) {
        this.trail.push([this.dLat, this.dLong]); if (this.trail.length > 40) this.trail.shift();
        this.hist.push([ts, this.aLong]); if (this.hist.length > 60) this.hist.shift();
        this.nextTrailT = ts + 0.1;
      }
      if (this.tickT === null) { this.tickT = ts; this.prevA = [this.aLong, this.aLat]; }
      else if (ts - this.tickT >= 0.5) {
        const d = ts - this.tickT;
        if (this.f && v !== null && v > 2) {
          const jl = (this.aLong - this.prevA[0]) / d, jt = (this.aLat - this.prevA[1]) / d;
          this.jerkSq += (jl*jl + jt*jt) * d; this.jerkT += d;
        }
        this.tickT = ts; this.prevA = [this.aLong, this.aLat];
      }
    }

    /** Vitesse GPS (m/s). Sert aussi à trouver l'axe avant du véhicule. */
    pushFix(t, v, heading) {
      if (this.t0 === null) this.t0 = t;
      const ts = t - this.t0;
      if (this.fix) {
        const dtf = ts - this.fix.t;
        if (dtf > 0.2 && dtf < 5) {
          this.dist += (v + this.fix.v) / 2 * dtf;
          const a = (v - this.fix.v) / dtf;
          if (this.basis && this.hN > 0 && Math.abs(a) >= 0.4) {
            const hm = [this.hAcc[0] / this.hN, this.hAcc[1] / this.hN], c = this.cal;
            c.sx += hm[0] * a; c.sy += hm[1] * a; c.den += Math.hypot(hm[0], hm[1]) * Math.abs(a); c.n++;
            const m = Math.hypot(c.sx, c.sy);
            if (c.n >= 4 && c.den > 1 && m / c.den >= 0.75) {
              const b = this.basis;
              this.f = unit([
                (c.sx*b.e1[0] + c.sy*b.e2[0]) / m,
                (c.sx*b.e1[1] + c.sy*b.e2[1]) / m,
                (c.sx*b.e1[2] + c.sy*b.e2[2]) / m
              ]);
              this.fSource = 'gps'; this.status = 'ready';
            }
          }
        }
      }
      // Sens gauche/droite : certains navigateurs (iOS) inversent le signe des capteurs.
      // On compare l'accélération latérale mesurée à celle déduite du changement de cap GPS.
      if (heading != null && Number.isFinite(heading) && v > 3) {
        const ph = this.prevHead;
        if (ph && this.fix && Math.abs(ph.t - this.fix.t) < 1e-9) {
          const dtf = ts - ph.t;
          if (dtf > 0.2 && dtf < 5 && this.f && this.latN > 0) {
            const dh = ((heading - ph.h + 540) % 360) - 180;
            const aLeft = -(v + ph.v) / 2 * (dh * Math.PI / 180) / dtf;
            if (Math.abs(aLeft) >= 0.6) {
              const m = this.latAcc / this.latN, c = this.latCal;
              c.sum += m * aLeft; c.den += Math.abs(m * aLeft); c.n++;
              if (c.n >= 3 && Math.abs(c.sum) / c.den >= 0.6) this.latSign = c.sum > 0 ? 1 : -1;
            }
          }
        }
        this.prevHead = { t: ts, h: heading, v };
      } else this.prevHead = null;
      this.fix = { t: ts, v }; this.speed = v; this.hAcc = [0, 0]; this.hN = 0; this.latAcc = 0; this.latN = 0;
    }

    _detect(kind, x, v, ts) {
      const th = CFG[kind]; let o = this.open[kind];
      if (x >= th.mod) {
        if (!o) this.open[kind] = { t0: ts, peak: x, tPeak: ts, v: v * 3.6, lead: kind === 'brake' ? this._lead(ts) : null };
        else if (x > o.peak) { o.peak = x; o.tPeak = ts; o.v = v * 3.6; }
      } else if (o && x < th.mod * CFG.hysteresis) this._close(kind, ts);
    }
    _close(kind, ts) {
      const o = this.open[kind]; if (!o) return;
      delete this.open[kind];
      if (ts - o.t0 < CFG.minEventS) return;
      const ev = { kind, t: o.tPeak, peak: o.peak, v: o.v, dur: ts - o.t0, sev: o.peak >= CFG[kind].sev ? 2 : 1 };
      if (kind === 'brake') ev.late = o.lead === null || o.lead > CFG.lateLead;
      this.events.push(ev); this.events.sort((a, b) => a.t - b.t);
    }
    /** Accélération longitudinale moyenne entre 4 s et 1,2 s avant le freinage. */
    _lead(ts) {
      const w = this.hist.filter(h => h[0] >= ts - 4 && h[0] <= ts - 1.2);
      return w.length ? w.reduce((s, h) => s + h[1], 0) / w.length : null;
    }
    _shockCheck(vh, sR, v, ts) {
      const x = Math.abs(vh), th = CFG.shock, o = this.shock, rel = Math.sign(vh) * sR;
      if (o) {
        if (x > o.peak) { o.peak = x; o.rel = rel; }
        if (ts - o.t0 >= 0.25) this._closeShock(ts);
      } else if (x >= th.mod && v >= CFG.minShockSpeed && ts - this.lastShock > CFG.shockRefractory) {
        this.shock = { t0: ts, peak: x, rel, v: v * 3.6 };
      }
    }
    _closeShock(ts) {
      const o = this.shock; if (!o) return;
      const ratio = o.rel / o.peak;
      const side = !this.f ? null : ratio > CFG.sideRatio ? 'left' : ratio < -CFG.sideRatio ? 'right' : 'both';
      this.events.push({ kind: 'shock', t: o.t0, peak: o.peak, v: o.v, dur: 0.25, sev: o.peak >= CFG.shock.sev ? 2 : 1, side });
      this.events.sort((a, b) => a.t - b.t); this.shock = null; this.lastShock = ts;
    }

    finish() { for (const k of Object.keys(this.open)) this._close(k, this.t); this._closeShock(this.t); return this.summary(); }

    summary() {
      const km = this.dist / 1000, base = Math.max(km, 2);
      const wsum = k => this.events.reduce((s, e) => e.kind === k ? s + (e.sev === 2 ? 2.5 : 1) * (e.late ? 1.4 : 1) : s, 0);
      const expo = (k, kk) => Math.round(100 * Math.exp(-(wsum(k) / base) / kk));
      const moving = this.movingS;
      const rms = this.jerkT > 5 ? Math.sqrt(this.jerkSq / this.jerkT) : null;
      const axes = {
        freinage: expo('brake', 1.2),
        virages: expo('corner', 1.2),
        acceleration: expo('accel', 1.4),
        fluidite: rms === null ? 100 : Math.round(100 * clamp(1 - (rms - 0.4) / 1.2, 0, 1))
      };
      let score = 0; for (const k in W) score += axes[k] * W[k];
      const cnt = k => this.events.filter(e => e.kind === k).length;
      return {
        score: Math.round(score), axes, km, durationS: this.t, movingS: moving,
        avgKmh: moving > 5 ? km / (moving / 3600) : 0, maxKmh: this.maxV,
        counts: { brake: cnt('brake'), accel: cnt('accel'), corner: cnt('corner'), shock: cnt('shock'), late: this.events.filter(e => e.late).length },
        jerkRms: rms
      };
    }
  }

  /* ---------- Simulateur : trajet de démonstration, téléphone orienté au hasard ---------- */
  const mulberry32 = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const TR = 1.0;
  const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const pulse = (t, p) => {
    const tau = t - p.t0; if (tau < 0 || tau > p.d) return 0;
    const tr = Math.min(TR, p.d / 2);
    return p.a * Math.min(smooth(tau / tr), smooth((p.d - tau) / tr));
  };
  // [début s, durée s, accélération m/s², brusque?]
  const LONG = [[8,10,1.5,0],[40,4,-1.5,0],[46,6,1.8,0],[75,4,1.4,0],[95,5,-1.4,0],[110,3,2.9,1],
                [150,2.6,-4.8,1],[158,8,1.2,0],[196,4,-0.8,0],[200,3,-3.2,1],[210,8,1.4,2]].map(([t0,d,a,h]) => ({t0,d,a,h}));
  const LAT = [[41,4,2.0,0],[100,3.5,-3.3,1],[120,4,1.6,0],[170,3.5,3.4,1],[204,4,2.2,0]].map(([t0,d,a,h]) => ({t0,d,a,h}));
  // Facteurs par type d'impulsion : 0 = normale, 1 = brusque, 2 = prise de vitesse.
  // Chocs : [instant s, amplitude m/s², côté] (+1 roue gauche, −1 roue droite, 0 dos d'âne : deux essieux).
  const SHOCK_ROLL = 0.4;   // rapport latéral/vertical au niveau du téléphone (hypothèse du simulateur)
  const SHOCKS = [[62, 14, 1], [133, 10, -1], [188, 16, 0], [231, 8, 1]]
    .flatMap(([t0, A, side]) => side === 0 ? [[t0, A, 0], [t0 + 0.3, 0.8 * A, 0]] : [[t0, A, side]]);
  const shockAt = t => {
    let z = 0, l = 0;
    for (const [t0, A, side] of SHOCKS) {
      const x = t - t0; if (x < 0 || x >= 0.6) continue;
      const w = A * Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * 10 * x);
      z += w; l += -side * SHOCK_ROLL * w;   // roue gauche qui monte : le haut part vers la droite (latéral < 0)
    }
    return [z, l];
  };
  // Téléphone en portrait sur la grille, penché de `tilt`°, pince décalée de `yaw`° par rapport à l'axe de la voiture.
  const ventR = (tilt = 12, yaw = 8) => {
    const th = tilt * Math.PI / 180, ps = yaw * Math.PI / 180, c = Math.cos, s = Math.sin;
    const M = [[0, -1, 0], [s(th), 0, c(th)], [-c(th), 0, s(th)]], Z = [[c(ps), -s(ps), 0], [s(ps), c(ps), 0], [0, 0, 1]];
    return M.map(row => [0, 1, 2].map(j => row[0] * Z[0][j] + row[1] * Z[1][j] + row[2] * Z[2][j]));
  };
  const STYLE = { calm: [1, 0.5, 0.75], normal: [1, 1, 1], rough: [1.1, 1.3, 1.1] };
  const scaleP = (p, k) => p.h === 1 && k < 1
    ? { t0: p.t0, d: (p.d - TR) / k + TR, a: p.a * k }   // même vitesse gagnée ou perdue, plus doucement
    : { t0: p.t0, d: p.d, a: p.a * k };
  const rot = (yaw, pitch, roll) => {
    const c = Math.cos, s = Math.sin;
    const Rz = [[c(yaw),-s(yaw),0],[s(yaw),c(yaw),0],[0,0,1]];
    const Rx = [[1,0,0],[0,c(pitch),-s(pitch)],[0,s(pitch),c(pitch)]];
    const Ry = [[c(roll),0,s(roll)],[0,1,0],[-s(roll),0,c(roll)]];
    const mm = (A, B) => A.map(row => [0,1,2].map(j => row[0]*B[0][j] + row[1]*B[1][j] + row[2]*B[2][j]));
    return mm(Rz, mm(Rx, Ry));
  };

  class Sim {
    constructor({ style = 'normal', seed = 7, mount = 'vent' } = {}) {
      this.rng = mulberry32(seed);
      const k = STYLE[style] || STYLE.normal;
      this.long = LONG.map(p => scaleP(p, k[p.h])); this.lat = LAT.map(p => scaleP(p, k[p.h]));
      this.R = mount === 'random' ? rot(2.53, -1.08, 0.12) : ventR();
      this.dt = 0.02; this.t = 0; this.v = 0; this.heading = 40; this.nextFix = 1; this.stopAt = null; this.done = false;
    }
    _n(s) { const r = this.rng; return s * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
    step() {
      const t = this.t, dt = this.dt;
      let a = 0; for (const p of this.long) a += pulse(t, p);
      if (t >= 250) a -= smooth((t - 250) / 1.5) * Math.min(1.6, 0.35 * this.v + 0.15);
      const vNew = Math.max(0, this.v + a * dt), aReal = (vNew - this.v) / dt; this.v = vNew;
      let lat = 0; for (const p of this.lat) lat += pulse(t, p);
      lat *= Math.min(1, this.v / 5);
      this.heading -= lat / Math.max(this.v, 1) * dt * 180 / Math.PI;   // virage à gauche : le cap diminue
      const m = this.v > 0.5 ? 1 : 0.1, tw = 2 * Math.PI * t;
      const vib = j => 0.22 * m * (Math.sin(tw * 11 + j) + 0.6 * Math.sin(tw * 17 + 2 * j));
      const sh = this.v > 3 ? shockAt(t) : [0, 0];
      const rv = [aReal + vib(0) + this._n(0.08), lat + vib(1.3) + this._n(0.08) + sh[1], G + vib(2.1) + this._n(0.08) + sh[0]];
      const R = this.R;
      const out = { t, ax: dot(R[0], rv), ay: dot(R[1], rv), az: dot(R[2], rv), fix: null, heading: null, tf: t + dt };
      this.t += dt;
      if (this.t >= this.nextFix) { this.nextFix += 1; out.fix = Math.max(0, this.v + this._n(0.12)); out.heading = ((this.heading + this._n(0.8)) % 360 + 360) % 360; }
      if (this.t > 252 && this.v < 0.02) { if (this.stopAt === null) this.stopAt = this.t; if (this.t - this.stopAt >= 5) this.done = true; }
      return out;
    }
    get progress() { return Math.min(1, this.t / 270); }
  }

  /* ---------- Import CSV : t, ax, ay, az, speed ---------- */
  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const split = l => l.split(delim).map(s => s.trim().replace(/^"|"$/g, ''));
    let idx = { t: 0, ax: 1, ay: 2, az: 3, speed: 4, heading: -1 }, start = 0;
    const head = split(lines[0]);
    if (head.some(h => /[a-z]/i.test(h))) {
      start = 1;
      const find = names => head.findIndex(h => names.includes(h.toLowerCase().replace(/[^a-z]/g, '')));
      const f = { t: find(['t','time','timestamp','seconds']), ax: find(['ax','x']), ay: find(['ay','y']),
                  az: find(['az','z']), speed: find(['speed','v','vitesse']), heading: find(['heading','bearing','course','cap']) };
      for (const k in f) if (f[k] >= 0) idx[k] = f[k]; else if (k !== 'speed') idx[k] = idx[k];
      if (f.speed < 0) idx.speed = -1;
    }
    const num = s => { if (s === undefined || s === '') return null; const x = parseFloat(delim === ';' ? s.replace(',', '.') : s); return Number.isFinite(x) ? x : null; };
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const c = split(lines[i]);
      const t = num(c[idx.t]), ax = num(c[idx.ax]), ay = num(c[idx.ay]), az = num(c[idx.az]);
      if (t === null || ax === null || ay === null || az === null) continue;
      rows.push({ t, ax, ay, az, speed: idx.speed >= 0 ? num(c[idx.speed]) : null, heading: idx.heading >= 0 ? num(c[idx.heading]) : null });
    }
    if (rows.length > 3) {
      const ds = []; for (let i = 1; i < Math.min(rows.length, 200); i++) ds.push(rows[i].t - rows[i-1].t);
      ds.sort((a, b) => a - b); const med = ds[ds.length >> 1];
      const sc = med > 5e5 ? 1e-9 : med > 0.5 ? 1e-3 : 1;
      if (sc !== 1) for (const r of rows) r.t *= sc;
    }
    return rows;
  }
  function analyzeRows(rows, mount) {
    const e = new Engine({ mount });
    for (const r of rows) { e.pushMotion(r.t, r.ax, r.ay, r.az); if (r.speed !== null) e.pushFix(r.t, r.speed, r.heading); }
    e.finish(); return e;
  }
  function runSim(style, seed, mount = 'vent') {
    const e = new Engine({ mount }), s = new Sim({ style, seed, mount: mount === 'free' ? 'random' : 'vent' });
    while (!s.done) { const o = s.step(); e.pushMotion(o.t, o.ax, o.ay, o.az); if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading); }
    e.finish(); return e;
  }
  return { Engine, Sim, CFG, parseCsv, analyzeRows, runSim, rot, ventR, dot };
})();
if (typeof module !== 'undefined') module.exports = PL;
