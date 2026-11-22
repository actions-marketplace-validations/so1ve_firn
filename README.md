# Firn

Stateful Nix binary cache backed by GHCR. Metadata, signing, and GC live in
SQLite; compressed NAR blobs go directly between clients and GHCR via 302 CDN
redirects.

## Setup

Generate separate main and PR signing keys:

```sh
firn keygen cache.example.com-1 -s main.key -p main.pub
firn keygen cache.example.com-pr-1 -s pr.key -p pr.pub
```

Minimal config ([full reference](firn.example.toml)):

```toml
database_path = "/var/lib/firn/state.db"
public_base_url = "https://cache.example.com"
main_signing_key_file = "/run/secrets/firn-main.key"
pr_signing_key_file = "/run/secrets/firn-pr.key"

[[owners]]
name = "so1ve"
github_owner_id = 58381667
```

Run directly, with Docker, or via the NixOS module (`inputs.firn.nixosModules.default`):

```sh
firn serve
```

```sh
docker run --rm -p 8080:8080 \
  -v /etc/firn/config.toml:/etc/firn/config.toml:ro \
  -v /run/secrets:/run/secrets:ro \
  -v firn-data:/var/lib/firn \
  ghcr.io/so1ve/firn:main
```

```nix
services.firn = {
  enable = true;
  settings = {
    public_base_url = "https://cache.example.com";
    main_signing_key_file = "/run/secrets/firn-main.key";
    pr_signing_key_file = "/run/secrets/firn-pr.key";
    owners = [{ name = "so1ve"; github_owner_id = 58381667; }];
  };
};
```

## GitHub Actions

Uses OIDC (`id-token: write`) with no repository secrets. Public keys are
fetched from `/api/v1/public-keys` automatically.

```yaml
permissions:
  contents: read
  id-token: write
  packages: write

steps:
  - uses: actions/checkout@v7
  - uses: cachix/install-nix-action@v32
  - uses: so1ve/firn@main
    with:
      server: https://cache.example.com
  - run: nix flake check
```

- `protected_refs` (default `refs/heads/main`, no GitHub branch protection required) push to the main cache.
- Internal `pull_request` jobs pull from and push to `/pr/<owner>/<repo>/<number>`. Fork PRs only pull from the main cache.

## Pull & Manual Push

Client `nix.conf`:

```text
extra-substituters = https://cache.example.com
extra-trusted-public-keys = cache.example.com-1:<MAIN_PUBLIC_KEY>
```

Local push (requires `manual_tokens_file` and `[github_app]`):

```sh
firn push --server https://cache.example.com --token "$FIRN_TOKEN" ./result
```

## CLI

Defaults to `/etc/firn/config.toml` (override with `-c` / `--config` or `FIRN_CONFIG`; logs via `RUST_LOG`):

```sh
firn status
firn ls --limit 50
firn pr ls
firn pr rm so1ve latchshot 7
firn gc --dry-run
```

## License

[MIT](LICENSE). Made by [Ray](https://github.com/so1ve) with ~~Tokens~~
