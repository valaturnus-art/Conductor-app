/* Pied Léger — moteur d'analyse de conduite (pur, sans DOM). v2 : exigeant, gyroscope, volant, passages de vitesse. */
const PL = (() => {
  'use strict';
  const G = 9.81, D2R = Math.PI / 180;
  const CFG = {
    // Seuils d'événements (m/s²). La télématique signale le freinage brusque dès 0,3 g et considère < 0,2 g normal :
    // on est volontairement plus strict (0,25 g / 0,2 g / 0,25 g).
    brake:  { mod: 2.5, sev: 4.0 },
    accel:  { mod: 2.0, sev: 3.2 },
    corner: { mod: 2.5, sev: 4.0 },
    ring:   { warn: 2.5, bad: 4.0 },   // repères du disque en direct
    shock:  { mod: 2.5, sev: 5, noiseK: 6 },   // choc vertical (nid-de-poule, dos-d'âne) ; seuil = max(mod, noiseK × bruit de fond)
    bump:   { fastKmh: 30, peak: 4 },
    shockRefractory: 1.0, minShockSpeed: 3, shockHz: 12,
    rollGain: 2.5, rollHz: 6, sideRatio: 0.15,
    lateLead: -0.5,                    // freinage « tardif » : on ne décélérait pas déjà 1,2 à 4 s avant
    minEventS: 0.3, minCornerSpeed: 3, stopSpeed: 0.5, movingSpeed: 1,
    smoothHz: 3, fastHz: 4, hysteresis: 0.7,   // lissage : 3 filtres de 3 Hz (≈ 1,5 Hz) pour l'affichage ET la détection ; 4 Hz (2 filtres) pour volant et vitesses
    gaugeDead: 0.7, gaugeDecay: 0.35,
    // Coup de volant : aller-retour latéral rapide (≥ 1,3 m/s² de chaque côté en moins de 2,2 s).
    swerve: { amp: 1.3, minSpeed: 8, maxGap: 2.2, jerkMod: 2.6, jerkSev: 6 },
    // Redressement : dérive lente (≥ 0,35 °/s) puis correction vive en sens inverse (≥ 5 °/s, < 1,6 s) : inattention.
    fix: { spike: 5, sev: 9, quiet: 2.6, drift: 0.3, agree: 0.7, minSpeed: 8, end: 2.5, maxDur: 1.6 },
    // Passage de vitesse : creux d'accélération en phase d'accélération (rupture de couple), puis reprise.
    shift: { minDepth: 0.8, preMin: 0.7, open: 0.4, recover: 0.3, maxFall: 1.0, maxDip: 2.0, harsh: 1.0, sev: 1.9, slope: 5, slopeSev: 9, reb: 0.9 },
    minKm: 3,
    phaseMin: 0.8, phaseTime: 8,
    // Intensité : percentile 90 de l'effort quand on freine / accélère / tourne (100 sous a, 0 au-delà de b).
    inten: { brake: [1.6, 4.0], accel: [1.2, 2.8], corner: [1.5, 3.6] },
    jerk: [0.4, 1.5], steer: [0.5, 1.8]
  };
  // Pondération des axes ; le score final mélange la moyenne et le plus faible axe (un point noir pèse).
  const W = { freinage: .24, acceleration: .16, virages: .20, trajectoire: .20, fluidite: .20 };
  const AXIS_K = { freinage: 1.7, acceleration: 1.7, virages: 1.7, trajectoire: 1.3 };

  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const unit = a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/n, a[1]/n, a[2]/n]; };
  const madd = (a, s, b) => [a[0]+s*b[0], a[1]+s*b[1], a[2]+s*b[2]];
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const lin = (x, a, b) => clamp((b - x) / (b - a), 0, 1);   // 1 sous a, 0 au-delà de b
  const fin = x => x !== null && x !== undefined && Number.isFinite(x);
  const BIN = 0.1, NB = 81;

  class Engine {
    constructor(opts = {}) { this.mount = opts.mount === 'vent' ? 'vent' : 'free'; this.reset(); }

    reset() {
      this.t0 = null; this.tPrev = null; this.t = 0;
      this.g = null; this.gBuf = []; this.gCal = null;
      this.speed = null; this.fix = null; this.dist = 0;
      this.movingS = 0; this.maxV = 0; this.moveStart = null;
      this.basis = null; this.f = null;
      this.cal = { n: 0, sx: 0, sy: 0, den: 0 };
      this.hAcc = [0, 0]; this.hN = 0;
      this.sm = [0, 0, 0, 0, 0, 0];
      this.aLong = 0; this.aLat = 0;
      this.open = {}; this.events = []; this.evSeq = 0; this.lastEvent = null;
      this.series = []; this.nextSeriesT = 0;
      this.trail = []; this.nextTrailT = 0; this.hist = []; this.nextTickT = 0;
      this.vz = 0; this.shock = null; this.lastShock = -9;
      this.rs = 1; this.ventOk = false; this.fSource = null;
      this.vh = 0; this.vzSlow = 0; this.lz = 0; this.lzSlow = 0; this.zL = 0; this.zR = 0; this.pk = [0, 0]; this.vNoise = 0.3; this.latLearned = false; this.gapS = 0; this.lastMotionT = null;
      this.fxQ = null; this.shocks = 0;
      this.fd = [0, 0, 0, 0]; this.dLong = 0; this.dLat = 0; this.fLong = 0; this.fLat = 0; this.liveMag = 0;
      this.latSign = 1; this.latAcc = 0; this.latN = 0; this.latCal = { sum: 0, den: 0, n: 0 }; this.prevHead = null;
      this.tickT = null; this.prevA = [0, 0]; this.jerkSq = 0; this.jerkT = 0;
      this.recalCount = 0;
      // Gyroscope : cap de la voiture (lacet), volant, redressements
      this.gyroOn = false; this.bias = 0; this.ySign = 1; this.ySum = 0; this.yF = 0; this.yawSlow = 0; this.yaw = 0; this.yawD = 0;
      this.ybuf = []; this.fx = null; this.fxLast = -9;
      this.steerSq = 0; this.steerT = 0;
      // Segments latéraux (coups de volant), creux d'accélération (passages de vitesse)
      this.sg = null; this.sgPrev = null; this.mute = null; this.lastCurveT = -9;
      this.dip = null; this.shiftPend = null; this.shiftN = 0;
      // Histogrammes d'effort (pondérés par le temps) pour l'intensité du freinage, de l'accélération, des virages
      this.bins = { brake: new Float32Array(NB), accel: new Float32Array(NB), corner: new Float32Array(NB) };
      this.phaseT = { brake: 0, accel: 0, corner: 0 };
      this.lastBadT = 0; this.bestStreak = 0;
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

    /** Oublie l'orientation : le calage se refait à la prochaine accélération en ligne droite. */
    recalibrate() {
      if (!this.g) return;
      this.f = null; this.fSource = null; this.basis = null; this.open = {}; this.sg = null; this.sgPrev = null; this.dip = null; this.fx = null;
      this.gCal = unit(this.g); this.status = 'calibrating'; this.recalCount++;
    }

    /** Accéléromètre gravité incluse (m/s²) ; gx, gy, gz : gyroscope (°/s, axes de l'appareil), facultatif. t en s. */
    pushMotion(t, ax, ay, az, gx, gy, gz) {
      if (this.t0 === null) this.t0 = t;
      const ts = t - this.t0;
      const dt = this.tPrev === null ? 0.02 : clamp(t - this.tPrev, 0.001, 0.2);
      if (this.tPrev !== null && t - this.tPrev > 0.5) this.gapS += t - this.tPrev;   // capteurs interrompus (écran verrouillé…)
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
      // À l'arrêt, la gravité se met à jour vite, mais seulement si le téléphone est calme.
      const stopped = this.speed !== null && this.speed < CFG.stopSpeed;
      const dev = Math.hypot(r[0] - this.g[0], r[1] - this.g[1], r[2] - this.g[2]);
      let tau = 300;
      if (stopped) {
        if (dev <= 0.35) { this.devT = 0; tau = 1; }
        else { this.devT = (this.devT || 0) + dt; tau = this.devT > 2 ? 0.5 : Infinity; }
      } else this.devT = 0;
      const kg = tau === Infinity ? 0 : 1 - Math.exp(-dt / tau);
      for (let i = 0; i < 3; i++) this.g[i] += (r[i] - this.g[i]) * kg;
      const u = unit(this.g);

      // Téléphone déplacé : on oublie l'axe avant et on recalibre.
      if (this.f && dot(u, this.gCal) < 0.94) {
        this.f = null; this.fSource = null; this.basis = null; this.gCal = u; this.open = {}; this.sg = null; this.sgPrev = null; this.dip = null; this.fx = null;
        this.status = 'calibrating'; this.recalCount++;
        if (this.ventOk) this._applyPrior(u);
      }
      if (!this.basis || dot(u, this.basis.u) < 0.996) this._newBasis(u);

      // 2. Accélération linéaire et projection sur les axes du véhicule.
      const li = [r[0]-this.g[0], r[1]-this.g[1], r[2]-this.g[2]];
      if (this.basis) { this.hAcc[0] += dot(li, this.basis.e1); this.hAcc[1] += dot(li, this.basis.e2); this.hN++; }
      let aL = 0, aT = 0;
      if (this.f) {
        const fp = unit(madd(this.f, -dot(this.f, u), u));
        aL = dot(li, fp); aT = dot(li, cross(u, fp));
      }
      if (this.f) { this.latAcc += aT; this.latN++; }
      const aTs = aT * this.latSign;                 // + = le véhicule accélère vers la gauche
      // Signal « voiture » : 3 filtres en cascade. C'est LE signal affiché ET celui qui déclenche les événements :
      // ce que le conducteur voit en direct est exactement ce qui est enregistré. Les vibrations moteur disparaissent.
      const al = 1 - Math.exp(-2 * Math.PI * CFG.smoothHz * dt), M = this.sm;
      M[0] += al * (aL - M[0]); M[1] += al * (M[0] - M[1]); M[2] += al * (M[1] - M[2]);
      M[3] += al * (aTs - M[3]); M[4] += al * (M[3] - M[4]); M[5] += al * (M[4] - M[5]);
      this.aLong = this.dLong = M[2]; this.aLat = this.dLat = M[5];
      // Signal plus vif (2 filtres, 4 Hz) pour les gestes courts : coups de volant et passages de vitesse.
      const ad = 1 - Math.exp(-2 * Math.PI * CFG.fastHz * dt), D = this.fd;
      D[0] += ad * (aL - D[0]); D[1] += ad * (D[0] - D[1]);
      D[2] += ad * (aTs - D[2]); D[3] += ad * (D[2] - D[3]);
      this.fLong = D[1]; this.fLat = D[3];
      const hm = Math.sqrt(Math.max(0, dot(li, li) - dot(li, u) ** 2));
      this.liveMag += (hm - this.liveMag) * (1 - Math.exp(-dt / 0.3));

      // 3. Temps cumulés selon la vitesse GPS.
      const v = this.speed;
      if (v !== null) {
        const kmh = v * 3.6;
        if (v > CFG.movingSpeed) { this.movingS += dt; if (this.moveStart === null) { this.moveStart = ts; this.lastBadT = ts; } }
        if (kmh > this.maxV) this.maxV = kmh;
      }

      // 4. Gyroscope : vitesse de lacet (volant). Signe appris en comparant au latéral, biais estimé à l'arrêt.
      if (fin(gx) && fin(gy) && fin(gz)) {
        this.gyroOn = true;
        const yr = dot([gx * D2R, gy * D2R, gz * D2R], u);
        if (stopped) this.bias += (yr - this.bias) * (1 - Math.exp(-dt / 2));
        else if (v !== null && v > 8 && Math.abs(yr - this.bias) < 0.025) this.bias += (yr - this.bias) * (1 - Math.exp(-dt / 40));
        const y = yr - this.bias;
        if (this.f && v !== null && v > 4 && Math.abs(this.aLat) > 0.8) this.ySum += y * this.aLat * dt;
        this.ySign = this.ySum < 0 ? -1 : 1;
        const yc = this.ySign * y;                                  // + = la voiture tourne à gauche
        this.yF += (yc - this.yF) * (1 - Math.exp(-2 * Math.PI * 2.5 * dt));
        this.yawD += (yc - this.yawD) * (1 - Math.exp(-2 * Math.PI * 4 * dt));
        this.yaw = this.yawD / D2R;                                 // °/s, pour l'affichage
        this.yawSlow += (this.yF - this.yawSlow) * (1 - Math.exp(-dt / 3));
        if (Math.abs(this.aLat) >= 0.9) this.lastCurveT = ts;
        if (v !== null && v >= CFG.swerve.minSpeed && ts - this.lastCurveT > 2.5) {
          const hp = (this.yF - this.yawSlow) / D2R; this.steerSq += hp * hp * dt; this.steerT += dt;
        }
      }

      // 5. Chocs de chaussée : vertical et latéral peu filtrés (12 Hz), sans la composante lente.
      const ks = 1 - Math.exp(-2 * Math.PI * CFG.shockHz * dt);
      this.vz += (dot(li, u) - this.vz) * ks;
      this.vzSlow += (this.vz - this.vzSlow) * (1 - Math.exp(-dt / 1.5));
      this.vh = this.vz - this.vzSlow;
      this.lz += (aTs - this.lz) * (1 - Math.exp(-2 * Math.PI * CFG.rollHz * dt));
      this.lzSlow += (this.lz - this.lzSlow) * (1 - Math.exp(-dt / 0.8));
      const sR = -(this.lz - this.lzSlow);   // + : vers la droite
      // Jauge : zone morte (vibrations du moteur et du revêtement) puis retombée douce, pour lire les chocs et pas le bruit.
      const dz = x => Math.sign(x) * Math.max(0, Math.abs(x) - CFG.gaugeDead), dc = Math.exp(-dt / CFG.gaugeDecay);
      const zl = dz(0.5 * (this.vh + CFG.rollGain * sR)), zr = dz(0.5 * (this.vh - CFG.rollGain * sR));
      this.zL = Math.abs(zl) >= Math.abs(this.zL) ? zl : this.zL * dc; this.zR = Math.abs(zr) >= Math.abs(this.zR) ? zr : this.zR * dc;
      const dk = Math.exp(-dt / 2.5);
      this.pk[0] = Math.max(this.pk[0] * dk, Math.abs(this.zL)); this.pk[1] = Math.max(this.pk[1] * dk, Math.abs(this.zR));
      // Bruit de fond du revêtement : un choc doit nettement le dépasser (route pavée = seuil plus haut).
      if (!this.shock) this.vNoise += (Math.min(Math.abs(this.vh), 2) - this.vNoise) * (1 - Math.exp(-dt / 8));
      if (v !== null) this._shockCheck(this.vh, sR, v, ts);

      // 6. Événements de conduite.
      if (this.f && v !== null) {
        this._detect('brake', -this.aLong, v, ts);
        this._detect('accel', this.aLong, v, ts);
        if (v >= CFG.minCornerSpeed) this._detect('corner', Math.abs(this.aLat), v, ts);
        else this._close('corner', ts);
        this._swerve(this.fLat, v, ts);
        // Intensité : temps passé à chaque niveau d'effort quand on freine / accélère / tourne.
        const hp = CFG.phaseMin;
        if (v > 1.5 && -this.aLong >= hp) this._bin('brake', -this.aLong, dt);
        if (v > 1.5 && this.aLong >= hp) this._bin('accel', this.aLong, dt);
        if (v >= CFG.minCornerSpeed && Math.abs(this.aLat) >= hp) this._bin('corner', Math.abs(this.aLat), dt);
      }

      // 7. Séries et mémoire courte à 10 Hz ; fluidité (à-coups à 2 Hz).
      if (ts >= this.nextSeriesT) { this.series.push({ t: Math.round(ts), v: (v || 0) * 3.6 }); this.nextSeriesT = ts + 1; }
      if (ts >= this.nextTrailT) {
        this.trail.push([this.dLat, this.dLong]); if (this.trail.length > 40) this.trail.shift();
        this.hist.push([ts, this.aLong, this.fLong]); if (this.hist.length > 60) this.hist.shift();
        this.ybuf.push([ts, this.yF / D2R]); if (this.ybuf.length > 50) this.ybuf.shift();
        this.nextTrailT = ts + 0.1;
        if (this.f && v !== null) { this._tickShift(ts, v); this._tickFix(ts, v); }
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
              if (c.n >= 3 && Math.abs(c.sum) / c.den >= 0.6) { this.latSign = c.sum > 0 ? 1 : -1; this.latLearned = true; }
            }
          }
        }
        this.prevHead = { t: ts, h: heading, v };
      } else this.prevHead = null;
      this.fix = { t: ts, v }; this.speed = v; this.hAcc = [0, 0]; this.hN = 0; this.latAcc = 0; this.latN = 0;
    }

    _bin(k, x, dt) { this.bins[k][Math.min(NB - 1, Math.floor(x / BIN))] += dt; this.phaseT[k] += dt; }
    _p90(k) {
      const tot = this.phaseT[k]; if (tot < CFG.phaseTime) return null;
      let c = 0; const b = this.bins[k];
      for (let i = 0; i < NB; i++) { c += b[i]; if (c >= 0.9 * tot) return (i + 0.5) * BIN; }
      return NB * BIN;
    }
    _bad(ts) { this.bestStreak = Math.max(this.bestStreak, ts - this.lastBadT); this.lastBadT = ts; }
    _push(ev, scoring) {
      this.events.push(ev); this.events.sort((a, b) => a.t - b.t);
      if (ev.kind === 'shock') this.shocks++;
      this.evSeq++; this.lastEvent = ev;
      if (scoring) this._bad(this.t);
    }
    /** Temps écoulé depuis le dernier événement qui compte (série « fluide »). */
    get streak() { return this.moveStart === null ? 0 : Math.max(0, this.t - this.lastBadT); }

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
      // Un virage pris dans un coup de volant reste dans l'historique (jamais supprimé) mais ne pèse que moitié.
      if (kind === 'corner' && this.mute && o.tPeak >= this.mute[0] && o.tPeak <= this.mute[1]) ev.part = true;
      // Deux creux séparés de moins d'une seconde sont le même geste : on prolonge l'événement déjà annoncé.
      const prev = this.lastOf && this.lastOf[kind];
      if (prev && o.t0 - prev.end < 1.0) {
        if (ev.peak > prev.peak) { prev.peak = ev.peak; prev.v = ev.v; prev.sev = Math.max(prev.sev, ev.sev); }
        prev.end = ts; prev.dur = ts - prev.t0; return;
      }
      ev.t0 = o.t0; ev.end = ts;
      (this.lastOf || (this.lastOf = {}))[kind] = ev;
      if (kind === 'brake') ev.late = o.lead === null || o.lead > CFG.lateLead;
      this._push(ev, true);
    }
    /** Accélération longitudinale moyenne entre 4 s et 1,2 s avant le freinage. */
    _lead(ts) {
      const w = this.hist.filter(h => h[0] >= ts - 4 && h[0] <= ts - 1.2);
      return w.length ? w.reduce((s, h) => s + h[1], 0) / w.length : null;
    }

    /** Coup de volant : un pic latéral puis un pic de signe opposé moins de 2,2 s plus tard, avec un fort à-coup. */
    _swerve(x, v, ts) {
      const ax = Math.abs(x), sgn = Math.sign(x), s = this.sg;
      if (s && (sgn !== s.sign || ax < 0.35)) { this._endSeg(s); this.sg = null; }
      if (!this.sg) { if (ax >= 0.35) this.sg = { sign: sgn, peak: ax, tPeak: ts, v }; }
      else if (ax > this.sg.peak) { this.sg.peak = ax; this.sg.tPeak = ts; this.sg.v = v; }
    }
    _endSeg(s) {
      const C = CFG.swerve;
      if (s.peak < C.amp || s.v < C.minSpeed) return;
      const p = this.sgPrev; this.sgPrev = s;
      if (!p || p.sign !== -s.sign || s.tPeak - p.tPeak > C.maxGap) return;
      const gap = Math.max(0.3, s.tPeak - p.tPeak), jerk = (p.peak + s.peak) / gap;
      if (jerk < C.jerkMod) return;
      const lo = p.tPeak - 1.5, hi = s.tPeak + 1.5;
      for (const e of this.events) if (e.kind === 'corner' && e.t >= lo && e.t <= hi) e.part = true;
      if (this.fxQ && this.fxQ.t >= lo && this.fxQ.t <= hi) this.fxQ = null;   // le « redressement » faisait partie du coup de volant
      this.mute = [lo, hi];
      this._push({ kind: 'swerve', t: (p.tPeak + s.tPeak) / 2, peak: Math.min(p.peak, s.peak), jerk, v: s.v * 3.6, dur: gap, sev: jerk >= C.jerkSev ? 2 : 1 }, true);
      this.sgPrev = null;
    }

    /** Redressement : la voiture dérivait doucement, puis le conducteur corrige d'un coup (inattention). */
    _tickFix(ts, v) {
      const C = CFG.fix;
      if (this.fxQ && ts >= this.fxQ.due) { const q = this.fxQ; this.fxQ = null; this._push(q, true); }
      if (!this.gyroOn || v < C.minSpeed) { this.fx = null; return; }
      const y = this.yF / D2R, o = this.fx;
      if (o) {
        const same = Math.sign(y) === o.sign;
        if (same && Math.abs(y) > o.peak) { o.peak = Math.abs(y); o.tPk = ts; }
        const dur = ts - o.t0;
        if (Math.abs(y) < C.end || !same) {
          if (dur <= C.maxDur) this.fxQ = { kind: 'fix', t: o.tPk, peak: o.peak, drift: o.drift, v: o.v, dur, sev: o.peak >= C.sev ? 2 : 1, due: ts + 3 };
          this.fx = null; this.fxLast = ts;
        } else if (dur > C.maxDur) { this.fx = null; this.fxLast = ts; }   // un vrai virage, pas un redressement
        return;
      }
      if (Math.abs(y) < C.spike || ts - this.fxLast < 2.5) return;
      const w = this.ybuf.filter(b => b[0] >= ts - 3.5 && b[0] <= ts - 0.8);
      if (w.length < 20) return;
      const sgn = Math.sign(y); let m = 0, mx = 0, agree = 0;
      for (const b of w) { m += b[1]; mx = Math.max(mx, Math.abs(b[1])); if (Math.sign(b[1]) === -sgn) agree++; }
      m /= w.length; agree /= w.length;
      if (mx <= C.quiet && Math.sign(m) === -sgn && Math.abs(m) >= C.drift && agree >= C.agree) this.fx = { t0: ts, sign: sgn, peak: Math.abs(y), tPk: ts, drift: Math.abs(m), v: v * 3.6 };
    }

    /** Passage de vitesse : creux de l'accélération en pleine accélération, puis reprise. Profondeur et à-coup = brusquerie. */
    _tickShift(ts, v) {
      const C = CFG.shift, cur = this.fLong, h = this.hist;
      const pend = this.shiftPend;
      if (pend) {
        pend.rebMax = Math.max(pend.rebMax, cur);
        if (ts >= pend.rebT) { this.shiftPend = null; this._endShift(pend); }
      }
      const o = this.dip;
      if (o) {
        o.maxSlope = Math.max(o.maxSlope, Math.abs(cur - o.prevC) / 0.1); o.prevC = cur;
        if (cur < o.min) { o.min = cur; o.tMin = ts; }
        if (cur >= o.pre - C.recover) {
          if (o.tMin - o.t0 <= C.maxFall && ts - o.t0 <= C.maxDip && !this.shiftPend) { o.rebMax = cur; o.rebT = ts + 0.5; this.shiftPend = o; }
          this.dip = null;
        } else if (ts - o.t0 > C.maxDip) this.dip = null;
        return;
      }
      if (v < 2) return;
      const w = h.filter(b => b[0] >= ts - 3.2 && b[0] <= ts - 1.0);
      if (w.length < 12) return;
      let pre = 0, mn = Infinity; for (const b of w) { pre += b[2]; mn = Math.min(mn, b[2]); }
      pre /= w.length;
      if (pre < C.preMin || mn < C.preMin * 0.5) return;
      const prev = h.length > 1 ? h[h.length - 2][2] : cur;
      if (cur <= pre - C.open && cur < prev) this.dip = { t0: ts, pre, min: cur, tMin: ts, prevC: cur, maxSlope: 0, v: v * 3.6 };
    }
    _endShift(o) {
      const C = CFG.shift, depth = o.pre - o.min, reb = Math.max(0, o.rebMax - o.pre);
      this.shiftN++;
      const sev = depth < C.minDepth ? 0 : depth >= C.sev || o.maxSlope >= C.slopeSev ? 2 : depth >= C.harsh || o.maxSlope >= C.slope || reb >= C.reb ? 1 : 0;
      if (sev) this._push({ kind: 'shift', t: o.tMin, peak: depth, jerk: o.maxSlope, reb, v: o.v, dur: o.rebT - o.t0, sev }, true);
    }

    _shockCheck(vh, sR, v, ts) {
      const x = Math.abs(vh), th = CFG.shock, o = this.shock, rel = Math.sign(vh) * sR;
      if (o) {
        if (x > o.peak) { o.peak = x; o.rel = rel; }
        if (ts - o.t0 >= 0.25) this._closeShock(ts);
      } else if (x >= Math.max(th.mod, th.noiseK * this.vNoise) && v >= CFG.minShockSpeed && ts - this.lastShock > CFG.shockRefractory) {
        this.shock = { t0: ts, peak: x, rel, v: v * 3.6 };
      }
    }
    _closeShock(ts) {
      const o = this.shock; if (!o) return;
      const ratio = o.rel / o.peak;
      const side = !this.f ? null : Math.abs(ratio) <= CFG.sideRatio ? 'both' : !this.latLearned && this.mount !== 'vent' ? 'one' : ratio > 0 ? 'left' : 'right';
      // Un dos-d'âne franchi trop vite est un défaut d'anticipation du conducteur ; un nid-de-poule, non.
      const fast = side === 'both' && o.v >= CFG.bump.fastKmh && o.peak >= CFG.bump.peak;
      this._push({ kind: 'shock', t: o.t0, peak: o.peak, v: o.v, dur: 0.25, sev: o.peak >= CFG.shock.sev ? 2 : 1, side, fast }, fast);
      this.shock = null; this.lastShock = ts;
    }

    finish() {
      for (const k of Object.keys(this.open)) this._close(k, this.t);
      if (this.sg) { this._endSeg(this.sg); this.sg = null; }
      if (this.fxQ) { const q = this.fxQ; this.fxQ = null; this._push(q, true); }
      if (this.shiftPend) { const p = this.shiftPend; this.shiftPend = null; this._endShift(p); }
      this._closeShock(this.t);
      return this.summary();
    }

    summary() {
      const km = this.dist / 1000, base = Math.max(km, CFG.minKm);
      const wt = e => e.kind === 'shock' ? 1 : (e.sev === 2 ? 2 : 1) * (e.late ? 1.4 : 1) * (e.part ? 0.5 : 1);
      const wsum = f => this.events.reduce((s, e) => f(e) ? s + wt(e) : s, 0);
      const expo = (w, k) => 100 * Math.exp(-(w / base) / k);
      const inten = (k) => { const p = this._p90(k); return p === null ? null : 100 * lin(p, CFG.inten[k][0], CFG.inten[k][1]); };
      const mix = (E, I) => Math.round(I === null ? E : 0.6 * E + 0.4 * I);
      const cnt = f => this.events.filter(f).length;
      const rms = this.jerkT > 5 ? Math.sqrt(this.jerkSq / this.jerkT) : null;
      const steerRms = this.gyroOn && this.steerT > 20 ? Math.sqrt(this.steerSq / this.steerT) : null;
      const nShift = this.shiftN, shiftW = wsum(e => e.kind === 'shift');
      const Sh = nShift >= 2 ? 100 * Math.exp(-(shiftW / nShift) / 0.6) : null;
      const J = rms === null ? 100 : 100 * lin(rms, CFG.jerk[0], CFG.jerk[1]);
      const Rv = steerRms === null ? null : 100 * lin(steerRms, CFG.steer[0], CFG.steer[1]);
      const axes = {
        freinage: mix(expo(wsum(e => e.kind === 'brake' || (e.kind === 'shock' && e.fast)), AXIS_K.freinage), inten('brake')),
        acceleration: mix(expo(wsum(e => e.kind === 'accel'), AXIS_K.acceleration), inten('accel')),
        virages: mix(expo(wsum(e => e.kind === 'corner'), AXIS_K.virages), inten('corner')),
        trajectoire: mix(expo(wsum(e => e.kind === 'swerve' || e.kind === 'fix'), AXIS_K.trajectoire), Rv),
        fluidite: Math.round(Sh === null ? J : 0.65 * J + 0.35 * Sh)
      };
      let wm = 0, mn = 100; for (const k in W) { wm += axes[k] * W[k]; mn = Math.min(mn, axes[k]); }
      const score = Math.round(0.7 * wm + 0.3 * mn);
      const moving = this.movingS;
      return {
        score, axes, km, durationS: this.t, movingS: moving,
        avgKmh: moving > 5 ? km / (moving / 3600) : 0, maxKmh: this.maxV,
        counts: {
          brake: cnt(e => e.kind === 'brake'), late: cnt(e => e.late), accel: cnt(e => e.kind === 'accel'), corner: cnt(e => e.kind === 'corner'),
          swerve: cnt(e => e.kind === 'swerve'), fix: cnt(e => e.kind === 'fix'), shift: nShift, shiftHarsh: cnt(e => e.kind === 'shift'),
          shock: cnt(e => e.kind === 'shock'), fast: cnt(e => e.fast)
        },
        jerkRms: rms, steerRms, gyro: this.gyroOn, coverage: this.t > 5 ? clamp(1 - this.gapS / this.t, 0, 1) : 1,
        streakBest: Math.max(this.bestStreak, this.moveStart === null ? 0 : this.t - this.lastBadT),
        p90: { brake: this._p90('brake'), accel: this._p90('accel'), corner: this._p90('corner') }
      };
    }
  }

  /* ---------- Simulateur : trajet de démonstration (téléphone sur la grille ou posé au hasard) ---------- */
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
                [150,2.6,-4.8,1],[158,8,1.2,0],[177,11,-1.5,3],[189,7,1.2,3],[196,4,-0.8,0],[200,3,-3.2,1],[210,8,1.4,2]].map(([t0,d,a,h]) => ({t0,d,a,h}));
  const LAT = [[41,4,2.0,0],[100,3.5,-3.3,1],[120,4,1.6,0],[170,3.5,3.4,1],[204,4,2.2,0]].map(([t0,d,a,h]) => ({t0,d,a,h}));
  // Facteurs par type d'impulsion : 0 = normale, 1 = brusque, 2 = prise de vitesse.
  // Chocs : [instant s, amplitude m/s², côté] (+1 roue gauche, −1 roue droite, 0 dos d'âne : deux essieux).
  const SHOCK_ROLL = 0.4;
  const SHOCKS = [[62, 8, 1], [133, 6, -1], [188, 9, 0], [231, 2.5, 1]]
    .flatMap(([t0, A, side]) => side === 0 ? [[t0, A, 0], [t0 + 0.3, 0.8 * A, 0]] : [[t0, A, side]]);
  const shockAt = t => {
    let z = 0, l = 0;
    for (const [t0, A, side] of SHOCKS) {
      const x = t - t0; if (x < 0 || x >= 0.6) continue;
      const w = A * Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * 10 * x);
      z += w; l += -side * SHOCK_ROLL * w;
    }
    return [z, l];
  };
  // Passages de vitesse (boîte manuelle) : [instant s]. Profondeur du creux, durée, rampe, rebond selon le style.
  const SHIFTS = [12.5, 16.2, 49, 111.8, 161, 164.5, 213, 216.5];
  const SHIFT_STYLE = { calm: { depth: 0.5, d: 0.55, ramp: 0.4, reb: 0 }, normal: { depth: 1.0, d: 0.6, ramp: 0.3, reb: 0.25 }, rough: { depth: 2.4, d: 0.55, ramp: 0.12, reb: 1.0 } };
const SHIFT_K = [0.8, 1.3, 0.8, 1.0, 1.3, 0.8, 0.8, 1.0];   // les passages ne se ressemblent pas tous
  const shiftAt = (t, S) => {
    let a = 0;
    for (let i = 0; i < SHIFTS.length; i++) {
      const t0 = SHIFTS[i], x = t - t0, k = SHIFT_K[i]; if (x < 0 || x > S.d + 2 * S.ramp + 0.5) continue;
      const e = Math.min(smooth(x / S.ramp), smooth((S.d + S.ramp - x) / S.ramp));
      a -= k * S.depth * Math.max(0, e);
      const y = x - (S.d + S.ramp); if (y >= 0 && y < 0.3) a += k * S.reb * Math.sin(Math.PI * y / 0.3);
    }
    return a;
  };
  // Coups de volant : un aller-retour latéral (sinus complet). Redressements : dérive lente puis correction vive.
  const SWERVES = [[88, 'calm'], [236, 'rough']];
  const SWERVE_STYLE = { calm: { A: 1.0, T: 4.0 }, normal: { A: 2.7, T: 3.2 }, rough: { A: 4.2, T: 2.4 } };
  const FIXES = [[140, 'normal'], [225, 'normal']];
  const FIX_STYLE = { calm: null, normal: { drift: -0.28, spike: 1.7 }, rough: { drift: -0.35, spike: 2.4 } };
  const wander = (t, A, ph) => A * D2R * (Math.sin(2 * Math.PI * t / 6.3 + ph[0]) + 0.6 * Math.sin(2 * Math.PI * t / 9.7 + ph[1]));
  const swerveAt = (t, S, style) => {
    let l = 0;
    for (const [t0, min] of SWERVES) {
      if (min === 'rough' && style !== 'rough') continue;
      const x = t - t0, P = style === 'rough' && min === 'rough' ? { A: 3.5, T: 2.6 } : S; if (x < 0 || x > P.T) continue;
      l += P.A * Math.sin(2 * Math.PI * x / P.T);
    }
    return l;
  };
  const fixAt = (t, F) => {
    let l = 0; if (!F) return 0;
    for (const [t0] of FIXES) {
      if (t >= t0 - 2.6 && t < t0) l += F.drift * smooth((t - (t0 - 2.6)) / 0.6);
      const x = t - t0; if (x >= 0 && x < 0.7) l += F.spike * Math.sin(Math.PI * x / 0.7);
    }
    return l;
  };
  // Téléphone en portrait sur la grille, penché de `tilt`°, pince décalée de `yaw`° par rapport à l'axe de la voiture.
  const ventR = (tilt = 12, yaw = 8) => {
    const th = tilt * Math.PI / 180, ps = yaw * Math.PI / 180, c = Math.cos, s = Math.sin;
    const M = [[0, -1, 0], [s(th), 0, c(th)], [-c(th), 0, s(th)]], Z = [[c(ps), -s(ps), 0], [s(ps), c(ps), 0], [0, 0, 1]];
    return M.map(row => [0, 1, 2].map(j => row[0] * Z[0][j] + row[1] * Z[1][j] + row[2] * Z[2][j]));
  };
  const STYLE = { calm: [1, 0.45, 0.75, 1], normal: [1, 1, 1, 1], rough: [1.1, 1.3, 1.1, 0] };   // 3 = ralentir avant le dos d'âne (sauf conducteur nerveux)
  const WANDER = { calm: 0.35, normal: 0.6, rough: 1.0 };
  const scaleP = (p, k) => p.h === 1 && k < 1
    ? { t0: p.t0, d: (p.d - TR) / k + TR, a: p.a * k }
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
    constructor({ style = 'normal', seed = 7, mount = 'vent', gearbox = 'manual', hum = 0 } = {}) {
      this.hum = hum;   // vibrations moteur/route repliées dans les capteurs (écart type en m/s², sur chaque axe)
      this.rng = mulberry32(seed); this.style = STYLE[style] ? style : 'normal'; this.gearbox = gearbox;
      const k = STYLE[this.style];
      this.long = LONG.map(p => scaleP(p, k[p.h])); this.lat = LAT.map(p => scaleP(p, k[p.h]));
      this.R = mount === 'random' ? rot(2.53, -1.08, 0.12) : ventR();
      this.ph = [this.rng() * 6.28, this.rng() * 6.28];
      this.bias = [0.0061, -0.0035, 0.0043];   // biais du gyroscope (rad/s) dans les axes de l'appareil
      this.dt = 0.02; this.t = 0; this.v = 0; this.heading = 40; this.nextFix = 1; this.stopAt = null; this.done = false;
    }
    _n(s) { const r = this.rng; return s * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
    step() {
      const t = this.t, dt = this.dt, st = this.style;
      let a = 0; for (const p of this.long) a += pulse(t, p);
      if (this.gearbox === 'manual') a += shiftAt(t, SHIFT_STYLE[st]);
      if (t >= 250) a -= smooth((t - 250) / 1.5) * Math.min(1.6, 0.35 * this.v + 0.15);
      const vNew = Math.max(0, this.v + a * dt), aReal = (vNew - this.v) / dt; this.v = vNew;
      let lat = 0; for (const p of this.lat) lat += pulse(t, p);
      const ramp = Math.min(1, this.v / 5);
      lat *= ramp;
      const vv = Math.max(this.v, 1);
      lat += (swerveAt(t, SWERVE_STYLE[st], st) + fixAt(t, FIX_STYLE[st])) * ramp;
      if (this.v > 6) lat += vv * wander(t, WANDER[st], this.ph);
      const yaw = lat / vv;                                   // rad/s, + = tourne à gauche
      this.heading -= yaw * dt * 180 / Math.PI;               // virage à gauche : le cap diminue
      const m = this.v > 0.5 ? 1 : 0.1, tw = 2 * Math.PI * t;
      const vib = j => 0.22 * m * (Math.sin(tw * 11 + j) + 0.6 * Math.sin(tw * 17 + 2 * j));
      const sh = this.v > 3 ? shockAt(t) : [0, 0];
      const hm = this.hum ? () => this._n(this.hum) : () => 0;
      const rv = [aReal + vib(0) + this._n(0.08) + hm(), lat + vib(1.3) + this._n(0.08) + sh[1] + hm(), G + vib(2.1) + this._n(0.08) + sh[0] + hm()];
      const R = this.R;
      const wv = [0, 0, yaw];
      const gy = i => (dot(R[i], wv) + this.bias[i] + this._n(0.0025 + 0.004 * this.hum)) / D2R;   // °/s, axes de l'appareil
      const out = { t, ax: dot(R[0], rv), ay: dot(R[1], rv), az: dot(R[2], rv), gx: gy(0), gy: gy(1), gz: gy(2), fix: null, heading: null, tf: t + dt };
      this.t += dt;
      if (this.t >= this.nextFix) { this.nextFix += 1; out.fix = Math.max(0, this.v + this._n(0.12)); out.heading = ((this.heading + this._n(0.8)) % 360 + 360) % 360; }
      if (this.t > 252 && this.v < 0.02) { if (this.stopAt === null) this.stopAt = this.t; if (this.t - this.stopAt >= 5) this.done = true; }
      return out;
    }
    get progress() { return Math.min(1, this.t / 270); }
  }

  /* ---------- Import CSV : t, ax, ay, az, speed[, heading][, gx, gy, gz en °/s] ---------- */
  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const split = l => l.split(delim).map(s => s.trim().replace(/^"|"$/g, ''));
    let idx = { t: 0, ax: 1, ay: 2, az: 3, speed: 4, heading: -1, gx: -1, gy: -1, gz: -1 }, start = 0;
    const head = split(lines[0]);
    if (head.some(h => /[a-z]/i.test(h))) {
      start = 1;
      const find = names => head.findIndex(h => names.includes(h.toLowerCase().replace(/[^a-z]/g, '')));
      const f = { t: find(['t','time','timestamp','seconds']), ax: find(['ax','x']), ay: find(['ay','y']),
                  az: find(['az','z']), speed: find(['speed','v','vitesse']), heading: find(['heading','bearing','course','cap']),
                  gx: find(['gx','gyrox','rotx']), gy: find(['gy','gyroy','roty']), gz: find(['gz','gyroz','rotz']) };
      for (const k in f) idx[k] = f[k];
      if (f.t < 0) idx.t = 0; if (f.ax < 0) idx.ax = 1; if (f.ay < 0) idx.ay = 2; if (f.az < 0) idx.az = 3;
    }
    const num = s => { if (s === undefined || s === '') return null; const x = parseFloat(delim === ';' ? s.replace(',', '.') : s); return Number.isFinite(x) ? x : null; };
    const col = (c, i) => i >= 0 ? num(c[i]) : null;
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const c = split(lines[i]);
      const t = num(c[idx.t]), ax = num(c[idx.ax]), ay = num(c[idx.ay]), az = num(c[idx.az]);
      if (t === null || ax === null || ay === null || az === null) continue;
      rows.push({ t, ax, ay, az, speed: col(c, idx.speed), heading: col(c, idx.heading), gx: col(c, idx.gx), gy: col(c, idx.gy), gz: col(c, idx.gz) });
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
    for (const r of rows) { e.pushMotion(r.t, r.ax, r.ay, r.az, r.gx, r.gy, r.gz); if (r.speed !== null) e.pushFix(r.t, r.speed, r.heading); }
    e.finish(); return e;
  }
  function runSim(style, seed, mount = 'vent', opts = {}) {
    const e = new Engine({ mount }), s = new Sim({ style, seed, mount: mount === 'free' ? 'random' : 'vent', gearbox: opts.gearbox, hum: opts.hum });
    const gyro = opts.gyro !== false;
    while (!s.done) { const o = s.step(); if (gyro) e.pushMotion(o.t, o.ax, o.ay, o.az, o.gx, o.gy, o.gz); else e.pushMotion(o.t, o.ax, o.ay, o.az); if (o.fix !== null) e.pushFix(o.tf, o.fix, o.heading); }
    e.finish(); return e;
  }
  return { Engine, Sim, CFG, parseCsv, analyzeRows, runSim, rot, ventR, dot };
})();
if (typeof module !== 'undefined') module.exports = PL;
