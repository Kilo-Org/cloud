FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl dnsutils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install pg@8.23.1 >/dev/null
COPY server.mjs /app/server.mjs
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
