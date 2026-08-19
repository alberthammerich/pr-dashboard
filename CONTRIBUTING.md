# Contributing

Thanks for wanting to help. PR Dashboard is a tiny project with a strict scope, so this is short.

## What it is (and what keeps it simple)

The whole app is **one file: `index.html`**. No build step, no framework, no dependencies, no bundler. It runs entirely in the browser and talks only to `api.github.com`. Keeping it a single self-contained file is a feature, not an accident — please don't add a build system, npm packages, or external runtime requests.

## Run it locally

No tooling required. Either open `index.html` directly, or serve the folder to match GitHub Pages locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

You'll need a GitHub token to see live data (the landing page walks you through it). **Never commit a token** — it lives only in your browser's `localStorage`, and nothing in this repo should ever contain one.

## Good things to know

- **The font** (Instrument Serif) is embedded as base64 so the page makes zero external font requests. Please keep it that way.
- **Data fetching** is client-side REST against `api.github.com` — no server, ever.
- The connected dashboard is hidden behind a token; the editorial landing page and setup are what logged-out visitors see.

## How to propose a change

1. **Fork** the repo and create a branch (`fix/…` or `feat/…`).
2. Make your change in `index.html` and **test it in a real browser** — click through the landing, connect a token, and exercise the search and filters.
3. Open a **pull request** against `master` with a short description and, for anything visual, a **before/after screenshot**.
4. A maintainer reviews and merges. **All changes land through pull requests** — nobody pushes to `master` directly, including for review reasons.

## Reporting bugs & ideas

Open an [issue](https://github.com/alberthammerich/pr-dashboard/issues/new/choose) — there are templates for bug reports and feature requests. When reporting a bug, include your browser and, if you can, a screenshot. **Redact your token** from anything you paste.

That's it. Small, careful changes are the most welcome kind.
