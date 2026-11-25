{ inputs, pkgs, ... }:

{
  overlays = [ inputs.js-toolchain-overlay.overlays.default ];

  languages.javascript = {
    enable = true;
    package = pkgs.node-bin.fromProject ./.;
    pnpm.enable = true;
    lsp.package = pkgs.vtsls;
  };

  packages = with pkgs; [
    nixd
    actionlint
    git
    nixfmt
    prettierd
    vscode-langservers-extracted
    yaml-language-server
  ];
}
