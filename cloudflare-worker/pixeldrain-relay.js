// Cloudflare Worker: pixeldrain-relay
// Forwards any request (including binary upload bodies) to
// https://pixeldrain.com, preserving path, query, method and headers.
//
// Deploy (free plan):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create Worker
//   2. Name it "pixeldrain-relay", paste this file, Deploy.
//   3. Your relay URL: https://pixeldrain-relay.<username>.workers.dev
//   4. Set PIXELDRAIN_API_BASE on the HF Space to that URL.

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = "https://pixeldrain.com" + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.delete("host");

    const init = {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    };

    return fetch(target, init);
  },
};
