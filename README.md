# Loop Deck

A browser-based music player for building **loops** on top of a song.

Upload an audio file, see its waveform, drop loop markers wherever you like, and
play them live — flowing from one loop into the next while the music is running.

## Try it locally

No build step and no dependencies. Just serve the folder and open it:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly with `file://` works too in most browsers.)

## Host it on GitHub Pages

The site is plain static files at the repo root with relative links, so it runs
as-is on GitHub Pages — including from a project subpath like
`https://<user>.github.io/loop-deck/`.

There are two ways to publish it; pick one.

### Option A — GitHub Actions (included, recommended)

A workflow at `.github/workflows/pages.yml` builds and deploys on every push.

1. Push this branch to GitHub (already done if you're reading this there).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. The workflow runs on pushes to `main`, `master`, or the
   `claude/music-player-loops-wnjr44` branch (and can be run manually from the
   **Actions** tab via **Run workflow**). When it finishes, the live URL is
   shown in the Actions run summary and on the Settings → Pages screen.

### Option B — Deploy from a branch (no Actions)

1. In the repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Select the branch to publish and the **`/ (root)`** folder, then **Save**.
4. Give it a minute, then load the URL Pages shows you.

A `.nojekyll` file is included so GitHub serves the files directly without
running Jekyll.

> Pages is served over HTTPS, which the Web Audio API requires — so playback and
> looping work exactly the same as they do locally. The audio file you load
> still stays in your browser and is never uploaded anywhere.

## How it works

- **Add loop** drops a single marker at the current playhead position.
- **Click a marker** to flip it between a **start** `->` and an **end** `<-`.
- **Drag** a marker to move it; **double-click** to delete it.
- **Play** starts playback.
  - When the playhead reaches an **end**, it jumps back to the **most recent
    start** (the latest start before that end, or the beginning of the song if
    there isn't one). That's your loop.
- While playing, two more buttons appear:
  - **Next** converts the nearest upcoming **end** into a **start**, so instead
    of looping back, playback flows past it into the following loop.
  - **End** arms a one-shot stop: the next time an end is reached, playback
    stops there instead of looping.

A lone **end** marker loops back to the very start of the song, so a single
marker is already a working loop. Add a **start** before it to loop a smaller
region.

## Under the hood

- **Web Audio API** decodes the file into an `AudioBuffer` and plays it through
  `AudioBufferSourceNode`s. Loop jumps are done by stopping the current source
  and starting a fresh one at the target offset, so they're sample-accurate.
- The playhead position is derived from `AudioContext.currentTime`, and a
  `requestAnimationFrame` loop watches for end-marker crossings each frame.
- The waveform is drawn on a `<canvas>` from per-pixel min/max peaks; markers
  and the playhead are positioned as an HTML overlay.

Everything runs locally in the browser — the audio file never leaves your
machine.
