// iceapi_test.go：ICE 端点（鉴权、TURN 凭据下发、未配置回退 STUN、secret 不泄露）。
package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"listogether/apps/relay/internal/hub"
)

func TestICERequiresSession(t *testing.T) {
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	srv := httptest.NewServer(NewICEAPI(testLogger, h, nil, "", 0, nil))
	t.Cleanup(srv.Close)
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无会话应 401, got %d", res.StatusCode)
	}
}

func TestICETurnCredentials(t *testing.T) {
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	created := createRoomForTest(t, h)
	attachHost(t, h, created)
	now := time.Unix(1735996400, 0)
	srv := httptest.NewServer(NewICEAPI(testLogger, h, []string{"turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"}, "listogether-test-secret", time.Hour, func() time.Time { return now }))
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Authorization", "Bearer "+created["sessionToken"].(string))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var body struct {
		IceServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"iceServers"`
		TurnEnabled bool `json:"turnEnabled"`
		TTLSeconds  int  `json:"ttlSeconds"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.TurnEnabled || body.TTLSeconds != 3600 {
		t.Fatalf("unexpected meta: %+v", body)
	}
	if len(body.IceServers) != 1 {
		t.Fatalf("expect 1 server, got %d", len(body.IceServers))
	}
	s := body.IceServers[0]
	if s.Username != "1736000000" || s.Credential != "owktllEOJ1LdlY0srw8HOtlgo6c=" {
		t.Fatalf("凭据不符合 coturn REST 算法: %+v", s)
	}
	if len(s.URLs) != 2 {
		t.Fatalf("urls = %v", s.URLs)
	}
	// 响应体不得包含 secret 本身
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "listogether-test-secret") {
		t.Fatal("响应泄露 secret")
	}
}

func TestICEFallbackSTUNWithoutTurn(t *testing.T) {
	h := hub.New(testLogger)
	t.Cleanup(h.Close)
	created := createRoomForTest(t, h)
	attachHost(t, h, created)
	srv := httptest.NewServer(NewICEAPI(testLogger, h, nil, "", 0, nil))
	t.Cleanup(srv.Close)
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Authorization", "Bearer "+created["sessionToken"].(string))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(raw), "stun:stun.l.google.com:19302") {
		t.Fatalf("未配置 TURN 应回退默认 STUN: %s", raw)
	}
	if !strings.Contains(string(raw), `"turnEnabled":false`) {
		t.Fatalf("turnEnabled 应为 false: %s", raw)
	}
}
