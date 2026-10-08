# PR Dashboard

A private, open-source dashboard for the GitHub pull requests **you're working on** — every PR
you've authored that's still **open**, plus everything you **closed/merged in the last 48 hours** —
grouped by repository, with **live CI status** you can expand check-by-check.

It's a single static HTML file. **No server, no build step, no accounts, no tracking.** It runs
entirely in your browser and talks only to the GitHub API.

👉 **Live:** https://alberthammerich.github.io/pr-dashboard/

## Why I built this

Because GitHub's own PR search and "your pull requests" overview are, frankly, shit — scattered
across tabs, no live CI at a glance, no clean per-repo grouping, and no single place to see
*everything you're currently working on*. I wanted one fast, searchable page that just shows me my
open and just-closed PRs with their CI status. So I made it.

## Features

- **Self-personalizing** — paste your token and it picks up *your* username, avatar, and PRs.
- **At-a-glance summary** — big-number cards for open, closed-in-48h, CI failing, and running.
- **Per-repo grouping** with failing/running badges on each repo.
- **Live CI** per PR (✓ pass · × fail · ◌ running) — expand any PR to see every check, linked to its run.
- **Instant search** across title / repo / branch / `#number`, plus filter chips (open · closed · failing · running).
- **One-click deploy** to your own GitHub (see below), plus **Refresh** and optional **auto-refresh** every 60s.
- Closed-PR window configurable in ⚙︎ Settings (default 48h).

## Use it

1. Open **https://alberthammerich.github.io/pr-dashboard/** and click **Sign in with GitHub**. Done.
   If your PRs live in an org with SSO, the org may need to approve the app once.

Work org asks for admin approval ("Request")? Skip it with the token you already have:
run `gh auth token | pbcopy` (GitHub CLI) and paste it into the page. SSO orgs work, no approval needed.

No GitHub CLI, or on a self-hosted copy?

1. Open the page.
2. Create a GitHub token: [github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=PR%20Dashboard)
   → tick **`repo`** → set **Expiration: No expiration** → **Generate**.
   *(Tracking only public repos? A no-scope token works too.)*
3. If your PRs live in an org with SSO, click **Configure SSO** on the token and authorize it.
4. Paste the token and hit **Open dashboard**. You won't paste it again on this browser.

## Is it safe? (yes — here's why)

- **No backend.** This is a static page. All data calls go straight to `api.github.com`.
  The one exception: **Sign in with GitHub** sends GitHub's one-time login code through a
  ~25-line relay ([`worker/index.js`](./worker/index.js)) that swaps it for a token, because GitHub's
  token endpoint can't be called from a browser. It stores and logs nothing. Pasting a token skips it.
- **Your token stays local.** It's saved only in your browser's `localStorage`, on your device.
  It is never embedded in the page, the repo, or anywhere else.
- **Read it yourself.** The entire app is [`index.html`](./index.html) plus its script, [`app.js`](./app.js). There are no
  dependencies, no bundler, no hidden requests, and no analytics.
- **Read-only in practice.** The dashboard only reads your PRs and check statuses. (GitHub's `repo`
  scope can't be narrowed to read-only for OAuth apps; paste a fine-grained read-only token if you want that.)
- **Revoke anytime** at [github.com/settings/tokens](https://github.com/settings/tokens), or click
  **Sign out** in the app to wipe it from your browser.

## Host your own copy

Three ways, easiest first:

- **One-click "Deploy to my GitHub"** *(recommended)* — on the live page, paste your token and hit
  **Deploy your own copy**. It uses your token to create a `pr-dashboard` repo on **your** account,
  upload the page, and turn on GitHub Pages — then hands you your own URL at
  `https://<you>.github.io/pr-dashboard/`. (Needs the `repo` scope.)
- **Fork & host manually:** fork this repo, enable **GitHub Pages** (Settings → Pages → branch root),
  and it's live at `https://<you>.github.io/pr-dashboard/`.
- **Run locally:** open `index.html` directly in a browser, or `python3 -m http.server` in the repo
  and visit the printed URL.

Once your copy is live, you paste your token there once (it lives in *your* browser, on *your*
origin) and never again.

## How it works

On connect, the page calls `GET /user` to learn who you are, then uses the GitHub Search API
(`/search/issues`) to find your open and recently-closed PRs. For each PR it reads the head commit's
**check-runs** and **combined status** to compute a CI rollup. Everything is rendered client-side.
The GitHub **GraphQL** API isn't usable here because it doesn't send CORS headers to browsers, so
this uses the REST API throughout.

## Running the sign-in relay

One-time setup for the maintainer's hosted copy (`worker/`, Cloudflare Workers free tier):

1. Create a GitHub OAuth App: Homepage and Callback URL = `https://alberthammerich.github.io/pr-dashboard/`.
2. Put its Client ID in `worker/wrangler.toml` (`CLIENT_ID`), then from `worker/`:
   `npx wrangler secret put CLIENT_SECRET` and `npx wrangler deploy`.
3. Set `OAUTH.clientId` and `OAUTH.exchange` (the printed `*.workers.dev` URL) in `app.js`.

Until those are set, the button stays hidden and the page works with pasted tokens.

## Contributing

Issues and pull requests are welcome. Found a bug or have an idea? [Open an issue](https://github.com/alberthammerich/pr-dashboard/issues/new/choose). Want to change something? Fork the repo, edit the single `index.html`, and open a PR.

Everything lands through pull requests — outside contributors work from a fork, and a maintainer reviews and merges. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the (short) details and [the code of conduct](./CODE_OF_CONDUCT.md).

## Credits

Display type is [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif) by Rodrigo
Fuenzalida & Jonny Pinhorn, embedded under the [SIL Open Font License 1.1](./INSTRUMENT_SERIF_OFL.txt).

## License

[MIT](./LICENSE)
