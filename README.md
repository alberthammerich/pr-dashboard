# 🔭 PR Dashboard

A private, open-source dashboard for the GitHub pull requests **you're working on** — every PR
you've authored that's still **open**, plus everything you **closed/merged in the last 48 hours** —
grouped by repository, with **live CI status** you can expand check-by-check.

It's a single static HTML file. **No server, no build step, no accounts, no tracking.** It runs
entirely in your browser and talks only to the GitHub API.

👉 **Live:** https://alberthammerich.github.io/pr-dashboard/

![PR Dashboard](https://avatars.githubusercontent.com/u/54889469?v=4)

## Features

- **Self-personalizing** — paste your token and it picks up *your* username, avatar, and PRs.
- **Per-repo grouping** with at-a-glance failing/running badges.
- **Live CI** per PR (✅ pass · ❌ fail · 🟡 running) — click a PR to expand every individual
  check with links to its run.
- **Instant search** across title / repo / branch / `#number`, plus filter chips
  (Open · Closed/Merged · CI failing · CI running).
- **🔄 Refresh** + optional **auto-refresh** every 60s.
- Open + closed-in-48h window (configurable in ⚙︎ Settings).

## Use it

1. Open **https://alberthammerich.github.io/pr-dashboard/**.
2. Create a GitHub token: [github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=PR%20Dashboard)
   → tick **`repo`** → set **Expiration: No expiration** → **Generate**.
   *(Tracking only public repos? A no-scope token works too.)*
3. If your PRs live in an org with SSO, click **Configure SSO** on the token and authorize it.
4. Paste the token and hit **Connect**. You won't paste it again on this browser.

## Is it safe? (yes — here's why)

- **No backend.** This is a static page. Nothing you type is sent to any server — only direct
  HTTPS calls to `api.github.com`.
- **Your token stays local.** It's saved only in your browser's `localStorage`, on your device.
  It is never embedded in the page, the repo, or anywhere else.
- **Read it yourself.** The entire app is this one [`index.html`](./index.html). There are no
  dependencies, no bundler, no hidden requests, and no analytics.
- **Read-only.** The token is used only to read your PRs and check statuses.
- **Revoke anytime** at [github.com/settings/tokens](https://github.com/settings/tokens), or click
  **Sign out** in the app to wipe it from your browser.

## Run it yourself / fork it

It's just one file. Either:

- **Fork & host:** fork this repo, enable **GitHub Pages** (Settings → Pages → branch root), and
  your own copy is live at `https://<you>.github.io/pr-dashboard/`. Update `REPO_URL` near the top
  of the `<script>` in `index.html` to point at your fork.
- **Run locally:** open `index.html` directly in a browser, or `python3 -m http.server` in the repo
  and visit the printed URL.

## How it works

On connect, the page calls `GET /user` to learn who you are, then uses the GitHub Search API
(`/search/issues`) to find your open and recently-closed PRs. For each PR it reads the head commit's
**check-runs** and **combined status** to compute a CI rollup. Everything is rendered client-side.
The GitHub **GraphQL** API isn't usable here because it doesn't send CORS headers to browsers, so
this uses the REST API throughout.

## License

[MIT](./LICENSE)
