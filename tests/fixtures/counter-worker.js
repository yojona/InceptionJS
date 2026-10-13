// Test helper: a shared worker that counts the ports it has been given and answers with its start time.
const started = Date.now();
let ports = 0;
onconnect = (event) => {
  const port = event.ports[0];
  ports++;
  port.onmessage = () => port.postMessage({ started, ports });
};
