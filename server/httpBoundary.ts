import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export const isLoopbackHost = (hostname: string): boolean => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());

export function trustedOrigin(origin: string, configured: string[] = []): boolean {
  if (configured.includes(origin) || origin === "tauri://localhost") return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && (isLoopbackHost(url.hostname) || url.hostname === "tauri.localhost") && !url.username && !url.password && url.origin === origin;
  } catch { return false; }
}

/** Local control-plane guard: prevent an unrelated website from operating the agent. */
export function checkHttpBoundary(request: IncomingMessage, response: ServerResponse, bindHost: string): boolean {
  const allowedOrigins = (process.env.SAKASAKA_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const origin = request.headers.origin;
  let reason: string | undefined;
  if (origin && !trustedOrigin(origin, allowedOrigins)) reason = "허용되지 않은 Origin입니다.";
  try {
    const host = new URL(`http://${request.headers.host ?? ""}`).hostname;
    const hosts = (process.env.SAKASAKA_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim());
    if (!isLoopbackHost(host) && !hosts.includes(host)) reason = "허용되지 않은 Host입니다.";
  } catch { reason = "잘못된 Host입니다."; }
  const token = process.env.SAKASAKA_API_TOKEN;
  if (request.method !== "OPTIONS" && (!isLoopbackHost(bindHost) || token)) {
    const actual = request.headers.authorization ?? "";
    const expected = `Bearer ${token ?? ""}`;
    if (!token || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) reason = "API 인증이 필요합니다.";
  }
  if (reason) {
    response.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: reason }));
    return false;
  }
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return true;
}
