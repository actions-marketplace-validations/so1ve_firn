{
  description = "Stateful Nix binary cache backed by GHCR and Cloudflare Workers + D1";

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
        pkgs.stdenvNoCC.mkDerivation {
          pname = manifest.name;
          inherit (manifest) version;

          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./src/cli
              ./src/shared
            ];
          };

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/share/firn"
            cp -r package.json src "$out/share/firn"

            makeWrapper ${pkgs.lib.getExe pkgs.nodejs_24} "$out/bin/firn" \
              --add-flags "$out/share/firn/src/cli/index.ts" \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.nix
                  pkgs.nodejs_24
                ]
              }

            runHook postInstall
          '';

          meta = {
            inherit (manifest) description;
            homepage = "https://github.com/so1ve/firn";
            license = pkgs.lib.licenses.mit;
            mainProgram = manifest.name;
            platforms = pkgs.lib.platforms.unix;
          };
        };
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
    };
}
