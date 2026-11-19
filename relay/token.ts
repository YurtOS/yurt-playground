/**
 * Per-tab relay tokens: `<id>.<expiry>.<mac>`, an HMAC-SHA256 under the
 * relay's secret. A page asks `/token` for one (from an allowed origin);
 * every `/dns` and `/tcp` request carries it, and the relay's caps count
 * against its id. Nothing is stored: the MAC is the proof.
 */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function mac(secret: string, body: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(body),
  );
  return base64url(new Uint8Array(signature));
}

/** A fresh token that expires `ttlMs` after `now`. */
export async function issueToken(
  secret: string,
  now: number,
  ttlMs: number,
): Promise<{ token: string; expires: number }> {
  const id = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const expires = now + ttlMs;
  const body = `${id}.${expires}`;
  return { token: `${body}.${await mac(secret, body)}`, expires };
}

/** The token's id when it is genuine and unexpired, else `undefined`. */
export async function verifyToken(
  secret: string,
  token: string,
  now: number,
): Promise<string | undefined> {
  const match = /^([A-Za-z0-9_-]{16})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(
    token,
  );
  if (match === null) return undefined;
  const [, id, expires, given] = match;
  if (Number(expires) <= now) return undefined;
  const expected = await mac(secret, `${id}.${expires}`);
  // Constant-time compare: both are 43 ASCII characters.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0 ? id : undefined;
}
