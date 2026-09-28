// deno-lint-ignore-file no-control-regex
// HTTP framing deliberately rejects ASCII control bytes.
import {
  type GuestHttpReply,
  type GuestMethod,
  type HeaderPairs,
  validateGuestPath,
} from "./guest_http.ts";
export type DatasetteState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "stuck";
export interface DatasetteSnapshot {
  state: DatasetteState;
  session?: string;
  prefix?: string;
  error?: string;
  logTail?: string;
}
export interface GuestRequest {
  type: "guest-http-request" | "datasette-http";
  session: string;
  requestId: string;
  method: GuestMethod;
  path: string;
  headers: HeaderPairs;
}
export interface GuestAbort {
  type: "guest-http-abort" | "datasette-abort";
  session: string;
  requestId: string;
}
export type GuestReply =
  | (
    & { type: "guest-http-response"; session: string; requestId: string }
    & GuestHttpReply
  )
  | {
    type: "guest-http-error";
    session: string;
    requestId: string;
    code: number;
    message: string;
  };
export interface LifecycleMessage {
  type: "datasette-start" | "datasette-stop" | "datasette-reset";
  requestId: string;
}
export interface LifecycleReply {
  type: "datasette-state";
  requestId?: string;
  snapshot: DatasetteSnapshot;
}
export interface OwnerMessage {
  type:
    | "datasette-register"
    | "datasette-registered"
    | "datasette-ping"
    | "datasette-pong"
    | "datasette-find-owner"
    | "datasette-unregister";
  session: string;
  nonce: string;
  prefix?: string;
  hashes?: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !/[\x00-\x20\x7f]/.test(value);
}
function scoped(value: Record<string, unknown>): boolean {
  return typeof value.session === "string" && UUID.test(value.session) &&
    id(value.requestId);
}
function headers(value: unknown): value is HeaderPairs {
  return Array.isArray(value) && value.length <= 256 &&
    value.every((pair) =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" &&
      TOKEN.test(pair[0]) && typeof pair[1] === "string" &&
      !/[\x00-\x1f\x7f]/.test(pair[1])
    );
}
export function parseGuestRequest(value: unknown): GuestRequest | undefined {
  const v = object(value);
  if (
    !v || !scoped(v) || !headers(v.headers) || typeof v.path !== "string" ||
    (v.type !== "guest-http-request" && v.type !== "datasette-http") ||
    (v.method !== "GET" && v.method !== "HEAD")
  ) return;
  try {
    validateGuestPath(
      v.session as string,
      `/apps/datasette/${v.session}/`,
      v.path,
    );
  } catch {
    return;
  }
  return v as unknown as GuestRequest;
}
export function parseGuestAbort(value: unknown): GuestAbort | undefined {
  const v = object(value);
  if (
    v && scoped(v) &&
    (v.type === "guest-http-abort" || v.type === "datasette-abort")
  ) return v as unknown as GuestAbort;
}
export function parseGuestReply(value: unknown): GuestReply | undefined {
  const v = object(value);
  if (!v || !scoped(v)) return;
  if (
    v.type === "guest-http-response" && Number.isInteger(v.status) &&
    (v.status as number) >= 200 && (v.status as number) <= 599 &&
    headers(v.headers) && v.body instanceof ArrayBuffer &&
    v.body.byteLength <= 16 * 1024 * 1024
  ) return v as unknown as GuestReply;
  if (
    v.type === "guest-http-error" &&
    [405, 502, 503, 504].includes(v.code as number) &&
    typeof v.message === "string"
  ) return v as unknown as GuestReply;
}
export function parseLifecycleMessage(
  value: unknown,
): LifecycleMessage | undefined {
  const v = object(value);
  if (
    v && id(v.requestId) &&
    ["datasette-start", "datasette-stop", "datasette-reset"].includes(
      v.type as string,
    )
  ) return v as unknown as LifecycleMessage;
}
export function parseOwnerMessage(value: unknown): OwnerMessage | undefined {
  const v = object(value);
  if (
    !v || typeof v.session !== "string" || !UUID.test(v.session) ||
    !id(v.nonce) ||
    ![
      "datasette-register",
      "datasette-registered",
      "datasette-ping",
      "datasette-pong",
      "datasette-find-owner",
      "datasette-unregister",
    ].includes(v.type as string)
  ) return;
  if (
    v.type === "datasette-register" &&
    (v.prefix !== `/apps/datasette/${v.session}/` || !Array.isArray(v.hashes) ||
      !v.hashes.length ||
      !v.hashes.every((hash) =>
        typeof hash === "string" && /^sha256-[A-Za-z0-9+/]{43}=$/.test(hash)
      ))
  ) return;
  return v as unknown as OwnerMessage;
}
