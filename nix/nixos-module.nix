{
  config,
  lib,
  ...
}:

let
  cfg = config.services.firn;

  credentials = lib.filter (x: x != null) [
    (lib.optionalString (cfg.mainSigningKeyFile != null) "main-signing-key:${cfg.mainSigningKeyFile}")
    (lib.optionalString (cfg.prSigningKeyFile != null) "pr-signing-key:${cfg.prSigningKeyFile}")
    (lib.optionalString (
      cfg.githubAppPrivateKeyFile != null
    ) "github-app-private-key:${cfg.githubAppPrivateKeyFile}")
    (lib.optionalString (
      cfg.githubWebhookSecretFile != null
    ) "github-webhook-secret:${cfg.githubWebhookSecretFile}")
    (lib.optionalString (cfg.manualTokensFile != null) "manual-tokens:${cfg.manualTokensFile}")
    (lib.optionalString (cfg.adminTokenFile != null) "admin-token:${cfg.adminTokenFile}")
    (lib.optionalString (
      cfg.libsqlAuthTokenFile != null
    ) "libsql-auth-token:${cfg.libsqlAuthTokenFile}")
  ];
in
{
  options.services.firn = {
    enable = lib.mkEnableOption "Firn Nix binary cache index for GHCR";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The Firn package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address to bind the HTTP server to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "Port to bind the HTTP server to.";
    };

    publicBaseUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://cache.example.com";
      description = "Public HTTPS URL of the cache (also used as the OIDC audience).";
    };

    owners = lib.mkOption {
      type = lib.types.listOf (lib.types.attrsOf lib.types.anything);
      description = "List of allowed GitHub users/organizations (serialized to OWNERS_JSON).";
      example = [
        {
          name = "so1ve";
          owner_type = "user";
          github_owner_id = 58381667;
          github_installation_id = 98765432;
        }
      ];
    };

    githubAppId = lib.mkOption {
      type = lib.types.nullOr lib.types.int;
      default = null;
      description = "Optional numeric GitHub App ID for GHCR GC deletion and manual pushes.";
    };

    gc = {
      prTtlDays = lib.mkOption {
        type = lib.types.ints.positive;
        default = 3;
        description = "Days before idle PR overlays expire.";
      };

      mainLruDays = lib.mkOption {
        type = lib.types.ints.positive;
        default = 15;
        description = "Days before unaccessed main store paths are evicted (closure-safe).";
      };

      intervalMinutes = lib.mkOption {
        type = lib.types.ints.unsigned;
        default = 30;
        description = "Periodic GC interval in minutes (0 disables built-in GC scheduling).";
      };

      maxSubrequests = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = "Optional cap on GitHub API subrequests per GC run (unlimited by default when self-hosted).";
      };
    };

    mainSigningKeyFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to file containing MAIN_SIGNING_KEY.";
    };

    prSigningKeyFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to file containing PR_SIGNING_KEY.";
    };

    githubAppPrivateKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional path to GitHub App PEM private key file.";
    };

    githubWebhookSecretFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional path to GitHub webhook HMAC secret file.";
    };

    manualTokensFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional path to MANUAL_TOKENS_JSON file.";
    };

    adminTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional path to ADMIN_TOKEN file.";
    };

    libsqlUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "libsql://firn-org.turso.io";
      description = "Optional Turso/libSQL URL. When unset, Firn uses a local SQLite database in StateDirectory.";
    };

    libsqlAuthTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional path to LIBSQL_AUTH_TOKEN file.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional systemd EnvironmentFile for additional variables.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.firn = {
      description = "Firn Nix binary cache index";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        PUBLIC_BASE_URL = cfg.publicBaseUrl;
        OWNERS_JSON = builtins.toJSON cfg.owners;
        GC_PR_TTL_DAYS = toString cfg.gc.prTtlDays;
        GC_MAIN_LRU_DAYS = toString cfg.gc.mainLruDays;
        GC_INTERVAL_MINUTES = toString cfg.gc.intervalMinutes;
        FIRN_DB_PATH = "/var/lib/firn/firn.db";
        MAIN_SIGNING_KEY_FILE = "/run/credentials/firn.service/main-signing-key";
        PR_SIGNING_KEY_FILE = "/run/credentials/firn.service/pr-signing-key";
      }
      // lib.optionalAttrs (cfg.githubAppId != null) {
        GITHUB_APP_ID = toString cfg.githubAppId;
      }
      // lib.optionalAttrs (cfg.gc.maxSubrequests != null) {
        GC_MAX_SUBREQUESTS = toString cfg.gc.maxSubrequests;
      }
      // lib.optionalAttrs (cfg.githubAppPrivateKeyFile != null) {
        GITHUB_APP_PRIVATE_KEY_FILE = "/run/credentials/firn.service/github-app-private-key";
      }
      // lib.optionalAttrs (cfg.githubWebhookSecretFile != null) {
        GITHUB_WEBHOOK_SECRET_FILE = "/run/credentials/firn.service/github-webhook-secret";
      }
      // lib.optionalAttrs (cfg.manualTokensFile != null) {
        MANUAL_TOKENS_JSON_FILE = "/run/credentials/firn.service/manual-tokens";
      }
      // lib.optionalAttrs (cfg.adminTokenFile != null) {
        ADMIN_TOKEN_FILE = "/run/credentials/firn.service/admin-token";
      }
      // lib.optionalAttrs (cfg.libsqlUrl != null) {
        LIBSQL_URL = cfg.libsqlUrl;
      }
      // lib.optionalAttrs (cfg.libsqlAuthTokenFile != null) {
        LIBSQL_AUTH_TOKEN_FILE = "/run/credentials/firn.service/libsql-auth-token";
      };

      serviceConfig = {
        Type = "simple";
        DynamicUser = true;
        StateDirectory = "firn";
        LoadCredential = builtins.filter (s: s != "") credentials;
        ExecStart = "${lib.getExe cfg.package} serve";
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
