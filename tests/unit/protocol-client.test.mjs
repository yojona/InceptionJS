import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolClient, ProtocolError } from '../../host/protocol.js';

test('closing a client fails what it asked and was not answered', async () => {
  const sent = [];
  const transport = { onmessage: null, send: (message) => sent.push(message) };
  const client = new ProtocolClient(transport);
  const pending = client.request('view.find', { text: 'x' });
  const answered = client.request('view.state');
  transport.onmessage({ jsonrpc: '2.0', id: sent[1].id, result: { url: 'https://example.com/' } });
  client.close(ProtocolError.fromReason('not_ready', 'the host went away'));
  await assert.rejects(pending, (error) => error instanceof ProtocolError && error.data.reason === 'not_ready' && /went away/.test(error.message));
  assert.deepEqual(await answered, { url: 'https://example.com/' });
  // A late reply for a failed request is ignored.
  transport.onmessage({ jsonrpc: '2.0', id: sent[0].id, result: { found: true } });
});
