/**
 * Self-signed TLS for LAN play.
 *
 * Browsers only expose getUserMedia on a secure context. On a home LAN that
 * means HTTPS with a self-signed certificate (accepted once per phone) or a
 * tunnel. We generate and cache a certificate that covers every LAN IP the
 * machine has, plus localhost, so it keeps working across reboots.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import selfsigned from 'selfsigned';

const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';
const META_FILE = 'meta.json';

export async function ensureCertificate(dir, lan = []) {
  await fsp.mkdir(dir, { recursive: true });
  const certPath = path.join(dir, CERT_FILE);
  const keyPath = path.join(dir, KEY_FILE);
  const metaPath = path.join(dir, META_FILE);

  const altNames = ['localhost', '127.0.0.1', ...lan.map((l) => l.address)].join(',');

  try {
    const [key, cert, metaRaw] = await Promise.all([
      fsp.readFile(keyPath, 'utf8'),
      fsp.readFile(certPath, 'utf8'),
      fsp.readFile(metaPath, 'utf8').catch(() => '{}'),
    ]);
    const meta = JSON.parse(metaRaw);
    // If we moved networks, the old cert no longer matches the LAN IP.
    if (meta.altNames === altNames) {
      return { key, cert };
    }
  } catch {
    // fall through and generate
  }

  const attrs = [{ name: 'commonName', value: 'fruit-ninja.tv' }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...lan.map((l) => ({ type: 7, ip: l.address })),
        ],
      },
    ],
  });

  await Promise.all([
    fsp.writeFile(certPath, pems.cert, 'utf8'),
    fsp.writeFile(keyPath, pems.private, 'utf8'),
    fsp.writeFile(metaPath, JSON.stringify({ altNames, createdAt: new Date().toISOString() }, null, 2)),
  ]);

  return { key: pems.private, cert: pems.cert };
}
