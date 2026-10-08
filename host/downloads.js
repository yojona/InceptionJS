// Files the page downloads. The engine fetches them and streams the bytes
// here; the view dispatches cancelable events and, unless the embedder takes
// over, saves the finished file the way the host browser saves any download.
//   downloadstart    {id, url, filename, mime, size}
//   downloadprogress {id, received, size}
//   downloadfinish   {id, filename, mime, error?, blob?}; preventDefault()
//                    keeps the host browser from saving it
export class Downloads {
  #view;
  #active = new Map();

  constructor(view) {
    this.#view = view;
  }

  handleEvent(name, data) {
    if (name === 'download.started') {
      this.#active.set(data.id, { ...data, chunks: [] });
      this.#view.dispatchEvent(new CustomEvent('downloadstart', { detail: data }));
    } else if (name === 'download.progress') {
      this.#view.dispatchEvent(new CustomEvent('downloadprogress', { detail: data }));
    } else if (name === 'download.finished') {
      const entry = this.#active.get(data.id);
      this.#active.delete(data.id);
      const detail = { id: data.id, filename: entry?.filename ?? 'download', mime: entry?.mime ?? '', error: data.error };
      if (!data.error && entry) detail.blob = new Blob(entry.chunks, { type: entry.mime || 'application/octet-stream' });
      const event = new CustomEvent('downloadfinish', { detail, cancelable: true });
      this.#view.dispatchEvent(event);
      if (detail.blob && !event.defaultPrevented) save(detail.blob, detail.filename);
    }
  }

  chunk({ id, bytes }) {
    this.#active.get(id)?.chunks.push(bytes);
  }
}

function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
