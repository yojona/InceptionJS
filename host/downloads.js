// Files the page downloads. The engine fetches them and streams the bytes
// here; the view dispatches events and hands the embedder the finished file.
// It saves the file to the person's disk only when the embedder's policy says
// so (policy.downloads === 'save'); 'block' cancels downloads as they start
// and reports them as downloadblocked. Downloads are held in memory, so one
// larger than policy.maxDownloadBytes is cancelled with an error.
//   downloadblocked  {url, filename, mime, size, reason: 'policy' | 'no-gesture'}
//   downloadstart    {id, url, filename, mime, size, userGesture}
//   downloadprogress {id, received, size}
//   downloadpause    {id, received}
//   downloadresume   {id, received}; after a restart (the server could not
//                    continue) received is 0 and the file starts over
//   downloadfinish   {id, filename, mime, error?, blob?}; preventDefault()
//                    keeps the view from saving it when the policy says save
export class Downloads {
  #view;
  #send;
  #policy;
  #active = new Map();

  // `send(command, args)` talks to the engine; `policy()` is the effective policy.
  constructor(view, send, policy) {
    this.#view = view;
    this.#send = send;
    this.#policy = policy;
  }

  handleEvent(name, data) {
    if (name === 'download.started') {
      const { downloads, gesturelessDownloads } = this.#policy();
      const reason = downloads === 'block' ? 'policy' : data.userGesture === false && gesturelessDownloads !== 'allow' ? 'no-gesture' : null;
      if (reason) {
        this.#send('download.cancel', { id: data.id });
        this.#view.dispatchEvent(new CustomEvent('downloadblocked', { detail: { url: data.url, filename: data.filename, mime: data.mime, size: data.size, reason } }));
        return;
      }
      this.#active.set(data.id, { ...data, chunks: [], received: 0 });
      this.#view.dispatchEvent(new CustomEvent('downloadstart', { detail: data }));
    } else if (name === 'download.progress') {
      this.#view.dispatchEvent(new CustomEvent('downloadprogress', { detail: data }));
    } else if (name === 'download.paused') {
      this.#view.dispatchEvent(new CustomEvent('downloadpause', { detail: data }));
    } else if (name === 'download.resumed') {
      this.#view.dispatchEvent(new CustomEvent('downloadresume', { detail: data }));
    } else if (name === 'download.restarted') {
      const entry = this.#active.get(data.id);
      if (entry) Object.assign(entry, { chunks: [], received: 0 });
      this.#view.dispatchEvent(new CustomEvent('downloadresume', { detail: { id: data.id, received: 0 } }));
    } else if (name === 'download.finished') {
      const entry = this.#active.get(data.id);
      if (!entry) return;
      this.#active.delete(data.id);
      const error = entry.tooLarge ? 'The file is larger than the view keeps in memory' : data.error;
      const detail = { id: data.id, filename: safeFilename(entry.filename), mime: entry.mime ?? '', error };
      if (!error) detail.blob = new Blob(entry.chunks, { type: entry.mime || 'application/octet-stream' });
      const event = new CustomEvent('downloadfinish', { detail, cancelable: true });
      this.#view.dispatchEvent(event);
      if (detail.blob && !event.defaultPrevented && this.#policy().downloads === 'save') save(detail.blob, detail.filename);
    }
  }

  chunk({ id, bytes }) {
    const entry = this.#active.get(id);
    if (!entry || entry.tooLarge) return;
    entry.received += bytes.byteLength;
    if (entry.received > this.#policy().maxDownloadBytes) {
      entry.tooLarge = true;
      entry.chunks = [];
      this.#send('download.cancel', { id });
      return;
    }
    entry.chunks.push(bytes);
  }
}

// The name comes from the server; it must never carry a path or control characters.
export function safeFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return base || 'download';
}

function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
