/* Generation queue for Khmer SRT Studio.
 * - one lane per engine (Edge: 3 parallel, VoxPocket: 1) so the free GPU Space is never flooded
 * - the voice / style / text used for a request are read from the row at the moment it is sent and stored with the
 *   audio (audio.key), so audio always belongs to exactly the voice it was made with; if the row changes later the
 *   audio is shown as "outdated" instead of silently being reused
 * - duplicate requests for a row already queued or running are ignored
 * - cancel aborts running requests and un-queues the rest; repeated failures halt a lane (circuit breaker)    */
(function (root) {
  'use strict';
  var EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac' };

  function rowKey(row, style) {
    var eng = Engines.byVoice(row.voice);
    if (row._src !== row.text) { row._src = row.text; row._tt = SRT.ttsText(row.text); }   // memoised: cheap for large files
    return row.voice + '|' + (eng.id === 'vox' ? (style || '') : '') + '|' + row._tt;
  }

  function GenQueue(host) {
    this.host = host;               // {get(id), getStyle(), changed(id), progress(stats)}
    this.jobs = [];
    this.lanes = {};
    this.ctl = new AbortController();
    this.stats = { total: 0, done: 0, failed: 0, running: 0, notice: '' };
  }
  GenQueue.prototype.lane = function (id) { return this.lanes[id] || (this.lanes[id] = { run: 0, consecutive: 0, halted: false }); };
  GenQueue.prototype.busy = function () { return this.jobs.length > 0 || this.stats.running > 0; };

  GenQueue.prototype.status = function (row) {
    if (row.job === 'generating') return 'generating';
    if (row.job === 'queued') return 'queued';
    if (row.err) return 'failed';                      // an unresolved error always wins, even if older audio exists
    if (row.audio) return row.audio.key === rowKey(row, this.host.getStyle()) ? 'ready' : 'outdated';
    return 'none';
  };

  GenQueue.prototype.enqueue = function (ids, force) {
    var self = this, added = 0;
    if (!this.busy()) { this.stats = { total: 0, done: 0, failed: 0, running: 0, notice: '' }; this.lanes = {}; }
    ids.forEach(function (id) {
      var row = self.host.get(id); if (!row || row.job) return;
      var st = self.status(row);
      if (!force && st === 'ready') return;
      if (!SRT.ttsText(row.text)) { row.err = 'The subtitle text is empty.'; self.host.changed(id); return; }
      row.job = 'queued'; row.err = null; self.jobs.push(id); self.stats.total++; added++; self.host.changed(id);
    });
    if (added) this.pump(); else this.host.progress(this.stats);
    return added;
  };

  GenQueue.prototype.cancel = function () {
    var self = this;
    this.jobs.splice(0).forEach(function (id) { var r = self.host.get(id); if (r) { r.job = null; self.host.changed(id); } self.stats.total--; });
    this.ctl.abort(); this.ctl = new AbortController();
    this.stats.notice = 'Cancelled.'; this.host.progress(this.stats);
  };

  GenQueue.prototype.pump = function () {
    var self = this;
    for (var i = 0; i < this.jobs.length;) {
      var id = this.jobs[i], row = this.host.get(id);
      if (!row) { this.jobs.splice(i, 1); continue; }
      var eng = Engines.byVoice(row.voice), lane = this.lane(eng.id);
      if (lane.halted) { i++; continue; }
      if (lane.run >= eng.concurrency) { i++; continue; }
      this.jobs.splice(i, 1); lane.run++; this.stats.running++;
      this.run(row, eng, lane);
    }
    this.host.progress(this.stats);
  };

  GenQueue.prototype.run = async function (row, eng, lane) {
    var self = this, signal = this.ctl.signal, style = this.host.getStyle();
    row.job = 'generating'; this.host.changed(row.id);
    var snap = { voice: row.voice, text: SRT.ttsText(row.text), key: rowKey(row, style) };   // exactly what is sent
    try {
      var res = await eng.synth(snap.text, snap.voice.replace(/^(edge|vox):/, ''), { signal: signal, style: style });
      var d = await KAudio.decode(res.blob, 24000), an = KAudio.analyse(d.pcm, d.sr);
      row.audio = { blob: res.blob, mime: res.mime, ext: EXT[res.mime] || 'bin', key: snap.key, voice: snap.voice, dur: an.dur, a: an.a, b: an.b, peaks: an.peaks, pps: an.pps, rawDur: an.rawDur };
      row.err = null; lane.consecutive = 0;
    } catch (e) {
      if (e && e.code === 'aborted' || signal.aborted) { row.err = null; }
      else {
        row.err = (e && e.message) || 'Unknown error'; lane.consecutive++; this.stats.failed++;
        var quota = /quota|zerogpu/i.test(row.err);
        if (quota || lane.consecutive >= 3) { this.halt(eng, lane, quota ? 'The free GPU quota is used up' : 'Repeated errors: ' + row.err); }
      }
    } finally {
      row.job = null; lane.run--; this.stats.running--; this.stats.done++;
      this.host.changed(row.id);
      if (this.jobs.length) this.pump(); else this.host.progress(this.stats);
    }
  };

  // stop feeding a lane: its queued rows are returned to idle with a clear message (press Retry later)
  GenQueue.prototype.halt = function (eng, lane, why) {
    var self = this; lane.halted = true;
    this.jobs = this.jobs.filter(function (id) {
      var r = self.host.get(id); if (!r) return false;
      if (Engines.byVoice(r.voice).id !== eng.id) return true;
      r.job = null; r.err = 'Skipped: ' + why + '. Press Retry failed when the problem is fixed.'; self.stats.failed++; self.stats.done++; self.stats.total += 0; self.host.changed(id); return false;
    });
    this.stats.notice = eng.name + ' stopped: ' + why + '.';
  };

  root.GenQueue = GenQueue; root.rowKey = rowKey;
})(window);
