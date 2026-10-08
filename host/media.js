// Host side of the media bridge. Each engine media player is mirrored by a
// <video> element in the view, under the canvas: the engine paints a
// transparent hole where the video is, and the element shows through. Media
// Source players get a real MediaSource whose SourceBuffers receive the bytes
// the page appends inside the engine; decoding, audio and A/V sync are the host
// browser's. State flows back to the engine, which drives the page's media
// element from it.

import { encodeInitData } from './eme.js';
import { mediaLog } from './media-log.js';

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

const AUDIO_FAMILIES = new Set(['mp4a', 'opus', 'flac', 'vorbis', 'mp3']);

// Per container: the families the host plays progressively and through Media
// Source, and the video families its MediaCapabilities rate smooth and power
// efficient at 1080p30. Audio decoding is cheap; supported audio counts as both.
export async function probeMediaCapabilities() {
  const video = document.createElement('video');
  const result = {};
  const ratings = [];
  for (const [container, families] of Object.entries(PROBES)) {
    const entry = { progressive: [], mse: [], smooth: [], efficient: [] };
    for (const [family, codec] of Object.entries(families)) {
      const type = codec ? `${container}; codecs="${codec}"` : container;
      if (video.canPlayType(type) === 'probably' || (!codec && video.canPlayType(type))) entry.progressive.push(family);
      if (!globalThis.MediaSource?.isTypeSupported(type)) continue;
      entry.mse.push(family);
      if (AUDIO_FAMILIES.has(family) || container.startsWith('audio/')) {
        entry.smooth.push(family);
        entry.efficient.push(family);
        continue;
      }
      const query = { type: 'media-source', video: { contentType: type, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 } };
      ratings.push(navigator.mediaCapabilities?.decodingInfo(query).then((info) => {
        if (info.smooth) entry.smooth.push(family);
        if (info.powerEfficient) entry.efficient.push(family);
      }, () => {}));
    }
    result[container] = entry;
  }
  await Promise.all(ratings);
  return result;
}

export class MediaHost {
  #players = new Map();
  #layer;
  #send;
  #soundAllowed;
  #eme;
  #releasing = new Set();

  // `layer` is the element that holds the videos, under the canvas.
  // `soundAllowed`: the embedder knows autoplay with sound is permitted (a
  // kiosk policy, an iframe allow="autoplay"); never fall back to muted.
  // `eme`: the EncryptedMedia whose MediaKeys the videos decrypt with.
  constructor(layer, send, { soundAllowed = false, eme = null } = {}) {
    this.#layer = layer;
    this.#send = send;
    this.#soundAllowed = soundAllowed;
    this.#eme = eme;
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
    if (name !== 'media.layout') mediaLog(name, data);
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
    case 'media.setMediaKeys': return this.#setMediaKeys(player, data.keys);
    }
  }

  // Every element decrypting with these MediaKeys can play now.
  keysUsable(mediaKeys) {
    for (const player of this.#players.values()) {
      if (player.video.mediaKeys !== mediaKeys) continue;
      player.waitingForKey = false;
      mediaLog(`video ${player.id} keys usable`);
      this.#send('media.keysUsable', { id: player.id });
    }
  }

  append(id, sb, seq, bytes) {
    const player = this.#players.get(id);
    mediaLog('append', { id, sb, seq, bytes: bytes.byteLength, known: !!player });
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
    for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'emptied', 'ended', 'error', 'encrypted', 'waitingforkey'])
      video.addEventListener(type, () => mediaLog(`video ${id} ${type}`, { t: video.currentTime, readyState: video.readyState, networkState: video.networkState, paused: video.paused, muted: video.muted, keys: !!video.mediaKeys, error: video.error?.code ?? null }));
    video.addEventListener('timeupdate', () => this.#queueState(player, 'timeupdate'));
    // Encrypted media: the page's element fires "encrypted" with the same init
    // data, and reports waiting for a key while the host is.
    video.addEventListener('encrypted', (event) => {
      if (event.initData && event.initData.byteLength <= 64 * 1024)
        this.#send('media.encrypted', { id, initDataType: event.initDataType, initData: encodeInitData(event.initData) });
    });
    video.addEventListener('waitingforkey', () => { player.waitingForKey = true; this.#queueState(player, 'waitingforkey'); });
    for (const type of ['playing', 'timeupdate']) video.addEventListener(type, () => { player.waitingForKey = false; });
    this.#players.set(id, player);
  }

  #destroy(id) {
    const player = this.#players.get(id);
    if (!player) return;
    this.#players.delete(id);
    player.video.pause();
    player.video.removeAttribute('src');
    player.video.load();
    // A MediaKeys serves one element at a time: a page that moves on to its next
    // track reuses its MediaKeys on a new element, which fails until this one
    // lets go (after unloading: browsers refuse while media is loaded).
    if (player.video.mediaKeys) this.#releasing.add(this.#releaseKeys(player.video));
    if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
    player.video.remove();
  }

  #attachSource(player) {
    const source = new MediaSource();
    player.source = source;
    for (const type of ['sourceopen', 'sourceended', 'sourceclose']) source.addEventListener(type, () => mediaLog(`source of video ${player.id} ${type}`));
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
      mediaLog(`video ${player.id} addSourceBuffer ${sb}`, { type });
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
    mediaLog(`video ${player.id} buffer ${buffer.id} done ${seq}`, { buffered: ranges, error: error ?? null });
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
      mediaLog(`video ${player.id} play() resolved`, { muted: video.muted });
    } catch (error) {
      mediaLog(`video ${player.id} play() rejected`, { error: `${error?.name}: ${error?.message}`, activated: navigator.userActivation?.hasBeenActive ?? null });
      if (error?.name !== 'NotAllowedError' || this.#soundAllowed || video.muted || !player.wantsPlay) return;
      player.forcedMute = true;
      video.muted = true;
      try {
        await video.play();
      } catch {}
    }
    if (!player.wantsPlay && !video.paused) video.pause();
  }

  async #releaseKeys(video) {
    try {
      await video.setMediaKeys(null);
    } catch (error) {
      console.warn('[media] releasing MediaKeys:', error);
    }
  }

  async #setMediaKeys(player, keys) {
    try {
      const mediaKeys = keys ? await this.#eme?.mediaKeys(keys) : null;
      if (mediaKeys) {
        for (const other of this.#players.values()) {
          if (other !== player && other.video.mediaKeys === mediaKeys) this.#releasing.add(this.#releaseKeys(other.video));
        }
        await Promise.all(this.#releasing);
        this.#releasing.clear();
      }
      mediaLog(`video ${player.id} setMediaKeys`, { keys, same: player.video.mediaKeys === mediaKeys });
      await player.video.setMediaKeys(mediaKeys);
      mediaLog(`video ${player.id} setMediaKeys done`);
    } catch (error) {
      console.warn(`[media] setMediaKeys on video ${player.id}:`, error);
    }
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
        waitingForKey: !!player.waitingForKey,
        // Players check that frames are really being presented.
        ...(() => {
          const quality = video.getVideoPlaybackQuality?.();
          return quality ? { totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames } : {};
        })(),
        buffered,
      });
    });
  }
}
