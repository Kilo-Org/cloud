package main

import (
	"net/http"
	"time"
)

const (
	defaultPort           = 18789
	defaultBackendHost    = "127.0.0.1"
	defaultBackendPort    = 3001
	proxyTokenHeader      = "x-kiloclaw-proxy-token"
	bearerPrefix          = "Bearer "
	backoffInitial        = time.Second
	backoffMax            = 5 * time.Minute
	backoffMultiplier     = 2
	healthyThreshold      = 30 * time.Second
	shutdownTimeout       = 10 * time.Second
	serverShutdownTimeout = 10 * time.Second
)

type supervisorState string

const (
	stateStopped      supervisorState = "stopped"
	stateStarting     supervisorState = "starting"
	stateRunning      supervisorState = "running"
	stateStopping     supervisorState = "stopping"
	stateCrashed      supervisorState = "crashed"
	stateShuttingDown supervisorState = "shutting_down"
)

type controllerConfig struct {
	port              int
	expectedToken     string
	requireProxyToken bool
	backendHost       string
	backendPort       int
	gatewayArgs       []string
}

type lastExit struct {
	Code   *int   `json:"code"`
	Signal string `json:"signal"`
	At     string `json:"at"`
}

type supervisorStats struct {
	State    supervisorState `json:"state"`
	Pid      *int            `json:"pid"`
	Uptime   int64           `json:"uptime"`
	Restarts int             `json:"restarts"`
	LastExit *lastExit       `json:"lastExit"`
}

type authMode uint8

const (
	authNone authMode = iota
	authGatewayBearer
)

type routeDef struct {
	pattern string
	auth    authMode
	handler http.HandlerFunc
}
