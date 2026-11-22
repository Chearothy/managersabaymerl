/* Khmer SRT Studio - UI + orchestration. Vanilla JS, no dependencies. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var embedded = window.parent !== window;
  var EDGE_DEFAULT = 'edge:km-KH-SreymomNeural';

  var S = { rows: [], byId: new Map(), nextId: 1, selected: new Set(), active: null, fileName: 'subtitles', origText: '', undo: [],
            q: '', mode: 'autofit', limit: 1.3, fmt: 'wav', rate: 24000, defVoice: EDGE_DEFAULT, style: '', playheadMs: null, view: [] };
  var Q = new GenQueue({
    get: function (id) { return S.byId.get(id); },
    getStyle: function () { return S.style; },
    changed: function (id) { onRowChanged(id); },
    progress: function (st) { onProgress(st); }
  });
  var tl;

  /* ---------- settings ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  (function () { try { var s = JSON.parse(lsGet('ksrt_settings') || '{}'); ['mode', 'limit', 'fmt', 'rate', 'defVoice'].forEach(function (k) { if (s[k] != null) S[k] = s[k]; }); } catch (e) {} })();
  function saveSettings() { lsSet('ksrt_settings', JSON.stringify({ mode: S.mode, limit: S.limit, fmt: S.fmt, rate: S.rate, defVoice: S.defVoice })); }

  /* ---------- toasts & dialog ---------- */
  function toast(msg, kind, ms) {
    var t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg; $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, ms || (kind === 'bad' ? 9000 : 4500));
  }
  function ask(title, body, buttons) {
    return new Promise(function (ok) {
      var d = $('dlg');
      if (!d.showModal) { var r = confirm(title + '\n\n' + body); return ok(r ? buttons[0].v : null); }
      $('dlgT').textContent = title; $('dlgB').textContent = body; var box = $('dlgBtns'); box.innerHTML = '';
      buttons.forEach(function (b, i) { var el = document.createElement('button'); el.type = 'button'; el.className = i === 0 && b.v !== null ? 'go sm' : 'btn'; el.textContent = b.t; el.onclick = function () { d.close(); ok(b.v); }; box.appendChild(el); });
      d.oncancel = function () { ok(null); };
      d.showModal();
    });
  }

  /* ---------- model helpers ---------- */
  function newRow(o) {
    var r = { id: 'r' + (S.nextId++), num: o.num, s: o.s, e: o.e, text: o.text, os: o.os != null ? o.os : o.s, oe: o.oe != null ? o.oe : o.e, voice: o.voice || S.defVoice, audio: o.audio || null, err: null, job: null };
    return r;
  }
  function index() { S.byId = new Map(); S.rows.forEach(function (r) { S.byId.set(r.id, r); }); }
  function renumber() { S.rows.forEach(function (r, i) { r.num = i + 1; }); }
  function info(r) {
    if (!r.audio) return { eff: 0, kind: 'none', ratio: 1, over: 0, need: 1 };
    var d = KAudio.decide(r.audio.dur, r.e - r.s, S.mode, S.limit);
    return { eff: d.kind === 'fit' ? r.audio.dur / d.ratio : r.audio.dur, kind: d.kind, ratio: d.ratio, over: d.over, need: d.need };
  }
  function isReady(r) { return !!r.audio && r.audio.key === rowKey(r, S.style); }
  function busyNow() { return Q.busy(); }
  function pushUndo(label) { S.undo.push({ label: label, rows: S.rows.map(function (r) { return Object.assign({}, r, { job: null }); }), active: S.active }); if (S.undo.length > 25) S.undo.shift(); updateButtons(); }
  function structural(label, fn) {
    if (busyNow()) { toast('Wait for generation to finish (or cancel it) before changing the list.', 'warn'); return false; }
    stopPlay(); pushUndo(label); fn(); index(); S.selected = new Set(Array.from(S.selected).filter(function (id) { return S.byId.has(id); })); if (S.active && !S.byId.has(S.active)) S.active = null;
    refreshAll(true); scheduleSave(); return true;
  }

  /* ---------- voices UI ---------- */
  var voiceBase = '';
  function voiceLabel(v) { var all = Engines.edge.voices().concat(Engines.vox.voices()), f = all.filter(function (x) { return x.id === v; })[0]; return f ? f.label : Engines.voiceName(v); }
  function buildVoiceBase() {
    var o = function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.label) + '</option>'; };
    var h = '<optgroup label="Edge · Piseth / Srey Mom">' + Engines.edge.voices().map(o).join('') + '</optgroup>', vv = Engines.vox.voices();
    h += vv.length ? '<optgroup label="VoxPocket (live Space)">' + vv.map(o).join('') + '</optgroup>' : '<optgroup label="VoxPocket: Space not reachable"></optgroup>';
    voiceBase = h;
  }
  function voiceOpts(sel) {
    var h = voiceBase, key = 'value="' + esc(sel) + '"';
    if (h.indexOf(key) === -1) return h + '<option value="' + esc(sel) + '" selected>' + esc(Engines.voiceName(sel)) + ' (unavailable)</option>';
    return h.replace(key, key + ' selected');
  }
  function validDefault() {
    var ids = Engines.edge.voices().concat(Engines.vox.voices()).map(function (v) { return v.id; });
    if (ids.indexOf(S.defVoice) === -1) S.defVoice = EDGE_DEFAULT;
  }
  function fillDefaultVoice() { buildVoiceBase(); validDefault(); $('defVoice').innerHTML = voiceOpts(S.defVoice); }

  /* ---------- engine status ---------- */
  function renderEngines() {
    var e = Engines.edge.status(), v = Engines.vox.status();
    var pill = function (id, lvl, txt) { var p = $(id); p.dataset.s = lvl; p.lastChild.textContent = txt; };
    pill('pillEdge', e.level, 'Edge: ' + e.text); pill('pillVox', v.level, 'VoxPocket: ' + v.text);
    $('engines').innerHTML = '<div class="eng"><div class="row"><span><b>Edge · Piseth / Srey Mom</b>' + esc(e.detail) + '</span><button class="btn" id="testEdge" type="button">Test</button></div></div>'
      + '<div class="eng"><div class="row"><span><b>VoxPocket · Hugging Face Space</b>' + esc(v.detail) + (Engines.vox.online ? ' ' + Engines.vox.voices().length + ' voice(s).' : '') + '</span><button class="btn" id="recheck" type="button">Re-check</button></div></div>';
    $('testEdge').onclick = testEdge; $('recheck').onclick = checkVox;
    var st = Engines.vox.styles();
    $('styleWrap').hidden = !(Engines.vox.online && st.length);
    if (st.length) { var cur = S.style || st[0]; $('style').innerHTML = st.map(function (x) { return '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); S.style = $('style').value; }
  }
  async function testEdge() {
    var b = $('testEdge'); b.disabled = true; b.textContent = 'Testing…';
    try { var res = await Engines.edge.synth('សួស្តី', 'km-KH-SreymomNeural', {}); var d = await KAudio.decode(res.blob, 24000); toast('Edge voices work: received ' + (d.pcm.length / d.sr).toFixed(1) + ' s of audio.', 'ok'); }
    catch (e) { toast(e.message, 'bad', 12000); }
    b.disabled = false; b.textContent = 'Test';
  }
  async function checkVox() {
    var b = $('recheck'); if (b) { b.disabled = true; b.textContent = 'Checking…'; }
    await Engines.vox.check(); fillDefaultVoice(); renderEngines(); refreshAll(true);
  }

  /* ---------- table (windowed rendering) ---------- */
  var vp = $('vp'), vsp = $('vsp'), RH = 76, lastFirst = -1, lastLast = -1;
  function rowH() { return matchMedia('(min-width:1260px)').matches ? 76 : 300; }
  function buildView() {
    var q = S.q.trim().toLowerCase();
    S.view = !q ? S.rows : S.rows.filter(function (r) { return r.text.toLowerCase().indexOf(q) !== -1 || String(r.num) === q || SRT.fmtTime(r.s).indexOf(q) !== -1; });
  }
  function statusHtml(r) {
    var st = Q.status(r), i = info(r), h;
    if (st === 'generating') return '<span><span class="sp"></span>Generating…</span>';
    if (st === 'queued') return '<span class="wn">⏳ Queued</span>';
    if (st === 'failed') return '<span class="bd">✗ Failed</span><small class="e" title="' + esc(r.err) + '">' + esc(r.err) + '</small>';
    if (st === 'none') return '<span class="muted">— no audio</span>';
    h = st === 'ready' ? '<span class="ok">✓ ' + r.audio.dur.toFixed(2) + 's</span>' : '<span class="out">⟳ Outdated</span> <span class="muted">' + r.audio.dur.toFixed(2) + 's</span>';
    var nx = S.rows[S.rows.indexOf(r) + 1], ov = '';
    if (i.kind !== 'fits' && i.kind !== 'fit' && nx && r.s + i.eff * 1000 > nx.s + 1) ov = ', overlaps #' + nx.num;
    if (st === 'outdated') h += '<small class="w">text/voice changed since this audio was made</small>';
    else if (i.kind === 'fit') h += '<small>fitted ×' + i.ratio.toFixed(2) + ' → ' + i.eff.toFixed(2) + 's (pitch kept)</small>';
    else if (i.kind === 'toolong') h += '<small class="w" title="Needs ×' + i.need.toFixed(2) + ' but the limit is ×' + S.limit.toFixed(2) + '. Original audio kept; nothing is cut.">⚠ needs ×' + i.need.toFixed(2) + ' (limit ×' + S.limit.toFixed(2) + '): original kept, +' + i.over.toFixed(2) + 's' + ov + '</small>';
    else if (i.kind === 'warn') h += '<small class="w">⚠ longer than subtitle by ' + i.over.toFixed(2) + 's' + ov + '</small>';
    else if (i.kind === 'extends') h += '<small>extends +' + i.over.toFixed(2) + 's past the subtitle' + ov + '</small>';
    return h;
  }
  function rowHtml(r, top) {
    var edited = r.s !== r.os || r.e !== r.oe, playing = Pl.id === r.id, has = !!r.audio, busy = !!r.job;
    return '<div class="r' + (S.active === r.id ? ' active' : '') + (S.selected.has(r.id) ? ' sel' : '') + '" data-id="' + r.id + '" style="top:' + top + 'px">'
      + '<div class="c-sel"><input type="checkbox" data-f="sel"' + (S.selected.has(r.id) ? ' checked' : '') + ' aria-label="Select subtitle ' + r.num + '"></div>'
      + '<div class="c-num">' + r.num + '</div>'
      + '<div class="c-st"><input class="t' + (r.e <= r.s ? ' bad' : '') + '" data-f="s" value="' + SRT.fmtTime(r.s) + '" aria-label="Start time" spellcheck="false" inputmode="numeric"></div>'
      + '<div class="c-en"><input class="t' + (r.e <= r.s ? ' bad' : '') + '" data-f="e" value="' + SRT.fmtTime(r.e) + '" aria-label="End time" spellcheck="false" inputmode="numeric"></div>'
      + '<div class="c-du">' + ((r.e - r.s) / 1000).toFixed(2) + 's</div>'
      + '<div class="c-tx"><textarea data-f="text" lang="km" spellcheck="false" aria-label="Subtitle text">' + esc(r.text) + '</textarea></div>'
      + '<div class="c-vo"><select data-f="voice" aria-label="Voice for subtitle ' + r.num + '">' + voiceOpts(r.voice) + '</select></div>'
      + '<div class="c-su st">' + statusHtml(r) + '</div>'
      + '<div class="c-ac">'
      + '<button class="ib' + (playing ? ' on' : '') + '" data-a="play" title="Play / stop" aria-label="Play"' + (has ? '' : ' disabled') + '>' + (playing ? '■' : '▶') + '</button>'
      + '<button class="ib" data-a="regen" title="Regenerate audio" aria-label="Regenerate"' + (busy ? ' disabled' : '') + '>⟳</button>'
      + '<button class="ib" data-a="dl" title="Download this clip" aria-label="Download"' + (has ? '' : ' disabled') + '>⬇</button>'
      + '<button class="ib" data-a="dup" title="Duplicate" aria-label="Duplicate">⧉</button>'
      + '<button class="ib" data-a="split" title="Split at the text cursor" aria-label="Split">✂</button>'
      + '<button class="ib" data-a="del" title="Delete" aria-label="Delete">🗑</button>'
      + (edited ? '<button class="ib" data-a="revert" title="Restore the imported start/end times" aria-label="Revert times">↺</button>' : '') + '</div></div>';
  }
  function renderTable(force) {
    RH = rowH(); vp.style.setProperty('--rh', RH + 'px');
    var n = S.view.length; vsp.style.height = n * RH + 'px';
    var first = Math.max(0, Math.floor(vp.scrollTop / RH) - 3), last = Math.min(n - 1, first + Math.ceil(vp.clientHeight / RH) + 6);
    if (!force && first === lastFirst && last === lastLast) return;
    lastFirst = first; lastLast = last;
    var h = ''; for (var i = first; i <= last; i++) h += rowHtml(S.view[i], i * RH);
    vsp.innerHTML = n ? h : '<div class="empty">' + (S.rows.length ? 'No subtitles match your search.' : 'No subtitles yet.') + '</div>';
  }
  function rowEl(id) { return vsp.querySelector('[data-id="' + id + '"]'); }
  function onRowChanged(id) {
    var r = S.byId.get(id), el = r && rowEl(id);
    if (el) {
      el.querySelector('.c-su').innerHTML = statusHtml(r);
      var rg = el.querySelector('[data-a=regen]'); rg.disabled = !!r.job;
      el.querySelector('[data-a=play]').disabled = !r.audio; el.querySelector('[data-a=dl]').disabled = !r.audio;
    }
    if (tl) tl.redraw(); updateButtons(); debouncedCounts(); if (S.active === id) selInfo();
  }
  function refreshAll(force) { buildView(); renderTable(force !== false); if (tl) tl.redraw(); updateButtons(); updateCounts(); selInfo(); $('studio').hidden = !S.rows.length && !studioShown; }
  var studioShown = false;
  var cT = 0; function debouncedCounts() { clearTimeout(cT); cT = setTimeout(updateCounts, 200); }
  function updateCounts() {
    var ready = 0, failed = 0, outd = 0, longer = 0, n = S.rows.length;
    for (var i = 0; i < n; i++) {
      var r = S.rows[i]; if (r.audio) { if (isReady(r)) ready++; else outd++; var k = info(r).kind; if (k === 'toolong' || k === 'warn') longer++; } else if (r.err) failed++;
    }
    $('counts').textContent = n + ' subtitle(s) · ' + ready + ' with audio' + (outd ? ' · ' + outd + ' outdated' : '') + (failed ? ' · ' + failed + ' failed' : '');
    var b = $('banner');
    if (longer && S.mode !== 'original') { b.hidden = false; b.textContent = '⚠ ' + longer + ' clip(s) are longer than their subtitle' + (S.mode === 'autofit' ? ' and exceed the Auto Fit limit (×' + S.limit.toFixed(2) + ')' : '') + '. Their audio is kept at full length — nothing is cut. Edit the text, extend the subtitle, or raise the limit.'; }
    else b.hidden = true;
  }
  function updateButtons() {
    var busy = busyNow(), has = S.rows.length > 0;
    ['addBtn', 'mergeBtn', 'sortBtn', 'renumBtn', 'extBtn', 'moreBtn'].forEach(function (id) { $(id).disabled = busy; });
    $('undoBtn').disabled = busy || !S.undo.length; $('undoBtn').title = S.undo.length ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo';
    $('cancel').hidden = !busy; $('genAll').disabled = !has; $('genSel').disabled = !has; $('retry').disabled = !has;
  }

  /* ---------- table events ---------- */
  var tRow = function (e) { var el = e.target.closest('.r'); return el ? S.byId.get(el.dataset.id) : null; };
  vp.addEventListener('scroll', function () { renderTable(false); }, { passive: true });
  vp.addEventListener('input', function (e) {
    var r = tRow(e), f = e.target.dataset.f; if (!r) return;
    if (f === 'text') { r.text = e.target.value; rowEl(r.id).querySelector('.c-su').innerHTML = statusHtml(r); if (tl) tl.redraw(); scheduleSave(); debouncedCounts(); }
  });
  vp.addEventListener('change', function (e) {
    var r = tRow(e), f = e.target.dataset.f; if (!r) return;
    if (f === 'sel') { e.target.checked ? S.selected.add(r.id) : S.selected.delete(r.id); rowEl(r.id).classList.toggle('sel', e.target.checked); }
    else if (f === 'voice') { r.voice = e.target.value; r.err = null; onRowChanged(r.id); scheduleSave(); }
    else if (f === 's' || f === 'e') {
      var v = SRT.parseTime(e.target.value), el = e.target;
      if (v === null) { toast('Invalid time. Use hh:mm:ss,mmm (for example 00:01:02,500).', 'bad'); el.value = SRT.fmtTime(r[f]); return; }
      var ns = f === 's' ? v : r.s, ne = f === 'e' ? v : r.e;
      if (ne <= ns) { toast('The end time must be after the start time.', 'bad'); el.value = SRT.fmtTime(r[f]); return; }
      r.s = ns; r.e = ne; redrawRow(r); if (tl) tl.redraw(); scheduleSave(); debouncedCounts();
    } else if (f === 'text') scheduleSave();
  });
  function redrawRow(r) { var el = rowEl(r.id); if (!el) return; var top = el.style.top; var t = document.createElement('div'); t.innerHTML = rowHtml(r, 0); var n = t.firstChild; n.style.top = top; el.replaceWith(n); }
  vp.addEventListener('focusin', function (e) { var r = tRow(e); if (r && S.active !== r.id) setActive(r.id, 'table'); });
  vp.addEventListener('click', function (e) {
    var r = tRow(e); if (!r) return; var b = e.target.closest('[data-a]');
    if (!b) { if (S.active !== r.id) setActive(r.id, 'table'); return; }
    var a = b.dataset.a;
    if (a === 'play') playRow(r.id);
    else if (a === 'regen') { Q.enqueue([r.id], true); }
    else if (a === 'dl') downloadRow(r);
    else if (a === 'dup') duplicateRow(r);
    else if (a === 'split') splitRow(r);
    else if (a === 'del') structural('Delete subtitle', function () { S.rows.splice(S.rows.indexOf(r), 1); });
    else if (a === 'revert') { r.s = r.os; r.e = r.oe; redrawRow(r); if (tl) tl.redraw(); scheduleSave(); toast('Restored the imported times for #' + r.num + '.', 'ok'); }
  });
  $('selAll').onchange = function () { var on = this.checked; S.view.forEach(function (r) { on ? S.selected.add(r.id) : S.selected.delete(r.id); }); renderTable(true); };
  $('q').oninput = function () { S.q = this.value; vp.scrollTop = 0; buildView(); renderTable(true); };

  function setActive(id, from) {
    var prev = S.active; S.active = id;
    if (prev) { var p = rowEl(prev); if (p) p.classList.remove('active'); }
    var el = rowEl(id); if (el) el.classList.add('active');
    var r = S.byId.get(id);
    if (tl) { tl.select(id); if (from === 'table' && r) tl.scrollToMs(r.s); }
    if (from === 'timeline' && r) {
      var i = S.view.indexOf(r); if (i === -1) { S.q = ''; $('q').value = ''; buildView(); i = S.view.indexOf(r); }
      if (i !== -1) { var top = i * RH; if (top < vp.scrollTop || top > vp.scrollTop + vp.clientHeight - RH) vp.scrollTop = Math.max(0, top - RH * 2); renderTable(true); }
    }
    selInfo();
  }
  function selInfo() {
    var r = S.byId.get(S.active), el = $('selInfo');
    if (!r) { el.textContent = 'Select a subtitle or clip'; return; }
    var i = info(r);
    el.textContent = '#' + r.num + ' · ' + SRT.fmtTime(r.s) + ' → ' + SRT.fmtTime(r.e) + ' · subtitle ' + ((r.e - r.s) / 1000).toFixed(2) + 's' + (r.audio ? ' · audio ' + r.audio.dur.toFixed(2) + 's' + (i.kind === 'fit' ? ' → ' + i.eff.toFixed(2) + 's fitted' : '') : ' · no audio');
  }

  /* ---------- structural editing ---------- */
  function duplicateRow(r) { structural('Duplicate subtitle', function () { var c = newRow(Object.assign({}, r, { audio: r.audio })); S.rows.splice(S.rows.indexOf(r) + 1, 0, c); renumber(); S.active = c.id; }); }
  async function splitRow(r) {
    var ta = rowEl(r.id) && rowEl(r.id).querySelector('textarea'), txt = r.text, pos = ta && document.activeElement === ta ? ta.selectionStart : (ta ? ta.selectionStart : 0);
    if (!(pos > 0 && pos < txt.length)) { var sp = txt.indexOf(' ', Math.floor(txt.length / 2)); pos = sp > 0 ? sp : Math.floor(Array.from(txt).length / 2); if (!(pos > 0 && pos < txt.length)) return toast('Click inside the subtitle text where it should split, then press ✂ again.', 'warn'); }
    var a = txt.slice(0, pos).trim(), b = txt.slice(pos).trim();
    if (!a || !b) return toast('Click inside the subtitle text where it should split, then press ✂ again.', 'warn');
    var mid = r.s + Math.round((r.e - r.s) * (a.length / (a.length + b.length)));
    if (mid <= r.s || mid >= r.e) return toast('This subtitle is too short to split.', 'warn');
    var ok = await ask('Split subtitle #' + r.num, 'The timing will change:\n' + SRT.fmtTime(r.s) + ' → ' + SRT.fmtTime(r.e) + '\nbecomes\n' + SRT.fmtTime(r.s) + ' → ' + SRT.fmtTime(mid) + '  and  ' + SRT.fmtTime(mid) + ' → ' + SRT.fmtTime(r.e) + '\n\nYou can undo this.', [{ t: 'Split', v: true }, { t: 'Cancel', v: null }]);
    if (!ok) return;
    structural('Split subtitle', function () {
      var second = newRow({ num: 0, s: mid, e: r.e, text: b, voice: r.voice });
      r.text = a; r.e = mid; r.oe = mid; r.audio = null; r.err = null; second.os = mid; second.oe = second.e;
      S.rows.splice(S.rows.indexOf(r) + 1, 0, second); renumber();
    });
  }
  $('addBtn').onclick = function () {
    structural('Add subtitle', function () {
      var a = S.byId.get(S.active), at = a ? S.rows.indexOf(a) + 1 : S.rows.length, prev = S.rows[at - 1], s = prev ? prev.e : 0;
      var r = newRow({ num: 0, s: s, e: s + 2000, text: '', voice: S.defVoice }); S.rows.splice(at, 0, r); renumber(); S.active = r.id; studioShown = true;
    });
  };
  $('mergeBtn').onclick = async function () {
    var ids = S.rows.filter(function (r) { return S.selected.has(r.id); });
    if (ids.length < 2) return toast('Tick at least two subtitles to merge.', 'warn');
    var s = Math.min.apply(null, ids.map(function (r) { return r.s; })), e = Math.max.apply(null, ids.map(function (r) { return r.e; }));
    var ok = await ask('Merge ' + ids.length + ' subtitles', 'The merged subtitle will run ' + SRT.fmtTime(s) + ' → ' + SRT.fmtTime(e) + ' and use the text of all selected lines.\nThe original timestamps of the merged lines are replaced (you can undo).', [{ t: 'Merge', v: true }, { t: 'Cancel', v: null }]);
    if (!ok) return;
    structural('Merge subtitles', function () {
      var first = ids[0]; first.text = ids.map(function (r) { return r.text.trim(); }).filter(Boolean).join(' '); first.s = s; first.e = e; first.os = Math.min.apply(null, ids.map(function (r) { return r.os; })); first.oe = Math.max.apply(null, ids.map(function (r) { return r.oe; }));
      first.audio = null; first.err = null; S.rows = S.rows.filter(function (r) { return r === first || !S.selected.has(r.id); }); S.selected = new Set(); renumber(); S.active = first.id;
    });
  };
  $('sortBtn').onclick = function () { structural('Sort by number', function () { S.rows = S.rows.map(function (r, i) { return [r, i]; }).sort(function (a, b) { return a[0].num - b[0].num || a[1] - b[1]; }).map(function (x) { return x[0]; }); }); };
  $('renumBtn').onclick = function () { structural('Renumber', renumber); };
  $('undoBtn').onclick = function () {
    if (busyNow() || !S.undo.length) return; stopPlay(); var u = S.undo.pop();
    S.rows = u.rows.map(function (r) { return Object.assign({}, r); }); index(); S.selected = new Set(); S.active = u.active && S.byId.has(u.active) ? u.active : null; refreshAll(true); scheduleSave(); toast('Undid: ' + u.label, 'ok');
  };
  $('extBtn').onclick = async function () {
    var rows = S.rows.filter(function (r) { if (!r.audio) return false; var k = info(r).kind; return k === 'toolong' || k === 'warn' || k === 'extends'; });
    if (!rows.length) return toast('Every clip already fits its subtitle (or has not been generated yet).', 'ok');
    var ok = await ask('Extend end times', rows.length + ' subtitle(s) have audio longer than their time slot. Their END times will be moved later so the audio fits. Start times are not changed. You can undo this, and the originals stay available in the "Original SRT" export.', [{ t: 'Extend ' + rows.length, v: true }, { t: 'Cancel', v: null }]);
    if (!ok) return;
    structural('Extend end times', function () { rows.forEach(function (r) { r.e = r.s + Math.ceil(r.audio.dur * 1000) + 20; }); });
  };

  /* ---------- import ---------- */
  async function readText(file) {
    var ab = await file.arrayBuffer(), u = new Uint8Array(ab, 0, Math.min(4, ab.byteLength)), enc = 'utf-8';
    if (u[0] === 0xFF && u[1] === 0xFE) enc = 'utf-16le'; else if (u[0] === 0xFE && u[1] === 0xFF) enc = 'utf-16be';
    return new TextDecoder(enc).decode(ab);
  }
  function showIssues(p, name, ms) {
    var box = $('issues'), er = 0, wa = 0; p.issues.forEach(function (i) { if (i.level === 'error') er++; else if (i.level === 'warn') wa++; });
    var h = '<p><b>' + esc(name) + '</b>: ' + p.cues.length + ' subtitle(s) read in ' + Math.round(ms) + ' ms · ' + er + ' error(s) · ' + wa + ' warning(s)</p>';
    p.issues.slice(0, 200).forEach(function (i) { h += '<p class="' + (i.level === 'error' ? 'e' : i.level === 'warn' ? 'w' : 'i') + '">' + (i.line ? 'Line ' + i.line + ': ' : '') + esc(i.msg) + '</p>'; });
    if (p.issues.length > 200) h += '<p class="i">…and ' + (p.issues.length - 200) + ' more.</p>';
    if (p.fatal) h += '<p class="e">' + esc(p.fatal).replace(/\n/g, '<br>') + '</p>';
    box.innerHTML = h; box.hidden = false;
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) return toast('This file is larger than 30 MB: too big for the browser. Split it first.', 'bad');
    var text; try { text = await readText(file); } catch (e) { return toast('The file could not be read: ' + e.message, 'bad'); }
    var t0 = performance.now(), p = SRT.parse(text), ms = performance.now() - t0;
    showIssues(p, file.name, ms);
    if (p.fatal) return toast('Not a valid SRT file: no subtitles found. See the details below.', 'bad');
    if (!/\.(srt|txt)$/i.test(file.name)) toast('The file does not end in .srt but was read as SRT.', 'warn');
    var mode = 'replace';
    if (S.rows.length) {
      var c = await ask('Import another SRT', 'You already have ' + S.rows.length + ' subtitle(s). Replacing removes them and their generated audio (you can undo). Appending adds the new subtitles at the end and renumbers all.', [{ t: 'Replace', v: 'replace' }, { t: 'Append', v: 'append' }, { t: 'Cancel', v: null }]);
      if (!c) return; mode = c;
    }
    if (busyNow()) return toast('Wait for generation to finish (or cancel it) first.', 'warn');
    stopPlay(); if (S.rows.length) pushUndo('Import ' + file.name);
    var rows = p.cues.map(function (c) { return newRow({ num: c.num, s: c.s, e: c.e, text: c.text, voice: S.defVoice }); });
    if (mode === 'append') { S.rows = S.rows.concat(rows); renumber(); } else { S.rows = rows; S.fileName = file.name.replace(/\.[^.]+$/, '') || 'subtitles'; S.origText = text; S.selected = new Set(); S.active = null; }
    index(); studioShown = true; $('fileInfo').textContent = file.name + ' · ' + S.rows.length + ' subtitles'; vp.scrollTop = 0; refreshAll(true); scheduleSave();
    toast('Imported ' + rows.length + ' subtitle(s).' + (p.issues.some(function (i) { return i.level === 'error'; }) ? ' Some entries were skipped: see the list.' : ''), 'ok');
  }
  var drop = $('drop'), fileIn = $('file');
  drop.onclick = function () { fileIn.click(); }; $('browseBtn').onclick = function () { fileIn.click(); }; $('moreBtn').onclick = function () { fileIn.click(); };
  drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
  fileIn.onchange = function () { var f = fileIn.files[0]; fileIn.value = ''; importFile(f); };
  ['dragenter', 'dragover'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1) drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over'); }); });
  window.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) importFile(f); });
  $('emptyBtn').onclick = function () { if (S.rows.length) return toast('A project is already open.', 'warn'); studioShown = true; S.fileName = 'subtitles'; $('addBtn').click(); };

  /* ---------- generation ---------- */
  function ids(list) { return list.map(function (r) { return r.id; }); }
  $('genSel').onclick = function () { var l = S.rows.filter(function (r) { return S.selected.has(r.id); }); if (!l.length) return toast('Tick the subtitles you want to generate first.', 'warn'); Q.enqueue(ids(l), true); };
  $('genAll').onclick = function () { var n = Q.enqueue(ids(S.rows), false); if (!n) toast('Nothing to generate: every subtitle already has up-to-date audio.', 'ok'); };
  $('retry').onclick = function () { var l = S.rows.filter(function (r) { return r.err && !r.job; }); if (!l.length) return toast('No failed subtitles.', 'ok'); Q.enqueue(ids(l), true); };
  $('cancel').onclick = function () { Q.cancel(); };
  $('applySel').onclick = function () { var v = $('defVoice').value, n = 0; S.rows.forEach(function (r) { if (S.selected.has(r.id)) { r.voice = v; r.err = null; n++; } }); if (!n) return toast('Tick the subtitles first.', 'warn'); renderTable(true); updateCounts(); scheduleSave(); };
  $('applyAll').onclick = function () { var v = $('defVoice').value; S.rows.forEach(function (r) { r.voice = v; r.err = null; }); renderTable(true); updateCounts(); scheduleSave(); };
  $('defVoice').onchange = function () { S.defVoice = this.value; saveSettings(); };
  $('style').onchange = function () { S.style = this.value; renderTable(true); updateCounts(); };
  var wasBusy = false;
  function onProgress(st) {
    var busy = Q.busy(), box = $('gprog');
    if (st.total > 0) { box.hidden = false; $('gbar').style.width = Math.round(100 * st.done / Math.max(1, st.total)) + '%'; $('gtxt').textContent = st.done + ' / ' + st.total + ' done' + (st.failed ? ' · ' + st.failed + ' failed' : '') + (st.notice ? ' · ' + st.notice : ''); }
    updateButtons();
    if (wasBusy && !busy) { var ok = st.done - st.failed; toast('Generation finished: ' + ok + ' succeeded' + (st.failed ? ', ' + st.failed + ' failed (use Retry failed)' : '') + '.' + (st.notice ? ' ' + st.notice : ''), st.failed ? 'warn' : 'ok', 7000); updateCounts(); }
    wasBusy = busy;
  }
  $('tlRegen').onclick = function () { var r = S.byId.get(S.active); if (!r) return toast('Select a subtitle first.', 'warn'); Q.enqueue([r.id], true); };

  /* ---------- timing helpers / playback ---------- */
  async function finalPcm(r, rate) {
    var d = await KAudio.decode(r.audio.blob, rate), pcm = KAudio.slice(d.pcm, d.sr, r.audio.a, r.audio.b), di = KAudio.decide(r.audio.dur, r.e - r.s, S.mode, S.limit);
    if (di.kind === 'fit') pcm = await KAudio.wsola(pcm, d.sr, di.ratio);
    return { pcm: pcm, sr: d.sr, d: di };
  }
  var Pl = { id: null, src: null, tok: 0, srcs: [], raf: 0 };
  function stopPlay() {
    Pl.tok++; var was = Pl.id; Pl.id = null;
    if (Pl.src) { try { Pl.src.onended = null; Pl.src.stop(); } catch (e) {} Pl.src = null; }
    Pl.srcs.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) {} }); Pl.srcs = [];
    cancelAnimationFrame(Pl.raf); S.playheadMs = null; if (tl) tl.redraw();
    if (was) { var el = rowEl(was); if (el) { var b = el.querySelector('[data-a=play]'); b.classList.remove('on'); b.textContent = '▶'; } }
  }
  async function playRow(id) {
    if (Pl.id === id) return stopPlay(); stopPlay();
    var r = S.byId.get(id); if (!r || !r.audio) return;
    var tok = Pl.tok; Pl.id = id; var el = rowEl(id); if (el) { var b = el.querySelector('[data-a=play]'); b.classList.add('on'); b.textContent = '■'; }
    try {
      var f = await finalPcm(r, 44100); if (tok !== Pl.tok) return;
      var ctx = KAudio.ctxFor(44100); await ctx.resume(); var buf = ctx.createBuffer(1, f.pcm.length, f.sr); buf.getChannelData(0).set(f.pcm);
      var src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.onended = function () { if (Pl.src === src) stopPlay(); }; Pl.src = src; src.start();
    } catch (e) { stopPlay(); toast('Playback failed: ' + e.message, 'bad'); }
  }
  async function previewTimeline() {
    stopPlay(); var tok = Pl.tok, a = S.byId.get(S.active), t = a ? a.s : (S.playheadSeek || 0);
    var list = S.rows.filter(function (r) { return r.audio && r.s < t + 45000 && r.s + info(r).eff * 1000 > t; }).sort(function (x, y) { return x.s - y.s; }).slice(0, 200);
    if (!list.length) return toast('No generated audio in the next 45 seconds from here.', 'warn');
    try {
      var ctx = KAudio.ctxFor(44100), bufs = []; await ctx.resume();
      for (var i = 0; i < list.length; i++) { var f = await finalPcm(list[i], 44100); if (tok !== Pl.tok) return; var b = ctx.createBuffer(1, f.pcm.length, f.sr); b.getChannelData(0).set(f.pcm); bufs.push(b); }
      var base = ctx.currentTime + 0.12; Pl.id = '__timeline';
      list.forEach(function (r, i) { var s = ctx.createBufferSource(); s.buffer = bufs[i]; s.connect(ctx.destination); var off = Math.max(0, (t - r.s) / 1000), when = base + Math.max(0, (r.s - t) / 1000); if (off < bufs[i].duration) { s.start(when, off); Pl.srcs.push(s); } });
      var endMs = Math.max.apply(null, list.map(function (r, i) { return r.s + bufs[i].duration * 1000; }));
      var tick = function () { if (tok !== Pl.tok) return; var ph = t + Math.max(0, (ctx.currentTime - base) * 1000); S.playheadMs = ph; tl.redraw(); tl.scrollToMs(ph); if (ph > endMs + 200) stopPlay(); else Pl.raf = requestAnimationFrame(tick); }; tick();
    } catch (e) { stopPlay(); toast('Preview failed: ' + e.message, 'bad'); }
  }
  $('tlPlay').onclick = previewTimeline; $('tlStop').onclick = stopPlay;

  /* ---------- timeline ---------- */
  tl = new Timeline($('tl'), {
    rows: function () { return S.rows; }, info: info, isReady: isReady, playhead: function () { return S.playheadMs; },
    select: function (id, from) { setActive(id, from); }, seek: function (ms) { S.playheadSeek = ms; S.playheadMs = ms; tl.redraw(); }
  });
  $('zIn').onclick = function () { tl.zoom(1.4); }; $('zOut').onclick = function () { tl.zoom(1 / 1.4); };
  $('zFit').onclick = function () { var w = $('tl').clientWidth, tot = tl.totalMs() / 1000; tl.pps = Math.max(4, Math.min(600, (w - 20) / Math.max(1, tot))); tl.layout(); $('tl').scrollLeft = 0; tl.redraw(); };

  /* ---------- settings controls ---------- */
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.checked = r.value === S.mode; r.onchange = function () { if (this.checked) { S.mode = this.value; saveSettings(); renderTable(true); updateCounts(); tl.redraw(); selInfo(); } }; });
  $('limit').value = S.limit; $('limitV').textContent = '×' + (+S.limit).toFixed(2);
  $('limit').oninput = function () { S.limit = +this.value; $('limitV').textContent = '×' + S.limit.toFixed(2); saveSettings(); renderTable(true); updateCounts(); tl.redraw(); };
  document.querySelectorAll('input[name=fmt]').forEach(function (r) { r.checked = r.value === S.fmt; r.onchange = function () { if (this.checked) { S.fmt = this.value; saveSettings(); } }; });
  $('rate').value = String(S.rate); $('rate').onchange = function () { S.rate = +this.value; saveSettings(); };

  /* ---------- export ---------- */
  var xbusy = false;
  function xmsg(t, kind) { var el = $('xmsg'); el.textContent = t || ''; el.style.color = kind === 'bad' ? '#fca5a5' : kind === 'ok' ? '#6ee7b7' : ''; }
  function xprog(p, t) { var b = $('xprog'); b.hidden = p == null; if (p != null) { $('xbar').style.width = Math.round(p * 100) + '%'; $('xtxt').textContent = t || ''; } }
  function download(blob, name) { var a = document.createElement('a'), u = URL.createObjectURL(blob); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 20000); }
  function base() { return (S.fileName || 'subtitles').replace(/[\\/:*?"<>|]+/g, '_'); }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function parseLen(s) { s = String(s).trim(); if (!s) return 0; var p = s.split(':').map(Number); if (p.some(isNaN)) return NaN; return p.reduce(function (a, v) { return a * 60 + v; }, 0); }
  async function encode(f32, sr, fmt) {
    if (fmt === 'mp3') {
      try { return { blob: await KAudio.mp3Blob(f32, sr, function (p) { xprog(0.9 + p * 0.1, 'Encoding MP3…'); }), ext: 'mp3' }; }
      catch (e) { toast('MP3 is unavailable (' + e.message + ') — saved as WAV instead.', 'warn', 9000); }
    }
    return { blob: KAudio.wavBlob(f32, sr), ext: 'wav' };
  }
  async function renderMix(kind) {
    var withAudio = S.rows.filter(function (r) { return r.audio; }).sort(function (a, b) { return a.s - b.s; });
    if (!withAudio.length) throw new Error('No audio has been generated yet.');
    var missing = S.rows.length - withAudio.length, sr = S.rate, ctxSr = KAudio.ctxFor(sr).sampleRate;
    var origin = kind === 'sync' ? 0 : withAudio[0].s, lastEnd = 0, i;
    withAudio.forEach(function (r) { lastEnd = Math.max(lastEnd, r.s + info(r).eff * 1000); });
    var subEnd = Math.max.apply(null, S.rows.map(function (r) { return r.e; })), userLen = parseLen($('total').value);
    if (isNaN(userLen)) throw new Error('The synchronized length must look like 12:30 or 750 (seconds).');
    var endMs = kind === 'sync' ? Math.max(lastEnd, subEnd, userLen * 1000) : lastEnd;
    if (kind === 'sync' && userLen * 1000 < lastEnd && userLen > 0) toast('Your length is shorter than the audio; extended to ' + SRT.fmtTime(lastEnd).slice(0, 8) + ' so nothing is cut.', 'warn');
    var total = Math.ceil((endMs - origin) / 1000 * ctxSr) + ctxSr, out;
    try { out = new Float32Array(total); } catch (e) { throw new Error('Not enough memory for this length. Lower the sample rate to 24 kHz or export in parts.'); }
    var st = { clips: 0, fitted: 0, kept: 0, overlaps: 0, missing: missing, outdated: 0 }, prevEnd = -1;
    for (i = 0; i < withAudio.length; i++) {
      var r = withAudio[i]; xprog(i / withAudio.length * 0.9, 'Mixing ' + (i + 1) + ' / ' + withAudio.length + '…');
      var f = await finalPcm(r, sr), at = Math.round((r.s - origin) / 1000 * f.sr);
      for (var k = 0, n = f.pcm.length; k < n; k++) { var p = at + k; if (p >= 0 && p < out.length) out[p] += f.pcm[k]; }
      st.clips++; if (f.d.kind === 'fit') st.fitted++; if (f.d.kind === 'toolong' || f.d.kind === 'warn' || f.d.kind === 'extends') st.kept++;
      var endS = at + f.pcm.length; if (prevEnd > at) st.overlaps++; prevEnd = Math.max(prevEnd, endS); if (!isReady(r)) st.outdated++;
      if (i % 5 === 4) await KAudio.yieldUI();
    }
    var peak = 0; for (i = 0; i < out.length; i++) { var v = Math.abs(out[i]); if (v > peak) peak = v; }
    if (peak > 1) { var g = 0.98 / peak; for (i = 0; i < out.length; i++) out[i] *= g; st.gain = g; }
    return { pcm: out, sr: ctxSr, st: st };
  }
  async function exportMix(kind) {
    if (xbusy) return; xbusy = true; xmsg(''); ['xComb', 'xSync', 'xInd'].forEach(function (b) { $(b).disabled = true; });
    try {
      xprog(0, 'Preparing…'); var m = await renderMix(kind), e = await encode(m.pcm, m.sr, S.fmt);
      var name = base() + '-' + (kind === 'sync' ? 'synchronized' : 'combined') + '.' + e.ext; download(e.blob, name);
      var s = m.st; xmsg('Saved ' + name + ' · ' + (m.pcm.length / m.sr).toFixed(1) + 's · ' + s.clips + ' clip(s)' + (s.fitted ? ', ' + s.fitted + ' time-fitted' : '') + (s.kept ? ', ' + s.kept + ' longer than their subtitle (kept at full length)' : '') + (s.overlaps ? ', ' + s.overlaps + ' overlap(s)' : '') + (s.missing ? ' · ' + s.missing + ' subtitle(s) have no audio and are silent' : '') + (s.outdated ? ' · ' + s.outdated + ' clip(s) are outdated' : '') + (s.gain ? ' · volume reduced to avoid clipping' : '') + '.', 'ok');
    } catch (e) { xmsg(e.message, 'bad'); toast(e.message, 'bad'); }
    xprog(null); xbusy = false; ['xComb', 'xSync', 'xInd'].forEach(function (b) { $(b).disabled = false; });
  }
  function clipName(r, ext) { return pad(r.num, 4) + '_' + Engines.voiceName(r.audio ? r.audio.voice : r.voice).replace(/[^\w-]+/g, '') + '.' + ext; }
  function downloadRow(r) { if (r.audio) download(r.audio.blob, base() + '-' + clipName(r, r.audio.ext)); }
  function srtBlob(text) { return new Blob([text], { type: 'application/x-subrip;charset=utf-8' }); }
  async function exportIndividual() {
    if (xbusy) return; var withAudio = S.rows.filter(function (r) { return r.audio; });
    if (!withAudio.length) return xmsg('No audio has been generated yet.', 'bad');
    xbusy = true; xmsg(''); ['xComb', 'xSync', 'xInd'].forEach(function (b) { $(b).disabled = true; });
    try {
      var files = [], mode = $('indMode').value;
      for (var i = 0; i < withAudio.length; i++) {
        var r = withAudio[i]; xprog(i / withAudio.length * 0.8, 'Preparing clip ' + (i + 1) + ' / ' + withAudio.length + '…');
        if (mode === 'orig') files.push({ name: clipName(r, r.audio.ext), blob: r.audio.blob });
        else { var f = await finalPcm(r, S.rate), e = await encode(f.pcm, f.sr, S.fmt); files.push({ name: clipName(r, e.ext), blob: e.blob }); }
        if (i % 5 === 4) await KAudio.yieldUI();
      }
      files.push({ name: base() + '-updated.srt', blob: srtBlob(SRT.stringify(S.rows)) });
      xprog(0.9, 'Packing ZIP…'); var z = await KAudio.zipBlob(files); download(z, base() + '-clips.zip');
      xmsg('Saved ' + base() + '-clips.zip with ' + withAudio.length + ' clip(s) + the updated SRT.' + (S.rows.length > withAudio.length ? ' ' + (S.rows.length - withAudio.length) + ' subtitle(s) had no audio.' : ''), 'ok');
    } catch (e) { xmsg(e.message, 'bad'); toast(e.message, 'bad'); }
    xprog(null); xbusy = false; ['xComb', 'xSync', 'xInd'].forEach(function (b) { $(b).disabled = false; });
  }
  $('xComb').onclick = function () { exportMix('combined'); }; $('xSync').onclick = function () { exportMix('sync'); }; $('xInd').onclick = exportIndividual;
  $('xSrt').onclick = function () { if (!S.rows.length) return xmsg('There are no subtitles to export.', 'bad'); download(srtBlob(SRT.stringify(S.rows)), base() + '-updated.srt'); xmsg('Saved ' + base() + '-updated.srt (' + S.rows.length + ' subtitles, renumbered 1–' + S.rows.length + ').', 'ok'); };
  $('xSrt0').onclick = function () { if (!S.origText) return xmsg('There is no imported file to restore.', 'bad'); download(srtBlob(S.origText), base() + '-original.srt'); xmsg('Saved the original file as imported.', 'ok'); };

  /* ---------- autosave (text, times, voices only; audio is never stored) ---------- */
  var saveT = 0;
  function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(save, 1200); }
  function save() { try { if (!S.rows.length) return; var j = JSON.stringify({ v: 1, name: S.fileName, t: Date.now(), rows: S.rows.map(function (r) { return [r.num, r.s, r.e, r.text, r.voice, r.os, r.oe]; }) }); if (j.length < 3500000) lsSet('ksrt_autosave', j); } catch (e) {} }
  function offerRestore() {
    try {
      var j = JSON.parse(lsGet('ksrt_autosave') || 'null'); if (!j || !j.rows || !j.rows.length) return;
      var b = $('restore'); b.hidden = false; b.innerHTML = 'Unfinished project <b>' + esc(j.name) + '</b> · ' + j.rows.length + ' subtitles · saved ' + new Date(j.t).toLocaleString() + ' (audio is not stored). <button class="btn" id="rsYes" type="button">Restore</button> <button class="btn" id="rsNo" type="button">Discard</button>';
      $('rsYes').onclick = function () { S.rows = j.rows.map(function (a) { return newRow({ num: a[0], s: a[1], e: a[2], text: a[3], voice: a[4], os: a[5], oe: a[6] }); }); S.fileName = j.name; S.origText = ''; index(); studioShown = true; b.hidden = true; $('fileInfo').textContent = j.name + ' · restored'; refreshAll(true); };
      $('rsNo').onclick = function () { b.hidden = true; try { localStorage.removeItem('ksrt_autosave'); } catch (e) {} };
    } catch (e) {}
  }

  /* ---------- embedding ---------- */
  $('back').addEventListener('click', function (e) { if (embedded) { e.preventDefault(); try { parent.postMessage({ type: 'khmer-srt-back' }, location.origin); } catch (x) { location.href = '../'; } } });
  window.addEventListener('message', function (e) { if (e.origin === location.origin && e.data && e.data.type === 'khmer-srt-pause') stopPlay(); });
  if (embedded && window.ResizeObserver) { var last = 0; new ResizeObserver(function () { var h = Math.ceil(document.documentElement.scrollHeight); if (Math.abs(h - last) < 2) return; last = h; try { parent.postMessage({ type: 'khmer-srt-height', height: h }, location.origin); } catch (x) {} }).observe(document.body); }
  matchMedia('(min-width:1260px)').addEventListener && matchMedia('(min-width:1260px)').addEventListener('change', function () { renderTable(true); });

  /* ---------- init ---------- */
  fillDefaultVoice(); renderEngines(); buildView(); renderTable(true); updateButtons(); offerRestore();
  checkVox().then(function () { fillDefaultVoice(); });
  window.KSRT = { S: S, Q: Q, info: info, finalPcm: finalPcm };   // read-only handle used by the automated tests
})();
