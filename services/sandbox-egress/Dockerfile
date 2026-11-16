FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist/main.mjs /app/main.mjs
RUN chown node:node /tmp
USER node
VOLUME ["/tmp"]
EXPOSE 3128
CMD ["node", "/app/main.mjs"]
