// Relay 主程序：装配配置、日志、HTTP 路由（/healthz、/ws、/api/rooms/*、
// /api/rooms/*/links/resolve、/api/oauth/*）并支持直连 TLS 与优雅关闭。
// panic recovery（Phase 4）：任何 handler panic 都不会击穿进程。
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"listogether/apps/relay/internal/config"
	"listogether/apps/relay/internal/httpapi"
	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/logging"
	"listogether/apps/relay/internal/oauth"
	"listogether/apps/relay/internal/providers"
	relayws "listogether/apps/relay/internal/ws"
)

func main() {
	cfg := config.FromEnv(os.Getenv)
	logger := logging.New(cfg.LogLevel)

	roomHub := hub.New(logger)

	// ---- 平台识别（D-014）：API base 可经环境变量覆盖（D-019 运维切换）----
	registry := providers.NewRegistryWithBases(providers.Bases{
		NetEaseAPIBase:    cfg.NetEaseAPIBase,
		QQMusicAPIBase:    cfg.QQMusicAPIBase,
		SpotifyOEmbedBase: cfg.SpotifyOEmbedBase,
		SpotifyAPIBase:    cfg.SpotifyAPIBase,
		YouTubeOEmbedBase: cfg.YouTubeOEmbedBase,
	})

	// ---- OAuth（D-015）：端点始终挂载，未配置凭证时状态接口显示"未配置"；
	// 未设置 PublicBaseURL 时无法构造回调地址，start() 报告 not-configured。
	oauthCfg := oauth.ConfigFromEnv(os.Getenv)
	oauthMgr := oauth.NewManager(oauthCfg, cfg.PublicBaseURL, roomHub.SessionExistsByHash, logger)
	if len(oauthCfg.Providers) > 0 && cfg.PublicBaseURL == "" {
		logger.Warn("oauth providers configured but LISTO_RELAY_PUBLIC_BASE_URL is empty; start() will report not-configured")
	}

	mux := http.NewServeMux()
	mux.Handle("GET /healthz", httpapi.NewHealthHandler(cfg.AllowedOrigins))
	mux.Handle("GET /ws", relayws.NewHandler(logger, roomHub, cfg.AllowedOrigins))
	mux.Handle("/api/rooms", httpapi.NewRoomAPI(logger, roomHub, cfg.AllowedOrigins))
	mux.Handle("/api/rooms/", httpapi.NewRoomAPI(logger, roomHub, cfg.AllowedOrigins))
	mux.Handle("POST /api/rooms/{roomId}/links/resolve", httpapi.WithRoomCORS(cfg.AllowedOrigins, httpapi.NewResolveAPI(logger, roomHub, registry, oauthMgr)))
	mux.Handle("/api/oauth/", httpapi.NewOAuthAPI(logger, roomHub, oauthMgr, cfg.AllowedOrigins))
	mux.Handle("GET /api/webrtc/ice", httpapi.WithRoomCORS(cfg.AllowedOrigins, httpapi.NewICEAPI(logger, roomHub, cfg.TurnURLs, cfg.TurnSecret, cfg.TurnTTL, nil)))

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.WithRecovery(logger, mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		if cfg.TLS() {
			errCh <- srv.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile)
			return
		}
		errCh <- srv.ListenAndServe()
	}()

	mode := "http"
	if cfg.TLS() {
		mode = "https/wss"
	}
	logger.Info("relay listening",
		"addr", cfg.Addr,
		"mode", mode,
		"logLevel", cfg.LogLevel,
		"allowedOrigins", cfg.AllowedOrigins,
		"maxMembers", cfg.MaxMembers,
		"offlineTTLSeconds", int(cfg.OfflineTTL/time.Second),
		"oauthProvidersConfigured", len(oauthCfg.Providers),
		"version", httpapi.Version,
	)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "err", err.Error())
			roomHub.Close()
			os.Exit(1)
		}
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "err", err.Error())
	}
	roomHub.Close()
	logger.Info("relay stopped")
}
