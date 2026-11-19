/**
 * What the relay lets a tab reach: three ports, and public unicast
 * addresses only. The address rules mirror the Yurt runtime's egress
 * guard (the desktop app's), plus three special-purpose /24s it does not
 * list (AS112 and AMT): "public" is defined positively, so anything not
 * provably routable global unicast is refused.
 *
 * Dependency-free: the Cloudflare Worker and the Deno server both use it.
 */

/** HTTP, HTTPS and git's own protocol. */
export const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 9418]);

type V4 = [number, number, number, number];
type V6 = number[]; // eight 16-bit segments

function parseV4(s: string): V4 | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    // Canonical dotted quad only: no leading zeros, no octal or hex forms.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out as V4;
}

function parseV6(s: string): V6 | undefined {
  if (s.includes("%")) return undefined; // no zone ids: link-local only
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const segments = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.includes(".") && i === pieces.length - 1) {
        const v4 = parseV4(piece);
        if (v4 === undefined) return undefined;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = segments(halves[0]);
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = segments(halves[1]);
  if (tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

function publicV4(a: V4): boolean {
  const [x, y, z] = a;
  return !(
    x === 0 || // this network
    x === 10 || // private
    x === 127 || // loopback
    (x === 100 && y >= 64 && y <= 127) || // CGNAT
    (x === 169 && y === 254) || // link-local, cloud metadata
    (x === 172 && y >= 16 && y <= 31) || // private
    (x === 192 && y === 0 && z === 0) || // IETF protocol assignments
    (x === 192 && y === 0 && z === 2) || // documentation
    (x === 192 && y === 88 && z === 99) || // 6to4 relay anycast
    (x === 192 && y === 31 && z === 196) || // AS112-v4
    (x === 192 && y === 52 && z === 193) || // AMT
    (x === 192 && y === 175 && z === 48) || // AS112 direct delegation
    (x === 192 && y === 168) || // private
    (x === 198 && (y === 18 || y === 19)) || // benchmarking
    (x === 198 && y === 51 && z === 100) || // documentation
    (x === 203 && y === 0 && z === 113) || // documentation
    x >= 224 // multicast, reserved, broadcast
  );
}

function embeddedV4(s: V6): V4 | undefined {
  const v4 = (
    hi: number,
    lo: number,
  ): V4 => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeroHead = s.slice(0, 5).every((x) => x === 0);
  if (zeroHead && s[5] === 0xffff) return v4(s[6], s[7]); // ::ffff:a.b.c.d
  if (zeroHead && s[5] === 0 && (s[6] !== 0 || s[7] > 1)) return v4(s[6], s[7]);
  if (s[0] === 0x2002) return v4(s[1], s[2]); // 6to4
  if (s[0] === 0x2001 && s[1] === 0) return v4(~s[6] & 0xffff, ~s[7] & 0xffff); // Teredo
  return undefined;
}

function publicV6(s: V6): boolean {
  const v4 = embeddedV4(s);
  if (v4 !== undefined) return publicV4(v4);
  if ((s[0] & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  return !(
    (s[0] === 0x2001 && s[1] === 0x0db8) || // documentation
    (s[0] & 0xfff0) === 0x3ff0 || // documentation
    (s[0] === 0x2001 && s[1] === 0x0002 && s[2] === 0) // benchmarking
  );
}

/** Whether `ip`, a numeric address, is routable global unicast. Anything
 * that is not a numeric address is not. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4 !== undefined) return publicV4(v4);
  const v6 = parseV6(ip.replace(/^\[|\]$/g, ""));
  return v6 !== undefined && publicV6(v6);
}

/** Whether `ip` is a numeric IPv4 address (the guest's own addresses are). */
export function isIpv4(ip: string): boolean {
  return parseV4(ip) !== undefined;
}

/** A DNS name the relay will resolve: letters, digits, hyphens and dots,
 * at most 253 characters, with a dot (no single-label names). */
export function isHostname(name: string): boolean {
  if (name.length > 253 || !name.includes(".")) return false;
  return name.replace(/\.$/, "").split(".").every((label) =>
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
  );
}
