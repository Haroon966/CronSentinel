FROM golang:1.22-alpine AS builder
WORKDIR /app
# Without a committed go.sum, `go build` fails. Tidy generates go.sum before build.
# Optional: commit go.sum and split COPY go.mod go.sum + go mod download for better caching.
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /out/server ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates bash
WORKDIR /app
COPY --from=builder /out/server /app/server
RUN mkdir -p /data/scripts
ENV PORT=8080
ENV SCRIPT_DIR=/data/scripts
EXPOSE 8080
CMD ["/app/server"]
