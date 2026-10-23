// Compiles against the published typings: each public method a page uses has
// a declaration. `npm run typecheck`.
import { Inception, createDisplay, ProfileConnection, type InceptionView, type RemoteWindow } from '../../packages/inceptionjs/types/index';

declare const view: InceptionView;
declare const remote: RemoteWindow;
declare const connection: ProfileConnection;
declare const canvas: HTMLCanvasElement;
declare const port: MessagePort;

export async function smoke() {
  Inception.configure({ engineUrl: '/engine/inception-engine.js', relayUrl: 'wss://relay.example/' });
  await view.ready;
  await view.navigate('https://example.com/');
  await view.edit('Paste');
  await view.pauseDownload(1);
  await view.resumeDownload(1);
  await view.cancelDownload(1);
  await view.deleteHistory({ from: 0 });
  view.close();
  const closed: boolean = view.closed;
  view.addEventListener('downloadstart', (e) => e.detail.initiator satisfies 'person' | 'agent' | 'page' | undefined);
  view.addEventListener('title', (e) => e.detail.title.length);

  await remote.deleteHistory({ url: 'https://example.com/' });
  const id: string = connection.id;
  const host: string | null = connection.hostId;

  const display = createDisplay(canvas, port);
  display.input('edit', { command: 'Copy' });
  display.setLevel({ muted: true });
  display.close();
  return { closed, id, host };
}
