const SLUG = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;

const words = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const SHARED = { GB: ['GB', 'GBC'], GBC: ['GBC', 'GB'] };

const strings = (value) => (Array.isArray(value) ? value.filter((s) => typeof s === 'string') : []);

export function extrasFrom(index) {
  const platforms = new Map();
  for (const [slug, entry] of Object.entries(index ?? {})) {
    if (!SLUG.test(slug) || typeof entry?.name !== 'string' || typeof entry.platform !== 'string') continue;
    const extra = { slug, name: entry.name, names: [entry.name, ...strings(entry.aka)] };
    for (const platform of SHARED[entry.platform] ?? [entry.platform]) {
      if (!platforms.has(platform)) platforms.set(platform, { list: [], byName: new Map(), byCrc: new Map() });
      const p = platforms.get(platform);
      p.list.push(extra);
      if (!p.byName.has(extra.name)) p.byName.set(extra.name, extra);
      for (const crc of strings(entry.crcs)) if (!p.byCrc.has(crc.toUpperCase())) p.byCrc.set(crc.toUpperCase(), extra);
    }
  }
  const of = (platform) => platforms.get(platform) ?? { list: [], byName: new Map(), byCrc: new Map() };

  return {
    named: (platform, name) => of(platform).byName.get(name) ?? null,
    dumped: (platform, crc) => of(platform).byCrc.get(crc) ?? null,

    guess(platform, title) {
      const said = words(title);
      const whole = said.join('');
      const has = new Set(said);
      const hits = [];
      for (const extra of of(platform).list) {
        for (const name of extra.names) {
          const want = words(name);
          if (want.length && (whole.includes(want.join('')) || want.every((w) => has.has(w)))) {
            hits.push({ extra, want });
          }
        }
      }
      const within = (a, b) => a !== b && a.want.every((w) => b.want.includes(w));
      const kept = new Set(hits.filter((a) => !hits.some((b) => within(a, b))).map((hit) => hit.extra));
      return kept.size === 1 ? [...kept][0] : null;
    },

    search(platform, query, limit) {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      return of(platform)
        .list.map((extra) => {
          const at = Math.min(
            ...extra.names.map((n) => {
              const i = n.toLowerCase().indexOf(needle);
              return i < 0 ? Infinity : i;
            }),
          );
          return { name: extra.name, first: at === 0, found: at !== Infinity };
        })
        .filter((hit) => hit.found)
        .sort((a, b) => b.first - a.first || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((hit) => hit.name);
    },
  };
}
