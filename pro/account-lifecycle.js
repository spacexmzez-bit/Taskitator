import { SecurityError, sha256 } from '../cloudflare/auth.js';
export async function liveAccount(store, accountId) {
    if (await store.get('deleted-identity:'+await sha256(accountId))) throw new SecurityError(410,'Account deletion has been accepted.');
    const link=await store.get('identity:'+accountId);
    const meta=link ? await store.get('account:'+encodeURIComponent(link.user)) : null;
    if (!meta || meta.deleting || meta.owner_id!==accountId) throw new SecurityError(403,'Connect your current Taskitator account before continuing.');
    return {link,meta};
}
