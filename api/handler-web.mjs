/* Fetch-style adapter: (Request) => Response.
   Works on Netlify Functions v2, Vercel, Deno and Bun without changes.

   Serverless hosts freeze or discard the process between invocations, so the
   forked generation worker is re-created on cold start and the in-memory rate
   limiter resets with it. Put real rate limiting at the edge on those hosts. */
import { createApi, MAX_BODY_BYTES } from "./handlers.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

let api = null;

export default async function handler(request) {
  if (!api) api = createApi();
  const json = (status, obj) =>
    new Response(obj === null ? "" : JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  let body = null;
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: { code: "body_too_large", message: `Body must be under ${MAX_BODY_BYTES} bytes` } });
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { return json(400, { error: { code: "invalid_json", message: "Body must be valid JSON" } }); }
  }

  const ip = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const out = await api.handle({ method: request.method, path, body, ip });
  return json(out.status, out.body);
}
