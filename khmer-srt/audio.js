/* Audio engine for Khmer SRT Studio: decode, trim, peaks, pitch-preserving time-stretch (WSOLA),
 * timeline mixdown, WAV / MP3 writers and a tiny ZIP writer. No dependencies (lamejs is loaded on demand). */
(function (root) {
  'use strict';
  var yieldUI = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  var LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';   // same library/URL the Dubber uses

  /* ---------- decoding ---------- */
  var ctxs = {};
  function ctxFor(rate) {
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio support.');
    if (!ctxs[rate]) { try { ctxs[rate] = new AC({ sampleRate: rate }); } catch (e) { ctxs[rate] = new AC(); } }
    return ctxs[rate];
  }
  function mono(buf) {
    var n = buf.length, ch = buf.numberOfChannels;
    if (ch === 1) return new Float32Array(buf.getChannelData(0));
    var o = new Float32Array(n);
    for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var i = 0; i < n; i++) o[i] += d[i] / ch; }
    return o;
  }
  // Decode a Blob to mono Float32 at `rate`.
  async function decode(blob, rate) {
    var ab = await blob.arrayBuffer();
    var ctx = ctxFor(rate), buf;
    try { buf = await new Promise(function (ok, no) { var p = ctx.decodeAudioData(ab, ok, no); if (p && p.catch) p.catch(no); }); }
    catch (e) { throw new Error('The audio could not be decoded (' + ((e && e.message) || 'unsupported or corrupt data') + ').'); }
    return { pcm: mono(buf), sr: buf.sampleRate };
  }

  // Find audible region (leading/trailing silence trimmed, small margin kept) and a compact waveform.
  function analyse(pcm, sr) {
    var n = pcm.length, th = 0.004, a = 0, b = n;
    while (a < n && Math.abs(pcm[a]) < th) a++;
    while (b > a && Math.abs(pcm[b - 1]) < th) b--;
    if (b - a < sr * 0.05) { a = 0; b = n; }                       // nearly silent: keep as is
    var lead = Math.round(sr * 0.012), tail = Math.round(sr * 0.04);
    a = Math.max(0, a - lead); b = Math.min(n, b + tail);
    var PPS = 50, bars = Math.max(1, Math.ceil((b - a) / sr * PPS)), peaks = new Uint8Array(bars), per = (b - a) / bars;
    for (var k = 0; k < bars; k++) {
      var s = a + Math.floor(k * per), e = Math.min(b, a + Math.floor((k + 1) * per)), m = 0;
      for (var i = s; i < e; i++) { var v = Math.abs(pcm[i]); if (v > m) m = v; }
      peaks[k] = Math.min(255, Math.round(m * 255));
    }
    return { a: a / sr, b: b / sr, dur: (b - a) / sr, peaks: peaks, pps: PPS, rawDur: n / sr };
  }
  function slice(pcm, sr, a, b) { return pcm.subarray(Math.max(0, Math.round(a * sr)), Math.min(pcm.length, Math.round(b * sr))); }

  /* ---------- WSOLA time-stretch (speed-up by ratio r >= 1, pitch preserved) ---------- */
  async function wsola(x, sr, r) {
    if (!(r > 1.0005)) return x;
    var L = Math.round(sr * 0.032); L += L % 2;
    var Hs = L / 2, Ha = Hs * r, tol = Math.round(sr * 0.010);
    var win = new Float32Array(L); for (var i = 0; i < L; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / L);
    var xp = new Float32Array(x.length + L * 3); xp.set(x);
    var outLen = Math.max(1, Math.round(x.length / r)), out = new Float32Array(outLen + L * 2);
    var prev = 0, k = 0;
    for (;; k++) {
      var outPos = k * Hs; if (outPos >= outLen) break;
      var nominal = Math.round(k * Ha), pos;
      if (nominal >= x.length) break;
      if (k === 0) pos = 0;
      else {
        var tgt = prev + Hs, lo = Math.max(0, nominal - tol), hi = Math.min(x.length - 1, nominal + tol);
        var best = nominal, bs = -Infinity;
        var scan = function (from, to, step) {
          for (var p = from; p <= to; p += step) {
            var dot = 0, en = 1e-9;
            for (var j = 0; j < L; j += 2) { var v = xp[p + j]; dot += v * xp[tgt + j]; en += v * v; }
            var sc = dot / Math.sqrt(en);
            if (sc > bs) { bs = sc; best = p; }
          }
        };
        scan(lo, hi, 2); scan(Math.max(lo, best - 1), Math.min(hi, best + 1), 1);
        pos = best;
      }
      for (var q = 0; q < L; q++) out[outPos + q] += xp[pos + q] * win[q];
      prev = pos;
      if (k % 40 === 39) await yieldUI();
    }
    var res = out.slice(0, outLen), f = Math.min(res.length, Math.round(sr * 0.006));
    for (var t = 0; t < f; t++) res[res.length - 1 - t] *= t / f;
    return res;
  }

  /* ---------- timing decision (shared by status column, preview and export) ---------- */
  // mode: 'autofit' | 'original' | 'warn'.  availMs = subtitle duration, dur = clip seconds.
  function decide(dur, availMs, mode, limit) {
    var avail = Math.max(0.001, availMs / 1000);
    if (dur <= avail + 0.004) return { kind: 'fits', ratio: 1, over: 0, need: dur / avail };
    var over = dur - avail, need = dur / avail;
    if (mode === 'autofit') return need <= limit ? { kind: 'fit', ratio: need * 1.003, over: over, need: need } : { kind: 'toolong', ratio: 1, over: over, need: need };
    return { kind: mode === 'warn' ? 'warn' : 'extends', ratio: 1, over: over, need: need };
  }

  /* ---------- WAV / MP3 / ZIP ---------- */
  function wavBlob(f32, sr) {
    var parts = [], total = f32.length, CH = 1 << 20;
    var h = new DataView(new ArrayBuffer(44)), bytes = total * 2;
    var w = function (o, s) { for (var i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, sr, true); h.setUint32(28, sr * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, bytes, true);
    parts.push(h.buffer);
    for (var s = 0; s < total; s += CH) { var e = Math.min(total, s + CH), o = new Int16Array(e - s); for (var i = s; i < e; i++) { var v = f32[i]; o[i - s] = (v < -1 ? -1 : v > 1 ? 1 : v) * 32767; } parts.push(o.buffer); }
    return new Blob(parts, { type: 'audio/wav' });
  }
  function loadLame() {
    if (root.lamejs) return Promise.resolve();
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = LAME_URL; s.onload = ok; s.onerror = function () { no(new Error('The MP3 encoder could not be loaded (it needs internet access the first time).')); };
      document.head.appendChild(s);
    });
  }
  async function mp3Blob(f32, sr, onProgress, signal) {
    await loadLame();
    var enc = new root.lamejs.Mp3Encoder(1, sr, 128), parts = [], n = f32.length, blk = 1152 * 8;
    for (var i = 0, k = 0; i < n; i += blk, k++) {
      if (signal && signal.aborted) throw new Error('Cancelled.');
      var e = Math.min(n, i + blk), o = new Int16Array(e - i);
      for (var j = i; j < e; j++) { var v = f32[j]; o[j - i] = (v < -1 ? -1 : v > 1 ? 1 : v) * 32767; }
      var d = enc.encodeBuffer(o); if (d.length) parts.push(new Uint8Array(d));
      if (k % 40 === 0) { if (onProgress) onProgress(i / n); await yieldUI(); }
    }
    var f = enc.flush(); if (f.length) parts.push(new Uint8Array(f));
    return new Blob(parts, { type: 'audio/mpeg' });
  }
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  // files: [{name, blob}] -> Blob (store-only ZIP, UTF-8 names)
  async function zipBlob(files, onProgress) {
    var parts = [], cen = [], off = 0, enc = new TextEncoder(), d = new Date();
    var dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)), dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
    for (var i = 0; i < files.length; i++) {
      var u8 = new Uint8Array(await files[i].blob.arrayBuffer()), nm = enc.encode(files[i].name), crc = crc32(u8);
      var lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nm, u8);
      var ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      cen.push(ch.buffer, nm); off += 30 + nm.length + u8.length;
      if (onProgress) onProgress((i + 1) / files.length); if (i % 10 === 9) await yieldUI();
    }
    var csz = cen.reduce(function (a, b) { return a + (b.byteLength || b.length); }, 0);
    var end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csz, true); end.setUint32(16, off, true);
    return new Blob(parts.concat(cen, [end.buffer]), { type: 'application/zip' });
  }

  root.KAudio = { ctxFor: ctxFor, decode: decode, analyse: analyse, slice: slice, wsola: wsola, decide: decide, wavBlob: wavBlob, mp3Blob: mp3Blob, zipBlob: zipBlob, loadLame: loadLame, yieldUI: yieldUI };
})(window);
