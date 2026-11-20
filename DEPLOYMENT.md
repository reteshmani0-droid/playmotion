# Deployment

## Local LAN (recommended)

```bash
npm install
npm start
```

- HTTP on `0.0.0.0:8080`, HTTPS on `0.0.0.0:8443`.
- Open `http://<lan-ip>:8080/tv` on the TV.
- The TV hands out `https://<lan-ip>:8443/m` to the phone automatically.

The self-signed certificate is generated in `.certs/` on first run and
regenerated when the LAN IP changes. Phones must accept it once (iOS: Advanced →
Proceed; Android: Advanced → Continue).

## Zero-config HTTPS via Cloudflare quick tunnel

```bash
npm run tunnel
```

Requires the `cloudflared` binary on PATH. Prints a public `https://…trycloudflare.com`
URL; the TV's QR code uses it. Good for testing on a friend's phone without
installing a certificate.

## Free PaaS (Render / Fly / Railway)

1. Push the repo.
2. Start command: `npm start`.
3. Set env `PUBLIC_URL=https://your-app.onrender.com` (or rely on
   `X-Forwarded-*` headers, which the server honours).
4. The platform terminates TLS, so set `NO_HTTPS=1` to skip the self-signed
   listener.

The server binds `0.0.0.0` and reads `PORT` from the environment, so it works
on any PaaS without changes.

## Docker (optional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
ENV NO_HTTPS=1
CMD ["npm", "start"]
```

## Platform notes

- **Apple TV**: no general browser. Mirror a Mac/iPhone browser via AirPlay, or
  plug a PC into the TV. The game itself runs fine in Safari/Chrome.
- **Roku**: no general browser; not supported. Use a Fire Stick / Chromecast /
  PC instead.
- **Smart TVs (Samsung/LG)**: use the built-in browser; performance varies.
  Prefer a wired/5 GHz connection.
- **Fire TV / Google TV**: Silk/Chrome work; the TV does not need a camera.
- **Sony TV**: works via the built-in Chrome browser (Android/Google TV models) or
  Chromecast — open the PlayMotion TV URL and you're done; no AirPlay needed.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | HTTP port |
| `HTTPS_PORT` | 8443 | HTTPS port |
| `NO_HTTPS` | unset | Set to `1` to disable the HTTPS listener |
| `PUBLIC_URL` | unset | Override the phone URL handed out by `/api/net` |
| `HTTPS_PORT` | 8443 | (see above) |

## Security

- The relay pairs one TV room at a time; rooms expire after 30 min idle.
- No accounts, no analytics, no cloud processing.
- Quick tunnels are public while running — do not leave them unattended.
