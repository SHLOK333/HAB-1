// Re-serialise one JSON line the way the Pi signs it: Python json.dumps(rec, sort_keys=True,
// separators=(",", ":")), ensure_ascii on. Number and string tokens are kept exactly as
// written (JSON.parse would turn 70.0 into 70, and "—" into "—", breaking the signature).
export function pyCanon(text, dropKey) {
  let i = 0
  const ws = () => { while (" \t\n\r".includes(text[i])) i++ }
  function str() { const s = i; i++; while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1; i++; return text.slice(s, i) }
  function val(top) {
    ws(); const c = text[i]
    if (c === "{") {
      i++; const kv = []; ws()
      if (text[i] === "}") { i++; return "{}" }
      for (;;) { ws(); const k = str(); ws(); i++; const v = val(false); kv.push([JSON.parse(k), k, v]); ws(); if (text[i++] === "}") break }
      return "{" + kv.filter(([k]) => !(top && k === dropKey)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, k, v]) => k + ":" + v).join(",") + "}"
    }
    if (c === "[") {
      i++; const out = []; ws()
      if (text[i] === "]") { i++; return "[]" }
      for (;;) { out.push(val(false)); ws(); if (text[i++] === "]") break }
      return "[" + out.join(",") + "]"
    }
    if (c === '"') return str()
    const s = i; while (i < text.length && !",]} \t\n\r".includes(text[i])) i++; return text.slice(s, i)
  }
  return val(true)
}
