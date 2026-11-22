mod admin;
mod config;
mod db;
mod firn;
mod gc;
mod github;
mod nix_format;
mod oci;
mod protocol;
mod push;
mod server;

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::{fs, io};

use anyhow::{Context, Result};
use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::Shell;
use tracing_subscriber::EnvFilter;

use crate::firn::Firn;
use crate::nix_format::SigningKeyPair;
use crate::push::PushArgs;

#[derive(Subcommand)]
enum PrCommand {
    /// List active PR overlays and remaining TTL
    Ls {
        /// Path to the TOML configuration file
        #[arg(value_name = "CONFIG", env = "FIRN_CONFIG")]
        config: PathBuf,

        /// Filter by owner name
        #[arg(long)]
        owner: Option<String>,
    },

    /// Delete a PR overlay immediately
    Rm {
        /// Path to the TOML configuration file
        #[arg(value_name = "CONFIG", env = "FIRN_CONFIG")]
        config: PathBuf,

        /// Owner name
        owner: String,

        /// Repository name
        repo: String,

        /// Pull request number
        number: u64,
    },
}

#[derive(Subcommand)]
enum Command {
    /// Run the Firn HTTP control-plane server
    Serve {
        /// Path to the TOML configuration file
        #[arg(value_name = "CONFIG", env = "FIRN_CONFIG")]
        config: PathBuf,
    },

    /// Push Nix store paths and their closures to a Firn server
    Push(PushArgs),

    /// Show owners, public keys, cache usage, and GC-blocked blobs
    Status {
        /// Path to the TOML configuration file
        #[arg(value_name = "CONFIG", env = "FIRN_CONFIG")]
        config: PathBuf,
    },

    /// List cached store paths ordered by recent access
    Ls {
        /// Path to the TOML configuration file
        #[arg(value_name = "CONFIG", env = "FIRN_CONFIG")]
        config: PathBuf,

        /// Filter by owner name
        #[arg(long)]
        owner: Option<String>,

        /// Filter by scope (e.g. main or pr:<repo>:<number>)
        #[arg(long)]
        scope: Option<String>,

        /// Maximum number of paths to display
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },

    /// Inspect or remove PR overlays
    Pr {
        #[command(subcommand)]
        command: PrCommand,
    },

    /// Generate a Nix Ed25519 signing key pair
    Keygen {
        /// Key name prefix (e.g. cache.so1ve.dev-1)
        #[arg(value_name = "NAME")]
        name: String,

        /// Write secret key to a file instead of printing it
        #[arg(long, short, value_name = "FILE")]
        secret_out: Option<PathBuf>,

        /// Write public key to a file instead of printing it
        #[arg(long, short, value_name = "FILE")]
        public_out: Option<PathBuf>,
    },

    /// Run a single garbage collection pass
    Gc {
        /// Path to the TOML configuration file
        #[arg(value_name = "CONFIG", env = "FIRN_CONFIG")]
        config: PathBuf,

        /// Report what would be deleted without mutating SQLite or GHCR
        #[arg(long)]
        dry_run: bool,
    },

    /// Generate shell completions
    Completions {
        #[arg(value_enum)]
        shell: Shell,
    },
}

#[derive(Parser)]
#[command(version, about, arg_required_else_help = true)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

fn run_keygen(name: &str, secret_out: Option<&Path>, public_out: Option<&Path>) -> Result<()> {
    let pair = SigningKeyPair::generate(name)?;
    let secret = pair.secret_string();
    let public = pair.public_string();

    match secret_out {
        Some(path) => {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .with_context(|| format!("failed to open secret key file {}", path.display()))?;
            writeln!(file, "{secret}")
                .with_context(|| format!("failed to write secret key to {}", path.display()))?;
            println!("Wrote secret key to {}", path.display());
        }
        None => println!("Secret key: {secret}"),
    }

    match public_out {
        Some(path) => {
            fs::write(path, format!("{public}\n"))
                .with_context(|| format!("failed to write public key to {}", path.display()))?;
            println!("Wrote public key to {}", path.display());
        }
        None => println!("Public key: {public}"),
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(tracing::Level::INFO.into())
                .from_env_lossy(),
        )
        .with_writer(io::stderr)
        .init();

    match Cli::parse().command {
        Command::Serve { config } => Firn::open(&config)?.serve().await,
        Command::Push(args) => push::run(args).await,
        Command::Status { config } => Firn::open(&config)?.show_status(),
        Command::Ls {
            config,
            owner,
            scope,
            limit,
        } => Firn::open(&config)?.list_paths(owner.as_deref(), scope.as_deref(), limit),
        Command::Pr { command } => match command {
            PrCommand::Ls { config, owner } => Firn::open(&config)?.list_prs(owner.as_deref()),
            PrCommand::Rm {
                config,
                owner,
                repo,
                number,
            } => Firn::open(&config)?.remove_pr(&owner, &repo, number),
        },
        Command::Keygen {
            name,
            secret_out,
            public_out,
        } => run_keygen(&name, secret_out.as_deref(), public_out.as_deref()),
        Command::Gc { config, dry_run } => {
            let report = Firn::open(&config)?.run_gc(dry_run).await?;
            println!(
                "GC finished (dry_run={dry_run}): pr_paths_removed={}, main_paths_removed={}, blobs_deleted={}, blobs_protected={}, blobs_skipped={}, blob_errors={}",
                report.pr_paths_removed,
                report.main_paths_removed,
                report.blobs_deleted,
                report.blobs_protected,
                report.blobs_skipped,
                report.blob_errors,
            );

            Ok(())
        }
        Command::Completions { shell } => {
            clap_complete::generate(shell, &mut Cli::command(), "firn", &mut io::stdout());

            Ok(())
        }
    }
}
