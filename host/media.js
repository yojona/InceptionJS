// Host side of the media bridge. Each engine media player is mirrored by a
// <video> element in the view, under the canvas: the engine paints a
// transparent hole where the video is, and the element shows through. Media
// Source players get a real MediaSource whose SourceBuffers receive the bytes
// the page appends inside the engine; decoding, audio and A/V sync are the host
// browser's. State flows back to the engine, which drives the page's media
// element from it.

const STATE_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'pause', 'waiting',
  'seeking', 'seeked', 'ended', 'durationchange', 'ratechange', 'volumechange', 'resize', 'error', 'stalled', 'emptied'];

// Representative codec strings per family; the engine answers canPlayType and
// isTypeSupported from these results.
const PROBES = {
  'video/mp4': { avc1: 'avc1.42E01E', hev1: 'hev1.1.6.L93.B0', vp09: 'vp09.00.10.08', av01: 'av01.0.05M.08', mp4a: 'mp4a.40.2', opus: 'opus', flac: 'flac' },
  'video/webm': { vp8: 'vp8', vp09: 'vp09.00.10.08', av01: 'av01.0.05M.08', opus: 'opus', vorbis: 'vorbis' },
  'audio/mp4': { mp4a: 'mp4a.40.2', opus: 'opus', flac: 'flac' },
  'audio/webm': { opus: 'opus', vorbis: 'vorbis' },
  'audio/mpeg': { mp3: '' },
};

export function probeMediaCapabilities() {
  const video = document.createElement('video');
  const result = {};
  for (const [container, families] of Object.entries(PROBES)) {
    const entry = { progressive: [], mse: [] };
    for (const [family, codec] of Object.entries(families)) {
      const type = codec ? `${container}; codecs="${codec}"` : container;
      if (video.canPlayType(type) === 'probably' || (!codec && video.canPlayType(type))) entry.progressive.push(family);
      if (globalThis.MediaSource?.isTypeSupported(type)) entry.mse.push(family);
    }
    result[container] = entry;
  }
  return result;
}

export class MediaHost {
  #players = new Map();
  #layer;
  #send;
  #soundAllowed;

  // `layer` is the element that holds the videos, under the canvas.
  // `soundAllowed`: the embedder knows autoplay with sound is permitted (a
  // kiosk policy, an iframe allow="autoplay"); never fall back to muted.
  constructor(layer, send, { soundAllowed = false } = {}) {
    this.#layer = layer;
    this.#send = send;
    this.#soundAllowed = soundAllowed;
  }

  // A user gesture anywhere in the host page: videos muted only to get past
  // the autoplay policy get their sound back. Activation is sticky for the
  // page's lifetime, so this happens at most once per page load.
  userGesture() {
    for (const player of this.#players.values()) {
      if (player.forcedMute) {
        player.forcedMute = false;
        player.video.muted = player.muted;
      }
      if (player.wantsPlay && player.video.paused) this.#play(player);
    }
  }

  handleEvent(name, data) {
    const player = this.#players.get(data.id);
    switch (name) {
    case 'media.create': return this.#create(data);
    case 'media.destroy': return this.#destroy(data.id);
    }
    if (!player) return;
    switch (name) {
    case 'media.attachSource': return this.#attachSource(player);
    case 'media.load': player.video.src = data.url; return;
    case 'media.addSourceBuffer': return this.#addSourceBuffer(player, data);
    case 'media.removeSourceBuffer': return this.#withSource(player, () => {
      const buffer = player.buffers.get(data.sb);
      player.buffers.delete(data.sb);
      if (buffer?.native && player.source.readyState === 'open') player.source.removeSourceBuffer(buffer.native);
    });
    case 'media.remove': return this.#bufferOp(player, data, (native) => native.remove(data.start, data.end === null ? Infinity : data.end));
    case 'media.abort': return this.#withBuffer(player, data.sb, (buffer) => { if (buffer.native.updating) buffer.native.abort(); });
    case 'media.setTimestampOffset': return this.#withBuffer(player, data.sb, (buffer) => { buffer.native.timestampOffset = data.offset; });
    case 'media.setAppendWindow': return this.#withBuffer(player, data.sb, (buffer) => {
      buffer.native.appendWindowStart = 0;
      buffer.native.appendWindowEnd = data.end === null ? Infinity : data.end;
      buffer.native.appendWindowStart = data.start;
    });
    case 'media.setMode': return this.#withBuffer(player, data.sb, (buffer) => { buffer.native.mode = data.mode; });
    case 'media.duration':
      player.pendingDuration = data.duration;
      return this.#withSource(player, () => this.#applyPendingDuration(player));
    case 'media.endOfStream': return this.#withSource(player, () => this.#whenIdle(player, () => {
      if (player.source.readyState === 'open') player.source.endOfStream(data.error || undefined);
    }));
    case 'media.play': player.wantsPlay = true; return this.#play(player);
    case 'media.pause': player.wantsPlay = false; player.video.pause(); return;
    case 'media.seek': player.video.currentTime = data.time; return;
    case 'media.rate': player.video.playbackRate = data.rate; return;
    case 'media.volume': player.video.volume = Math.min(1, Math.max(0, data.volume)); return;
    case 'media.muted':
      player.muted = data.muted;
      if (!player.forcedMute) player.video.muted = data.muted;
      return;
    case 'media.layout': return this.#layout(player, data.rect);
    }
  }

  append(id, sb, bytes) {
    const player = this.#players.get(id);
    if (!player) return;
    this.#bufferOp(player, { sb }, (native) => native.appendBuffer(bytes));
  }

  // --- players ----------------------------------------------------------------

  #create({ id }) {
    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    Object.assign(video.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', objectFit: 'contain', background: 'black', display: 'none' });
    this.#layer.append(video);
    const player = { id, video, source: null, sourceOpen: null, buffers: new Map(), muted: false, forcedMute: false, wantsPlay: false, pendingDuration: undefined, stateQueued: false };
    for (const type of STATE_EVENTS) video.addEventListener(type, () => this.#queueState(player, type));
    video.addEventListener('timeupdate', () => this.#queueState(player, 'timeupdate'));
    this.#players.set(id, player);
  }

  #destroy(id) {
    const player = this.#players.get(id);
    if (!player) return;
    this.#players.delete(id);
    player.video.pause();
    player.video.removeAttribute('src');
    player.video.load();
    if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
    player.video.remove();
  }

  #attachSource(player) {
    const source = new MediaSource();
    player.source = source;
    player.sourceOpen = new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true }));
    player.objectUrl = URL.createObjectURL(source);
    player.video.src = player.objectUrl;
  }

  #withSource(player, fn) {
    if (!player.sourceOpen) return;
    player.sourceOpen.then(fn).catch((error) => console.warn('[media]', error));
  }

  #addSourceBuffer(player, { sb, type }) {
    const buffer = { id: sb, native: null, queue: [], running: false, failed: null, ready: null };
    player.buffers.set(sb, buffer);
    buffer.ready = (player.sourceOpen ?? Promise.reject(new Error('no MediaSource'))).then(() => {
      buffer.native = player.source.addSourceBuffer(type);
      buffer.native.addEventListener('updateend', () => this.#runQueue(player, buffer));
    }).catch((error) => {
      buffer.failed = String(error);
    });
  }

  #withBuffer(player, sb, fn) {
    const buffer = player.buffers.get(sb);
    if (!buffer) return;
    buffer.ready.then(() => buffer.native && fn(buffer));
  }

  // Appends and removals are serialized per buffer: each waits for the
  // previous one's updateend, and its completion is reported to the engine.
  #bufferOp(player, { sb }, op) {
    const buffer = player.buffers.get(sb);
    if (!buffer) return;
    buffer.queue.push(op);
    buffer.ready.then(() => {
      if (buffer.failed) {
        buffer.queue.length = 0;
        return this.#finishOp(player, buffer, buffer.failed);
      }
      if (!buffer.running && !buffer.native.updating) this.#runQueue(player, buffer);
    });
  }

  #runQueue(player, buffer) {
    if (buffer.running) {
      buffer.running = false;
      this.#finishOp(player, buffer, null);
    }
    if (!buffer.queue.length || buffer.native.updating) {
      this.#applyPendingDuration(player);
      return;
    }
    const op = buffer.queue.shift();
    buffer.running = true;
    try {
      op(buffer.native);
    } catch (error) {
      buffer.running = false;
      this.#finishOp(player, buffer, String(error));
      this.#runQueue(player, buffer);
    }
  }

  #finishOp(player, buffer, error) {
    const ranges = [];
    try {
      const buffered = buffer.native?.buffered;
      for (let i = 0; buffered && i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
    } catch {}
    this.#send('media.bufferDone', { id: player.id, sb: buffer.id, buffered: ranges, error });
  }

  #applyPendingDuration(player) {
    if (player.pendingDuration === undefined || player.source?.readyState !== 'open') return;
    if ([...player.buffers.values()].some((b) => b.native?.updating)) return;
    try {
      player.source.duration = player.pendingDuration === null ? Infinity : player.pendingDuration;
    } catch {}
    player.pendingDuration = undefined;
  }

  #whenIdle(player, fn) {
    const busy = [...player.buffers.values()].filter((b) => b.native?.updating);
    if (!busy.length) return fn();
    busy[0].native.addEventListener('updateend', () => this.#whenIdle(player, fn), { once: true });
  }

  // Unmuted first. Only a NotAllowedError from the autoplay policy falls back to
  // muted playback, and the next user gesture restores the sound. The engine
  // stays the source of truth: if it paused meanwhile, nothing plays.
  async #play(player) {
    const video = player.video;
    try {
      await video.play();
    } catch (error) {
      if (error?.name !== 'NotAllowedError' || this.#soundAllowed || video.muted || !player.wantsPlay) return;
      player.forcedMute = true;
      video.muted = true;
      try {
        await video.play();
      } catch {}
    }
    if (!player.wantsPlay && !video.paused) video.pause();
  }

  #layout(player, rect) {
    const style = player.video.style;
    if (!rect) {
      style.display = 'none';
      return;
    }
    Object.assign(style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  #queueState(player, reason) {
    (player.reasons ??= new Set()).add(reason);
    if (player.stateQueued) return;
    player.stateQueued = true;
    queueMicrotask(() => {
      player.stateQueued = false;
      const reasons = [...player.reasons];
      player.reasons.clear();
      const video = player.video;
      const buffered = [];
      for (let i = 0; i < video.buffered.length; i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]);
      this.#send('media.state', {
        id: player.id,
        reasons,
        currentTime: video.currentTime,
        // NaN (unknown) and Infinity (live) do not survive JSON.
        duration: Number.isFinite(video.duration) ? video.duration : (Number.isNaN(video.duration) ? null : -1),
        paused: video.paused,
        ended: video.ended,
        seeking: video.seeking,
        readyState: video.readyState,
        networkState: video.networkState,
        rate: video.playbackRate,
        // Muted by the host to get past the autoplay policy, which the page
        // must see as muted until a gesture lifts it.
        muted: video.muted,
        width: video.videoWidth,
        height: video.videoHeight,
        error: video.error ? video.error.code : 0,
        buffered,
      });
    });
  }
}
