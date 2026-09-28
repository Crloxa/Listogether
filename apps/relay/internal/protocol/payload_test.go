package protocol

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func expectInvalid(t *testing.T, got *ProtocolError) {
	t.Helper()
	if got == nil {
		t.Fatal("期望 INVALID_MESSAGE 错误，得到 nil")
	}
	if got.Code != CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got.Code)
	}
}

func TestDecodePosition(t *testing.T) {
	p, perr := DecodePosition([]byte(`{"positionMs":1500}`))
	if perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}
	if p.PositionMs != 1500 {
		t.Fatalf("positionMs = %d, want 1500", p.PositionMs)
	}
	_, perr = DecodePosition([]byte(`{"positionMs":-1}`))
	expectInvalid(t, perr)
	_, perr = DecodePosition([]byte(`{"positionMs":1,"extra":true}`))
	expectInvalid(t, perr)
}

func TestDecodeHeartbeat(t *testing.T) {
	if _, perr := DecodeHeartbeat([]byte(`{"clientTimeMs":123}`)); perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}
	_, perr := DecodeHeartbeat([]byte(`{"clientTimeMs":-5}`))
	expectInvalid(t, perr)
}

func TestDecodeReady(t *testing.T) {
	p, perr := DecodeReady([]byte(`{"transitionId":"t-1"}`))
	if perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}
	if p.TransitionID != "t-1" {
		t.Fatalf("transitionId = %q", p.TransitionID)
	}
	_, perr = DecodeReady([]byte(`{}`))
	expectInvalid(t, perr)
	_, perr = DecodeReady([]byte(`{"transitionId":"` + strings.Repeat("x", MaxTransitionIDLen+1) + `"}`))
	expectInvalid(t, perr)
}

func TestDecodeNextTrackPrepare(t *testing.T) {
	ok := NextTrackPreparePayload{
		TransitionID:      "tr-1",
		Track:             Track{TrackID: "k1", Title: "Song", DurationMs: 180000},
		StartPositionMs:   0,
		PrepareDeadlineMs: 2000,
		StartAtMs:         5000,
	}
	if _, perr := DecodeNextTrackPrepare(mustMarshal(t, ok)); perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}

	// startAtMs <= prepareDeadlineMs 拒绝（schema 无法表达的跨字段约束）
	bad := ok
	bad.StartAtMs = bad.PrepareDeadlineMs
	_, perr := DecodeNextTrackPrepare(mustMarshal(t, bad))
	expectInvalid(t, perr)

	// track 缺 title 拒绝
	badTrack := ok
	badTrack.Track.Title = ""
	_, perr = DecodeNextTrackPrepare(mustMarshal(t, badTrack))
	expectInvalid(t, perr)

	// 未知字段拒绝
	_, perr = DecodeNextTrackPrepare([]byte(`{"transitionId":"tr","track":{},"startPositionMs":0,"prepareDeadlineMs":1,"startAtMs":2,"sneaky":1}`))
	expectInvalid(t, perr)
}

func TestDecodeResyncRequest(t *testing.T) {
	if _, perr := DecodeResyncRequest([]byte(`{}`)); perr != nil {
		t.Fatalf("空对象应接受: %v", perr)
	}
	if _, perr := DecodeResyncRequest([]byte(`{"reason":"manual"}`)); perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}
	_, perr := DecodeResyncRequest([]byte(`{"reason":"hijack"}`))
	expectInvalid(t, perr)
}

func TestDecodeWebrtcAndIce(t *testing.T) {
	if _, perr := DecodeWebrtcSdp([]byte(`{"toMemberId":"m1","sdp":"v=0..."}`)); perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}
	_, perr := DecodeWebrtcSdp([]byte(`{"toMemberId":"m1","sdp":""}`))
	expectInvalid(t, perr)

	if _, perr := DecodeIceCandidate([]byte(`{"toMemberId":"m1","candidate":""}`)); perr != nil {
		t.Fatalf("空 candidate 应接受: %v", perr)
	}
	_, perr = DecodeIceCandidate([]byte(`{"toMemberId":"","candidate":"c"}`))
	expectInvalid(t, perr)
}

func TestTrackValidate(t *testing.T) {
	track := Track{TrackID: "t1", Title: "T", Artist: "A", DurationMs: 1000}
	if perr := track.Validate(); perr != nil {
		t.Fatalf("unexpected error: %v", perr)
	}
	track.DurationMs = -1
	if perr := track.Validate(); perr == nil || perr.Code != CodeInvalidMessage {
		t.Fatalf("负 durationMs 应拒绝, got %v", perr)
	}
}

func TestMarshalPayload(t *testing.T) {
	raw := MarshalPayload(MemberLeftPayload{MemberID: "m1", Reason: "kicked"})
	if !strings.Contains(string(raw), `"reason":"kicked"`) {
		t.Fatalf("unexpected payload: %s", raw)
	}
}

func TestTrackSourceValidate(t *testing.T) {
	src := TrackSource{Platform: "netease", URL: "https://music.163.com/song?id=347230", Playability: "needs_login"}
	if perr := src.Validate(); perr != nil {
		t.Fatalf("合法 source 应接受: %v", perr)
	}
	badPlatform := src
	badPlatform.Platform = "evil"
	if perr := badPlatform.Validate(); perr == nil || perr.Code != CodeInvalidMessage {
		t.Fatalf("未知 platform 应拒绝, got %v", perr)
	}
	badPlay := src
	badPlay.Playability = "free"
	if perr := badPlay.Validate(); perr == nil || perr.Code != CodeInvalidMessage {
		t.Fatalf("未知 playability 应拒绝, got %v", perr)
	}
	long := src
	long.URL = strings.Repeat("a", MaxSourceURLLen+1)
	if perr := long.Validate(); perr == nil {
		t.Fatalf("超长 url 应拒绝")
	}
}

func TestTrackValidateWithSource(t *testing.T) {
	track := Track{TrackID: "t1", Title: "T", DurationMs: 1, Source: &TrackSource{Platform: "qqmusic", URL: "https://y.qq.com/n/yqq/song/001J5QJL1pRQYQ.html"}}
	if perr := track.Validate(); perr != nil {
		t.Fatalf("带 source 的 track 应接受: %v", perr)
	}
	track.Source = &TrackSource{Platform: "netease", URL: "https://music.163.com/x", Playability: "wrong"}
	if perr := track.Validate(); perr == nil {
		t.Fatalf("track.source 校验应生效")
	}
}

func TestDecodeTrackLyrics(t *testing.T) {
	p, perr := DecodeTrackLyrics([]byte(`{"trackId":"t1","format":"lrc","lyrics":"[00:01.00]你好"}`))
	if perr != nil {
		t.Fatalf("合法歌词应接受: %v", perr)
	}
	if p.Format != "lrc" || p.TrackID != "t1" {
		t.Fatalf("unexpected payload: %+v", p)
	}
	if _, perr = DecodeTrackLyrics([]byte(`{"trackId":"t1","format":"xml","lyrics":"x"}`)); perr == nil || perr.Code != CodeInvalidMessage {
		t.Fatalf("未知 format 应拒绝, got %v", perr)
	}
	if _, perr = DecodeTrackLyrics([]byte(`{"trackId":"t1","format":"plain","lyrics":""}`)); perr == nil {
		t.Fatalf("空歌词应拒绝")
	}
	if _, perr = DecodeTrackLyrics([]byte(`{"trackId":"t1","format":"plain","lyrics":"x","extra":1}`)); perr == nil {
		t.Fatalf("未知字段应拒绝")
	}
	// 体积超限 → LYRICS_TOO_LARGE
	big := strings.Repeat("a", MaxLyricsBytes+1)
	payload := fmt.Sprintf(`{"trackId":"t1","format":"plain","lyrics":%q}`, big)
	if _, perr = DecodeTrackLyrics([]byte(payload)); perr == nil || perr.Code != CodeLyricsTooLarge {
		t.Fatalf("超 48KB 歌词应回 LYRICS_TOO_LARGE, got %v", perr)
	}
	// 行数超限 → LYRICS_TOO_LARGE（末尾换行产生空行也算行）
	many, _ := json.Marshal(map[string]string{"trackId": "t1", "format": "plain", "lyrics": strings.Repeat("x\n", MaxLyricsLines)})
	if _, perr = DecodeTrackLyrics(many); perr == nil || perr.Code != CodeLyricsTooLarge {
		t.Fatalf("超 500 行歌词应回 LYRICS_TOO_LARGE, got %v", perr)
	}
	// 单行超限 → LYRICS_TOO_LARGE
	longLine, _ := json.Marshal(map[string]string{"trackId": "t1", "format": "plain", "lyrics": strings.Repeat("x", MaxLyricsLineBytes+1)})
	if _, perr = DecodeTrackLyrics(longLine); perr == nil || perr.Code != CodeLyricsTooLarge {
		t.Fatalf("单行超限应回 LYRICS_TOO_LARGE, got %v", perr)
	}
	// 边界内通过
	atLimit, _ := json.Marshal(map[string]string{"trackId": "t1", "format": "plain", "lyrics": strings.Repeat("x", MaxLyricsLineBytes)})
	if _, perr = DecodeTrackLyrics(atLimit); perr != nil {
		t.Fatalf("边界内单行应接受: %v", perr)
	}
}
