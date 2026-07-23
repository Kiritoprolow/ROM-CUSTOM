// Cloudflare Worker: pixeldrain-relay
// Forwards any request (including binary upload bodies) to
// https://pixeldrain.com, preserving path, query, method and headers.
//
// Deploy (free plan):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create Worker
//   2. Name it "pixeldrain-relay", paste this file, Deploy.
//   3. Your relay URL: https://pixeldrain-relay.<username>.workers.dev
//   4. Set PIXELDRAIN_API_BASE on the HF Space to that URL.
//   5. Worker Settings -> Variables -> add secret RELAY_KEY; set the same
//      value as secret PIXELDRAIN_RELAY_KEY on the HF Space. Requests
//      without a matching X-Relay-Key header are rejected with 403.

export default {
  async fetch(request, env) {
    if (env.RELAY_KEY && request.headers.get("X-Relay-Key") !== env.RELAY_KEY) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    const target = "https://pixeldrain.com" + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("X-Relay-Key");

    const init = {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    };

    return fetch(target, init);
  },
};
