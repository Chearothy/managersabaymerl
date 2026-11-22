/* TTS engine adapters for Khmer SRT Studio.
 *   edge : Microsoft Edge neural voices Piseth / Srey Mom. Uses the Edge proxy URL already saved by the
 *          Dubber (localStorage "kd_edgeprox", read-only); without one it tries the direct service.
 *   vox  : VoxPocket Hugging Face Space (voices read live from the Space's /config).
 * Every engine exposes:  status(), voices(), synth(text, voiceId, {signal, style}) -> {blob, mime}      */
(function (root) {
  'use strict';

  var SPACE_URL = 'https://muyleanging-voxpocket-tts-demo.hf.space';
  var spaceUrl = SPACE_URL;
  try {   // test hook, localhost only
    var q = new URLSearchParams(location.search).get('space');
    if (q && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q)) spaceUrl = q;
  } catch (e) {}

  function EngineError(code, msg, extra) { var e = new Error(msg); e.code = code; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  function abortable(signal) { if (signal && signal.aborted) throw EngineError('aborted', 'Cancelled.'); }

  /* ================= EDGE ================= */
  var EDGE_T = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';   // public client token used by the Edge read-aloud feature (same as the Dubber)
  var EDGE_VOICES = [{ id: 'km-KH-PisethNeural', label: 'Piseth (male)' }, { id: 'km-KH-SreymomNeural', label: 'Srey Mom (female)' }];

  function proxyUrl() { try { return (localStorage.getItem('kd_edgeprox') || '').trim(); } catch (e) { return ''; } }
  function checkProxy(u) {
    if (!u) return { state: 'none' };
    try { var x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw 0; return { state: 'ok', url: x.href }; }
    catch (e) { return { state: 'invalid', url: u }; }
  }

  async function edgeProxySynth(px, text, voice, signal) {
    var r;
    try { r = await fetch(px, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ text: text, voice: voice }), signal: signal }); }
    catch (e) {
      if (signal && signal.aborted) throw EngineError('aborted', 'Cancelled.');
      throw EngineError('proxy-unreachable', 'The Edge proxy could not be reached (' + px + '). Check that the Cloudflare Worker is deployed and the URL saved in the Dubber (Pipeline → Edge proxy) is correct.');
    }
    if (!r.ok) { var t = ''; try { t = (await r.text()).slice(0, 120); } catch (e) {} throw EngineError('proxy-http', 'The Edge proxy answered HTTP ' + r.status + (t ? ': ' + t : '') + '.', { status: r.status }); }
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    var b = await r.blob();
    if (/text\/html|json/.test(ct)) throw EngineError('proxy-bad', 'The Edge proxy URL did not return audio (it returned ' + ct.split(';')[0] + '). Is it the Worker URL?');
    if (!b.size) throw EngineError('proxy-empty', 'The Edge proxy returned empty audio.');
    return { blob: new Blob([b], { type: /audio\//.test(ct) ? ct.split(';')[0] : 'audio/mpeg' }), mime: 'audio/mpeg' };
  }

  async function edgeGec() {
    var t = Math.floor(Date.now() / 1000) + 11644473600; t -= t % 300;
    var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(BigInt(t) * 10000000n) + EDGE_T));
    return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
  }
  var xesc = function (t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); };
  function edgeDirect(text, voice, signal) {
    return new Promise(async function (ok, no) {
      try {
        var id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, ''), g = await edgeGec(), parts = [], done = false;
        var ws = new WebSocket('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + EDGE_T + '&ConnectionId=' + id + '&Sec-MS-GEC=' + g + '&Sec-MS-GEC-Version=1-130.0.2849.68');
        ws.binaryType = 'arraybuffer';
        var fail = function (e) { if (done) return; done = true; clearTimeout(tm); try { ws.close(); } catch (x) {} no(e); };
        var tm = setTimeout(function () { fail(EngineError('direct-timeout', 'The Edge service did not answer in time.')); }, 15000);
        if (signal) signal.addEventListener('abort', function () { fail(EngineError('aborted', 'Cancelled.')); }, { once: true });
        ws.onopen = function () {
          var t = new Date().toISOString();
          ws.send('X-Timestamp:' + t + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
          ws.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + t + '\r\nPath:ssml\r\n\r\n<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'' + voice.slice(0, 5) + '\'><voice name=\'' + voice + '\'><prosody pitch=\'+0Hz\' rate=\'+0%\' volume=\'+0%\'>' + xesc(text) + '</prosody></voice></speak>');
        };
        ws.onmessage = function (e) {
          if (typeof e.data === 'string') { if (e.data.indexOf('Path:turn.end') !== -1 && !done) { done = true; clearTimeout(tm); ws.close(); parts.length ? ok({ blob: new Blob(parts, { type: 'audio/mpeg' }), mime: 'audio/mpeg' }) : no(EngineError('direct-empty', 'The Edge service returned no audio.')); } }
          else { var d = new Uint8Array(e.data), hl = (d[0] << 8) | d[1]; if (new TextDecoder().decode(d.subarray(2, 2 + hl)).indexOf('Path:audio') !== -1) parts.push(d.subarray(2 + hl)); }
        };
        ws.onerror = function () { fail(EngineError('direct-blocked', 'The Edge service cannot be reached directly from this page (browsers often block it). Set up the free Edge proxy in the Dubber (Pipeline → Edge proxy); it is then used here automatically.')); };
        ws.onclose = function (ev) { if (!parts.length) fail(EngineError('direct-blocked', 'The direct Edge connection closed (' + ev.code + '). Set up the free Edge proxy in the Dubber (Pipeline → Edge proxy); it is then used here automatically.')); };
      } catch (e) { no(e); }
    });
  }

  var edge = {
    id: 'edge', name: 'Edge · Piseth / Srey Mom', concurrency: 3,
    voices: function () { return EDGE_VOICES.map(function (v) { return { id: 'edge:' + v.id, label: v.label }; }); },
    status: function () {
      var p = checkProxy(proxyUrl());
      if (p.state === 'ok') return { level: 'ok', text: 'Proxy ' + new URL(p.url).host, detail: 'Using the Edge proxy saved in the Dubber.' };
      if (p.state === 'invalid') return { level: 'bad', text: 'Invalid proxy URL', detail: 'The saved Edge proxy "' + p.url + '" is not a valid http(s) URL. Fix it in the Dubber (Pipeline → Edge proxy).' };
      return { level: 'warn', text: 'No proxy saved', detail: 'No Edge proxy is saved in the Dubber. A direct connection will be tried, but browsers usually block it.' };
    },
    synth: async function (text, voiceId, o) {
      o = o || {}; abortable(o.signal);
      var p = checkProxy(proxyUrl());
      if (p.state === 'invalid') throw EngineError('proxy-invalid', 'The saved Edge proxy "' + p.url + '" is not a valid URL. Fix it in the Dubber (Pipeline → Edge proxy).');
      var res = p.state === 'ok' ? await edgeProxySynth(p.url, text, voiceId, o.signal) : await edgeDirect(text, voiceId, o.signal);
      return res;
    }
  };

  /* ================= VOXPOCKET ================= */
  var vox = {
    id: 'vox', name: 'VoxPocket (Hugging Face)', concurrency: 1, maxChars: 1500,
    client: null, _voices: [], _styles: [], samples: {}, online: false, info: 'Not checked yet',
    voices: function () { return vox._voices.map(function (v) { return { id: 'vox:' + v, label: v }; }); },
    styles: function () { return vox._styles.slice(); },
    status: function () { return vox.online ? { level: 'ok', text: 'Space online', detail: 'Voices read live from the Space.' } : { level: 'warn', text: vox.info, detail: 'The VoxPocket Space is asleep, unreachable or has not been checked.' }; },
    check: async function () {
      try {
        var c = new GradioLite(spaceUrl); await c.connect();
        if (!c.hasEndpoint('clone') || !c.hasEndpoint('pick_voice')) { vox.online = false; vox.info = 'Space API changed'; return false; }
        var v = (c.inputComponent('pick_voice', 0) || {}).props, ch = v && v.choices;
        var vs = Array.isArray(ch) ? ch.map(function (x) { return Array.isArray(x) ? x[1] : x; }).filter(function (x) { return !/upload/i.test(x); }) : [];
        var st = (c.inputComponent('clone', 1) || {}).props, sc = st && st.choices;
        vox._styles = Array.isArray(sc) ? sc.map(function (x) { return Array.isArray(x) ? x[1] : x; }) : [];
        vox._voices = vs; vox.client = c; vox.online = vs.length > 0; vox.info = vs.length ? 'Space online' : 'Space has no voices';
        return vox.online;
      } catch (e) { vox.online = false; vox.client = null; vox.info = e.code === 'unavailable' ? 'Space asleep / starting' : 'Space not reachable'; return false; }
    },
    synth: async function (text, voiceId, o) {
      o = o || {}; abortable(o.signal);
      if (text.length > vox.maxChars) throw EngineError('too-long', 'Text is longer than the Space limit (' + vox.maxChars + ' characters).');
      if (!vox.client && !(await vox.check())) throw EngineError('unavailable', 'The VoxPocket Space is not available (' + vox.info + '). Open the Space once to wake it, wait a minute, then retry.');
      var c = vox.client, sample = vox.samples[voiceId];
      if (vox._voices.indexOf(voiceId) === -1) throw EngineError('bad-voice', 'The voice "' + voiceId + '" is not offered by the Space.');
      var style = o.style && vox._styles.indexOf(o.style) !== -1 ? o.style : (vox._styles[0] || 'None (plain)');
      var run = async function () {
        if (!sample) { var pv = await c.call('pick_voice', [voiceId], { signal: o.signal, deadlineMs: 60000 }); if (!pv || !pv[0]) throw EngineError('no-sample', 'The Space returned no sample for ' + voiceId + '.'); sample = vox.samples[voiceId] = { fd: pv[0], text: pv[1] == null ? '' : String(pv[1]) }; }
        return c.call('clone', [text, style, sample.fd, sample.text, 2.0, 10, 0], { signal: o.signal, deadlineMs: 300000 });
      };
      var out;
      try { out = await run(); }
      catch (e) {
        if (e && e.code === 'remote' && /file|path|not found|no such/i.test(e.message) && sample) { delete vox.samples[voiceId]; sample = null; out = await run(); }   // cached sample expired: refresh once
        else throw e;
      }
      var fd = Array.isArray(out) ? out[0] : null, url = c.fileUrl(fd);
      if (!url) throw EngineError('no-audio', (out && out[1]) ? String(out[1]) : 'The Space finished but returned no audio.');
      var r = await fetch(url, { signal: o.signal });
      if (!r.ok) throw EngineError('fetch-audio', 'The audio file could not be downloaded from the Space (HTTP ' + r.status + ').');
      var b = await r.blob();
      if (b.size < 1024) throw EngineError('invalid-audio', 'The Space returned an empty or invalid audio file (' + b.size + ' bytes).');
      var mime = (b.type && /^audio\//.test(b.type)) ? b.type : 'audio/wav';
      return { blob: new Blob([b], { type: mime }), mime: mime };
    }
  };

  root.Engines = { edge: edge, vox: vox, list: [edge, vox], byVoice: function (vid) { return vid && vid.indexOf('vox:') === 0 ? vox : edge; }, voiceName: function (vid) { return String(vid).replace(/^(edge|vox):/, '').replace(/^km-KH-/, '').replace(/Neural$/, ''); }, checkProxy: checkProxy, proxyUrl: proxyUrl };
})(window);
