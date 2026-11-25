# Rothy Dubber Free

One project, two ways to run it. Edit `index.html` once and both update.

```
index.html      the whole app (website)
api/visit.js    visitor counter (Vercel serverless function)
studio.py       local runner: serves index.html + native-ffmpeg "Cut clip" (no size limit)
vercel.json     Vercel settings
```

## Run on your computer
```
python studio.py                 # opens the app; needs Python 3.8+ and ffmpeg
python studio.py movie.mp4 --minutes 3     # cut from the command line
```
`studio.py` must stay in the same folder as `index.html`.

## Host on GitHub + Vercel
1. Create a GitHub repo and upload everything in this folder (keep the `api` folder at the root).
2. Vercel → **Add New → Project** → import the repo → **Deploy** (no build settings needed).
3. Visitor counter (free): Vercel project → **Storage** → **Create** → **Upstash Redis** → free plan → **Connect to Project**.
   Then **Deployments → ⋯ → Redeploy** so the function can see the new variables.
4. Open your site. The first visit on a device adds 1 to the number (starts at 3,124).
   Add `?debug` to the address to see an alert explaining why the counter is not live.

## Notes
- On Vercel, **Cut clip** runs inside the browser (ffmpeg.wasm), so very large files depend on the device's memory.
  The local `studio.py` uses native ffmpeg and has no size limit.
- The counter counts devices (a browser's local storage), not people; clearing site data counts again.
- Change the starting number with `BASE` in `api/visit.js`.

## v3 — faster + cheaper dubbing
- Transcribe + translate to Khmer is ONE Gemini call per ~60 s part, parts run in parallel (2–4 at a time).
- Silence is trimmed before sending (fewer audio tokens). Output uses a compact `start|end|m|text` format.
- Results are cached in the browser (same video + settings = 0 tokens). Turn off in Pipeline → "Cache results".
- **⬇ Download SRT** appears as soon as translation finishes. Enable Pipeline → "Keep original text" for a bilingual SRT.
- Edge voice (free) is the default voice engine; switch to Gemini TTS in the voice settings if you prefer.

## v4 — Whisper in the browser + 30-minute videos
- **Engine selector** next to the Dub button: *Gemini (audio)* or *Whisper (free · in browser)*. With Whisper, speech is transcribed locally (0 Gemini audio tokens) and Gemini only translates the text in batches of 40 lines. The original-language SRT can be downloaded as soon as Whisper finishes.
- Whisper model/device: Pipeline tab → "Whisper transcription". WebGPU (Chrome/Edge desktop) is much faster than CPU. If Whisper cannot start, the app switches to Gemini automatically.
- **Long videos (30 min+)**: audio is extracted without loading the whole video into memory — native ffmpeg when you run `python studio.py` (fastest, any size), otherwise ffmpeg.wasm in the browser, with the normal browser decoder as the last fallback.
- `studio.py` has a new `/api/audio` endpoint for this.
