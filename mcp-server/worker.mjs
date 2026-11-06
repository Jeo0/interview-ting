// Cloudflare Workers entry point.
// Bindings (see wrangler.toml): KV namespace FILES, secret MCP_TOKEN,
// optional var ALLOW_ORIGIN (e.g. https://<user>.github.io).
import { createHandler } from "./core.mjs";

export default {
  async fetch(request, env) {
    const store = {
      get: (k) => env.FILES.get(k),
      // Uploaded interview files expire after 30 days.
      put: (k, v) => env.FILES.put(k, v, { expirationTtl: 60 * 60 * 24 * 30 }),
      delete: (k) => env.FILES.delete(k),
    };
    const handle = createHandler({ store, token: env.MCP_TOKEN, allowOrigin: env.ALLOW_ORIGIN || "*" });
    return handle(request);
  },
};
