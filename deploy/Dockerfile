# Ivyea Note 同步服务镜像：三阶段构建
# ① 前端：desktop 源码 → vite build --mode web（base=/app/）
FROM node:22-alpine AS webui
WORKDIR /web/desktop
COPY desktop/package.json desktop/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY desktop/ ./
RUN npm run build -- --mode web

# ② 服务端：把前端产物放进 internal/api/webui/ 后 go:embed 编译
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
COPY --from=webui /web/desktop/dist ./internal/api/webui
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/ivnote-server ./cmd/ivnote-server

# ③ 运行时：最小镜像 + 非 root 用户
FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 ivnote
USER ivnote
COPY --from=build /out/ivnote-server /usr/local/bin/ivnote-server
EXPOSE 8080
ENTRYPOINT ["ivnote-server"]
