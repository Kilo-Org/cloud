FROM docker.io/cloudflare/sandbox:0.6.7

RUN apt-get update && apt-get install -y iproute2 && rm -rf /var/lib/apt/lists/*

EXPOSE 8080