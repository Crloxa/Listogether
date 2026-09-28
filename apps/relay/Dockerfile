# Relay 生产镜像：多阶段构建（Go 编译 → 最小运行时）。
# 构建上下文 = apps/relay（compose 中指定）。
# 参数：
#   GOPROXY  — Go 模块代理，默认走 goproxy.cn（中国大陆网络可用）；海外可覆盖为默认。
FROM golang:1.27-alpine AS build
ARG GOPROXY=https://goproxy.cn,direct
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

FROM alpine:3.20
# ca 证书：直连 TLS 模式与 OAuth 回调出站请求需要
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 listo
COPY --from=build /out/relay /usr/local/bin/relay
USER listo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/relay"]
