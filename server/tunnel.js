/**
 * Zero-config HTTPS tunnel.
 *
 * Phones refuse camera access on plain http:// LAN pages. The built-in server
 * already offers HTTPS with a self-signed certificate, but iOS makes you trust
 * a profile before Safari will accept it — annoying on a friend's phone.
 *
 * This script starts a free Cloudflare quick tunnel (no account, no credit
 * card) and then boots the game server with PUBLIC_URL pointing at the tunnel,
 * so the QR code on the TV hands out a real https:// address.
 *
 *   npm run tunnel
 *
 * Requires the `cloudflared` binary on PATH:
 *   Windows:  winget install --id Cloudflare.cloudflared
 *   macOS:    brew install cloudflared
 *   Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
 *
 * Note: a quick tunnel is public while it runs. Anyone with the random URL can
 * open the game and phone pages. The relay only pairs one TV room at a time,
 * but do not leave it running unattended.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const BIN = process.env.CLOUDFLARED || 'cloudflared';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function findCloudflared() {
  const probe = spawnSync(BIN, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (probe.status === 0) {
    return String(probe.stdout || probe.stderr || '').trim().split('\n')[0];
  }
  return null;
}

function fail(message) {
  console.error('');
  console.error(`  ${message}`);
  console.error('');
  console.error('  Install cloudflared, then run `npm run tunnel` again:');
  console.error('    Windows   winget install --id Cloudflare.cloudflared');
  console.error('    macOS     brew install cloudflared');
  console.error('    Linux     https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  console.error('');
  console.error('  Or just use the built-in HTTPS server (accept the certificate once):');
  console.error(`    https://<your-lan-ip>:${process.env.HTTPS_PORT || 8443}/m`);
  console.error('');
  process.exit(1);
}

const version = findCloudflared();
if (!version) fail('cloudflared was not found on PATH.');

console.log('');
console.log('  FRUIT NINJA TV · quick tunnel');
console.log(`  ${version}`);
console.log('');

let server = null;
let tunnel = null;
let publicUrl = null;
let shuttingDown = false;

function startGameServer(url) {
  if (server) return;
  console.log(`  Public URL: ${url}`);
  console.log('  Starting the game server with that public URL…');
  console.log('');
  server = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_URL: url,
      // The tunnel terminates TLS, so the local HTTPS listener is unnecessary
      // (and would just open an extra port on the LAN).
      NO_HTTPS: '1',
    },
  });
  server.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`  Game server exited with code ${code}`);
      shutdown(code || 0);
    }
  });
}

function scan(chunk) {
  const text = chunk.toString();
  // Keep the tunnel logs quiet unless they look interesting.
  if (process.env.TUNNEL_VERBOSE === '1') process.stdout.write(text);
  if (!publicUrl) {
    const match = URL_RE.exec(text);
    if (match) {
      publicUrl = match[0];
      startGameServer(publicUrl);
    }
  }
}

tunnel = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

tunnel.stdout.on('data', scan);
tunnel.stderr.on('data', scan);

tunnel.on('error', (err) => {
  console.error('  Could not start cloudflared:', err.message);
  shutdown(1);
});

tunnel.on('exit', (code) => {
  if (shuttingDown) return;
  if (!publicUrl) {
    console.error('  cloudflared exited before reporting a URL.');
    console.error('  Set TUNNEL_VERBOSE=1 to see its logs.');
    shutdown(code || 1);
  } else {
    console.log('  Tunnel closed.');
    shutdown(0);
  }
});

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    server?.kill();
  } catch {}
  try {
    tunnel?.kill();
  } catch {}
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Safety net: if cloudflared prints nothing (blocked network), tell the user.
setTimeout(() => {
  if (!publicUrl) {
    console.error('');
    console.error('  Still waiting for a tunnel URL…');
    console.error('  Check that outbound HTTPS is allowed, or set TUNNEL_VERBOSE=1.');
    console.error('  The built-in HTTPS server on port 8443 still works meanwhile.');
  }
}, 25_000).unref();
