package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

func newReverseProxy(cfg controllerConfig) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(fmt.Sprintf("http://%s:%d", cfg.backendHost, cfg.backendPort))
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Header.Del(proxyTokenHeader)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		log.Printf("[controller-go] proxy error: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Bad Gateway"})
	}
	return proxy, nil
}
