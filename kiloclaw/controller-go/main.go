package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	cfg, err := loadConfigFromEnv()
	if err != nil {
		log.Fatalf("[controller-go] configuration error: %v", err)
	}

	sup := newSupervisor(cfg.gatewayArgs)
	if _, err := sup.Start(); err != nil {
		log.Fatalf("[controller-go] failed to start gateway: %v", err)
	}

	app, err := newApp(cfg, sup)
	if err != nil {
		log.Fatalf("[controller-go] failed to initialize app: %v", err)
	}

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.port),
		Handler: app.Routes(),
	}

	log.Printf("[controller-go] listening on %s requireProxyToken=%t", server.Addr, cfg.requireProxyToken)

	stopSignals := make(chan os.Signal, 1)
	signal.Notify(stopSignals, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-stopSignals
		log.Printf("[controller-go] received %s, shutting down", sig.String())

		if err := sup.Shutdown(sig); err != nil {
			log.Printf("[controller-go] supervisor shutdown error: %v", err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("[controller-go] server shutdown error: %v", err)
		}
	}()

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[controller-go] server error: %v", err)
	}
}
