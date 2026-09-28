# Web 生产镜像：Node 构建前端静态文件 → nginx 托管并反代 Relay（同源，免 CORS）。
# 构建上下文 = 仓库根目录（monorepo：web 构建依赖 packages/* 工作区）。
# 参数：
#   GOPROXY_NPM 无需设置；VITE_RELAY_HTTP_URL 留空 = 走同源相对路径（经 nginx 反代到 relay）。
FROM node:22-alpine AS build
# Vite 在构建期内联 VITE_* 环境变量；留空 = 前端用同源相对路径（经 nginx 反代）
ARG VITE_RELAY_HTTP_URL=""
ENV VITE_RELAY_HTTP_URL=$VITE_RELAY_HTTP_URL
WORKDIR /repo
# 先拷贝依赖清单再装依赖，充分利用层缓存
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/media/package.json packages/media/
RUN npm ci
# 再拷贝源码并构建
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build -w @listogether/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1
