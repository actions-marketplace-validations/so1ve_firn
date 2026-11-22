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

const DEFAULT_CONFIG_PATH: &str = "/etc/firn/config.toml";

#[derive(Subcommand)]
enum PrCommand {
    /// List active PR overlays and remaining TTL
    Ls {
        /// Filter by owner name
        #[arg(long)]
        owner: Option<String>,
    },

    /// Delete a PR overlay immediately
    Rm {
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
    Serve,

    /// Push Nix store paths and their closures to a Firn server
    Push(PushArgs),

    /// Show owners, public keys, cache usage, and GC-blocked blobs
    Status,

    /// List cached store paths ordered by recent access
    Ls {
        /// Filter by owner name
        #[arg(long)]
        owner: Option<String>,

        /// Filter by scope (e.g. main or pr:<owner>:<repo>:<number>)
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
    /// Path to the TOML configuration file
    #[arg(
        short,
        long,
        global = true,
        env = "FIRN_CONFIG",
        default_value = DEFAULT_CONFIG_PATH,
        value_name = "FILE"
    )]
    config: PathBuf,

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

    let cli = Cli::parse();

    match cli.command {
        Command::Serve => Firn::open(&cli.config)?.serve().await,
        Command::Push(args) => push::run(args).await,
        Command::Status => Firn::open(&cli.config)?.show_status(),
        Command::Ls {
            owner,
            scope,
            limit,
        } => Firn::open(&cli.config)?.list_paths(owner.as_deref(), scope.as_deref(), limit),
        Command::Pr { command } => match command {
            PrCommand::Ls { owner } => Firn::open(&cli.config)?.list_prs(owner.as_deref()),
            PrCommand::Rm {
                owner,
                repo,
                number,
            } => Firn::open(&cli.config)?.remove_pr(&owner, &repo, number),
        },
        Command::Keygen {
            name,
            secret_out,
            public_out,
        } => run_keygen(&name, secret_out.as_deref(), public_out.as_deref()),
        Command::Gc { dry_run } => {
            let report = Firn::open(&cli.config)?.run_gc(dry_run).await?;
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
