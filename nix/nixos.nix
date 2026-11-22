flake:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.firn;
  toml = pkgs.formats.toml { };
  configFile = toml.generate "firn.toml" (
    lib.recursiveUpdate {
      listen = "127.0.0.1:8080";
      database_path = "/var/lib/firn/state.db";
    } cfg.settings
  );
in
{
  options.services.firn = {
    enable = lib.mkEnableOption "Firn Nix binary cache server";

    package = lib.mkOption {
      type = lib.types.package;
      default = flake.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.firn.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "Firn package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "firn";
      description = "System user under which Firn runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "firn";
      description = "System group under which Firn runs.";
    };

    log = lib.mkOption {
      type = lib.types.str;
      default = "firn=info";
      description = "RUST_LOG filter directive.";
    };

    settings = lib.mkOption {
      type = toml.type;
      default = { };
      description = "Declarative TOML configuration for Firn.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.${cfg.user} = lib.mkIf (cfg.user == "firn") {
      isSystemUser = true;
      group = cfg.group;
    };

    users.groups.${cfg.group} = lib.mkIf (cfg.group == "firn") { };

    systemd.services.firn = {
      description = "Firn stateful Nix binary cache";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        RUST_LOG = cfg.log;
      };

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        StateDirectory = "firn";
        StateDirectoryMode = "0750";
        ExecStart = "${lib.getExe cfg.package} serve ${configFile}";
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        LockPersonality = true;
      };
    };
  };
}
