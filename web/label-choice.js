export const KINDS = ['card', 'real', 'logo', 'customLogo', 'customLabel'];

const OTHER = { real: 'logo', logo: 'real' };

export function available(c, kind) {
  if (kind === 'card') return c.onCard;
  if (kind === 'real') return c.hasReal;
  if (kind === 'logo') return c.hasLogo;
  return true;
}

export function wears(c) {
  const why = c.byHand ? 'byHand' : 'fill';
  switch (c.choice) {
    case 'card':
      return { kind: 'card', why: 'card' };
    case 'customLogo':
      return c.customLogoBytes ? { kind: 'customLogo', why } : { kind: 'none', why: 'nothing' };
    case 'customLabel':
      return c.customLabelBytes ? { kind: 'customLabel', why } : { kind: 'none', why: 'nothing' };
    case 'real':
    case 'logo':
      if (available(c, c.choice)) return { kind: c.choice, why };
      if (available(c, OTHER[c.choice])) return { kind: OTHER[c.choice], why: 'fallback' };
      return { kind: 'none', why: 'nothing' };
    default:
      return { kind: 'none', why: 'unfilled' };
  }
}

const fillable = (c) => !c.onCard && !c.error;

export function applyFill(carts, fill) {
  let n = 0;
  for (const c of carts) {
    if (!fillable(c) || c.byHand || c.choice === fill) continue;
    c.choice = fill;
    n++;
  }
  return n;
}

export function reset(c, fill) {
  c.byHand = false;
  c.choice = c.onCard ? 'card' : fill;
}

export function fillCounts(carts) {
  const counts = { unlabelled: 0, real: 0, logo: 0, neither: 0 };
  for (const c of carts) {
    if (!fillable(c)) continue;
    counts.unlabelled++;
    if (c.hasReal) counts.real++;
    if (c.hasLogo) counts.logo++;
    if (!c.hasReal && !c.hasLogo) counts.neither++;
  }
  return counts;
}

export function fillText({ unlabelled, real, logo, neither }) {
  if (unlabelled === 1) {
    const has = real && logo ? 'It has a real label and a logo.' : real ? 'It has a real label but no logo.' : logo ? 'It has a logo but no real label.' : 'It has no real label or logo, so it will need art of your own.';
    return { title: '1 cart has no label yet', body: `How should the studio fill it? ${has} You can change it afterwards.` };
  }
  const parts = [`How should the studio fill them?`];
  parts.push(real === unlabelled ? `All ${real} have a real label.` : `${real} of them have a real label.`);
  const noReal = unlabelled - real - neither;
  const noLogo = unlabelled - logo - neither;
  if (noReal > 0) parts.push(noReal === 1 ? 'The one that doesn’t will use Logo Only instead.' : `The ${noReal} that don’t will use Logo Only instead.`);
  if (noLogo > 0) parts.push(`${noLogo} ${noLogo === 1 ? 'has' : 'have'} no logo and will use Real Label if you pick Logo Only.`);
  if (neither > 0) parts.push(`${neither} ${neither === 1 ? 'has' : 'have'} no logo either and will need art of your own.`);
  parts.push('You can change any cart afterwards.');
  return { title: `${unlabelled} carts have no label yet`, body: parts.join(' ') };
}
