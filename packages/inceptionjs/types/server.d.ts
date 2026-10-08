export interface RelayTokenPayload {
  sub: string;
  origin: string;
  iat: number;
  exp: number;
}

/** A short-lived token for the relay (default 5 minutes). The secret needs 32+ characters. */
export declare function signRelayToken(options: {
  secret: string;
  subject?: string;
  origin?: string;
  ttlSeconds?: number;
  now?: number;
}): string;

/** The payload of an authentic, unexpired token for this origin; throws RelayTokenError otherwise. */
export declare function verifyRelayToken(
  token: string | null | undefined,
  options: { secret: string; origin?: string; now?: number; leewaySeconds?: number },
): RelayTokenPayload;

export declare class RelayTokenError extends Error {}

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Require ?token= signed with this secret (default: $INCEPTION_RELAY_SECRET). */
  secret?: string;
  /** Allowed page origins; empty allows any. */
  origins?: string[];
  /** Allow loopback connections to devPorts (development only). */
  dev?: boolean;
  devPorts?: number[];
  maxStreams?: number;
  connectTimeoutMs?: number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface Relay {
  url: string;
  port: number;
  close(): Promise<void>;
}

export declare function startRelay(options?: RelayOptions): Promise<Relay>;

export declare const CloseReason: Readonly<{
  Unknown: 0x01;
  Voluntary: 0x02;
  NetworkError: 0x03;
  Invalid: 0x41;
  Unreachable: 0x42;
  ConnectTimeout: 0x43;
  Refused: 0x44;
  Timeout: 0x47;
  Blocked: 0x48;
  Throttled: 0x49;
}>;

/** The special-purpose range a resolved address belongs to, or null when it is public. */
export declare function addressRange(address: string): string | null;
export declare function nameRefusal(hostname: string, options?: { dev?: boolean }): string | null;
export declare function connectRefusal(address: string, port: number, options?: { dev?: boolean; devPorts?: Set<number> }): string | null;
export declare const PUBLIC_PORTS: Set<number>;
