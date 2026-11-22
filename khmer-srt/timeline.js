/* Canvas timeline: ruler, subtitle lane, audio-clip lane with waveforms. Zoom + native horizontal scrolling.
 * Only the visible window is drawn, so thousands of cues stay smooth. */
(function (root) {
  'use strict';
  var RULER = 22, SUB_Y = 28, SUB_H = 42, AUD_Y = 76, AUD_H = 62, H = 148;

  function Timeline(el, host) {
    this.el = el; this.host = host; this.pps = 40; this.raf = 0; this.sel = null;
    el.innerHTML = '<div class="tl-in"><canvas class="tl-cv" aria-label="Audio timeline"></canvas></div>';
    this.inner = el.firstChild; this.cv = this.inner.firstChild; this.ctx = this.cv.getContext('2d');
    var self = this;
    el.addEventListener('scroll', function () { self.redraw(); }, { passive: true });
    el.addEventListener('wheel', function (e) { if (e.ctrlKey || e.metaKey) { e.preventDefault(); self.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX); } }, { passive: false });
    this.cv.addEventListener('click', function (e) { self.click(e); });
    if (window.ResizeObserver) new ResizeObserver(function () { self.redraw(); }).observe(el);
  }
  Timeline.prototype.totalMs = function () {
    var m = 0, rows = this.host.rows();
    for (var i = 0; i < rows.length; i++) { var r = rows[i], eff = this.host.info(r).eff; var e = Math.max(r.e, r.audio ? r.s + eff * 1000 : 0); if (e > m) m = e; }
    return m + 3000;
  };
  Timeline.prototype.layout = function () {
    var w = Math.ceil(this.totalMs() / 1000 * this.pps), vw = this.el.clientWidth || 600;
    this.inner.style.width = Math.max(w, vw) + 'px'; this.inner.style.height = H + 'px';
  };
  Timeline.prototype.zoom = function (f, anchorPx) {
    var old = this.pps, vw = this.el.clientWidth, a = anchorPx == null ? vw / 2 : anchorPx, tAt = (this.el.scrollLeft + a) / old;
    this.pps = Math.max(4, Math.min(600, old * f)); this.layout(); this.el.scrollLeft = tAt * this.pps - a; this.redraw();
  };
  Timeline.prototype.scrollToMs = function (ms) {
    var x = ms / 1000 * this.pps, vw = this.el.clientWidth;
    if (x < this.el.scrollLeft + 20 || x > this.el.scrollLeft + vw - 60) this.el.scrollLeft = Math.max(0, x - vw * 0.25);
  };
  Timeline.prototype.select = function (id) { this.sel = id; this.redraw(); };
  Timeline.prototype.redraw = function () { var s = this; if (s.raf) return; s.raf = requestAnimationFrame(function () { s.raf = 0; s.draw(); }); };

  Timeline.prototype.hit = function (e) {
    var rect = this.cv.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, t = (this.el.scrollLeft + x) / this.pps * 1000;
    var rows = this.host.rows();
    if (y < RULER) return { t: t };
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i], info = this.host.info(r), inSub = y >= SUB_Y && y <= SUB_Y + SUB_H && t >= r.s && t <= r.e;
      var inAud = y >= AUD_Y && y <= AUD_Y + AUD_H && r.audio && t >= r.s && t <= r.s + info.eff * 1000;
      if (inSub || inAud) return { id: r.id, t: t };
    }
    return { t: t };
  };
  Timeline.prototype.click = function (e) {
    var h = this.hit(e);
    if (h.id) this.host.select(h.id, 'timeline'); else this.host.seek(h.t);
  };

  Timeline.prototype.draw = function () {
    var el = this.el, cv = this.cv, vw = el.clientWidth || 600, dpr = Math.min(2, window.devicePixelRatio || 1);
    this.layout();
    if (cv.width !== Math.round(vw * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(vw * dpr); cv.height = Math.round(H * dpr); cv.style.width = vw + 'px'; cv.style.height = H + 'px'; }
    var c = this.ctx, pps = this.pps, sl = el.scrollLeft, t0 = sl / pps * 1000, t1 = (sl + vw) / pps * 1000;
    var cs = getComputedStyle(document.documentElement);
    var col = { bg: '#0d0d1a', grid: 'rgba(255,255,255,.07)', tx: '#9aa0c3', sub: 'rgba(59,130,246,.28)', subB: 'rgba(96,165,250,.75)', aud: '#8b5cf6', warn: 'rgba(248,113,113,.85)', old: 'rgba(154,160,195,.35)', sel: '#fbbf24' };
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, vw, H); c.fillStyle = col.bg; c.fillRect(0, 0, vw, H);
    // ruler
    var step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].filter(function (s) { return s * pps >= 70; })[0] || 3600;
    c.font = '11px Inter,system-ui,sans-serif'; c.textBaseline = 'middle'; c.fillStyle = col.tx; c.strokeStyle = col.grid; c.lineWidth = 1;
    for (var t = Math.floor(t0 / 1000 / step) * step; t * 1000 <= t1; t += step) {
      var x = Math.round(t * pps - sl) + .5; c.beginPath(); c.moveTo(x, RULER - 5); c.lineTo(x, H); c.stroke();
      c.fillText(SRT.fmtTime(t * 1000).slice(0, step < 1 ? 12 : 8), x + 3, 10);
    }
    c.fillStyle = col.tx; c.fillText('Subtitles', 6, SUB_Y - 4 < 14 ? 14 : SUB_Y - 3 + 0); 
    var rows = this.host.rows(), n = rows.length;
    for (var i = 0; i < n; i++) {
      var r = rows[i];
      var info = this.host.info(r), aEnd = r.audio ? r.s + info.eff * 1000 : r.e;
      if (Math.max(r.e, aEnd) < t0 || r.s > t1) continue;
      var xs = r.s / 1000 * pps - sl, ws = Math.max(2, (r.e - r.s) / 1000 * pps), selected = r.id === this.sel;
      // subtitle block
      c.fillStyle = r.e <= r.s ? 'rgba(248,113,113,.35)' : col.sub; c.fillRect(xs, SUB_Y, ws, SUB_H);
      c.strokeStyle = selected ? col.sel : col.subB; c.lineWidth = selected ? 2 : 1; c.strokeRect(xs + .5, SUB_Y + .5, ws - 1, SUB_H - 1);
      if (ws > 34) { c.fillStyle = '#e6e9ff'; c.save(); c.beginPath(); c.rect(xs, SUB_Y, ws, SUB_H); c.clip(); c.fillText('#' + r.num + ' ' + r.text.replace(/\n/g, ' '), xs + 4, SUB_Y + SUB_H / 2, ws - 8); c.restore(); }
      // audio clip
      if (r.audio) {
        var wa = Math.max(2, info.eff * pps), outdated = !this.host.isReady(r);
        c.fillStyle = outdated ? col.old : 'rgba(139,92,246,.32)'; c.fillRect(xs, AUD_Y, wa, AUD_H);
        if (wa > ws + 1 && info.kind !== 'fits') { c.fillStyle = col.warn; c.globalAlpha = .28; c.fillRect(xs + ws, AUD_Y, wa - ws, AUD_H); c.globalAlpha = 1; }
        // waveform
        var pk = r.audio.peaks, pn = pk.length, mid = AUD_Y + AUD_H / 2, x0 = Math.max(0, Math.floor(-xs)), x1 = Math.min(Math.ceil(wa), Math.ceil(vw - xs));
        c.strokeStyle = outdated ? 'rgba(200,205,235,.5)' : '#c4b5fd'; c.lineWidth = 1; c.beginPath();
        for (var px = x0; px < x1; px += 1) {
          var k = Math.min(pn - 1, Math.floor(px / wa * pn)), amp = pk[k] / 255 * (AUD_H / 2 - 3);
          c.moveTo(xs + px + .5, mid - amp); c.lineTo(xs + px + .5, mid + amp);
        }
        c.stroke();
        c.strokeStyle = selected ? col.sel : (info.kind === 'toolong' || info.kind === 'warn') ? col.warn : col.aud; c.lineWidth = selected ? 2 : 1; c.strokeRect(xs + .5, AUD_Y + .5, wa - 1, AUD_H - 1);
        if (wa > 50) { c.fillStyle = '#fff'; c.fillText(info.eff.toFixed(2) + 's' + (info.kind === 'fit' ? ' ×' + info.ratio.toFixed(2) : ''), xs + 4, AUD_Y + 9); }
      }
    }
    c.fillStyle = col.tx; c.fillText('Audio', 6, AUD_Y - 5);
    var ph = this.host.playhead();
    if (ph != null) { var px2 = ph / 1000 * pps - sl; c.strokeStyle = '#34d399'; c.lineWidth = 2; c.beginPath(); c.moveTo(px2, 0); c.lineTo(px2, H); c.stroke(); }
  };

  root.Timeline = Timeline;
})(window);
