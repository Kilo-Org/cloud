FROM grafana/grafana-oss:latest

# Install ClickHouse datasource plugin for Analytics Engine
RUN grafana cli plugins install vertamedia-clickhouse-datasource

# Copy Grafana config
COPY grafana.ini /etc/grafana/grafana.ini

# Copy provisioning configs and dashboards
COPY provisioning /etc/grafana/provisioning

EXPOSE 3000
