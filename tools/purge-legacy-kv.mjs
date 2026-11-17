#!/usr/bin/env node
// Audit L4: delete what is left of the pre-Clerk accounts in the TASKITATOR_KV namespace.
// Those records hold plaintext API keys and a credential that is a single unsalted hash of the password.
// Accounts that migrated were copied to the Durable Object; what remains in KV belongs to accounts that never did.
//
// THIS CANNOT BE UNDONE. After it runs, an account that did not migrate cannot be recovered by anyone.
//
// Usage (from the repository root, with wrangler logged in or CLOUDFLARE_API_TOKEN set):
//   node tools/purge-legacy-kv.mjs --until 2026-12-31                 # dry run: only counts and lists
//   node tools/purge-legacy-kv.mjs --until 2026-12-31 --delete        # deletes
//
// --until must be the same date as the Worker's LEGACY_MIGRATION_UNTIL. The script refuses to run before that date,
// so migration cannot be cut short by accident.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREFIXES = ['user_reg:', 'user_data:'];
// Returns an error message, or null when the purge may run.
export function purgeBlocked(until, now = Date.now()) {
    const deadline = Date.parse(until || '');
    if (!Number.isFinite(deadline)) return 'Pass --until <date>: the same value as the Worker variable LEGACY_MIGRATION_UNTIL.';
    if (now < deadline) return 'Legacy migration is still open until ' + new Date(deadline).toISOString() + '. Nothing was deleted.';
    return null;
}
export const namespaceId = toml => /\[\[kv_namespaces\]\][^\[]*?binding\s*=\s*"TASKITATOR_KV"[^\[]*?id\s*=\s*"([a-f0-9]{32})"/.exec(toml)?.[1] || null;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const args = process.argv.slice(2), until = args[args.indexOf('--until') + 1], remove = args.includes('--delete');
    const blocked = purgeBlocked(args.includes('--until') ? until : '');
    if (blocked) { console.error(blocked); process.exit(1); }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const id = namespaceId(fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8'));
    if (!id) { console.error('TASKITATOR_KV namespace id was not found in wrangler.toml.'); process.exit(1); }
    const wrangler = (...a) => execFileSync('npx', ['--no-install', 'wrangler', ...a], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    let keys = [];
    for (const prefix of PREFIXES) {
        const found = JSON.parse(wrangler('kv', 'key', 'list', '--namespace-id', id, '--prefix', prefix, '--remote')).map(k => k.name);
        console.log(prefix + ' ' + found.length + ' record(s)');
        keys = keys.concat(found);
    }
    // Only the two legacy prefixes are ever deleted, whatever the listing returned.
    keys = keys.filter(k => PREFIXES.some(p => k.startsWith(p)));
    if (!keys.length) { console.log('Nothing to delete.'); process.exit(0); }
    if (!remove) {
        console.log('Dry run. ' + keys.length + ' record(s) would be deleted. usernames: ' +
            keys.filter(k => k.startsWith('user_reg:')).map(k => k.slice(9)).join(', '));
        console.log('Run again with --delete to delete them. This cannot be undone.');
        process.exit(0);
    }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taskitator-purge-')), 'keys.json');
    fs.writeFileSync(file, JSON.stringify(keys));
    wrangler('kv', 'bulk', 'delete', file, '--namespace-id', id, '--remote', '--force');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    console.log('Deleted ' + keys.length + ' legacy record(s). Also clear LEGACY_MIGRATION_OWNERS in the Worker settings.');
}
