/** The qualified guest web apps the bridge may serve (spec section 2). The
 * port lives here and in coordinator state only, never in page or SW messages. */
export interface GuestAppDef {
  id: GuestAppId;
  port: number;
  title: string;
}

export type GuestAppId = "datasette" | "preview";

export const GUEST_APPS: Readonly<Record<GuestAppId, GuestAppDef>> = {
  datasette: { id: "datasette", port: 8001, title: "Datasette" },
  preview: { id: "preview", port: 8002, title: "Preview" },
};

export function isGuestAppId(value: unknown): value is GuestAppId {
  return typeof value === "string" && Object.hasOwn(GUEST_APPS, value);
}

export function appPrefix(app: GuestAppId, session: string): string {
  return `/apps/${app}/${session}/`;
}
