export function manualMatches(t,query,data){return JSON.stringify([t,...(t.extracts||t.branches?.map(b=>b.code)||[]).map(k=>data.cn.codes[k])]).toLowerCase().includes(query.trim().toLowerCase())}
