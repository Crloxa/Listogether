package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateAcceptsValidEnvelope(t *testing.T) {
	env := Envelope{
		V:            1,
		Type:         "HEARTBEAT",
		EventID:      "evt-1",
		RoomRevision: 3,
		SenderID:     "m-1",
		SentAtMs:     100,
		Payload:      json.RawMessage(`{"clientTimeMs":100}`),
	}
	if err := Validate(&env); err != nil {
		t.Fatalf("valid envelope rejected: %v", err)
	}
}

func TestValidateRejectsWrongVersion(t *testing.T) {
	env := Envelope{V: 2, Type: "HEARTBEAT", EventID: "e", RoomRevision: 0, SenderID: "m-1", SentAtMs: 0, Payload: json.RawMessage(`{}`)}
	err := Validate(&env)
	if err == nil || err.Code != CodeUnsupportedVersion {
		t.Fatalf("want UNSUPPORTED_VERSION, got %v", err)
	}
}

func TestValidateRejectsUnknownType(t *testing.T) {
	env := Envelope{V: 1, Type: "SOMETHING_ELSE", EventID: "e", RoomRevision: 0, SenderID: "m-1", SentAtMs: 0, Payload: json.RawMessage(`{}`)}
	err := Validate(&env)
	if err == nil || err.Code != CodeUnknownType {
		t.Fatalf("want UNKNOWN_TYPE, got %v", err)
	}
}

func TestValidateRejectsMissingFields(t *testing.T) {
	cases := map[string]Envelope{
		"empty eventId":      {V: 1, Type: "PLAY", EventID: "", RoomRevision: 0, SenderID: "m-1", SentAtMs: 0, Payload: json.RawMessage(`{"positionMs":1}`)},
		"empty senderId":     {V: 1, Type: "PLAY", EventID: "e", RoomRevision: 0, SenderID: "", SentAtMs: 0, Payload: json.RawMessage(`{"positionMs":1}`)},
		"negative revision":  {V: 1, Type: "PLAY", EventID: "e", RoomRevision: -1, SenderID: "m-1", SentAtMs: 0, Payload: json.RawMessage(`{"positionMs":1}`)},
		"negative sentAtMs":  {V: 1, Type: "PLAY", EventID: "e", RoomRevision: 0, SenderID: "m-1", SentAtMs: -5, Payload: json.RawMessage(`{"positionMs":1}`)},
		"empty payload":      {V: 1, Type: "PLAY", EventID: "e", RoomRevision: 0, SenderID: "m-1", SentAtMs: 0, Payload: nil},
		"payload not object": {V: 1, Type: "PLAY", EventID: "e", RoomRevision: 0, SenderID: "m-1", SentAtMs: 0, Payload: json.RawMessage(`[]`)},
	}
	for name, env := range cases {
		if err := Validate(&env); err == nil || err.Code != CodeInvalidMessage {
			t.Fatalf("%s: want INVALID_MESSAGE, got %v", name, err)
		}
	}
}

func TestIsStale(t *testing.T) {
	env := Envelope{RoomRevision: 5}
	if !IsStale(&env, 6) {
		t.Fatal("revision 5 vs current 6 should be stale")
	}
	if IsStale(&env, 5) {
		t.Fatal("equal revision is not stale")
	}
	if IsStale(&env, 0) {
		t.Fatal("revision 5 vs current 0 is not stale")
	}
}

func TestNewErrorEnvelope(t *testing.T) {
	env := NewErrorEnvelope(CodeInvalidMessage, "bad", "evt-src", 1234)
	if env.Type != "ERROR" || env.SenderID != "relay" || env.V != ProtocolVersion {
		t.Fatalf("unexpected envelope: %+v", env)
	}
	if env.EventID == "" {
		t.Fatal("error envelope must carry an eventId")
	}
	var payload map[string]string
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if payload["code"] != CodeInvalidMessage || payload["refEventId"] != "evt-src" {
		t.Fatalf("unexpected payload: %v", payload)
	}
}

// TestKnownTypesParityWithSchema 保证 Go 侧已知事件集合与 canonical schema 的 type 枚举一致。
func TestKnownTypesParityWithSchema(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "packages", "protocol", "schema", "envelope.schema.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read canonical schema: %v", err)
	}
	var schema struct {
		Properties struct {
			Type struct {
				Enum []string `json:"enum"`
			} `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	if len(schema.Properties.Type.Enum) == 0 {
		t.Fatal("schema type enum is empty")
	}
	schemaTypes := map[string]struct{}{}
	for _, typ := range schema.Properties.Type.Enum {
		schemaTypes[typ] = struct{}{}
		if _, ok := KnownTypes[typ]; !ok {
			t.Fatalf("schema 定义了 Go 侧未知的事件类型: %s", typ)
		}
	}
	for typ := range KnownTypes {
		if _, ok := schemaTypes[typ]; !ok {
			t.Fatalf("Go 侧事件 %s 不在 canonical schema 中", typ)
		}
	}
}
