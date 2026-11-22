/* SRT parsing / writing. All times are integer milliseconds. No dependencies. */
(function (root) {
  'use strict';
  var TIME = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.:](\d{1,3}))?\s*$/;

  function parseTime(s) {
    var m = TIME.exec(String(s));
    if (!m) return null;
    var h = +(m[1] || 0), mi = +m[2], se = +m[3], ms = m[4] ? +(m[4] + '00').slice(0, 3) : 0;
    if (mi > 59 || se > 59) return null;
    return ((h * 60 + mi) * 60 + se) * 1000 + ms;
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function fmtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms % 1000, 3);
  }
  // text actually sent to a TTS engine: no markup, no ASS tags, newlines -> spaces
  function ttsText(t) {
    return String(t).replace(/\{\\[^}]*\}/g, '').replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* parse(text) -> {cues:[{num,s,e,text,line}], issues:[{line,level,msg}], fatal:string|null}
   * Tolerant of BOM, CRLF/CR, '.' or ',' milliseconds, missing numbers and stray blank lines
   * inside a cue, but every irregularity is reported with its line number. */
  function parse(raw) {
    var issues = [], cues = [];
    if (typeof raw !== 'string') return { cues: cues, issues: issues, fatal: 'The file could not be read as text.' };
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (raw.indexOf('�') !== -1) issues.push({ line: 0, level: 'warn', msg: 'The file contains invalid characters (�). It may not be UTF-8: re-save it as UTF-8 to keep Khmer text intact.' });
    var lines = raw.replace(/\r\n?/g, '\n').split('\n');
    var n = lines.length, i = 0, cur = null, prevBlank = true, lastNum = 0;

    function closeCue() {
      if (!cur) return;
      cur.text = cur.textLines.join('\n').replace(/\s+$/, '');
      delete cur.textLines;
      if (!cur.text.trim()) issues.push({ line: cur.line, level: 'warn', msg: 'Subtitle ' + cur.num + ' has no text.' });
      cues.push(cur); cur = null;
    }
    for (; i < n; i++) {
      var ln = lines[i], t = ln.trim();
      if (ln.indexOf('-->') !== -1) {
        // a timing line starts a new cue; a numeric line just before it (already pushed as pending num) is its number
        closeCue();
        var parts = ln.split('-->');
        var a = parseTime(parts[0]), rest = parts[1] || '', b = parseTime(rest.trim().split(/\s+/)[0] || '');
        var num = null;
        if (pend && pend.line === i - 1) num = pend.num;
        if (num === null) { num = lastNum + 1; issues.push({ line: i + 1, level: 'warn', msg: 'Missing subtitle number before this timing line; numbered ' + num + '.' }); }
        lastNum = num;
        if (a === null || b === null) {
          issues.push({ line: i + 1, level: 'error', msg: 'Invalid timestamp "' + t + '" (expected 00:00:01,000 --> 00:00:04,000). Subtitle ' + num + ' skipped.' });
          cur = null; skipping = true; pend = null; continue;
        }
        skipping = false;
        if (b <= a) issues.push({ line: i + 1, level: 'warn', msg: 'Subtitle ' + num + ': end time is not after start time (' + fmtTime(a) + ' → ' + fmtTime(b) + '). Fix it in the table.' });
        cur = { num: num, s: a, e: b, textLines: [], line: i + 1 };
        pend = null; prevBlank = false; continue;
      }
      if (/^\d+$/.test(t) && (prevBlank || pend === null) && lookaheadTiming(lines, i)) { pend = { num: +t, line: i }; closeCue(); skipping = false; prevBlank = false; continue; }
      if (t === '') { prevBlank = true; if (cur) cur.textLines.push(''); continue; }
      var afterBlank = prevBlank; prevBlank = false;
      if (cur) { if (afterBlank && cur.textLines.length && cur.textLines[cur.textLines.length - 1] === '') issues.push({ line: i + 1, level: 'warn', msg: 'Text after a blank line was added to subtitle ' + cur.num + ': "' + t.slice(0, 30) + '"' }); cur.textLines.push(ln.replace(/\s+$/, '')); }
      else if (!skipping) issues.push({ line: i + 1, level: 'warn', msg: 'Ignored text outside a subtitle: "' + t.slice(0, 40) + (t.length > 40 ? '…' : '') + '"' });
    }
    closeCue();
    // trailing blank lines were pushed into text lines; trim handled in closeCue (replace trailing whitespace)
    cues.forEach(function (c) { c.text = c.text.replace(/\n{2,}/g, '\n'); });
    var fatal = null;
    if (!cues.length) fatal = 'No subtitles found. An SRT cue looks like:\n1\n00:00:01,000 --> 00:00:04,000\nSubtitle text';
    // overlaps (info only)
    var sorted = cues.slice().sort(function (x, y) { return x.s - y.s; }), ov = 0;
    for (var k = 1; k < sorted.length; k++) if (sorted[k].s < sorted[k - 1].e) ov++;
    if (ov) issues.push({ line: 0, level: 'info', msg: ov + ' subtitle(s) overlap the previous one in time.' });
    return { cues: cues, issues: issues, fatal: fatal };
  }
  var pend = null, skipping = false;
  function lookaheadTiming(lines, i) { for (var j = i + 1; j < lines.length && j <= i + 2; j++) { if (lines[j].indexOf('-->') !== -1) return true; if (lines[j].trim() !== '') return false; } return false; }

  // wrapper resets parser state per call
  var _parse = parse;
  function parseSafe(raw) { pend = null; skipping = false; return _parse(raw); }

  function stringify(rows) {
    var out = [];
    rows.forEach(function (r, i) { out.push(String(i + 1), fmtTime(r.s) + ' --> ' + fmtTime(r.e), String(r.text).replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').replace(/\n/g, '\r\n'), ''); });
    return out.join('\r\n');
  }

  root.SRT = { parse: parseSafe, stringify: stringify, parseTime: parseTime, fmtTime: fmtTime, ttsText: ttsText };
})(window);
