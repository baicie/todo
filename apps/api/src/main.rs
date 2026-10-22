use std::{env, error::Error, time::Duration};

use sqlx::postgres::PgPoolOptions;
use todo_api::{
    AppState, build_router,
    config::Config,
    db::MIGRATOR,
    ops::{self, Command},
    push,
};
use tokio::net::TcpListener;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    init_tracing();

    let command = match ops::parse_command(env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(2);
        }
    };

    match command {
        Command::Help => ops::print_help(),
        Command::Serve => {
            if let Err(error) = run_server().await {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
        }
        Command::Ops(command) => match ops::run(command).await {
            Ok(report) => match serde_json::to_string_pretty(&report) {
                Ok(rendered) => println!("{rendered}"),
                Err(error) => {
                    eprintln!("error: could not serialize operations report: {error}");
                    std::process::exit(1);
                }
            },
            Err(error) => {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
        },
    }
}

async fn run_server() -> Result<(), Box<dyn Error>> {
    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;

    MIGRATOR.run(&pool).await?;

    let state = AppState::new(pool, config.clone())?;
    let mail_provider = state.mailer.kind();
    let push_enabled = state.push.is_some();
    let app = build_router(state.clone())?;
    let listener = TcpListener::bind(config.bind_addr).await?;
    let push_worker = push::spawn_worker(state);

    tracing::info!(
        address = %config.bind_addr,
        environment = ?config.app_env,
        mail_provider,
        push_enabled,
        "To Do API listening"
    );

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    if let Some(worker) = push_worker {
        worker.abort();
    }
    result?;
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("todo_api=info,tower_http=info,sqlx=warn"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .try_init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %error, "failed to install Ctrl+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
