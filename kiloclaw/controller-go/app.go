package main

import (
	"net/http"
	"strings"
)

type app struct {
	cfg        controllerConfig
	supervisor *supervisor
	proxy      http.Handler
}

func newApp(cfg controllerConfig, sup *supervisor) (*app, error) {
	proxy, err := newReverseProxy(cfg)
	if err != nil {
		return nil, err
	}
	return &app{
		cfg:        cfg,
		supervisor: sup,
		proxy:      proxy,
	}, nil
}

func (a *app) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	for _, route := range a.routeTable() {
		handler := route.handler
		if route.auth == authGatewayBearer {
			handler = a.requireGatewayAuth(handler)
		}
		mux.HandleFunc(route.pattern, handler)
	}
	mux.HandleFunc("/", a.handleProxy)
	return mux
}

func (a *app) routeTable() []routeDef {
	return []routeDef{
		{pattern: "GET /health", auth: authNone, handler: a.handleHealth},
		{pattern: "GET /gateway/status", auth: authGatewayBearer, handler: a.handleGatewayStatus},
		{pattern: "POST /gateway/start", auth: authGatewayBearer, handler: a.handleGatewayStart},
		{pattern: "POST /gateway/stop", auth: authGatewayBearer, handler: a.handleGatewayStop},
		{pattern: "POST /gateway/restart", auth: authGatewayBearer, handler: a.handleGatewayRestart},
	}
}

func (a *app) requireGatewayAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, bearerPrefix) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			return
		}
		token := strings.TrimPrefix(header, bearerPrefix)
		if token != a.cfg.expectedToken {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			return
		}
		next(w, r)
	}
}

func (a *app) handleHealth(w http.ResponseWriter, _ *http.Request) {
	stats := a.supervisor.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"gateway":  stats.State,
		"uptime":   stats.Uptime,
		"restarts": stats.Restarts,
	})
}

func (a *app) handleGatewayStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.supervisor.Stats())
}

func (a *app) handleGatewayStart(w http.ResponseWriter, _ *http.Request) {
	started, err := a.supervisor.Start()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !started {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Gateway already running or starting"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleGatewayStop(w http.ResponseWriter, _ *http.Request) {
	_, err := a.supervisor.Stop()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleGatewayRestart(w http.ResponseWriter, _ *http.Request) {
	_, err := a.supervisor.Restart()
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "shutting down") {
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleProxy(w http.ResponseWriter, r *http.Request) {
	if a.cfg.requireProxyToken && r.Header.Get(proxyTokenHeader) != a.cfg.expectedToken {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		return
	}

	r.Header.Del(proxyTokenHeader)
	a.proxy.ServeHTTP(w, r)
}
