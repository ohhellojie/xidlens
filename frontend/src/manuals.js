export function manualMatches(t, query, data, peer) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const codes = [...new Set([...(t.related || []), ...(t.extracts || []), ...((t.branches || []).map((b) => b.code))])];
  const haystack = JSON.stringify([
    t,
    peer,
    codes.map((k) => `xid ${k}`),
    codes.map((k) => data?.cn?.codes?.[k]),
    codes.map((k) => data?.en?.codes?.[k]),
  ]).toLowerCase();
  return haystack.includes(q);
}
