{
  description = "Stateful Nix binary cache backed by GHCR";

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
      cargoToml = builtins.fromTOML (builtins.readFile ./Cargo.toml);
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkPackage =
        pkgs:
        pkgs.rustPlatform.buildRustPackage {
          pname = cargoToml.package.name;
          inherit (cargoToml.package) version;

          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./Cargo.lock
              ./Cargo.toml
              ./src
            ];
          };

          cargoLock.lockFile = ./Cargo.lock;

          nativeBuildInputs = with pkgs; [
            installShellFiles
            pkg-config
          ];

          buildInputs = with pkgs; [
            aws-lc
            sqlite
            zstd
          ];

          nativeCheckInputs = with pkgs; [
            cacert
          ];

          postInstall = ''
            installShellCompletion --cmd firn \
              --bash <("$out/bin/firn" completions bash) \
              --fish <("$out/bin/firn" completions fish) \
              --zsh <("$out/bin/firn" completions zsh)
          '';

          meta = {
            inherit (cargoToml.package) description;
            homepage = cargoToml.package.repository;
            license = pkgs.lib.licenses.mit;
            mainProgram = cargoToml.package.name;
            platforms = pkgs.lib.platforms.linux;
          };
        };
    in
    {
      nixosModules.default = import ./nix/nixos.nix self;

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
            meta.description = cargoToml.package.description;
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
