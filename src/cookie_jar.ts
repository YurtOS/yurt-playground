export type SetCookieOutcome = "stored" | "deleted" | "ignored" | "rejected";
export const JAR_LIMITS = {
  count: 50,
  cookieBytes: 4096,
  totalBytes: 32 * 1024,
} as const;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface Cookie {
  name: string;
  value: string;
  path: string;
  expires?: number;
  created: number;
}

const sizeOf = (cookie: { name: string; value: string }) =>
  cookie.name.length + cookie.value.length;

const defaultPath = (requestPath: string) => {
  const path = requestPath.split("?")[0];
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
};

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** Keeps guest cookies in the coordinator because browser headers cannot set them. */
export class CookieJar {
  #cookies = new Map<string, Cookie>();
  #sequence = 0;

  #purge(now: number) {
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        this.#cookies.delete(key);
      }
    }
  }

  set(raw: string, requestPath: string, now: number): SetCookieOutcome {
    const [pair, ...attributes] = raw.split(";");
    const equals = pair.indexOf("=");
    if (equals <= 0) return "ignored";

    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!TOKEN.test(name)) return "ignored";

    let path = defaultPath(requestPath);
    let expires: number | undefined;
    let maxAge: number | undefined;
    for (const attribute of attributes) {
      const equals = attribute.indexOf("=");
      const key = (equals < 0 ? attribute : attribute.slice(0, equals))
        .trim()
        .toLowerCase();
      const value = equals < 0 ? "" : attribute.slice(equals + 1).trim();
      if (key === "path" && value.startsWith("/")) path = value;
      else if (key === "max-age" && /^-?\d+$/.test(value)) {
        maxAge = Number(value);
      } else if (key === "expires") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) expires = parsed;
      }
    }
    if (maxAge !== undefined) expires = now + maxAge * 1000;

    const id = `${name}\0${path}`;
    if (expires !== undefined && expires <= now) {
      this.#cookies.delete(id);
      return "deleted";
    }
    if (sizeOf({ name, value }) > JAR_LIMITS.cookieBytes) return "ignored";

    this.#purge(now);
    const existing = this.#cookies.get(id);
    let total = sizeOf({ name, value });
    for (const cookie of this.#cookies.values()) {
      if (cookie !== existing) total += sizeOf(cookie);
    }
    const count = this.#cookies.size + (existing ? 0 : 1);
    if (count > JAR_LIMITS.count || total > JAR_LIMITS.totalBytes) {
      return "rejected";
    }

    this.#cookies.set(id, {
      name,
      value,
      path,
      expires,
      created: existing?.created ?? this.#sequence++,
    });
    return "stored";
  }

  header(path: string, now: number): string {
    this.#purge(now);
    const requestPath = path.split("?")[0];
    return [...this.#cookies.values()]
      .filter((cookie) => pathMatches(requestPath, cookie.path))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  clear(): void {
    this.#cookies.clear();
  }
}
