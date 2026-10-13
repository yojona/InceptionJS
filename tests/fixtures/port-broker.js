// Test helper: a shared worker that hands the display channel's port from the
// document that owns an engine to a display document that may not be
// cross-origin isolated (a shared worker can carry ports between them).
const waiting = [];
let port = null;
onconnect = (event) => {
  const client = event.ports[0];
  client.onmessage = (e) => {
    if (e.data?.offer && e.ports[0]) {
      port = e.ports[0];
      for (const c of waiting.splice(0)) c.postMessage({ display: true }, [port]);
    } else if (e.data?.want) {
      if (port) client.postMessage({ display: true }, [port]);
      else waiting.push(client);
    }
  };
};
