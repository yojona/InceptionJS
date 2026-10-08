// Evaluated by the engine in each new window before page scripts. APIs this
// engine does not build exist anyway and answer as a browser that declined
// them would: feature detection sees them, and every request is refused with
// the error a page already handles.
(() => {
  const denied = (what) => new DOMException(`${what} is not allowed`, 'NotAllowedError');
  const define = (target, name, value) => {
    if (!(name in target)) Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: false });
  };

  // WebRTC: connections can be created, but never negotiate.
  if (typeof RTCPeerConnection === 'undefined') {
    class RTCSessionDescription {
      constructor({ type = '', sdp = '' } = {}) { this.type = type; this.sdp = sdp; }
      toJSON() { return { type: this.type, sdp: this.sdp }; }
    }
    class RTCIceCandidate {
      constructor({ candidate = '', sdpMid = null, sdpMLineIndex = null } = {}) { Object.assign(this, { candidate, sdpMid, sdpMLineIndex }); }
      toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; }
    }
    class RTCPeerConnection extends EventTarget {
      connectionState = 'new';
      iceConnectionState = 'new';
      iceGatheringState = 'new';
      signalingState = 'stable';
      localDescription = null;
      remoteDescription = null;
      #refuse = () => Promise.reject(denied('WebRTC'));
      createOffer() { return this.#refuse(); }
      createAnswer() { return this.#refuse(); }
      setLocalDescription() { return this.#refuse(); }
      setRemoteDescription() { return this.#refuse(); }
      addIceCandidate() { return this.#refuse(); }
      createDataChannel() { throw denied('WebRTC'); }
      addTrack() { throw denied('WebRTC'); }
      addTransceiver() { throw denied('WebRTC'); }
      getSenders() { return []; }
      getReceivers() { return []; }
      getTransceivers() { return []; }
      getStats() { return Promise.resolve(new Map()); }
      getConfiguration() { return {}; }
      close() { this.connectionState = this.signalingState = 'closed'; }
    }
    define(globalThis, 'RTCPeerConnection', RTCPeerConnection);
    define(globalThis, 'RTCSessionDescription', RTCSessionDescription);
    define(globalThis, 'RTCIceCandidate', RTCIceCandidate);
  }

  // Cameras and microphones: none to enumerate, and every request refused.
  if (!navigator.mediaDevices) {
    const mediaDevices = new EventTarget();
    mediaDevices.getUserMedia = () => Promise.reject(denied('Camera and microphone access'));
    mediaDevices.getDisplayMedia = () => Promise.reject(denied('Screen capture'));
    mediaDevices.enumerateDevices = () => Promise.resolve([]);
    mediaDevices.getSupportedConstraints = () => ({});
    define(Navigator.prototype, 'mediaDevices', mediaDevices);
  }

  // Speech synthesis: no voices; speaking fails as "not-allowed".
  if (typeof speechSynthesis === 'undefined') {
    class SpeechSynthesisUtterance extends EventTarget {
      constructor(text = '') {
        super();
        Object.assign(this, { text: String(text), lang: '', voice: null, volume: 1, rate: 1, pitch: 1 });
      }
    }
    class SpeechSynthesisErrorEvent extends Event {
      constructor(type, init = {}) { super(type); this.error = init.error; this.utterance = init.utterance; }
    }
    const synthesis = new EventTarget();
    Object.assign(synthesis, { pending: false, speaking: false, paused: false });
    synthesis.getVoices = () => [];
    synthesis.speak = (utterance) => setTimeout(() => {
      const event = new SpeechSynthesisErrorEvent('error', { error: 'not-allowed', utterance });
      utterance.onerror?.(event);
      utterance.dispatchEvent(event);
    });
    synthesis.cancel = synthesis.pause = synthesis.resume = () => {};
    define(globalThis, 'speechSynthesis', synthesis);
    define(globalThis, 'SpeechSynthesisUtterance', SpeechSynthesisUtterance);
    define(globalThis, 'SpeechSynthesisErrorEvent', SpeechSynthesisErrorEvent);
  }

  // Media Session: metadata and handlers are accepted; nothing shows them yet.
  if (!('mediaSession' in navigator)) {
    class MediaMetadata {
      constructor({ title = '', artist = '', album = '', artwork = [] } = {}) { Object.assign(this, { title, artist, album, artwork }); }
    }
    define(Navigator.prototype, 'mediaSession', {
      metadata: null,
      playbackState: 'none',
      setActionHandler() {},
      setPositionState() {},
      setCameraActive() {},
      setMicrophoneActive() {},
    });
    define(globalThis, 'MediaMetadata', MediaMetadata);
  }
})();
