/* node:http host for the API. Run with: npm run api  (PORT defaults to 8787) */
import http from "node:http";
import { createApi, MAX_BODY_BYTES } from "./handlers.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

/* X-Forwarded-For is caller-controlled unless something in front is rewriting
   it, and trusting it by default would let anyone reset their own rate limit
   by inventing an address. Opt in only when actually behind a proxy. */
const TRUST_PROXY = process.env.TDG_TRUST_PROXY === "1";
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

/* Past the cap this stops buffering but keeps draining, so the client still
   receives a 413 instead of a connection reset -- resetting mid-upload is what
   most clients surface as an unhelpful "socket hang up". A body several times
   over the cap is not worth the courtesy and gets dropped. */
const DRAIN_LIMIT = MAX_BODY_BYTES * 4;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        if (size > DRAIN_LIMIT) { req.destroy(); reject(Object.assign(new Error("body too large"), { tooLarge: true })); }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) reject(Object.assign(new Error("body too large"), { tooLarge: true }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export function createServer(opts) {
  const api = createApi(opts);
  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      const payload = obj === null ? "" : JSON.stringify(obj);
      res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    try {
      const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";
      let body = null;
      if (req.method === "POST") {
        let raw;
        try { raw = await readBody(req); }
        catch (e) {
          return send(e.tooLarge ? 413 : 400,
            { error: { code: e.tooLarge ? "body_too_large" : "bad_request", message: e.tooLarge ? `Body must be under ${MAX_BODY_BYTES} bytes` : "Could not read the request body" } });
        }
        try { body = raw ? JSON.parse(raw) : {}; }
        catch { return send(400, { error: { code: "invalid_json", message: "Body must be valid JSON" } }); }
      }
      const out = await api.handle({ method: req.method, path, body, ip: clientIp(req) });
      send(out.status, out.body);
    } catch (e) {
      send(500, { error: { code: "internal", message: "Unexpected error" } });
      console.error("[api]", e);
    }
  });
  return { server, api };
}

/* Started directly rather than imported by a test. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { server, api } = createServer();
  const port = Number(process.env.PORT) || 8787;
  api.pool.start().then(() => {
    server.listen(port, () => console.log(`test-data-generator api on http://localhost:${port}  (store: ${api.store.name})`));
  }).catch(e => { console.error("worker failed to start:", e.message); process.exit(1); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { api.pool.stop(); server.close(() => process.exit(0)); });
}
