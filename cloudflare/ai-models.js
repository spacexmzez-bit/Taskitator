import {SecurityError} from './auth.js';

export const PROVIDERS = {
    gemini: {name:'Gemini',models:['gemini-3.5-flash-lite','gemini-3.1-flash-lite']},
    claude: {name:'Claude',models:['claude-haiku-5-5']}
};
export function providerId(value='gemini') {
    if(typeof value!=='string' || !Object.hasOwn(PROVIDERS,value))throw new SecurityError(400,'Choose Gemini or Claude.');
    return value;
}
