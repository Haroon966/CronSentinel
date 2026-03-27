FROM golang:1.22-alpine AS builder
WORKDIR /app
# Copy manifest first; go mod download creates go.sum inside the container.
# For better layer caching: run `go mod tidy`, commit go.sum, then change the
# line below to `COPY go.mod go.sum ./`.
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/server ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates bash
WORKDIR /app
COPY --from=builder /out/server /app/server
RUN mkdir -p /data/scripts
ENV PORT=8080
ENV SCRIPT_DIR=/data/scripts
EXPOSE 8080
CMD ["/app/server"]
