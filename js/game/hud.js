'use strict';
/* ============================================================
   FABLE: DRIFTER — cockpit HUD (js/game/hud.js -> globalThis.HUD)
   Neon-noir overlay: throttle/speed gauge, heading + coordinates,
   centre reticle + off-screen nav arrow to the current target, a
   scanner sweep ring, discovery toasts, a bounty chip, and a codex
   log. Honors the v7 aesthetic contract. Own DOM in #hud; the
   integrator feeds it a state object each frame.
   ============================================================ */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const C = { cyan: '#37e6ff', mag: '#ff4fd8', amber: '#ffb347', bone: '#e8ecf8', dim: '#5a6688' };

  const CSS = `
  #hud { position: fixed; inset: 0; pointer-events: none; z-index: 30;
    font-family: 'SF Mono','Cascadia Code',Menlo,Consolas,monospace; color: ${C.bone};
    transition: opacity .8s ease; }
  body.idle #hud.fade { opacity: .25; }
  #hud .neon { text-shadow: 0 0 6px currentColor; }
  #hud-reticle { position: fixed; left: 50%; top: 50%; width: 46px; height: 46px;
    margin: -23px 0 0 -23px; }
  #hud-scan { position: fixed; left: 50%; top: 50%; width: 120px; height: 120px;
    margin: -60px 0 0 -60px; opacity: 0; transition: opacity .25s; }
  #hud-scan.on { opacity: 1; }
  #hud-throttle { position: fixed; left: 26px; bottom: 26px; width: 168px; }
  #hud-throttle .bar { height: 5px; background: rgba(90,102,136,.25); border-radius: 3px;
    overflow: hidden; }
  #hud-throttle .fill { height: 100%; width: 0%; background: ${C.cyan};
    box-shadow: 0 0 10px ${C.cyan}; transition: width .12s, background .2s; }
  #hud-throttle .row { display: flex; justify-content: space-between; font-size: 10px;
    letter-spacing: 2px; color: ${C.dim}; margin-bottom: 5px; }
  #hud-speed { color: ${C.cyan}; }
  #hud-nav { position: fixed; right: 26px; bottom: 26px; text-align: right;
    font-size: 10px; letter-spacing: 1px; line-height: 1.8; color: ${C.dim}; }
  #hud-nav b { color: ${C.bone}; font-weight: 400; }
  #hud-target { position: fixed; transform: translate(-50%,-50%); font-size: 10px;
    letter-spacing: 1px; color: ${C.amber}; text-shadow: 0 0 8px ${C.amber};
    white-space: nowrap; display: none; }
  #hud-target .ring { display: inline-block; width: 26px; height: 26px;
    border: 1px solid ${C.amber}; border-radius: 50%; vertical-align: middle;
    margin-right: 7px; box-sizing: border-box; }
  #hud-arrow { position: fixed; left: 50%; top: 50%; color: ${C.amber};
    font-size: 22px; transform-origin: center; display: none;
    text-shadow: 0 0 10px ${C.amber}; }
  #hud-toasts { position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 6px; }
  #hud-toasts .t { font-size: 11px; letter-spacing: 3px; padding: 5px 14px;
    border: 1px solid rgba(55,230,255,.3); background: rgba(5,6,10,.6);
    backdrop-filter: blur(6px); border-radius: 4px; opacity: 0;
    transform: translateY(-6px); transition: opacity .4s, transform .4s; }
  #hud-toasts .t.show { opacity: 1; transform: translateY(0); }
  #hud-bounty { position: fixed; top: 22px; right: 26px; font-size: 10px;
    letter-spacing: 1px; color: ${C.mag}; text-shadow: 0 0 6px ${C.mag};
    max-width: 240px; text-align: right; display: none; }
  #hud-bounty .rw { color: ${C.amber}; }
  #hud-codex { position: fixed; top: 0; right: 0; width: 320px; height: 100%;
    background: rgba(5,6,10,.86); backdrop-filter: blur(10px); pointer-events: auto;
    border-left: 1px solid rgba(55,230,255,.2); padding: 26px 22px; overflow-y: auto;
    transform: translateX(105%); transition: transform .35s ease; }
  #hud-codex.open { transform: translateX(0); }
  #hud-codex h3 { font-size: 11px; letter-spacing: 5px; color: ${C.cyan};
    margin-bottom: 16px; }
  #hud-codex .e { font-size: 10px; letter-spacing: .5px; line-height: 1.5;
    margin-bottom: 13px; border-left: 2px solid ${C.dim}; padding-left: 10px; }
  #hud-codex .e .k { color: ${C.amber}; letter-spacing: 2px; }
  #hud-codex .e .n { color: ${C.bone}; }
  #hud-codex .e .b { color: ${C.dim}; }
  #hud-frame { position: fixed; inset: 0; pointer-events: none;
    box-shadow: inset 0 0 180px rgba(0,0,4,.7); }
  #hud-scanlines { position: fixed; inset: 0; pointer-events: none; opacity: .06;
    background: repeating-linear-gradient(0deg, #fff 0, #fff 1px, transparent 1px, transparent 3px); }
  `;

  function el(tag, id, parent) { const e = document.createElement(tag); if (id) e.id = id; if (parent) parent.appendChild(e); return e; }
  function svgCircle(parent, r, stroke, w, dash) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '50%'); c.setAttribute('cy', '50%'); c.setAttribute('r', r);
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', w);
    if (dash) c.setAttribute('stroke-dasharray', dash);
    parent.appendChild(c); return c;
  }

  let root, fillEl, speedEl, navEl, targetEl, arrowEl, toastsEl, bountyEl, codexEl, scanEl, scanArc;
  let codexEntries = [];
  let W = 0, H = 0;

  const HUD = {
    init(container) {
      const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
      root = container || el('div', 'hud', document.body);
      root.id = 'hud'; root.className = 'fade';
      el('div', 'hud-frame', root);
      el('div', 'hud-scanlines', root);

      // centre reticle (svg)
      const ret = document.createElementNS(NS, 'svg'); ret.id = 'hud-reticle';
      ret.setAttribute('viewBox', '0 0 46 46'); root.appendChild(ret);
      const mk = (d) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d);
        p.setAttribute('stroke', C.cyan); p.setAttribute('stroke-width', '1'); p.setAttribute('fill', 'none');
        p.setAttribute('opacity', '.8'); ret.appendChild(p); };
      mk('M23 6 L23 15'); mk('M23 40 L23 31'); mk('M6 23 L15 23'); mk('M40 23 L31 23');
      const dot = document.createElementNS(NS, 'circle'); dot.setAttribute('cx', '23'); dot.setAttribute('cy', '23');
      dot.setAttribute('r', '1.6'); dot.setAttribute('fill', C.cyan); ret.appendChild(dot);

      // scanner ring
      const sv = document.createElementNS(NS, 'svg'); sv.id = 'hud-scan'; sv.setAttribute('viewBox', '0 0 120 120');
      root.appendChild(sv); scanEl = sv;
      svgCircle(sv, 54, 'rgba(55,230,255,.18)', 1.5);
      scanArc = svgCircle(sv, 54, C.cyan, 2.5, '0 1000');
      scanArc.setAttribute('transform', 'rotate(-90 60 60)');
      scanArc.style.filter = 'drop-shadow(0 0 6px ' + C.cyan + ')';

      // throttle / speed
      const thr = el('div', 'hud-throttle', root);
      const row = el('div', null, thr); row.className = 'row';
      const lab = el('span', null, row); lab.textContent = 'THROTTLE';
      speedEl = el('span', 'hud-speed', row); speedEl.textContent = '0 u/s';
      const bar = el('div', null, thr); bar.className = 'bar';
      fillEl = el('div', null, bar); fillEl.className = 'fill';

      navEl = el('div', 'hud-nav', root);
      targetEl = el('div', 'hud-target', root);
      const tring = el('span', null, targetEl); tring.className = 'ring';
      targetEl.appendChild(document.createTextNode(''));
      arrowEl = el('div', 'hud-arrow', root); arrowEl.textContent = '▲';
      toastsEl = el('div', 'hud-toasts', root);
      bountyEl = el('div', 'hud-bounty', root);
      codexEl = el('div', 'hud-codex', root);
      const ch = el('h3', null, codexEl); ch.textContent = 'SHIP LOG';
      this._codexList = el('div', null, codexEl);

      W = window.innerWidth; H = window.innerHeight;
      window.addEventListener('resize', () => { W = window.innerWidth; H = window.innerHeight; });
      return this;
    },

    show(on) { if (root) root.style.display = on ? '' : 'none'; },

    update(s) {
      if (!root) return;
      const sp = s.speed || 0;
      speedEl.textContent = Math.round(sp).toLocaleString() + ' u/s' + (s.boost ? '  ✦' : '');
      const thr = Math.max(0, Math.min(1, s.throttle || 0));
      fillEl.style.width = (thr * 100).toFixed(0) + '%';
      fillEl.style.background = s.boost ? C.mag : C.cyan;
      navEl.innerHTML =
        (s.breadcrumb ? '<b>' + s.breadcrumb + '</b><br>' : '') +
        (s.coords ? s.coords.map((c) => Math.round(c)).join('  ') + '<br>' : '') +
        'HDG ' + (s.heading ? s.heading.map((h) => Math.round(h * 57.3)).join(' / ') : '0 / 0') +
        '  ·  ' + (s.mode || 'chase').toUpperCase() +
        (s.fps ? '  ·  ' + Math.round(s.fps) + ' fps' : '');

      // scanner ring progress
      if (s.scanProgress > 0) {
        scanEl.classList.add('on');
        const circ = 2 * Math.PI * 54;
        scanArc.setAttribute('stroke-dasharray', (circ * s.scanProgress).toFixed(1) + ' 1000');
      } else scanEl.classList.remove('on');

      // target reticle / off-screen arrow
      const t = s.target;
      if (t) {
        if (t.on) {
          targetEl.style.display = '';
          targetEl.style.left = t.sx + 'px';
          targetEl.style.top = t.sy + 'px';
          targetEl.lastChild.nodeValue = t.label + (t.dist != null ? '  ' + fmtDist(t.dist) : '');
          arrowEl.style.display = 'none';
        } else {
          targetEl.style.display = 'none';
          arrowEl.style.display = '';
          const ang = Math.atan2(t.sy - H / 2, t.sx - W / 2);
          const rx = W * 0.42, ry = H * 0.42;
          arrowEl.style.left = (W / 2 + Math.cos(ang) * rx) + 'px';
          arrowEl.style.top = (H / 2 + Math.sin(ang) * ry) + 'px';
          arrowEl.style.transform = 'translate(-50%,-50%) rotate(' + (ang + Math.PI / 2) + 'rad)';
        }
      } else { targetEl.style.display = 'none'; arrowEl.style.display = 'none'; }

      if (s.bounty) {
        bountyEl.style.display = '';
        bountyEl.innerHTML = 'BOUNTY · ' + s.bounty.name + '<br>' +
          '<span class="rw">' + (s.bounty.reward ? s.bounty.reward.toLocaleString() + ' w' : '') + '</span>' +
          (s.bounty.systemHint ? '  → ' + s.bounty.systemHint : '');
      } else bountyEl.style.display = 'none';
    },

    toast(line, color) {
      if (!toastsEl) return;
      const t = el('div', null, toastsEl); t.className = 't'; t.textContent = line;
      if (color) { t.style.color = color; t.style.borderColor = color; }
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 500); }, 3200);
    },

    discovery(p) {
      this.toast((p.first ? 'NEW · ' : '') + (p.kind ? p.kind.toUpperCase() + ' · ' : '') + (p.name || ''), C.cyan);
      if (p.first) this.logEntry(p.kind, p.name, p.blurb);
    },

    logEntry(kind, name, blurb) {
      codexEntries.push({ kind, name, blurb });
      const e = el('div', null, this._codexList); e.className = 'e';
      e.innerHTML = '<span class="k">' + (kind || '').toUpperCase() + '</span> <span class="n">' +
        (name || '') + '</span><br><span class="b">' + (blurb || '') + '</span>';
    },

    logBounty(b) { this.toast('BOUNTY ACCEPTED · ' + b.name, C.mag); },

    codex(open) {
      if (!codexEl) return;
      const want = open === undefined ? !codexEl.classList.contains('open') : open;
      codexEl.classList.toggle('open', want);
    },

    entries() { return codexEntries.slice(); },
    loadEntries(arr) { (arr || []).forEach((e) => this.logEntry(e.kind, e.name, e.blurb)); },
  };

  function fmtDist(d) {
    if (d > 1e4) return (d / 1e3).toFixed(0) + 'k';
    if (d > 100) return Math.round(d) + '';
    return d.toFixed(1);
  }

  globalThis.HUD = HUD;
})();
