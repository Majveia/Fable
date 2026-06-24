'use strict';
/* ============================================================
   FABLE: DRIFTER — score (js/game/score.js -> globalThis.Score)
   A synthesized jazz-noir ambient bed (walking bass + warm pad +
   brushed noise) with context stingers (scan ping, discovery
   chime, bounty motif, danger drone). Pure WebAudio, no assets.
   Starts on first gesture; shares mute with the existing Sound.
   ============================================================ */
(function () {
  let ctx = null, master = null, started = false, muted = false;
  let bassGain, padGain, noiseGain, bedTimer = null, step = 0;

  // A minor-pentatonic-ish walk for that smoky after-hours feel.
  const ROOT = 55; // A1
  const WALK = [0, 3, 5, 7, 10, 7, 5, 3];      // semitone offsets, looping bass
  const PAD = [0, 7, 10, 15];                  // pad chord intervals
  const BPM = 76, BEAT = 60 / BPM;

  function note(semi) { return ROOT * Math.pow(2, semi / 12); }

  function start() {
    if (started || muted) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 3);

      bassGain = ctx.createGain(); bassGain.gain.value = 0.22; bassGain.connect(master);
      padGain = ctx.createGain(); padGain.gain.value = 0.10;
      const padFilt = ctx.createBiquadFilter(); padFilt.type = 'lowpass'; padFilt.frequency.value = 600;
      padGain.connect(padFilt); padFilt.connect(master);
      noiseGain = ctx.createGain(); noiseGain.gain.value = 0.0; noiseGain.connect(master);

      // warm sustained pad (detuned triangles)
      for (const iv of PAD) {
        const o = ctx.createOscillator(); o.type = 'triangle';
        o.frequency.value = note(12 + iv); o.detune.value = (iv === 0 ? -4 : 4);
        o.connect(padGain); o.start();
      }

      started = true;
      step = 0;
      tick();
    } catch (e) { /* no audio — fine */ }
  }

  // Sequenced walking bass + a brushed-noise pulse, scheduled per beat.
  function tick() {
    if (!started || muted) { bedTimer = setTimeout(tick, BEAT * 1000); return; }
    const t0 = ctx.currentTime + 0.02;
    const semi = WALK[step % WALK.length];
    // pluck a bass note
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 240; f.Q.value = 3;
    const g = ctx.createGain();
    o.frequency.setValueAtTime(note(semi), t0);
    g.gain.setValueAtTime(0.0, t0);
    g.gain.linearRampToValueAtTime(1.0, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + BEAT * 0.9);
    o.connect(f); f.connect(g); g.connect(bassGain);
    o.start(t0); o.stop(t0 + BEAT);
    // brushed noise on the off-beats
    if (step % 2 === 1) brush(t0, 0.05);
    step++;
    bedTimer = setTimeout(tick, BEAT * 1000);
  }

  function brush(t0, amp) {
    const len = 0.18, buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const g = ctx.createGain(); g.gain.value = amp;
    src.connect(hp); hp.connect(g); g.connect(master); src.start(t0);
  }

  function blip(freq, dur, type, amp, t0) {
    t0 = t0 || ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp || 0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
  }

  const Score = {
    poke() { start(); if (ctx && ctx.state === 'suspended') ctx.resume(); },
    toggleMute() {
      muted = !muted;
      if (!started && !muted) start();
      if (master) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.linearRampToValueAtTime(muted ? 0 : 0.5, ctx.currentTime + 0.3);
      }
      return muted;
    },
    // engine throttle colors the pad brightness / a faint thrust hiss
    setThrust(thr) {
      if (!started || muted || !noiseGain) return;
      noiseGain.gain.setTargetAtTime(Math.min(Math.max(thr, 0), 1) * 0.04, ctx.currentTime, 0.2);
    },
    scanPing() { if (started && !muted) blip(1400, 0.12, 'sine', 0.08); },
    discovery() {
      if (!started || muted) return;
      const t = ctx.currentTime;
      blip(660, 0.5, 'sine', 0.1, t); blip(990, 0.6, 'sine', 0.08, t + 0.12);
    },
    bounty() {
      if (!started || muted) return;
      const t = ctx.currentTime; [0, 3, 7, 12].forEach((s, i) =>
        blip(note(24 + s), 0.4, 'triangle', 0.09, t + i * 0.1));
    },
    danger(on) {
      if (!started || muted) return;
      blip(note(1), 1.4, 'sawtooth', on ? 0.12 : 0.0);
    },
  };

  globalThis.Score = Score;
})();
