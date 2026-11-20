FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN mkdir -p /app/server/dist && npm run build

FROM golang:1.26-alpine AS server
WORKDIR /app/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /app/server/dist ./dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /study-relay .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /study-relay /study-relay
ENV RELAY_DB=/data/study-relay.db
ENV RELAY_ADDR=:8000
EXPOSE 8000
VOLUME ["/data"]
ENTRYPOINT ["/study-relay"]
