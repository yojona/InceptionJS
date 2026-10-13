// The browser entry point: the <inception-view> element, its configuration, and
// the protocol client for driving a view from elsewhere (an iframe, a worker, a
// remote agent over WebSocket).
export { Inception, InceptionView } from './host/inception-view.js';
export {
  PROTOCOL_VERSION,
  ErrorCode,
  REASON_CODES,
  ProtocolError,
  ProtocolClient,
  createPostMessageTransport,
  createWebSocketTransport,
} from './host/protocol.js';
export { check } from './check.js';
