# Makefile — convenience targets for Kilo-Org/cloud

COMPOSE_DEV := docker compose -f dev/docker-compose.dev.yml

.PHONY: dev-docker dev-docker-core dev-docker-down

## Start all services in Docker (postgres + nextjs + all workers)
dev-docker:
	./dev/dev.sh

## Start only postgres + nextjs
dev-docker-core:
	$(COMPOSE_DEV) --profile core up

## Stop all Docker dev services
dev-docker-down:
	$(COMPOSE_DEV) --profile all down
