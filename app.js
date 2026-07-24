/*
 * Loop Deck — a music player where you drop "loops" onto the waveform.
 *
 * Model
 * -----
 * A "loop" is a single marker on the timeline. Each marker is either a
 * START ("->") or an END ("<-"). You toggle a marker's type by clicking it.
 *
 * Playback rules
 * --------------
 *  - The song plays forward normally.
 *  - When the playhead reaches an END marker, it jumps back to the most
 *    recent START (the latest START before that END, or the very beginning
 *    of the song if there is none).
 *  - "Next" converts the nearest upcoming END into a START, so the playhead
 *    flows past it into the following loop instead of looping back.
 *  - "End" arms a one-shot flag: the next time an END is reached, playback
 *    stops there instead of looping back.
 */

(() => {
  "use strict";

  // ---- DOM ----------------------------------------------------------------
  const fileInput = document.getElementById("fileInput");
  const drop = document.getElementById("drop");
  const uploader = document.getElementById("uploader");
  const stage = document.getElementById("stage");
  const track = document.getElementById("track");
  const canvas = document.getElementById("waveform");
  const overlay = document.getElementById("overlay");
  const playheadEl = document.getElementById("playhead");
  const markersEl = document.getElementById("markers");
  const filenameEl = document.getElementById("filename");
  const curTimeEl = document.getElementById("curTime");
  const durTimeEl = document.getElementById("durTime");

  const addLoopBtn = document.getElementById("addLoopBtn");
  const playBtn = document.getElementById("playBtn");
  const playGlyph = document.getElementById("playGlyph");
  const playLabel = document.getElementById("playLabel");
  const nextBtn = document.getElementById("nextBtn");
  const endBtn = document.getElementById("endBtn");
  const newFileBtn = document.getElementById("newFileBtn");
  const demoBtn = document.getElementById("demoBtn");

  const ctxClass = window.AudioContext || window.webkitAudioContext;

  // ---- State --------------------------------------------------------------
  const state = {
    audioCtx: null,
    buffer: null, // decoded AudioBuffer
    duration: 0,

    // playback
    source: null, // active AudioBufferSourceNode
    gain: null,
    isPlaying: false,
    segStartCtxTime: 0, // audioCtx.currentTime when current segment started
    segStartOffset: 0, // buffer offset (s) at the start of current segment
    pausedPos: 0, // playhead position (s) when not playing
    lastPos: 0, // previous frame position, for crossing detection
    endArmed: false, // stop at the next END instead of looping
    rafId: 0,

    // markers: { id, time (s), type: 'start' | 'end' }
    markers: [],
    nextId: 1,
  };

  let peaks = null; // cached min/max peaks for the current canvas width

  // ---- Utilities ----------------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function sortedMarkers() {
    return [...state.markers].sort((a, b) => a.time - b.time);
  }

  // The latest START strictly before time `t`, or 0 (song start) if none.
  function mostRecentStartBefore(t) {
    let best = 0;
    for (const m of state.markers) {
      if (m.type === "start" && m.time < t && m.time >= best) best = m.time;
    }
    return best;
  }

  // ---- Audio engine -------------------------------------------------------
  function ensureCtx() {
    if (!state.audioCtx) {
      state.audioCtx = new ctxClass();
      state.gain = state.audioCtx.createGain();
      state.gain.gain.value = 1;
      state.gain.connect(state.audioCtx.destination);
    }
    return state.audioCtx;
  }

  function currentPosition() {
    if (state.isPlaying && state.audioCtx) {
      return state.segStartOffset + (state.audioCtx.currentTime - state.segStartCtxTime);
    }
    return state.pausedPos;
  }

  function stopSource() {
    if (state.source) {
      state.source.onended = null;
      try {
        state.source.stop();
      } catch (e) {
        /* already stopped */
      }
      try {
        state.source.disconnect();
      } catch (e) {
        /* noop */
      }
      state.source = null;
    }
  }

  // Start playing the buffer from `offset` seconds.
  function startSegment(offset) {
    stopSource();
    const ctx = ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = state.buffer;
    src.connect(state.gain);
    src.onended = onSourceEnded;
    state.source = src;
    state.segStartOffset = offset;
    state.segStartCtxTime = ctx.currentTime;
    src.start(0, offset);
  }

  // Fires when the buffer plays all the way to its natural end.
  function onSourceEnded() {
    // Only meaningful if it ended on its own (we null onended for manual stops).
    if (!state.isPlaying) return;
    state.isPlaying = false;
    state.pausedPos = state.duration;
    stopSource();
    cancelAnimationFrame(state.rafId);
    syncTransport();
    render();
  }

  function play() {
    if (!state.buffer) return;
    const ctx = ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    // Restart from the top if we were parked at the very end.
    let offset = state.pausedPos;
    if (offset >= state.duration - 0.001) offset = 0;
    state.lastPos = offset;
    startSegment(offset);
    state.isPlaying = true;
    syncTransport();
    tick();
  }

  function pause() {
    if (!state.isPlaying) return;
    state.pausedPos = clamp(currentPosition(), 0, state.duration);
    stopSource();
    state.isPlaying = false;
    cancelAnimationFrame(state.rafId);
    syncTransport();
    render();
  }

  // Jump the playhead to `offset` and keep playing (or park there if paused).
  function seek(offset) {
    offset = clamp(offset, 0, state.duration);
    if (state.isPlaying) {
      state.lastPos = offset;
      startSegment(offset);
    } else {
      state.pausedPos = offset;
    }
    render();
  }

  // ---- Playback loop ------------------------------------------------------
  function tick() {
    if (!state.isPlaying) return;
    const pos = currentPosition();

    // Detect END markers crossed since the last frame: lastPos < time <= pos.
    // Handle the earliest crossed END first.
    let crossed = null;
    for (const m of state.markers) {
      if (m.type !== "end") continue;
      if (m.time > state.lastPos && m.time <= pos) {
        if (!crossed || m.time < crossed.time) crossed = m;
      }
    }

    if (crossed) {
      if (state.endArmed) {
        // Stop cleanly at the end marker.
        state.endArmed = false;
        state.pausedPos = crossed.time;
        state.isPlaying = false;
        stopSource();
        cancelAnimationFrame(state.rafId);
        syncTransport();
        render();
        return;
      }
      // Loop back to the most recent start before this end.
      const target = mostRecentStartBefore(crossed.time);
      state.lastPos = target;
      startSegment(target);
      render();
      state.rafId = requestAnimationFrame(tick);
      return;
    }

    if (pos >= state.duration) {
      // Reached the natural end; onended will finish up, but guard anyway.
      state.lastPos = pos;
      render();
      state.rafId = requestAnimationFrame(tick);
      return;
    }

    state.lastPos = pos;
    render();
    state.rafId = requestAnimationFrame(tick);
  }

  // ---- Marker actions -----------------------------------------------------
  function addLoop() {
    if (!state.buffer) return;
    const t = clamp(currentPosition(), 0, state.duration);
    // A lone END loops back to the song start, so it is immediately useful.
    state.markers.push({ id: state.nextId++, time: t, type: "end" });
    renderMarkers();
  }

  function toggleMarker(id) {
    const m = state.markers.find((x) => x.id === id);
    if (!m) return;
    m.type = m.type === "start" ? "end" : "start";
    renderMarkers();
  }

  function deleteMarker(id) {
    state.markers = state.markers.filter((x) => x.id !== id);
    renderMarkers();
  }

  // "Next": convert the nearest END ahead of the playhead into a START so the
  // song flows into the next loop. Falls back to the nearest END behind.
  function goNext() {
    const pos = currentPosition();
    let ahead = null;
    let behind = null;
    for (const m of state.markers) {
      if (m.type !== "end") continue;
      if (m.time > pos) {
        if (!ahead || m.time < ahead.time) ahead = m;
      } else {
        if (!behind || m.time > behind.time) behind = m;
      }
    }
    const target = ahead || behind;
    if (!target) return;
    target.type = "start";
    renderMarkers();
  }

  // "End": stop the next time an END is reached instead of looping back.
  function toggleEndArmed() {
    state.endArmed = !state.endArmed;
    endBtn.classList.toggle("is-armed", state.endArmed);
  }

  // ---- Loading & decoding -------------------------------------------------
  // Bundled public-domain demo so people can try the app without a file of
  // their own. It's a freshly synthesized rendition of Beethoven's "Fur Elise".
  const DEMO_URL = "assets/fur-elise.wav";
  const DEMO_NAME = "Fur Elise — Beethoven (public domain demo)";

  // decodeAudioData works two ways across browsers: modern engines return a
  // Promise, but Safari/iOS historically only supports the callback form (and
  // returns undefined). Support both, so `await` never hangs on undefined.
  function decodeAudio(ctx, arrayBuf) {
    return new Promise((resolve, reject) => {
      const maybePromise = ctx.decodeAudioData(arrayBuf, resolve, reject);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolve, reject);
      }
    });
  }

  async function loadDemo() {
    const ctx = ensureCtx();
    // iOS unlocks audio only inside a user gesture; resume here while we're
    // still in the tap handler's call stack.
    if (ctx.state === "suspended") ctx.resume();
    demoBtn.disabled = true;
    const original = demoBtn.innerHTML;
    demoBtn.textContent = "Loading…";
    try {
      const resp = await fetch(DEMO_URL);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const arrayBuf = await resp.arrayBuffer();
      const audioBuf = await decodeAudio(ctx, arrayBuf);
      if (!audioBuf) throw new Error("decodeAudioData returned no buffer");
      filenameEl.textContent = DEMO_NAME;
      resetForNewBuffer(audioBuf);
    } catch (err) {
      alert("Sorry, the demo track could not be loaded.");
      console.error(err);
    } finally {
      demoBtn.disabled = false;
      demoBtn.innerHTML = original;
    }
  }

  async function loadFile(file) {
    if (!file) return;
    const ctx = ensureCtx();
    filenameEl.textContent = file.name;
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await decodeAudio(ctx, arrayBuf);
      if (!audioBuf) throw new Error("decodeAudioData returned no buffer");
      resetForNewBuffer(audioBuf);
    } catch (err) {
      alert("Sorry, that file could not be decoded as audio.");
      console.error(err);
    }
  }

  function resetForNewBuffer(audioBuf) {
    stopSource();
    cancelAnimationFrame(state.rafId);
    state.buffer = audioBuf;
    state.duration = audioBuf.duration;
    state.markers = [];
    state.nextId = 1;
    state.isPlaying = false;
    state.pausedPos = 0;
    state.lastPos = 0;
    state.endArmed = false;
    endBtn.classList.remove("is-armed");

    uploader.hidden = true;
    stage.hidden = false;
    durTimeEl.textContent = fmtTime(state.duration);

    computePeaks();
    drawWaveform();
    renderMarkers();
    syncTransport();
    render();
  }

  // ---- Waveform rendering -------------------------------------------------
  function cssWidth() {
    return track.clientWidth;
  }
  function cssHeight() {
    return track.clientHeight;
  }

  function computePeaks() {
    if (!state.buffer) return;
    const width = Math.max(1, Math.floor(cssWidth()));
    const chan = state.buffer.getChannelData(0);
    const step = chan.length / width;
    const mins = new Float32Array(width);
    const maxs = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const start = Math.floor(x * step);
      const end = Math.min(chan.length, Math.floor((x + 1) * step));
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        const v = chan[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (end <= start) {
        min = 0;
        max = 0;
      }
      mins[x] = min;
      maxs[x] = max;
    }
    peaks = { width, mins, maxs };
  }

  function drawWaveform() {
    if (!state.buffer || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cssWidth();
    const h = cssHeight();
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const mid = h / 2;
    const styles = getComputedStyle(document.documentElement);
    const waveColor = styles.getPropertyValue("--wave").trim() || "#4a5468";

    g.fillStyle = waveColor;
    // peaks were computed for a (possibly different) width; scale x if needed.
    const scale = w / peaks.width;
    for (let px = 0; px < peaks.width; px++) {
      const x = px * scale;
      const yMax = mid - maxs(px) * mid;
      const yMin = mid - mins(px) * mid;
      const barH = Math.max(1, yMin - yMax);
      g.fillRect(x, yMax, Math.max(1, scale), barH);
    }

    function maxs(i) {
      return peaks.maxs[i];
    }
    function mins(i) {
      return peaks.mins[i];
    }
  }

  // ---- Marker + playhead DOM ---------------------------------------------
  function timeToPct(t) {
    if (!state.duration) return 0;
    return (t / state.duration) * 100;
  }

  function renderMarkers() {
    markersEl.innerHTML = "";
    for (const m of sortedMarkers()) {
      const el = document.createElement("div");
      el.className = "marker " + (m.type === "start" ? "is-start" : "is-end");
      el.style.left = timeToPct(m.time) + "%";
      el.dataset.id = String(m.id);

      const line = document.createElement("div");
      line.className = "marker__line";

      const flag = document.createElement("div");
      flag.className = "marker__flag";
      flag.textContent = m.type === "start" ? "->" : "<-";

      const handle = document.createElement("div");
      handle.className = "marker__handle";

      el.appendChild(line);
      el.appendChild(flag);
      el.appendChild(handle);
      markersEl.appendChild(el);

      attachMarkerInteractions(el, flag, handle, m.id);
    }
  }

  function attachMarkerInteractions(el, flag, handle, id) {
    let dragging = false;
    let moved = false;
    let pointerId = null;

    const onDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      moved = false;
      pointerId = e.pointerId;
      el.setPointerCapture?.(e.pointerId);
    };

    const onMove = (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const rect = track.getBoundingClientRect();
      const x = clamp(e.clientX - rect.left, 0, rect.width);
      const t = (x / rect.width) * state.duration;
      const m = state.markers.find((x) => x.id === id);
      if (!m) return;
      if (Math.abs(t - m.time) > 0.001) moved = true;
      m.time = clamp(t, 0, state.duration);
      el.style.left = timeToPct(m.time) + "%";
    };

    const onUp = (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
      if (!moved) {
        toggleMarker(id); // a click (no drag) flips start <-> end
      }
    };

    for (const grip of [flag, handle]) {
      grip.addEventListener("pointerdown", onDown);
      grip.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteMarker(id);
      });
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  // ---- Frame render (playhead + time) ------------------------------------
  function render() {
    const pos = currentPosition();
    playheadEl.style.left = timeToPct(pos) + "%";
    curTimeEl.textContent = fmtTime(pos);
  }

  function syncTransport() {
    const playing = state.isPlaying;
    playGlyph.textContent = playing ? "❚❚" : "▶";
    playLabel.textContent = playing ? "Pause" : "Play";
    nextBtn.hidden = !playing;
    endBtn.hidden = !playing;
    if (!playing) {
      state.endArmed = false;
      endBtn.classList.remove("is-armed");
    }
  }

  // ---- Seeking by clicking the waveform ----------------------------------
  track.addEventListener("pointerdown", (e) => {
    // Ignore clicks that originate on a marker (handled above).
    if (e.target.closest(".marker")) return;
    const rect = track.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    seek((x / rect.width) * state.duration);
  });

  // ---- Wiring -------------------------------------------------------------
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("is-dragover");
    })
  );
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  addLoopBtn.addEventListener("click", addLoop);
  playBtn.addEventListener("click", () => (state.isPlaying ? pause() : play()));
  nextBtn.addEventListener("click", goNext);
  endBtn.addEventListener("click", toggleEndArmed);
  newFileBtn.addEventListener("click", () => {
    pause();
    fileInput.value = "";
    fileInput.click();
  });
  demoBtn.addEventListener("click", loadDemo);

  // Keep the canvas + markers correct on resize.
  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (!state.buffer) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      computePeaks();
      drawWaveform();
      render();
    });
  });

  // Spacebar toggles play/pause.
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !stage.hidden) {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      state.isPlaying ? pause() : play();
    }
  });
})();
