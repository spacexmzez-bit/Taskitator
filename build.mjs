// ============================================================================
// Taskitator Consolidated Build & CSP Utility (build.mjs)
// Usage: node build.mjs [--csp] [--dev]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
// Audit M2: only the Clerk host on mazendev.com is trusted, not every subdomain. Clerk development instances
// (*.clerk.accounts.dev) are allowed only in a build made with --dev; never publish such a build.
const dev = process.argv.includes('--dev');
const hosts = (dev ? 'https://*.clerk.accounts.dev ' : '') + 'https://*.clerk.accounts.com https://*.clerk.com https://clerk.mazendev.com https://challenges.cloudflare.com';

export function rebuildCsp() {
    for (const file of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
        if (['welcome.html','privacy.html','terms.html','PHASE-1-SETUP.html','PHASE-2-SETUP.html','PHASE-3-SETUP.html'].includes(file)) continue;
        const filename = path.join(root, file);
        let html = fs.readFileSync(filename, 'utf8').replace(/\n?\s*<meta http-equiv="Content-Security-Policy" content="[^"]*">/g, '');
        const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
            .filter(match => !/\bsrc=/.test(match[1]) && match[2].trim())
            .map(match => "'sha256-" + createHash('sha256').update(match[2], 'utf8').digest('base64') + "'");
        const policy = [
            "default-src 'self'",
            "script-src 'self' " + [...new Set(hashes)].join(' ') + ' ' + hosts,
            "script-src-attr 'none'",
            // Audit L10: images only from the site itself and Clerk's avatar host; no external font hosts (none are used).
            // style-src keeps 'unsafe-inline': the pages rely on inline styles.
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://img.clerk.com",
            "font-src 'self' data: " + hosts,
            "connect-src 'self' https://taskitator-sync.spacexmzez.workers.dev https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk-telemetry.com " + hosts,
            "frame-src " + hosts,
            "worker-src 'self' blob:",
            "object-src 'none'", "base-uri 'none'", "form-action 'self' " + hosts,
            'upgrade-insecure-requests'
        ].join('; ');
        html = html.replace('<head>', '<head>\n<meta http-equiv="Content-Security-Policy" content="' + policy + '">');
        fs.writeFileSync(filename, html);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    rebuildCsp();
    console.log('Rebuilt CSP hashes across HTML pages.');
}
