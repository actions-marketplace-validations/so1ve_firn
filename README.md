<img src="public/favicon.svg" alt="Firn" width="56" height="56" />

# Firn

Nix binary cache index for GHCR with isolated PR overlays, closure-safe GC, and
keyless GitHub Actions OIDC uploads.

Firn stores only store path metadata and signatures; compressed NAR blobs are stored
in GHCR and transfer directly via 302 redirects.

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
`migrations/`, and deploys the Worker. After deploying, set the
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
- `GC_MAX_SUBREQUESTS`: max GitHub API subrequests per GC invocation (default
  `40` for Cloudflare Workers Free plan; increase on Workers Paid plans, e.g.
  `800`).
- `GITHUB_APP_ID`: numeric GitHub App ID (optional; required for local manual
  pushes and private GHCR package pull fallback).
- `OWNERS_JSON`: JSON array of allowed GitHub users/orgs, for example:

```json
[
  {
    "name": "so1ve",
    "owner_type": "user",
    "github_owner_id": 58381667,
    "github_installation_id": 98765432,
    "package_template": "{repo}-cache",
    "repo_packages": {
      "nix-config": "nixos-cache"
    },
    "manual_push_package": "manual-cache",
    "main_refs": ["refs/heads/main"],
    "allowed_repos": []
  }
]
```

`repo_packages` is optional and overrides `package_template` for specific
repositories (when `allowed_repos` is non-empty, every key in `repo_packages`
must also be listed in `allowed_repos`).

> For GHCR GC deletion, set `GITHUB_PACKAGES_TOKEN` to a GitHub **classic** PAT
> with `read:packages` and `delete:packages` scopes (GitHub Packages REST API
> rejects custom GitHub App installation tokens on package deletion). If you
> also set up a GitHub App for webhooks and local push, grant **Packages: Read &
> write** and **Pull requests: Read-only**, subscribe to `Pull request` events,
> and point the webhook URL to `https://cache.example.com/api/v1/webhooks/github`.

#### 3. Upload secrets and deploy

See [.dev.vars.example](.dev.vars.example) for local development. In production,
set secrets via Wrangler and deploy (`pnpm run deploy` applies D1 migrations and
deploys the Worker):

```sh
pnpm exec wrangler secret put MAIN_SIGNING_KEY < main.key
pnpm exec wrangler secret put PR_SIGNING_KEY < pr.key
pnpm exec wrangler secret put GITHUB_PACKAGES_TOKEN
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < github-app.pem
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put MANUAL_TOKENS_JSON
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm run deploy
```

## Self-Hosting (Node.js / Docker / NixOS)

Self-hosted Firn uses Node 24's built-in `node:sqlite` (zero native builds),
applies migrations automatically on startup, schedules periodic GC in-process
(with no 50-subrequest Worker cap), and supports `*_FILE` variants for all
secret environment variables (`MAIN_SIGNING_KEY_FILE`, `PR_SIGNING_KEY_FILE`,
`GITHUB_PACKAGES_TOKEN_FILE`, `GITHUB_APP_PRIVATE_KEY_FILE`,
`GITHUB_WEBHOOK_SECRET_FILE`, `MANUAL_TOKENS_JSON_FILE`, `ADMIN_TOKEN_FILE`,
`LIBSQL_AUTH_TOKEN_FILE`).

### CLI (`firn serve`)

```sh
export PUBLIC_BASE_URL=https://cache.example.com
export OWNERS_JSON='[{"name":"so1ve","owner_type":"user","github_owner_id":58381667}]'
export MAIN_SIGNING_KEY_FILE=/path/to/main.key
export PR_SIGNING_KEY_FILE=/path/to/pr.key

firn serve --host 0.0.0.0 --port 8787 --db /var/lib/firn/firn.db
```

Pass `--libsql-url` (or set `LIBSQL_URL` + `LIBSQL_AUTH_TOKEN`) to store index
state in Turso/libSQL instead of a local SQLite file. Set `--gc-interval 0` (or
`GC_INTERVAL_MINUTES=0`) to disable built-in periodic GC.

### Docker

Prebuilt multi-arch (`linux/amd64`, `linux/arm64`) images are published to
`ghcr.io/so1ve/firn`:

```sh
docker run -d --name firn -p 8787:8787 -v firn-data:/data \
  -e PUBLIC_BASE_URL=https://cache.example.com \
  -e OWNERS_JSON='[...]' \
  -e MAIN_SIGNING_KEY="$(cat main.key)" \
  -e PR_SIGNING_KEY="$(cat pr.key)" \
  ghcr.io/so1ve/firn:latest
```

### NixOS Module

The flake exports `nixosModules.default` with hardened systemd `DynamicUser`
and `LoadCredential` secret wiring:

```nix
{
  imports = [ inputs.firn.nixosModules.default ];

  services.firn = {
    enable = true;
    publicBaseUrl = "https://cache.example.com";
    mainSigningKeyFile = config.age.secrets.firn-main-key.path;
    prSigningKeyFile = config.age.secrets.firn-pr-key.path;
    adminTokenFile = config.age.secrets.firn-admin-token.path;
    owners = [
      {
        name = "so1ve";
        owner_type = "user";
        github_owner_id = 58381667;
      }
    ];
  };
}
```

## Other Serverless Platforms (Turso / libSQL)

[src/entry/web.ts](src/entry/web.ts) exports a standard Web Fetch handler
(`default.fetch` and `createWebApp`) backed by Turso/libSQL over Hrana HTTP
(`LIBSQL_URL` and `LIBSQL_AUTH_TOKEN`), with zero native dependencies and zero
filesystem access at runtime. Before deploying (or after adding migrations),
apply `migrations/*.sql` once with:

```sh
LIBSQL_URL=libsql://... LIBSQL_AUTH_TOKEN=... firn migrate
```

Then serve `public/` as static assets, point Vercel, Deno Deploy, Bun, or
Netlify Edge at `src/entry/web.ts`, and trigger periodic GC via your platform's
cron calling `POST /api/v1/admin/gc` (or `createWebApp().runScheduledGc()`).

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
  - run: nix build .#default --print-out-paths >> "$FIRN_PATHS_FILE"
```

- **Explicit runtime closure (recommended)**: append build outputs to the
  automatically exported `$FIRN_PATHS_FILE` (or pass `paths` / `paths-file`) so
  Firn uploads only the runtime closure of final outputs, skipping build-time
  crates, patches, and vendored sources.
- **Zero-config fallback**: if no explicit paths are recorded, Firn diffs
  `/nix/store` and automatically drops unreferenced fixed-output derivations
  (FODs) and store-copied source files.
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

When `ADMIN_TOKEN` is configured on the server, the local CLI can inspect and
manage the remote cache from any machine (pass `--server` / `--token` or set
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
