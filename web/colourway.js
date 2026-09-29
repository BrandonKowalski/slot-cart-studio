// slot's own RG SP colourways, copied from slot's site/app.js so the two pages never disagree.
// `accent` and `ink` are the studio's own: the plastic as it reads against the dark page, and the
// lettering pressed into a key made of it.
export const SHELLS = [
  { name: 'silver', light: '#e2e5e9', base: '#b8bcc2', shade: '#7e838b', etch: 'rgba(0,0,0,.46)', accent: '#b8bcc2', ink: '#2b2e33' },
  { name: 'pink', light: '#f6d3dd', base: '#e6a6b8', shade: '#a76d7e', etch: 'rgba(0,0,0,.44)', accent: '#e6a6b8', ink: '#4d2432' },
  { name: 'light blue', light: '#dbe9f2', base: '#a8c4d8', shade: '#6d8ba1', etch: 'rgba(0,0,0,.44)', accent: '#a8c4d8', ink: '#1f3446' },
  { name: 'black', light: '#5a5d64', base: '#34363b', shade: '#16171a', etch: 'rgba(255,255,255,.42)', accent: '#8d9097', ink: '#eceef2' },
];

// One per visit, the way the device you own was one of four in a bin; `?shell=pink` pins it.
export function pickShell(search, random = Math.random) {
  const want = new URLSearchParams(search).get('shell')?.toLowerCase();
  return SHELLS.find((s) => s.name === want) ?? SHELLS[Math.floor(random() * SHELLS.length)];
}

export function wear(shell, root = document.documentElement.style) {
  for (const key of ['light', 'base', 'shade', 'etch', 'accent', 'ink']) root.setProperty(`--shell-${key}`, shell[key]);
}
