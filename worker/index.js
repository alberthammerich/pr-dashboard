// Swaps a GitHub OAuth `code` for an access token. GitHub's token endpoint sends no CORS headers,
// so the static page can't call it directly. Stateless: nothing is stored or logged.
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

    const { code } = await req.json().catch(() => ({}));
    if (typeof code !== "string" || !code) return Response.json({ error: "missing_code" }, { status: 400, headers: cors });

    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, code }),
    });
    return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  },
};
