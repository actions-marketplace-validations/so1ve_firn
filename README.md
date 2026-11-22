<img src="assets/logo.svg" alt="Firn" width="56" height="56" />

# Firn

Stateful Nix binary cache backed by GHCR, running on Cloudflare Workers (Hono +
D1) with a built-in web dashboard and Node.js CLI.

Metadata, signing, and GC state live in Cloudflare D1, while compressed NAR
blobs transfer directly between clients and GHCR via 302 CDN redirects.

## Live Example

- **Cache & Dashboard**: [cache.so1ve.dev](https://cache.so1ve.dev)
- **CI Integration**: [so1ve/nur-packages](https://github.com/so1ve/nur-packages)

## Install CLI

```sh
# Run once
nix run github:so1ve/firn -- --help

# Or use nix shell
nix shell github:so1ve/firn
```

In a NixOS or Home Manager flake, add `inputs.firn.url = "github:so1ve/firn"`
and include `inputs.firn.packages.${system}.default` in `environment.systemPackages`.

## Deploy (Cloudflare Workers + D1)

### One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/so1ve/firn)

Cloudflare automatically provisions the D1 database (`DB`), applies
`migrations/0001_init.sql`, and deploys the Worker. After deploying, set the
variables and secrets below in the Cloudflare dashboard (or via Wrangler).

### Manual deploy

#### 1. Generate signing keys

Generate two Ed25519 key pairs: one for the main cache and one for pull request
overlays.

```sh
firn keygen cache.example.com-1 -s main.key -p main.pub
firn keygen cache.example.com-pr-1 -s pr.key -p pr.pub
```

#### 2. Configure `wrangler.jsonc` and create D1

Create the D1 database and update `database_id`, `routes`, and `vars` in
[wrangler.jsonc](wrangler.jsonc):

```sh
pnpm exec wrangler d1 create firn
```

Environment variables (`vars`):

- `PUBLIC_BASE_URL`: public HTTPS URL of the cache (also used as the OIDC
  audience).
- `GC_PR_TTL_DAYS` / `GC_MAIN_LRU_DAYS`: PR expiry (default `3`) and
  closure-safe main LRU (default `15`).
- `GITHUB_APP_ID`: numeric GitHub App ID (optional; required for GHCR GC
  deletion and local manual pushes).
- `OWNERS_JSON`: JSON array of allowed GitHub users/orgs, for example:

```json
[
  {
    "name": "so1ve",
    "owner_type": "user",
    "github_owner_id": 58381667,
    "github_installation_id": 98765432,
    "package_template": "{repo}-cache",
    "manual_push_package": "manual-cache",
    "main_refs": ["refs/heads/main"],
    "allowed_repos": []
  }
]
```

> If you set up a GitHub App for GC and webhooks, grant **Packages: Read &
> write** and **Pull requests: Read-only**, subscribe to `Pull request` events,
> and point the webhook URL to `https://cache.example.com/api/v1/webhooks/github`.

#### 3. Upload secrets and deploy

See [.dev.vars.example](.dev.vars.example) for local development. In production,
set secrets via Wrangler and deploy (`pnpm run deploy` applies D1 migrations and
deploys the Worker):

```sh
pnpm exec wrangler secret put MAIN_SIGNING_KEY < main.key
pnpm exec wrangler secret put PR_SIGNING_KEY < pr.key
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < github-app.pem
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put MANUAL_TOKENS_JSON
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm run deploy
```

## Web Dashboard

Opening the cache root URL (`GET /`) in a browser serves a server-rendered
dashboard showing:

- Cache summary (main/PR path counts, blob totals, priority, GC policy)
- Copyable `nix.conf`, GitHub Actions, and PR Overlay configuration snippets
- Live-filterable store paths table with direct `.narinfo` links
- Active PR overlays with remaining TTL and GitHub links
- Per-owner GHCR storage breakdown and `gc-blocked` package notices
- Optional **Admin** unlock (using `ADMIN_TOKEN`, stored in `sessionStorage`) to
  run dry-run/full GC or remove PR overlays directly from the browser

## GitHub Actions

Uses OIDC (`id-token: write`) with no repository secrets. Public keys are
fetched automatically from `/api/v1/public-keys`, and the action runs directly
on Node 24 with zero dependency installation or binary downloads.

```yaml
permissions:
  contents: read
  id-token: write
  packages: write

steps:
  - uses: actions/checkout@v7
  - uses: cachix/install-nix-action@v32
  - uses: so1ve/firn@v1
    with:
      server: https://cache.example.com
  - run: nix flake check
```

- Refs listed in `main_refs` (default `refs/heads/main`) push to the main cache.
  Pushes from other branches skip cache upload gracefully.
- Internal `pull_request` jobs pull from and push to
  `/pr/<owner>/<repo>/<number>`. Fork PRs only pull from the main cache.

## Pull

Add the cache and main public key to `nix.conf` (or `flake.nix` `nixConfig`):

```text
extra-substituters = https://cache.example.com
extra-trusted-public-keys = cache.example.com-1:<MAIN_PUBLIC_KEY>
```

## Local Push

To push store paths from a local machine, configure `MANUAL_TOKENS_JSON` (for
example `{"so1ve":["<random-token>"]}`) and a GitHub App installation for the
owner. Firn exchanges a short-lived scoped GHCR upload token on demand.

```sh
export FIRN_SERVER=https://cache.example.com
export FIRN_TOKEN=<manual-token>

firn push ./result
# Or pipe paths from stdin (already-signed cache.nixos.org paths are skipped):
nix build .#default --print-out-paths | firn push --stdin
```

Use `--owner <name>` only if the same token is shared across multiple owners,
`--jobs <n>` to control upload concurrency (default `4`), and
`--include-upstream` to upload paths already signed by `cache.nixos.org-1:`.

## Remote Administration

When `ADMIN_TOKEN` is configured on the Worker, the local CLI can inspect and
manage the remote D1 cache from any machine (pass `--server` / `--token` or set
`FIRN_SERVER` / `FIRN_ADMIN_TOKEN`; add `--json` to any read/GC command for
machine-readable output):

```sh
export FIRN_SERVER=https://cache.example.com
export FIRN_ADMIN_TOKEN=<admin-token>

# Overview: public keys, GC policy, store path counts, per-owner blob usage & gc-blocked list
firn status

# List recently accessed store paths (optional: -q <text>, --owner <name>, --scope <scope>)
firn ls --limit 50
firn ls -q firefox --owner so1ve

# List active PR overlays and remaining TTL
firn pr ls

# Remove a PR overlay immediately (unreferenced blobs are cleaned on next GC)
firn pr rm so1ve latchshot 7

# Trigger GC on demand (add --dry-run to preview without mutating D1 or GHCR)
firn gc --dry-run
firn gc
```

## License

[MIT](LICENSE). Made by [Ray](https://github.com/so1ve) with ~~Tokens~~
