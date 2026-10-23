// Tiny SFZ reader (data only): supports the subset used by VSCO 2 CE's instrument files:
// <control> default_path, <global>/<group>/<region> inheritance, sample, lokey/hikey/key, pitch_keycenter,
// lovel/hivel, volume (dB), tune (cents), seq_length/seq_position, offset. Unknown opcodes are kept verbatim.
import { readFileSync } from 'node:fs';

export function parseSfz(path) {
  const text = readFileSync(path, 'utf8').replace(/\/\/[^\n]*/g, ' ');
  const tokens = []; // {header} | {op, value}
  const re = /<(\w+)>|([A-Za-z_][\w]*)=/g; let m; const marks = [];
  while ((m = re.exec(text))) marks.push({ idx: m.index, end: re.lastIndex, header: m[1], op: m[2] });
  for (let i = 0; i < marks.length; i++) {
    const k = marks[i];
    if (k.header) { tokens.push({ header: k.header }); continue; }
    const stop = i + 1 < marks.length ? marks[i + 1].idx : text.length;
    tokens.push({ op: k.op, value: text.slice(k.end, stop).trim() });
  }
  let control = {}, global = {}, group = {}, cur = null, scope = 'none';
  const regions = [];
  const flush = () => { if (cur) regions.push({ ...global, ...group, ...cur }); cur = null; };
  for (const t of tokens) {
    if (t.header) {
      flush();
      scope = t.header;
      if (scope === 'group') group = {};
      if (scope === 'region') cur = {};
      continue;
    }
    const target = scope === 'control' ? control : scope === 'global' ? global : scope === 'group' ? group : scope === 'region' ? cur : null;
    if (target) target[t.op] = t.value;
  }
  flush();
  const base = (control.default_path || '').replace(/\\/g, '/');
  return regions.filter((r) => r.sample).map((r) => {
    const num = (k, d) => (r[k] !== undefined && r[k] !== '' && Number.isFinite(+r[k]) ? +r[k] : d);
    const key = num('key', NaN);
    return {
      sample: (base + r.sample.replace(/\\/g, '/')).replace(/^\/+/, ''),
      lokey: num('lokey', Number.isFinite(key) ? key : 0), hikey: num('hikey', Number.isFinite(key) ? key : 127),
      key: num('pitch_keycenter', Number.isFinite(key) ? key : 60),
      lovel: num('lovel', 0), hivel: num('hivel', 127),
      volume: num('volume', 0), tune: num('tune', 0),
      seqLength: num('seq_length', 1), seqPosition: num('seq_position', 1),
      offset: num('offset', 0),
    };
  });
}
