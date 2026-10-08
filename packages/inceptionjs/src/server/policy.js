// Where the relay may connect. The engine loads untrusted pages, so a page must
// never reach the relay host's own network: loopback, private and link-local
// ranges, cloud metadata, carrier-grade NAT (which includes Tailscale's
// addresses), and every special-purpose range are refused. Only the web's
// ports are allowed.

import net from 'node:net';

export const PUBLIC_PORTS = new Set([80, 443]);

// Names that only make sense on a local or private network.
const PRIVATE_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.home\.arpa$/i, /\.ts\.net$/i, /\.lan$/i];

// [network, prefix length, label]
const V4_BLOCKED = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special-purpose'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function v4ToInt(address) {
  return address.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function v4Range(address) {
  const value = v4ToInt(address);
  for (const [network, bits, label] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((value & mask) === (v4ToInt(network) & mask)) return label;
  }
  return null;
}

// Eight 16-bit groups.
function v6Groups(address) {
  let text = address.split('%')[0];
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v = v4ToInt(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = (part) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  const zeros = tail === undefined ? [] : new Array(8 - front.length - back.length).fill(0);
  return [...front, ...zeros, ...back];
}

function v6Range(address) {
  const g = v6Groups(address);
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Range(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Range(embeddedV4());
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return 'discard';
  // 2002::/16 (6to4) embeds an IPv4 address in groups 1-2.
  if (g[0] === 0x2002) return v4Range(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`);
  return null;
}

/** The range a resolved address belongs to when it is not public, else null. */
export function addressRange(address) {
  const family = net.isIP(address);
  if (family === 4) return v4Range(address);
  if (family === 6) return v6Range(address);
  return 'not an address';
}

/** Why a hostname is refused before resolving it, or null. */
export function nameRefusal(hostname, { dev = false } = {}) {
  if (!hostname || hostname.length > 253) return 'invalid hostname';
  if (net.isIP(hostname)) return dev ? null : 'direct IP addresses are not allowed';
  if (!dev && PRIVATE_NAMES.some((pattern) => pattern.test(hostname))) return 'private hostname';
  return null;
}

/**
 * Why a connection to a resolved address and port is refused, or null.
 * In development, loopback is allowed to the listed development ports only.
 */
export function connectRefusal(address, port, { dev = false, devPorts = new Set() } = {}) {
  const range = addressRange(address);
  if (range === 'loopback' && dev) return devPorts.has(port) ? null : `loopback port ${port}`;
  if (range) return range;
  if (!PUBLIC_PORTS.has(port)) return `port ${port}`;
  return null;
}
