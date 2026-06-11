'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — sound (js/sound.js)
   Pure WebAudio synthesis, no assets. A quiet detuned drone whose
   pitch and brightness follow the camera's zoom scale, soft bell
   chimes for supernovae, a low thud for black-hole drops.
   Starts on the first user gesture (autoplay policy); 'm' mutes.
   ============================================================ */
(function () {
  let ctx = null, master = null, filter = null;
  let oscGain = null;
  let muted = false, started = false;

  function start() {
    if (started || muted) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.0;
      master.connect(ctx.destination);

      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      filter.Q.value = 0.4;
      filter.connect(master);

      oscGain = ctx.createGain();
      oscGain.gain.value = 0.16;
      oscGain.connect(filter);

      // Three slowly-beating detuned voices.
      for (const [freq, det] of [[55, 0], [55.35, 0], [110.4, -4]]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        o.detune.value = det;
        o.connect(oscGain);
        o.start();
      }
      // Fade the drone in over 4 s.
      master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 4);
      started = true;
    } catch (e) { /* no audio — fine */ }
  }

  const Sound = {
    // Call from any user-gesture handler; no-op afterwards.
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

    // Map camera distance to drone color: vast = deep and dark,
    // close = brighter and airier.
    setScale(dist) {
      if (!started || muted || !filter) return;
      const t = Math.min(Math.max(Math.log10(Math.max(dist, 1)) / 5, 0), 1);
      filter.frequency.setTargetAtTime(900 - 700 * t, ctx.currentTime, 0.5);
    },

    supernova() {
      if (!started || muted) return;
      const t0 = ctx.currentTime;
      const carrier = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const env = ctx.createGain();
      const f = 520 + Math.random() * 700;
      carrier.frequency.value = f;
      mod.frequency.value = f * 1.4;
      modGain.gain.value = f * 0.8;
      mod.connect(modGain); modGain.connect(carrier.frequency);
      env.gain.setValueAtTime(0.0, t0);
      env.gain.linearRampToValueAtTime(0.07, t0 + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8);
      carrier.connect(env); env.connect(master);
      carrier.start(t0); mod.start(t0);
      carrier.stop(t0 + 3); mod.stop(t0 + 3);
    },

    thud() {
      if (!started || muted) return;
      const t0 = ctx.currentTime;
      const o = ctx.createOscillator();
      const env = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(90, t0);
      o.frequency.exponentialRampToValueAtTime(28, t0 + 0.5);
      env.gain.setValueAtTime(0.18, t0);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
      o.connect(env); env.connect(master);
      o.start(t0); o.stop(t0 + 0.8);
    },
  };

  globalThis.Sound = Sound;
})();
