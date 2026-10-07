// Swaps a GitHub OAuth `code` (sign-in) or `refresh_token` (renewal, tokens expire after 8h) for an access token.
// GitHub's token endpoint sends no CORS headers, so the static page can't call it directly.
// Stateless: nothing is stored, and Workers logging is off in wrangler.toml.
export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
    if (req.headers.get("Origin") !== env.ALLOWED_ORIGIN) return new Response("Forbidden", { status: 403, headers: cors });

    const { code, refresh_token } = await req.json().catch(() => ({}));
    const grant =
      typeof code === "string" && code ? { code }
      : typeof refresh_token === "string" && refresh_token ? { grant_type: "refresh_token", refresh_token }
      : null;
    if (!grant) return Response.json({ error: "missing_code" }, { status: 400, headers: cors });

    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, ...grant }),
    });
    return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  },
};
