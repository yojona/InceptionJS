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
    // Every SourceBuffer operation runs in order through one queue per
    // buffer, as the page issued it; appends and removals report back by seq.
    case 'media.remove': return this.#enqueue(player, data.sb, { seq: data.seq, run: (native) => native.remove(data.start, data.end === null ? Infinity : data.end) });
    case 'media.abort': return this.#abort(player, data.sb);
    case 'media.setTimestampOffset': return this.#enqueue(player, data.sb, { run: (native) => { native.timestampOffset = data.offset; } });
    case 'media.setAppendWindow': return this.#enqueue(player, data.sb, { run: (native) => {
      native.appendWindowStart = 0;
      native.appendWindowEnd = data.end === null ? Infinity : data.end;
      native.appendWindowStart = data.start;
    } });
    case 'media.setMode': return this.#enqueue(player, data.sb, { run: (native) => { native.mode = data.mode; } });
    case 'media.duration':
      player.pendingDuration = data.duration;
      return this.#withSource(player, () => this.#applyPendingDuration(player));
    case 'media.endOfStream': return this.#withSource(player, () => this.#whenIdle(player, () => {
      try {
        if (player.source.readyState === 'open') player.source.endOfStream(data.error || undefined);
      } catch (error) {
        console.warn('[media] endOfStream:', error);
      }
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

  append(id, sb, seq, bytes) {
    const player = this.#players.get(id);
    if (!player) return;
    this.#enqueue(player, sb, { seq, run: (native) => native.appendBuffer(bytes) });
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
    video.addEventListener('error', () => console.warn(`[media] video ${id} error ${video.error?.code}: ${video.error?.message}`));
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
    const buffer = { id: sb, native: null, queue: [], running: null, failed: null, ready: null };
    player.buffers.set(sb, buffer);
    buffer.ready = (player.sourceOpen ?? Promise.reject(new Error('no MediaSource'))).then(() => {
      buffer.native = player.source.addSourceBuffer(type);
      buffer.native.addEventListener('updateend', () => this.#updateEnded(player, buffer));
      buffer.native.addEventListener('error', () => console.warn(`[media] SourceBuffer ${sb} (${type}) reported an error`));
    }).catch((error) => {
      console.warn(`[media] addSourceBuffer(${type}):`, error);
      buffer.failed = String(error);
    });
  }

  // Operations with a seq (appends, removals) complete on updateend and are
  // reported; the others apply at once, between them.
  #enqueue(player, sb, op) {
    const buffer = player.buffers.get(sb);
    if (!buffer) return;
    buffer.queue.push(op);
    buffer.ready.then(() => this.#pump(player, buffer));
  }

  #pump(player, buffer) {
    while (buffer.queue.length && !buffer.running) {
      if (buffer.failed) {
        const op = buffer.queue.shift();
        if (op.seq !== undefined) this.#report(player, buffer, op.seq, buffer.failed);
        continue;
      }
      if (buffer.native.updating) return;
      const op = buffer.queue.shift();
      try {
        op.run(buffer.native);
      } catch (error) {
        console.warn(`[media] SourceBuffer ${buffer.id}:`, error);
        if (op.seq !== undefined) this.#report(player, buffer, op.seq, `${error.name}: ${error.message}`);
        continue;
      }
      if (op.seq !== undefined) buffer.running = op;
    }
    this.#applyPendingDuration(player);
  }

  #updateEnded(player, buffer) {
    const op = buffer.running;
    buffer.running = null;
    if (op) this.#report(player, buffer, op.seq, null);
    this.#pump(player, buffer);
  }

  // The engine abandons its pending appends; nothing queued is reported.
  #abort(player, sb) {
    const buffer = player.buffers.get(sb);
    if (!buffer) return;
    buffer.queue = buffer.queue.filter((op) => op.seq === undefined);
    buffer.ready.then(() => {
      buffer.running = null;
      try {
        if (buffer.native?.updating) buffer.native.abort();
      } catch (error) {
        console.warn(`[media] SourceBuffer ${buffer.id} abort:`, error);
      }
      this.#pump(player, buffer);
    });
  }

  #report(player, buffer, seq, error) {
    const ranges = [];
    try {
      const buffered = buffer.native?.buffered;
      for (let i = 0; buffered && i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
    } catch {}
    this.#send('media.bufferDone', { id: player.id, sb: buffer.id, seq, buffered: ranges, error });
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
    const busy = [...player.buffers.values()].filter((b) => b.native?.updating || b.queue.length);
    if (!busy.length) return fn();
    setTimeout(() => this.#whenIdle(player, fn), 20);
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
