// Unit-test storage fixtures; integration tests exercise the real Worker snapshot implementation.
import '../recurrence-core.js';
import { TaskProtection } from './task-protection.js';
import { liveAccount } from './account-lifecycle.js';
export function seedUnitAccounts(storage,ids=['user_A','user_B']){
    for(const id of ids){storage.data.set('identity:'+id,{user:id});storage.data.set('account:'+encodeURIComponent(id),{owner_id:id,version:0});}
}
export function unitParent(storage,env){
    const parent={storage,env,ensureAlarm:async()=>{},
        readTaskSnapshot:async(tx,account)=>{await liveAccount(tx,account);return {snapshot:await tx.get('test:snapshot:'+account)};},
        writeTaskSnapshot:async(tx,account,snapshot)=>{await liveAccount(tx,account);await tx.put('test:snapshot:'+account,snapshot);return 1;}};
    parent.protection=new TaskProtection(parent);return parent;
}
