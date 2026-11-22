# Khmer SRT Studio (module)

Turn a Khmer `.srt` into timed Khmer speech. Separate from the Dubber: it runs in its own page/iframe, with its own
JS/CSS, and is opened by the **📝 Khmer SRT** nav button, `/#khmer-srt`, or directly at `/khmer-srt/`.

| File | Role |
|---|---|
| `index.html`, `style.css` | UI (dark, responsive; table on desktop, cards on phones) |
| `srt.js` | Strict SRT parser/writer (BOM, CRLF, multi-line cues, `,`/`.` ms, line-numbered errors) |
| `engines.js` | Voice engines: **Edge** (Piseth, Srey Mom) and **VoxPocket** (voices read live from the Space) |
| `queue.js` | Generation queue: per-engine lanes, cancel, retry, duplicate protection, circuit breaker |
| `audio.js` | Decode, silence trim, **WSOLA** pitch-preserving time-stretch, mixdown, WAV / MP3 / ZIP writers |
| `timeline.js` | Canvas timeline (ruler, subtitle lane, audio lane with waveforms, zoom/scroll) |
| `app.js` | Editor, table (windowed for large files), player, exports, autosave |

It reuses `../khmer-tts/gradio-client.js` (unchanged) for the Hugging Face Space. Nothing else is shared with other modules.

## Voices
- **Edge · Piseth / Srey Mom** – uses the Edge proxy URL already saved by the Dubber (`localStorage` key `kd_edgeprox`, read-only). You do not configure it again. Without a proxy it tries a direct connection (browsers often block it) and says so. An invalid or unreachable proxy URL produces a clear error on the row.
- **VoxPocket** – voices (currently Woman 1, Woman 2, Man 1) and styles are read from the Space's `/config`; if the Space is asleep none are offered. The "Upload my own voice" option is not used.
- Each subtitle has its own voice. The voice/text/style used for a request are read when the request is sent and stored with the audio; if you later change the row, the audio is marked **Outdated** instead of being reused.
- Gemini is intentionally not included.

## Timing modes
- **Auto Fit** – audio longer than its subtitle is sped up with WSOLA (pitch preserved) to fit, up to the *quality limit* (default ×1.30, adjustable). Above the limit the original audio is kept and a warning is shown. Shorter audio is never slowed.
- **Original audio** – natural speed. Audio may run past the subtitle and **overlap** the next clip; later clips are never pushed.
- **Warning mode** – like Original, plus a ⚠ on every clip longer than its subtitle and a summary banner.
Speech is never cut off and subtitle timestamps are never changed automatically ("Extend end times…" asks for confirmation and can be undone).

## Export
- **Combined** – all clips at their SRT positions, starting at the first clip.
- **Synchronized** – starts at 00:00:00 and runs to the last subtitle end (or a length you enter), so it lines up with the video.
- **Individual (ZIP)** – one file per subtitle, "as generated" (MP3 from Edge, WAV from VoxPocket) or fitted by the timing mode, plus the updated SRT. Each row also has a ⬇ button.
- **Updated SRT** (edited text/times, renumbered, UTF-8, CRLF) and **Original SRT**.
- WAV is built in the browser. **MP3** is encoded in the browser with `lamejs`, loaded from cdnjs on first use (the same library/URL the Dubber uses). If it cannot be loaded you get a warning and a WAV instead. No server-side FFmpeg is used or required (Vercel is not configured for it).

## Editing
Edit text/start/end/voice inline; add, delete, duplicate, split (at the text cursor), merge selected, search, sort by number, renumber, import another SRT (replace or append), **Undo** (25 steps) for structural changes. Original times can be restored per row (↺). Merge, split, replace-import and "extend end times" ask for confirmation. Text, times and voices are autosaved locally (audio is not) and can be restored after a refresh.

## Limits (be aware)
- VoxPocket runs on a shared free GPU Space: one request at a time, a daily quota per visitor, max 1500 characters per line. If quota runs out the queue stops with a clear message. Edge is better for long files.
- Very long projects need memory: a 1-hour mix at 24 kHz uses ~350 MB; export in parts on phones.
- Auto Fit quality is good for moderate speed-ups (~×1.3); beyond that the audio is kept as is.
- Preview plays up to 45 s from the selected subtitle.
