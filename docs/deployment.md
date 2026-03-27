# Deployment

## Local Docker Compose

Run:

- `docker compose up --build`

Services:

- `db` - PostgreSQL 16
- `backend` - Go API on port `8080`
- `frontend` - Vite dev server on port `5173`

## Environment Variables

Backend:

- `PORT` (default `8080`)
- `DATABASE_URL` (default points to compose db service)
- `SCRIPT_DIR` (default `/data/scripts`)

Frontend:

- `VITE_API_BASE_URL` (default `http://localhost:8080`)

## Production Notes

- Place frontend behind a reverse proxy and serve static build for production.
- Persist Postgres volume and script volume.
- Add host-level firewall and reverse-proxy auth if needed.
- If GPU metrics are required, run container with host access and proper drivers.
