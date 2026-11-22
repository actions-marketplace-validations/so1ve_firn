# Firn

Stateful Nix binary cache backed by GHCR.

Firn keeps `.narinfo` metadata, signing keys, and garbage collection state in
SQLite while storing compressed NAR blobs in GitHub Container Registry. Clients
upload blobs directly to GHCR and download them via 302 redirects to GHCR's
presigned CDN URLs, so NAR payloads do not pass through the Firn server.

## Setup

### Signing keys

Generate two Ed25519 key pairs per owner: one for the main cache (default
`refs/heads/main`, configurable via `protected_refs`) and one for pull request
overlays. GitHub branch protection rules are not required—Firn matches the OIDC
`ref` claim against `protected_refs`.

```sh
firn keygen cache.example.com-1 -s main.key -p main.pub
firn keygen cache.example.com-pr-1 -s pr.key -p pr.pub
```

### Server configuration

Minimal configuration:

```toml
database_path = "/var/lib/firn/state.db"
public_base_url = "https://cache.example.com"

[[owners]]
name = "so1ve"
github_owner_id = 58381667
main_signing_key_file = "/run/secrets/so1ve-main.key"
pr_signing_key_file = "/run/secrets/so1ve-pr.key"
```

See [firn.example.toml](firn.example.toml) for the full configuration reference
with every field, default value, and optional section (`[github_app]`, `[gc]`,
`protected_refs`, `allowed_repos`, manual push tokens, etc.).

Start the server:

```sh
firn serve /etc/firn/config.toml
```

Or run the container image from GHCR:

```sh
docker run --rm -p 8080:8080 \
  -v /etc/firn/config.toml:/etc/firn/config.toml:ro \
  -v /run/secrets:/run/secrets:ro \
  -v firn-data:/var/lib/firn \
  ghcr.io/so1ve/firn:main
```

Or deploy on NixOS with the flake module:

```nix
{ inputs, ... }:
{
  imports = [ inputs.firn.nixosModules.default ];

  services.firn = {
    enable = true;
    settings = {
      public_base_url = "https://cache.example.com";
      owners = [
        {
          name = "so1ve";
          github_owner_id = 58381667;
          main_signing_key_file = "/run/secrets/so1ve-main.key";
          pr_signing_key_file = "/run/secrets/so1ve-pr.key";
        }
      ];
    };
  };
}
```

## Push

### GitHub Actions

GitHub Actions authenticate through OIDC (`id-token: write`), matched against
the owner's numeric `github_owner_id`. No signing key or static secret is needed
in the repository.

```yaml
permissions:
  contents: read
  id-token: write
  packages: write

steps:
  - run: nix build .#default --print-out-paths | firn push --server https://cache.example.com --stdin
```

- Refs listed in `protected_refs` (`refs/heads/main` by default; GitHub branch
  protection rules are not required) write to the main cache and are signed with
  `main_signing_key_file`.
- Internal `pull_request` workflows write to an isolated PR overlay signed with
  `pr_signing_key_file`. `pull_request_target` and pushes to unlisted refs are
  rejected.
- Paths already signed by `cache.nixos.org-1:` are skipped unless
  `--include-upstream` is passed.

### Local machine

Configure a static Bearer token in `manual_tokens_file` and a GitHub App
installation for the owner. Firn exchanges a short-lived scoped GHCR upload
token on demand.

```sh
firn push \
  --server https://cache.example.com \
  --owner so1ve \
  --token "$FIRN_TOKEN" \
  ./result
```

## Pull

Main cache (developer machines):

```text
extra-substituters = https://cache.example.com/so1ve
extra-trusted-public-keys = cache.example.com-1:<MAIN_PUBLIC_KEY>
```

PR overlay (CI only; falls back to the main cache on misses):

```text
extra-substituters = https://cache.example.com/so1ve/pr/<repo>/<number>
extra-trusted-public-keys = cache.example.com-1:<MAIN_PUBLIC_KEY> cache.example.com-pr-1:<PR_PUBLIC_KEY>
```

## Operations

Set `FIRN_CONFIG=/etc/firn/config.toml` or pass the config file as the first argument:

```sh
firn status /etc/firn/config.toml
firn ls /etc/firn/config.toml --owner so1ve --limit 50
firn pr ls /etc/firn/config.toml
firn pr rm /etc/firn/config.toml so1ve latchshot 7
firn gc /etc/firn/config.toml --dry-run
```

Logs are written to stderr via `tracing` and controlled with `RUST_LOG` (defaults to `info`; use `RUST_LOG=firn=debug` for per-request and cache-hit logs).

## Garbage collection

Firn runs GC every 6 hours (and on demand via `firn gc /etc/firn/config.toml`):

- PR overlays are removed when a signed `pull_request` (`closed`) webhook
  arrives at `/api/v1/webhooks/github`, or after `pr_ttl_days` without updates.
- Main-branch paths not accessed within `main_lru_days` are evicted while
  preserving transitive dependencies of retained paths.
- Unreferenced GHCR versions are deleted via the configured GitHub App. If
  GitHub rejects deleting the last version of a package, Firn deletes the empty
  package instead; if a public version exceeds GitHub's 5,000-download deletion
  limit, Firn marks it blocked so GC stops retrying it.

## Development

```sh
devenv shell
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt
nixfmt flake.nix devenv.nix nix/nixos.nix
```

## License

[MIT](LICENSE). Made by [Ray](https://github.com/so1ve) with ~~Tokens~~
