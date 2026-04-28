FROM grafana/grafana-oss:13.0.1

# Install ClickHouse datasource plugin for Analytics Engine.
# Pinned so rebuilds at the same git SHA produce the same artifact and a
# plugin takeover or bad release can't silently land on the next deploy.
RUN grafana cli plugins install vertamedia-clickhouse-datasource 3.4.11

# Copy Grafana config
COPY grafana.ini /etc/grafana/grafana.ini

# Copy provisioning configs and dashboards
COPY provisioning /etc/grafana/provisioning

EXPOSE 3000
