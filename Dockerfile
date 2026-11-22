FROM rust:1-bookworm AS build

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1000 --home-dir /var/lib/firn --create-home firn

COPY --from=build /app/target/release/firn /usr/local/bin/firn

USER firn
WORKDIR /var/lib/firn
EXPOSE 8080

ENTRYPOINT ["firn"]
CMD ["serve", "/etc/firn/config.toml"]
