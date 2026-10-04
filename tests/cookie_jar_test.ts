import { assertEquals } from "@std/assert";
import { CookieJar, JAR_LIMITS } from "../src/cookie_jar.ts";

const P = "/apps/preview/s/";
const t0 = Date.UTC(2026, 9, 4);

Deno.test("stores, replaces and sends cookies; value may contain '='", () => {
  const jar = new CookieJar();
  assertEquals(
    jar.set("sid=a=b==; HttpOnly; Secure; Domain=x", P + "login", t0),
    "stored",
  );
  assertEquals(jar.header(P + "next", t0), "sid=a=b==");
  jar.set("sid=2", P + "login", t0);
  assertEquals(jar.header(P, t0), "sid=2");
});

Deno.test("default path is the request directory; Path scopes and orders", () => {
  const jar = new CookieJar();
  jar.set("a=1", P + "admin/login", t0); // default path P + "admin"
  jar.set("a=2; Path=" + P, P + "x", t0);
  assertEquals(jar.header(P + "admin/users", t0), "a=1; a=2"); // longer path first
  assertEquals(jar.header(P + "administrator", t0), "a=2"); // not a path match
  assertEquals(jar.header("/apps/preview/other/", t0), "");
});

Deno.test("Max-Age and Expires; Max-Age=0 deletes", () => {
  const jar = new CookieJar();
  jar.set("a=1; Max-Age=10", P, t0);
  assertEquals(jar.header(P, t0 + 9_000), "a=1");
  assertEquals(jar.header(P, t0 + 11_000), "");
  jar.set("b=1", P, t0);
  assertEquals(jar.set("b=; Max-Age=0", P, t0), "deleted");
  assertEquals(jar.header(P, t0), "");
  jar.set("c=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT", P, t0);
  assertEquals(jar.header(P, t0), "");
});

Deno.test("limits: oversize ignored, count and total reject new, replace allowed", () => {
  const jar = new CookieJar();
  assertEquals(
    jar.set("big=" + "x".repeat(JAR_LIMITS.cookieBytes), P, t0),
    "ignored",
  );
  for (let i = 0; i < JAR_LIMITS.count; i++) {
    assertEquals(jar.set(`k${i}=v`, P, t0), "stored");
  }
  assertEquals(jar.set("extra=v", P, t0), "rejected");
  assertEquals(jar.set("k0=w", P, t0), "stored"); // replacement
  jar.clear();
  for (let i = 0; i < 8; i++) {
    assertEquals(jar.set(`t${i}=` + "x".repeat(4000), P, t0), "stored");
  }
  assertEquals(jar.set("t8=" + "x".repeat(4000), P, t0), "rejected"); // > 32 KiB total
});

Deno.test("per-cookie limit counts UTF-8 bytes", () => {
  const atLimit = new CookieJar();
  assertEquals(atLimit.set("x=" + "€".repeat(1365), P, t0), "stored");

  const overLimit = new CookieJar();
  assertEquals(overLimit.set("x=" + "€".repeat(1366), P, t0), "ignored");
});

Deno.test("total jar limit counts UTF-8 bytes", () => {
  const jar = new CookieJar();
  for (let i = 0; i < 8; i++) {
    const value = "€".repeat(1364) + "ab";
    assertEquals(jar.set(`k${i}=${value}`, P, t0), "stored");
  }
  assertEquals(jar.set("extra=v", P, t0), "rejected");
});

Deno.test("malformed Set-Cookie is ignored", () => {
  const jar = new CookieJar();
  assertEquals(jar.set("novalue", P, t0), "ignored");
  assertEquals(jar.set("=x", P, t0), "ignored");
});
