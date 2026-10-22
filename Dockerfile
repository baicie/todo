FROM rust:1.96-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY apps/api/Cargo.toml apps/api/Cargo.toml
COPY apps/api/src apps/api/src
COPY crates/native-core/Cargo.toml crates/native-core/Cargo.toml
COPY crates/native-core/src crates/native-core/src
COPY db/postgres/migrations db/postgres/migrations

RUN cargo build --locked --release -p todo-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 todo

COPY --from=builder /app/target/release/todo-api /usr/local/bin/todo-api

USER todo
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8787/readyz || exit 1

ENTRYPOINT ["/usr/local/bin/todo-api"]
