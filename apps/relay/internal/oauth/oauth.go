// Package oauth 实现官方 OAuth Authorization Code + PKCE（D-015）。
//
// token 边界（硬性，测试覆盖）：
//   - token 只保存在本进程内存（map），不落盘、不写日志、不回传浏览器；
//   - 状态接口只输出 connected + 打码用户标识 + scope；
//   - 绑定会话哈希（auth.HashToken），会话清理时同步释放；
//   - relay 重启即全部失效。
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// 语义化错误。
var (
	// ErrNotConfigured 该 provider 未配置凭证。
	ErrNotConfigured = errors.New("oauth provider not configured")
	// ErrUnknownState state 不存在/过期/不匹配（防 CSRF）。
	ErrUnknownState = errors.New("unknown oauth state")
	// ErrDenied 用户在 provider 侧取消了授权。
	ErrDenied = errors.New("authorization denied")
	// ErrProviderError 与 provider 交互失败（网络/非 2xx/响应缺失字段）。
	ErrProviderError = errors.New("oauth provider error")
	// ErrUnknownProvider 未知的 provider id。
	ErrUnknownProvider = errors.New("unknown oauth provider")
)

const (
	flowTTL       = 10 * time.Minute
	httpTimeout   = 8 * time.Second
	maxTokenTTL   = 24 * time.Hour // 刷新失败时的兜底寿命
	labelMaxRunes = 24
)

// ProviderConfig 是单个 provider 的配置（全部来自环境变量）。
type ProviderConfig struct {
	ID           string
	ClientID     string
	ClientSecret string // 可为空：公开客户端仅用 PKCE
	AuthorizeURL string
	TokenURL     string
	RevokeURL    string // 可为空：不支持撤销端点
	UserInfoURL  string // 可为空：不打用户标识
	Scopes       []string
}

// Config 是全部 provider 配置；Configured 判定 = ClientID 非空。
type Config struct{ Providers map[string]ProviderConfig }

// KnownProviderIDs 内置 provider（端点默认值已预置）。
var KnownProviderIDs = []string{"spotify", "netease", "qqmusic"}

// ConfigFromEnv 从环境变量读取：
// LISTO_OAUTH_<ID>_CLIENT_ID / _CLIENT_SECRET / _AUTHORIZE_URL / _TOKEN_URL / _REVOKE_URL / _USERINFO_URL / _SCOPES。
// 出现 _CLIENT_ID 即视为已配置该 provider；<ID> 大写连字符转下划线。
func ConfigFromEnv(getenv func(string) string) Config {
	cfg := Config{Providers: map[string]ProviderConfig{}}
	for _, id := range KnownProviderIDs {
		prefix := "LISTO_OAUTH_" + strings.ToUpper(strings.ReplaceAll(id, "-", "_")) + "_"
		clientID := strings.TrimSpace(getenv(prefix + "CLIENT_ID"))
		if clientID == "" {
			continue
		}
		def := defaultEndpoints(id)
		scopes := strings.Split(strings.TrimSpace(getenv(prefix+"SCOPES")), ",")
		cfg.Providers[id] = ProviderConfig{
			ID:           id,
			ClientID:     clientID,
			ClientSecret: strings.TrimSpace(getenv(prefix + "CLIENT_SECRET")),
			AuthorizeURL: firstNonEmpty(getenv(prefix+"AUTHORIZE_URL"), def.authorize),
			TokenURL:     firstNonEmpty(getenv(prefix+"TOKEN_URL"), def.token),
			RevokeURL:    firstNonEmpty(getenv(prefix+"REVOKE_URL"), def.revoke),
			UserInfoURL:  firstNonEmpty(getenv(prefix+"USERINFO_URL"), def.userInfo),
			Scopes:       scopes,
		}
	}
	return cfg
}

type endpoints struct{ authorize, token, revoke, userInfo string }

// defaultEndpoints 预置官方端点；netease/qqmusic 无公开 OAuth 时默认留空（配置即需显式端点）。
func defaultEndpoints(id string) endpoints {
	switch id {
	case "spotify":
		return endpoints{
			authorize: "https://accounts.spotify.com/authorize",
			token:     "https://accounts.spotify.com/api/token",
			revoke:    "", // Spotify 未提供标准撤销端点
			userInfo:  "https://api.spotify.com/v1/me",
		}
	default:
		return endpoints{}
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ---- 状态输出 ----

// ProviderStatus 是对浏览器的唯一可见状态（不含任何 token）。
type ProviderStatus struct {
	ID         string   `json:"id"`
	Configured bool     `json:"configured"`
	Connected  bool     `json:"connected"`
	UserLabel  string   `json:"userLabel,omitempty"`
	Scopes     []string `json:"scopes,omitempty"`
}

// ---- 内部状态 ----

type flowState struct {
	memberKey  string
	providerID string
	verifier   string
	createdAt  time.Time
}

type tokenSet struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Scope        string
	UserLabel    string
}

// Manager 管理 OAuth 流程与 token 生命周期。
type Manager struct {
	cfg          Config
	logger       *slog.Logger
	nowFunc      func() time.Time
	httpClient   *http.Client
	redirectBase string // 回调基址，如 https://relay.example.com

	mu     sync.Mutex
	flows  map[string]*flowState
	tokens map[string]*tokenSet // memberKey → tokenSet（每 provider 独立 key：memberKey+"\x00"+providerID）

	// sessionValid 由 hub 注入：会话哈希仍有效返回 true（Sweep 时释放失效会话的 token）。
	sessionValid func(memberKey string) bool
}

// NewManager 创建 Manager；redirectBase 是对外可达的 Relay 基址（生成 redirect_uri）。
func NewManager(cfg Config, redirectBase string, sessionValid func(string) bool, logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	redirectBase = strings.TrimRight(strings.TrimSpace(redirectBase), "/")
	return &Manager{
		cfg:          cfg,
		logger:       logger,
		nowFunc:      time.Now,
		httpClient:   &http.Client{Timeout: httpTimeout},
		redirectBase: redirectBase,
		flows:        map[string]*flowState{},
		tokens:       map[string]*tokenSet{},
		sessionValid: sessionValid,
	}
}

// tokenKey memberKey 与 providerID 的复合键。
func tokenKey(memberKey, providerID string) string { return memberKey + "\x00" + providerID }

// ---- PKCE（RFC 7636） ----

// newVerifier 生成 64 字节随机 code_verifier（base64url，无填充）。
func newVerifier() (string, error) {
	b := make([]byte, 64)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// challengeS256 计算 code_challenge = BASE64URL(SHA256(verifier))。
func challengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// ---- 流程 ----

// Start 生成 state/PKCE 并返回授权跳转 URL；provider 未配置返回 ErrNotConfigured。
func (m *Manager) Start(providerID, memberKey string) (string, error) {
	p, ok := m.cfg.Providers[providerID]
	if !ok {
		if isKnownProvider(providerID) {
			return "", fmt.Errorf("%w: %s（需要设置对应环境变量）", ErrNotConfigured, providerID)
		}
		return "", fmt.Errorf("%w: %s", ErrUnknownProvider, providerID)
	}
	if p.ClientID == "" {
		return "", fmt.Errorf("%w: %s（需要设置 LISTO_OAUTH_%s_CLIENT_ID）", ErrNotConfigured, providerID,
			strings.ToUpper(strings.ReplaceAll(providerID, "-", "_")))
	}
	if m.redirectBase == "" {
		return "", fmt.Errorf("%w: Relay 未配置 LISTO_RELAY_PUBLIC_BASE_URL，无法构造 OAuth 回调地址", ErrNotConfigured)
	}
	verifier, err := newVerifier()
	if err != nil {
		return "", fmt.Errorf("%w: 生成 code_verifier 失败", ErrProviderError)
	}
	state, err := randomHex(16)
	if err != nil {
		return "", fmt.Errorf("%w: 生成 state 失败", ErrProviderError)
	}
	m.mu.Lock()
	m.pruneLocked()
	m.flows[state] = &flowState{memberKey: memberKey, providerID: providerID, verifier: verifier, createdAt: m.nowFunc()}
	m.mu.Unlock()

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", p.ClientID)
	q.Set("redirect_uri", m.redirectURI(providerID))
	if len(p.Scopes) > 0 {
		q.Set("scope", strings.Join(p.Scopes, " "))
	}
	q.Set("state", state)
	q.Set("code_challenge", challengeS256(verifier))
	q.Set("code_challenge_method", "S256")
	return p.AuthorizeURL + "?" + q.Encode(), nil
}

// HandleCallback 处理 provider 重定向回的 code（或错误）；成功后 token 只进内存。
// 先校验 state（防伪造错误探测），再处理 provider 错误。
func (m *Manager) HandleCallback(providerID, code, state, providerError string) error {
	p, ok := m.cfg.Providers[providerID]
	if !ok || p.ClientID == "" {
		return fmt.Errorf("%w: %s", ErrUnknownProvider, providerID)
	}
	m.mu.Lock()
	flow, ok := m.flows[state]
	if ok && flow.providerID == providerID && m.nowFunc().Sub(flow.createdAt) <= flowTTL {
		// 一次性：无论成功与否都消费 state
		delete(m.flows, state)
	} else {
		ok = false
	}
	m.mu.Unlock()
	if !ok {
		return ErrUnknownState
	}
	if providerError != "" {
		return fmt.Errorf("%w: 平台返回 %s", ErrDenied, providerError)
	}

	set, err := m.exchangeCode(&p, code, flow.verifier)
	if err != nil {
		return err
	}
	if p.UserInfoURL != "" {
		if label := m.fetchUserLabel(&p, set.AccessToken); label != "" {
			set.UserLabel = label
		}
	}
	m.mu.Lock()
	m.tokens[tokenKey(flow.memberKey, providerID)] = set
	m.mu.Unlock()
	// 日志只记录事件与 provider，不记录任何 token/code/state
	m.logger.Info("oauth connected", "provider", providerID)
	return nil
}

// exchangeCode 用 code + verifier（PKCE）换 token；带 client_secret 时为机密客户端。
func (m *Manager) exchangeCode(p *ProviderConfig, code, verifier string) (*tokenSet, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", m.redirectURI(p.ID))
	form.Set("client_id", p.ClientID)
	form.Set("code_verifier", verifier)
	if p.ClientSecret != "" {
		form.Set("client_secret", p.ClientSecret)
	}
	return m.postToken(p, form)
}

// refresh 刷新 token；provider 轮换 refresh_token 时以新值覆盖（RFC 6749 §6 允许）。
func (m *Manager) refresh(p *ProviderConfig, old *tokenSet) (*tokenSet, error) {
	if old.RefreshToken == "" {
		return nil, fmt.Errorf("%w: 无 refresh_token 可刷新", ErrProviderError)
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", old.RefreshToken)
	form.Set("client_id", p.ClientID)
	if p.ClientSecret != "" {
		form.Set("client_secret", p.ClientSecret)
	}
	set, err := m.postToken(p, form)
	if err != nil {
		return nil, err
	}
	if set.RefreshToken == "" { // provider 未轮换时保留旧值
		set.RefreshToken = old.RefreshToken
	}
	return set, nil
}

func (m *Manager) postToken(p *ProviderConfig, form url.Values) (*tokenSet, error) {
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("%w: 构造 token 请求失败", ErrProviderError)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: token 请求失败（%v）", ErrProviderError, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: token 端点返回 HTTP %d", ErrProviderError, resp.StatusCode)
	}
	var parsed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Scope        string `json:"scope"`
		TokenType    string `json:"token_type"`
	}
	if err := unmarshalJSON(body, &parsed); err != nil {
		return nil, fmt.Errorf("%w: token 响应不是合法 JSON", ErrProviderError)
	}
	if parsed.AccessToken == "" {
		return nil, fmt.Errorf("%w: token 响应缺少 access_token", ErrProviderError)
	}
	ttl := time.Duration(parsed.ExpiresIn) * time.Second
	if ttl <= 0 || ttl > maxTokenTTL {
		ttl = maxTokenTTL
	}
	return &tokenSet{
		AccessToken:  parsed.AccessToken,
		RefreshToken: parsed.RefreshToken,
		ExpiresAt:    m.nowFunc().Add(ttl),
		Scope:        parsed.Scope,
	}, nil
}

// fetchUserLabel 拉取并打码用户标识；任何失败都不阻塞授权（label 留空）。
func (m *Manager) fetchUserLabel(p *ProviderConfig, accessToken string) string {
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.UserInfoURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	var parsed struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Nickname    string `json:"nickname"`
	}
	if unmarshalJSON(body, &parsed) != nil {
		return ""
	}
	label := parsed.DisplayName
	if label == "" {
		label = parsed.Nickname
	}
	if label == "" {
		label = parsed.ID
	}
	return maskLabel(label)
}

// maskLabel 打码用户标识：保留前 1 个 rune + "…"，杜绝可还原性。
func maskLabel(label string) string {
	runes := []rune(strings.TrimSpace(label))
	if len(runes) == 0 {
		return ""
	}
	if len(runes) > labelMaxRunes {
		runes = runes[:labelMaxRunes]
	}
	return string(runes[:1]) + "…"
}

// ---- 查询与生命周期 ----

// Status 返回 provider 对浏览器的可见状态；token 过期时尽力刷新。
func (m *Manager) Status(providerID, memberKey string) ProviderStatus {
	p, ok := m.cfg.Providers[providerID]
	status := ProviderStatus{ID: providerID, Configured: ok && p.ClientID != "", Scopes: p.Scopes}
	if !status.Configured {
		return status
	}
	if set := m.validTokenSet(&p, memberKey); set != nil {
		status.Connected = true
		status.UserLabel = set.UserLabel
		if set.Scope != "" {
			status.Scopes = strings.Fields(set.Scope)
		}
	}
	return status
}

// AccessToken 返回有效 access token（自动刷新）；未连接返回错误（token 本身绝不外泄出本包）。
func (m *Manager) AccessToken(providerID, memberKey string) (string, error) {
	p, ok := m.cfg.Providers[providerID]
	if !ok || p.ClientID == "" {
		return "", ErrNotConfigured
	}
	set := m.validTokenSet(&p, memberKey)
	if set == nil {
		return "", ErrUnknownState
	}
	return set.AccessToken, nil
}

// validTokenSet 取有效 token；过期则尝试刷新（轮换安全）。
func (m *Manager) validTokenSet(p *ProviderConfig, memberKey string) *tokenSet {
	key := tokenKey(memberKey, p.ID)
	m.mu.Lock()
	set, ok := m.tokens[key]
	m.mu.Unlock()
	if !ok {
		return nil
	}
	if m.nowFunc().Before(set.ExpiresAt) {
		return set
	}
	newSet, err := m.refresh(p, set)
	if err != nil {
		// 刷新失败：删除本地副本（用户需重新授权）；错误不外泄 token
		m.mu.Lock()
		delete(m.tokens, key)
		m.mu.Unlock()
		m.logger.Info("oauth token refresh failed", "provider", p.ID)
		return nil
	}
	m.mu.Lock()
	m.tokens[key] = newSet
	m.mu.Unlock()
	return newSet
}

// Disconnect 尽力调用撤销端点并删除本地 token 副本。
func (m *Manager) Disconnect(providerID, memberKey string) error {
	p, ok := m.cfg.Providers[providerID]
	if !ok || p.ClientID == "" {
		return ErrNotConfigured
	}
	key := tokenKey(memberKey, providerID)
	m.mu.Lock()
	set, ok := m.tokens[key]
	delete(m.tokens, key)
	m.mu.Unlock()
	if !ok {
		return nil
	}
	if p.RevokeURL == "" {
		return nil // provider 不支持撤销：仅删除本地副本
	}
	form := url.Values{}
	form.Set("token", set.AccessToken)
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.RevokeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if p.ClientSecret != "" {
		req.SetBasicAuth(p.ClientID, p.ClientSecret)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("%w: 撤销请求失败", ErrProviderError)
	}
	defer resp.Body.Close()
	_ = resp
	return nil
}

// Sweep 清理过期 flow 与已失效会话的 token（由 hub 周期调用）。
func (m *Manager) Sweep() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	if m.sessionValid == nil {
		return
	}
	for key := range m.tokens {
		memberKey, _, _ := strings.Cut(key, "\x00")
		if !m.sessionValid(memberKey) {
			delete(m.tokens, key)
		}
	}
}

func (m *Manager) pruneLocked() {
	now := m.nowFunc()
	for state, f := range m.flows {
		if now.Sub(f.createdAt) > flowTTL {
			delete(m.flows, state)
		}
	}
}

// redirectURI 是 provider 侧登记的回调地址。
func (m *Manager) redirectURI(providerID string) string {
	return m.redirectBase + "/api/oauth/" + url.PathEscape(providerID) + "/callback"
}

func isKnownProvider(id string) bool {
	for _, known := range KnownProviderIDs {
		if id == known {
			return true
		}
	}
	return false
}

func randomHex(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func unmarshalJSON(data []byte, v any) error {
	return json.Unmarshal(data, v)
}
