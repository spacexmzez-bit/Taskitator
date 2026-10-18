// Re-run after changing any inline application script in an HTML page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hosts = 'https://*.clerk.accounts.dev https://*.clerk.accounts.com https://*.clerk.com https://*.mazendev.com https://challenges.cloudflare.com';
for (const file of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
    if (['welcome.html','privacy.html','terms.html','PHASE-1-SETUP.html','PHASE-2-SETUP.html'].includes(file)) continue;
    const filename = path.join(root, file);
    let html = fs.readFileSync(filename, 'utf8').replace(/\n?<meta http-equiv="Content-Security-Policy" content="[^"]*">/g, '');
    const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter(match => !/\bsrc=/.test(match[1]) && match[2].trim())
        .map(match => "'sha256-" + createHash('sha256').update(match[2], 'utf8').digest('base64') + "'");
    const policy = [
        "default-src 'self'",
        "script-src 'self' " + [...new Set(hashes)].join(' ') + ' ' + hosts,
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https://fonts.gstatic.com " + hosts,
        "connect-src 'self' https://taskitator-sync.spacexmzez.workers.dev https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk-telemetry.com " + hosts,
        "frame-src " + hosts,
        "worker-src 'self' blob:",
        "object-src 'none'", "base-uri 'none'", "form-action 'self' " + hosts,
        'upgrade-insecure-requests'
    ].join('; ');
    html = html.replace('<head>', '<head>\n<meta http-equiv="Content-Security-Policy" content="' + policy + '">');
    fs.writeFileSync(filename, html);
}
