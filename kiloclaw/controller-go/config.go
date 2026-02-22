package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func loadConfigFromEnv() (controllerConfig, error) {
	token := strings.TrimSpace(os.Getenv("OPENCLAW_GATEWAY_TOKEN"))
	if token == "" {
		return controllerConfig{}, errors.New("OPENCLAW_GATEWAY_TOKEN is required")
	}

	argsJSON := strings.TrimSpace(os.Getenv("KILOCLAW_GATEWAY_ARGS"))
	if argsJSON == "" {
		return controllerConfig{}, errors.New("KILOCLAW_GATEWAY_ARGS is required")
	}

	var gatewayArgs []string
	if err := json.Unmarshal([]byte(argsJSON), &gatewayArgs); err != nil {
		return controllerConfig{}, fmt.Errorf("KILOCLAW_GATEWAY_ARGS must be valid JSON array: %w", err)
	}

	port := defaultPort
	if raw := strings.TrimSpace(os.Getenv("PORT")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return controllerConfig{}, errors.New("PORT must be a valid positive integer")
		}
		port = parsed
	}

	requireProxyToken := strings.EqualFold(strings.TrimSpace(os.Getenv("REQUIRE_PROXY_TOKEN")), "true")

	return controllerConfig{
		port:              port,
		expectedToken:     token,
		requireProxyToken: requireProxyToken,
		backendHost:       defaultBackendHost,
		backendPort:       defaultBackendPort,
		gatewayArgs:       gatewayArgs,
	}, nil
}
