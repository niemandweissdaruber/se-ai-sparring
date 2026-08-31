// ---------------------------------------------------------------------------
// Worker entry point.
//
// Cloudflare Workers have no equivalent of the Pages `functions/` convention,
// so the two API routes are dispatched here by path. The handlers themselves
// are untouched and keep their Pages signatures — they receive a `context`
// object with { request, env, waitUntil } — which means this repo still works
// as a Pages project if it ever needs to.
//
// Everything that is not an API route falls through to the static assets.
// ---------------------------------------------------------------------------

import { onRequestPost as chatOnRequestPost } from "../functions/api/chat.js";
import { onRequest as mcpOnRequest } from "../functions/api/mcp/seranking.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // Shape a Pages-style context so the handlers need no changes.
    // waitUntil matters: chat.js uses it to keep the worker alive while a
    // streamed response is still being written.
    const context = {
      request,
      env,
      waitUntil: (promise) => ctx.waitUntil(promise),
      // Pages handlers can call next() to defer to static assets.
      next: () => env.ASSETS.fetch(request),
    };

    if (pathname === "/api/chat") {
      // The handler is POST-only, matching the Pages export it came from.
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      return chatOnRequestPost(context);
    }

    // The MCP proxy forwards POST (JSON-RPC), GET (SSE channel) and DELETE
    // (session end), so every method goes through.
    if (pathname === "/api/mcp/seranking") {
      return mcpOnRequest(context);
    }

    return env.ASSETS.fetch(request);
  },
};
