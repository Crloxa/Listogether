// roomapi.go 实现房间控制 REST API：建房、加入、公开信息、锁房、踢人、授权、关房。
// 鉴权只识别会话身份；锁房/踢人等权限的最终判定在房间 actor 内。
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"listogether/apps/relay/internal/hub"
	"listogether/apps/relay/internal/protocol"
)

const maxBodyBytes = 8 * 1024

// NewRoomAPI 返回挂载在 /api 前缀下的房间 API 处理器。
func NewRoomAPI(logger *slog.Logger, h *hub.Hub, allowedOrigins []string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST /api/rooms", handleCreateRoom(logger, h))
	mux.Handle("POST /api/rooms/{roomId}/sessions", handleJoinRoom(logger, h))
	mux.Handle("GET /api/rooms/{roomId}", handleRoomInfo(logger, h))
	mux.Handle("POST /api/rooms/{roomId}/lock", requireSession(logger, h, handleLockRoom(h)))
	mux.Handle("POST /api/rooms/{roomId}/close", requireSession(logger, h, handleCloseRoom(h)))
	mux.Handle("POST /api/rooms/{roomId}/members/{memberId}/kick", requireSession(logger, h, handleKick(h)))
	mux.Handle("POST /api/rooms/{roomId}/members/{memberId}/role", requireSession(logger, h, handleSetRole(h)))
	return WithRoomCORS(allowedOrigins, mux)
}

// WithRoomCORS 在 WithCORS 基础上放行 POST 与 Authorization 头。
func WithRoomCORS(allowedOrigins []string, next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[o] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if _, ok := allowed[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---- 建房 / 加入 / 信息 ----

type createRoomBody struct {
	HostName   string `json:"hostName"`
	RoomName   string `json:"roomName"`
	Password   string `json:"password"`
	MaxMembers int    `json:"maxMembers"`
}

func handleCreateRoom(logger *slog.Logger, h *hub.Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body createRoomBody
		if !readJSON(w, r, &body) {
			return
		}
		result, herr := h.CreateRoom(hub.CreateOptions{
			HostName:   body.HostName,
			RoomName:   body.RoomName,
			Password:   body.Password,
			MaxMembers: body.MaxMembers,
		})
		if herr != nil {
			writeError(w, herr)
			return
		}
		logger.Info("room created via api", "roomId", result.RoomID)
		writeJSON(w, http.StatusCreated, result)
	})
}

type joinRoomBody struct {
	InviteToken string `json:"inviteToken"`
	Name        string `json:"name"`
	Password    string `json:"password"`
}

func handleJoinRoom(logger *slog.Logger, h *hub.Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomId")
		var body joinRoomBody
		if !readJSON(w, r, &body) {
			return
		}
		result, herr := h.Join(roomID, hub.JoinOptions{InviteToken: body.InviteToken, Name: body.Name, Password: body.Password})
		if herr != nil {
			writeError(w, herr)
			return
		}
		logger.Info("member session issued via api", "roomId", roomID)
		writeJSON(w, http.StatusCreated, result)
	})
}

func handleRoomInfo(logger *slog.Logger, h *hub.Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomId")
		info, herr := h.RoomInfo(roomID)
		if herr != nil {
			writeError(w, herr)
			return
		}
		writeJSON(w, http.StatusOK, info)
	})
}

// ---- 房主管理操作 ----

func requireSession(logger *slog.Logger, h *hub.Hub, next func(w http.ResponseWriter, r *http.Request, session hub.Session, roomID string)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionToken := bearerToken(r)
		if sessionToken == "" {
			writeJSON(w, http.StatusUnauthorized, errorBody{Code: protocol.CodeInvalidToken, Message: "缺少会话凭证"})
			return
		}
		session, ok := h.LookupSession(sessionToken)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorBody{Code: protocol.CodeInvalidToken, Message: "会话已失效，请重新加入"})
			return
		}
		next(w, r, session, r.PathValue("roomId"))
	})
}

func handleLockRoom(h *hub.Hub) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, session hub.Session, roomID string) {
		if session.RoomID != roomID {
			writeJSON(w, http.StatusForbidden, errorBody{Code: protocol.CodeUnauthorized, Message: "会话不属于该房间"})
			return
		}
		roomRef, ok := h.Room(roomID)
		if !ok {
			writeError(w, &hub.Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"})
			return
		}
		var body struct {
			Locked *bool `json:"locked"`
		}
		if !readJSON(w, r, &body) || body.Locked == nil {
			writeJSON(w, http.StatusBadRequest, errorBody{Code: protocol.CodeInvalidMessage, Message: "缺少 locked 字段"})
			return
		}
		if err := roomRef.LockRoom(session.MemberID, *body.Locked); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"locked": *body.Locked})
	}
}

func handleCloseRoom(h *hub.Hub) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, session hub.Session, roomID string) {
		if session.RoomID != roomID {
			writeJSON(w, http.StatusForbidden, errorBody{Code: protocol.CodeUnauthorized, Message: "会话不属于该房间"})
			return
		}
		roomRef, ok := h.Room(roomID)
		if !ok {
			writeError(w, &hub.Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"})
			return
		}
		if err := roomRef.CloseRoomByHost(session.MemberID); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"closed": true})
	}
}

func handleKick(h *hub.Hub) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, session hub.Session, roomID string) {
		if session.RoomID != roomID {
			writeJSON(w, http.StatusForbidden, errorBody{Code: protocol.CodeUnauthorized, Message: "会话不属于该房间"})
			return
		}
		roomRef, ok := h.Room(roomID)
		if !ok {
			writeError(w, &hub.Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"})
			return
		}
		if err := roomRef.Kick(session.MemberID, r.PathValue("memberId")); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"kicked": true})
	}
}

type setRoleBody struct {
	Role string `json:"role"`
}

func handleSetRole(h *hub.Hub) sessionHandler {
	return func(w http.ResponseWriter, r *http.Request, session hub.Session, roomID string) {
		if session.RoomID != roomID {
			writeJSON(w, http.StatusForbidden, errorBody{Code: protocol.CodeUnauthorized, Message: "会话不属于该房间"})
			return
		}
		roomRef, ok := h.Room(roomID)
		if !ok {
			writeError(w, &hub.Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"})
			return
		}
		var body setRoleBody
		if !readJSON(w, r, &body) {
			return
		}
		if err := roomRef.SetRole(session.MemberID, r.PathValue("memberId"), body.Role); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"role": body.Role})
	}
}

// ---- 工具 ----

type sessionHandler func(w http.ResponseWriter, r *http.Request, session hub.Session, roomID string)

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Code: protocol.CodeInvalidMessage, Message: "请求体不是合法 JSON 或包含未知字段"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError 输出 hub.Error（= room.AccessError 别名）对应的 HTTP 错误体。
func writeError(w http.ResponseWriter, herr *hub.Error) {
	body := errorBody{Code: herr.Code, Message: herr.Message}
	writeJSON(w, statusFor(body.Code), body)
}

func statusFor(code string) int {
	switch code {
	case protocol.CodeInvalidMessage:
		return http.StatusBadRequest
	case protocol.CodeInvalidToken:
		return http.StatusUnauthorized
	case protocol.CodeUnauthorized, protocol.CodeRoomLocked:
		return http.StatusForbidden
	case protocol.CodeRoomNotFound:
		return http.StatusNotFound
	case protocol.CodeRoomFull:
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

func bearerToken(r *http.Request) string {
	authz := r.Header.Get("Authorization")
	if token, ok := strings.CutPrefix(authz, "Bearer "); ok {
		return strings.TrimSpace(token)
	}
	return ""
}
