// Package hub 管理房间与会话：建房/入房校验、token 哈希比对、过期清理。
// 会话只携带身份；锁房/满员/权限的最终判定分别在房间 attach 与 actor 内进行。
package hub

import (
	"log/slog"
	"sync"
	"time"

	"listogether/apps/relay/internal/auth"
	"listogether/apps/relay/internal/protocol"
	"listogether/apps/relay/internal/room"
)

// DefaultSessionTTL 是会话空闲过期时间；DefaultUnusedRoomTTL 是从未有连接挂载的房间存活时间。
const (
	DefaultSessionTTL     = 10 * time.Minute
	DefaultUnusedRoomTTL  = 10 * time.Minute
	DefaultSweepInterval  = 30 * time.Second
	DefaultMaxMembersRoom = 16
)

// Error 是 hub 层业务失败；Code 与 protocol 错误码一致，由 httpapi 映射 HTTP 状态。
type Error = room.AccessError

// Session 是已发放的会话身份（不含 token 原文）。
type Session struct {
	RoomID   string
	MemberID string
	Name     string
	Role     string
}

type storedSession struct {
	session   Session
	tokenHash string
	lastUsed  time.Time
}

// CreateOptions 是建房参数。
type CreateOptions struct {
	HostName   string
	RoomName   string
	Password   string
	MaxMembers int
}

// CreateResult 是建房响应；InviteToken/SessionToken 只在此时返回原文。
type CreateResult struct {
	RoomID       string `json:"roomId"`
	RoomName     string `json:"roomName"`
	InviteToken  string `json:"inviteToken"`
	SessionToken string `json:"sessionToken"`
	MemberID     string `json:"memberId"`
	Role         string `json:"role"`
	MaxMembers   int    `json:"maxMembers"`
	PasswordSet  bool   `json:"passwordSet"`
	ServerTimeMs int64  `json:"serverTimeMs"`
}

// JoinOptions 是入房参数。
type JoinOptions struct {
	InviteToken string
	Name        string
	Password    string
}

// JoinResult 是入房响应。
type JoinResult struct {
	RoomID       string `json:"roomId"`
	SessionToken string `json:"sessionToken"`
	MemberID     string `json:"memberId"`
	Role         string `json:"role"`
	ServerTimeMs int64  `json:"serverTimeMs"`
}

// RoomInfo 是房间公开信息（含是否需要密码）。
type RoomInfo struct {
	RoomID        string `json:"roomId"`
	Exists        bool   `json:"exists"`
	Locked        bool   `json:"locked"`
	MemberCount   int    `json:"memberCount"`
	MaxMembers    int    `json:"maxMembers"`
	NeedsPassword bool   `json:"needsPassword"`
}

// Hub 管理全部房间与会话。
type Hub struct {
	mu       sync.Mutex
	rooms    map[string]*room.Room
	sessions map[string]*storedSession

	logger        *slog.Logger
	nowFunc       func() time.Time
	sessionTTL    time.Duration
	unusedRoomTTL time.Duration
	sweepStop     chan struct{}
	sweepOnce     sync.Once
}

// New 创建 hub 并启动周期清理。
func New(logger *slog.Logger) *Hub {
	return NewWithTuning(logger, DefaultSessionTTL, DefaultUnusedRoomTTL, DefaultSweepInterval)
}

// NewWithTuning 允许测试注入更短的 TTL。
func NewWithTuning(logger *slog.Logger, sessionTTL, unusedRoomTTL, sweepInterval time.Duration) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	h := &Hub{
		rooms:         make(map[string]*room.Room),
		sessions:      make(map[string]*storedSession),
		logger:        logger,
		nowFunc:       time.Now,
		sessionTTL:    sessionTTL,
		unusedRoomTTL: unusedRoomTTL,
		sweepStop:     make(chan struct{}),
	}
	go h.sweepLoop(sweepInterval)
	return h
}

// Close 停止周期清理。
func (h *Hub) Close() {
	h.sweepOnce.Do(func() { close(h.sweepStop) })
}

func (h *Hub) sweepLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			h.Sweep(h.nowFunc())
		case <-h.sweepStop:
			return
		}
	}
}

// Sweep 清理过期会话与从未挂载连接的房间。
func (h *Hub) Sweep(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, s := range h.sessions {
		if now.Sub(s.lastUsed) > h.sessionTTL {
			delete(h.sessions, key)
			h.logger.Info("session expired", "roomId", s.session.RoomID, "memberId", s.session.MemberID)
		}
	}
	for id, r := range h.rooms {
		if !r.AttachedEver() && now.Sub(r.CreatedAt()) > h.unusedRoomTTL {
			delete(h.rooms, id)
			h.removeSessionsLocked(id)
			h.logger.Info("unused room removed", "roomId", id)
		}
	}
}

// ---- 建房 / 入房 ----

// CreateRoom 创建房间并签发房主会话。
func (h *Hub) CreateRoom(opts CreateOptions) (CreateResult, *Error) {
	hostName, err := validName(opts.HostName)
	if err != nil {
		return CreateResult{}, err
	}
	maxMembers := opts.MaxMembers
	if maxMembers <= 0 {
		maxMembers = DefaultMaxMembersRoom
	}
	if maxMembers > roomMaxMembersCap {
		maxMembers = roomMaxMembersCap
	}
	var passwordHash string
	if opts.Password != "" {
		if len(opts.Password) > maxPasswordLen {
			return CreateResult{}, &Error{Code: protocol.CodeInvalidMessage, Message: "密码过长"}
		}
		hash, hashErr := auth.HashPassword(opts.Password)
		if hashErr != nil {
			h.logger.Error("password hash failed", "err", hashErr.Error())
			return CreateResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
		}
		passwordHash = hash
	}
	inviteToken, tokenErr := auth.NewToken()
	if tokenErr != nil {
		return CreateResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	sessionToken, tokenErr := auth.NewToken()
	if tokenErr != nil {
		return CreateResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	memberID, tokenErr := auth.NewToken()
	if tokenErr != nil {
		return CreateResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}

	roomName := opts.RoomName
	if roomName == "" {
		roomName = "朋友的音乐房间"
	}

	h.mu.Lock()
	roomID, ok := h.newRoomIDLocked()
	if !ok {
		h.mu.Unlock()
		return CreateResult{}, &Error{Code: protocol.CodeInternal, Message: "无法分配房间 ID"}
	}
	r := room.New(room.Config{
		ID:              roomID,
		InviteTokenHash: auth.HashToken(inviteToken),
		PasswordHash:    passwordHash,
		MaxMembers:      maxMembers,
	}, h, h.logger)
	h.rooms[roomID] = r
	h.mu.Unlock()

	result := CreateResult{
		RoomID:       roomID,
		RoomName:     roomName,
		InviteToken:  inviteToken,
		SessionToken: sessionToken,
		MemberID:     memberID,
		Role:         room.RoleHost,
		MaxMembers:   maxMembers,
		PasswordSet:  passwordHash != "",
		ServerTimeMs: h.nowFunc().UnixMilli(),
	}
	if !h.storeSession(result.RoomID, result.MemberID, hostName, result.Role, sessionToken) {
		return CreateResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	h.logger.Info("room created", "roomId", roomID, "maxMembers", maxMembers, "passwordSet", passwordHash != "")
	return result, nil
}

// Join 校验邀请 token、密码、锁房与满员后签发成员会话。
func (h *Hub) Join(roomID string, opts JoinOptions) (JoinResult, *Error) {
	h.mu.Lock()
	r, ok := h.rooms[roomID]
	h.mu.Unlock()
	if !ok {
		return JoinResult{}, &Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"}
	}
	if !auth.EqualTokens(auth.HashToken(opts.InviteToken), r.InviteTokenHash()) {
		return JoinResult{}, &Error{Code: protocol.CodeInvalidToken, Message: "邀请链接无效"}
	}
	if locked := r.IsLocked(); locked {
		return JoinResult{}, &Error{Code: protocol.CodeRoomLocked, Message: "房间已锁定，暂不接受新成员"}
	}
	if r.HasPassword() && !auth.VerifyPassword(opts.Password, r.PasswordHash()) {
		return JoinResult{}, &Error{Code: protocol.CodeUnauthorized, Message: "房间密码错误"}
	}
	name, nerr := validName(opts.Name)
	if nerr != nil {
		return JoinResult{}, nerr
	}
	if r.MemberCount() >= r.MaxMembers() {
		return JoinResult{}, &Error{Code: protocol.CodeRoomFull, Message: "房间已满"}
	}
	sessionToken, tokenErr := auth.NewToken()
	if tokenErr != nil {
		return JoinResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	memberID, tokenErr := auth.NewToken()
	if tokenErr != nil {
		return JoinResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	result := JoinResult{RoomID: roomID, SessionToken: sessionToken, MemberID: memberID, Role: room.RoleListener, ServerTimeMs: h.nowFunc().UnixMilli()}
	if !h.storeSession(roomID, memberID, name, result.Role, sessionToken) {
		return JoinResult{}, &Error{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	h.logger.Info("member session issued", "roomId", roomID, "role", result.Role)
	return result, nil
}

// RoomInfo 返回房间公开信息。
func (h *Hub) RoomInfo(roomID string) (RoomInfo, *Error) {
	h.mu.Lock()
	r, ok := h.rooms[roomID]
	h.mu.Unlock()
	if !ok {
		return RoomInfo{}, &Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"}
	}
	return RoomInfo{
		RoomID:        roomID,
		Exists:        true,
		Locked:        r.IsLocked(),
		MemberCount:   r.MemberCount(),
		MaxMembers:    r.MaxMembers(),
		NeedsPassword: r.HasPassword(),
	}, nil
}

// ---- 会话 ----

func (h *Hub) storeSession(roomID, memberID, name, role, sessionToken string) bool {
	key := auth.HashToken(sessionToken)
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, exists := h.sessions[key]; exists {
		return false // token 碰撞：重新生成由调用方处理（概率可忽略）
	}
	h.sessions[key] = &storedSession{
		session:   Session{RoomID: roomID, MemberID: memberID, Name: name, Role: role},
		tokenHash: key,
		lastUsed:  h.nowFunc(),
	}
	return true
}

// LookupSession 以 token 查找会话并刷新最近使用时间。
func (h *Hub) LookupSession(sessionToken string) (Session, bool) {
	key := auth.HashToken(sessionToken)
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[key]
	if !ok {
		return Session{}, false
	}
	s.lastUsed = h.nowFunc()
	return s.session, true
}

// LookupSessionForRoom 校验 token 且属于指定房间。
func (h *Hub) LookupSessionForRoom(roomID, sessionToken string) (Session, bool) {
	s, ok := h.LookupSession(sessionToken)
	if !ok || s.RoomID != roomID {
		return Session{}, false
	}
	return s, true
}

// SessionExistsByHash 返回会话哈希是否仍有效（OAuth token 生命周期联动，D-015）。
func (h *Hub) SessionExistsByHash(tokenHash string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.sessions[tokenHash]
	return ok
}

// ---- 房间管理转发 ----

// Attach 把连接挂载到房间（权威判定在房间 actor 内）。
func (h *Hub) Attach(roomID string, conn room.Conn, session Session) room.AttachResult {
	h.mu.Lock()
	r, ok := h.rooms[roomID]
	h.mu.Unlock()
	if !ok {
		return room.AttachResult{Err: &Error{Code: protocol.CodeRoomNotFound, Message: "房间不存在或已关闭"}}
	}
	return r.Attach(conn, room.Identity{MemberID: session.MemberID, Name: session.Name, Role: session.Role})
}

// Room 以 ID 取房间指针（供 ws/httpapi 投递任务）。
func (h *Hub) Room(roomID string) (*room.Room, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[roomID]
	return r, ok
}

// HubHooks 实现 room.HubHooks。

func (h *Hub) RoomRemoved(roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rooms, roomID)
	h.removeSessionsLocked(roomID)
}

func (h *Hub) SessionInvalidated(roomID, memberID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, s := range h.sessions {
		if s.session.RoomID == roomID && s.session.MemberID == memberID {
			delete(h.sessions, key)
		}
	}
}

func (h *Hub) removeSessionsLocked(roomID string) {
	for key, s := range h.sessions {
		if s.session.RoomID == roomID {
			delete(h.sessions, key)
		}
	}
}

// newRoomIDLocked 生成不冲突的房间 ID；调用方必须持有 h.mu。
func (h *Hub) newRoomIDLocked() (string, bool) {
	for i := 0; i < 5; i++ {
		id, err := auth.NewToken()
		if err != nil {
			return "", false
		}
		if _, exists := h.rooms[id]; !exists {
			return id, true
		}
	}
	return "", false
}

// 与 schema/room 包一致的边界。
const (
	roomMaxMembersCap = 256
	maxPasswordLen    = 128
	maxNameLen        = 64
)

func validName(name string) (string, *Error) {
	if len(name) == 0 || len(name) > maxNameLen {
		return "", &Error{Code: protocol.CodeInvalidMessage, Message: "昵称长度必须在 1..64"}
	}
	return name, nil
}
