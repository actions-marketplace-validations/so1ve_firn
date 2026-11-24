{
  description = "Nix binary cache index for GHCR with PR overlays, closure-safe GC, and OIDC CI uploads";

  nixConfig = {
    extra-substituters = [ "https://cache.so1ve.dev" ];
    extra-trusted-public-keys = [
      "cache.so1ve.dev-1:SijyzF9iE/VZwMXgMpd/HrNX9iItDZ1tdiNdeGakQGY="
    ];
  };

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkPackage =
        pkgs:
        let
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./migrations
              ./public
              ./src/cli
              ./src/entry
              ./src/server
              ./src/shared
            ];
          };
        in
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = manifest.name;
          inherit (manifest) version;
          inherit src;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 5;
            pnpmInstallFlags = [ "--prod" ];
            hash = "sha256-HLk/PHJmBE9xkfap3gc/f4SmEFtTLNbgU1ixVCduwJE=";
          };

          pnpmInstallFlags = [ "--prod" ];

          nativeBuildInputs = [
            pkgs.installShellFiles
            pkgs.makeWrapper
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/share/firn"
            cp -r package.json src public migrations node_modules "$out/share/firn"

            makeWrapper ${pkgs.lib.getExe pkgs.nodejs_24} "$out/bin/firn" \
              --add-flags "$out/share/firn/src/cli/index.ts" \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.nix
                  pkgs.nodejs_24
                ]
              }

            installShellCompletion --cmd firn \
              --bash <("$out/bin/firn" completions bash) \
              --fish <("$out/bin/firn" completions fish) \
              --zsh <("$out/bin/firn" completions zsh)

            runHook postInstall
          '';

          meta = {
            inherit (manifest) description;
            homepage = "https://github.com/so1ve/firn";
            license = pkgs.lib.licenses.mit;
            mainProgram = manifest.name;
            platforms = pkgs.lib.platforms.unix;
          };
        });
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          firn = mkPackage pkgs;
        in
        {
          inherit firn;
          default = firn;
        }
      );

      apps = forAllSystems (
        system:
        let
          app = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${system}.firn;
            meta.description = manifest.description;
          };
        in
        {
          firn = app;
          default = app;
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      overlays.default = final: _prev: {
        firn = mkPackage final;
      };

      nixosModules.default =
        {
          lib,
          pkgs,
          ...
        }:
        {
          imports = [ ./nix/nixos-module.nix ];
          services.firn.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.firn;
        };
    };
}
