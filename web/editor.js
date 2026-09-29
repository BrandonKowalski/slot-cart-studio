// One panel for everything about one cart. It keeps no cart state: every change goes through the
// studio's api, one history step at a time.
import { canRedo, canRevert, canUndo, commit, redo, revert, undo, visit, visited } from './history.js';

const $ = (id) => document.getElementById(id);
const OPENERS = { 'ed-games': 'ed-game', 'ed-bg-pal': 'ed-bg', 'ed-shell-pal': 'ed-shell' };

export function createEditor(api) {
  const panel = $('editor');
  let cart = null;
  let built = false;
  // A drag through a colour picker is one step: the first input records it, the rest follow.
  let dragging = false;

  function change(fn, c = cart) {
    if (c && commit(c, () => fn(c))) api.changed(c);
  }

  function drag(fn) {
    const c = cart;
    if (!c) return;
    if (dragging) {
      fn(c);
      api.changed(c, true);
    } else if ((dragging = commit(c, () => fn(c)))) {
      api.changed(c);
    }
  }

  function step(fn) {
    const c = cart;
    if (c && fn(c)) api.changed(c);
  }

  function closePops() {
    for (const [pop, opener] of Object.entries(OPENERS)) {
      $(pop).hidden = true;
      $(opener).setAttribute('aria-expanded', 'false');
    }
  }

  function toggle(pop) {
    const opening = $(pop).hidden;
    closePops();
    $(pop).hidden = !opening;
    $(OPENERS[pop]).setAttribute('aria-expanded', String(opening));
    return opening;
  }

  const press = (group, value) => {
    for (const b of $(group).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  };
  const enable = (group, on) => {
    for (const b of $(group).querySelectorAll('button')) b.disabled = !on;
  };

  function build() {
    if (built) return;
    built = true;
    $('ed-shell-presets').replaceChildren(
      ...api.presets().map(({ name, value }) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', title: name });
        b.setAttribute('aria-label', name);
        b.dataset.value = value;
        b.style.background = `#${value.split(' ')[1]}`;
        return b;
      }),
    );
  }

  function showGames() {
    const c = cart;
    const item = (text, pick, className = '') => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, className });
      b.addEventListener('click', () => {
        closePops();
        pick();
      });
      const li = document.createElement('li');
      li.append(b);
      return li;
    };
    $('ed-hits').replaceChildren(
      ...(api.matched(c) ? [item('No match', () => change(api.noMatch), 'none')] : []),
      ...(api.search(c, $('ed-query').value) ?? []).map((name) =>
        item(name, () => change((c) => api.chooseGame(c, name))),
      ),
    );
  }

  function refresh() {
    const c = cart;
    if (!c) return;
    if (!visited(c)) visit(c);
    $('ed-name').textContent = api.name(c);
    const shelf = api.carts();
    const at = shelf.indexOf(c);
    $('ed-prev').disabled = at <= 0;
    $('ed-next').disabled = at < 0 || at === shelf.length - 1;
    const face = api.face(c);
    $('ed-face').hidden = !face;
    if (face) api.draw($('ed-face'), face, c.platform);

    const label = api.canLabel(c);
    $('ed-game').disabled = !label;
    $('ed-game').querySelector('span').textContent = api.matched(c) ? c.game : 'Choose a game';
    enable('ed-logo', label);
    press('ed-logo', c.droppedBytes ? 'custom' : 'auto');

    const bg = api.background(c);
    $('ed-bg').disabled = !api.canBackground(c);
    $('ed-bg').querySelector('i').style.background = api.hex(bg.rgb);
    $('ed-bg').querySelector('span').textContent = bg.auto ? 'Automatic' : api.hex(bg.rgb);
    $('ed-bg-auto').setAttribute('aria-pressed', String(bg.auto));
    $('ed-bg-custom').value = api.hex(bg.rgb);

    const shell = api.shellOf(c);
    const shells = api.canShell(c);
    $('ed-shell').disabled = !shells;
    $('ed-shell').querySelector('i').style.background = `#${shell.colour}`;
    $('ed-shell').querySelector('span').textContent = shell.auto ? 'Automatic' : shell.name;
    for (const b of $('ed-shell-presets').querySelectorAll('button')) {
      const [, colour, finish] = b.dataset.value.split(' ');
      b.setAttribute('aria-pressed', String(!shell.auto && colour === shell.colour && finish === shell.finish));
    }
    $('ed-shell-auto').setAttribute('aria-pressed', String(shell.auto));
    $('ed-shell-custom').value = `#${shell.colour}`;
    press('ed-finish', shell.finish);
    enable('ed-finish', shells && !shell.auto);
    $('ed-outline-row').hidden = c.platform === 'GBA';
    press('ed-outline', shell.outline);
    enable('ed-outline', shells);

    if (Object.entries(OPENERS).some(([pop, opener]) => !$(pop).hidden && $(opener).disabled)) closePops();
    $('ed-undo').disabled = !canUndo(c);
    $('ed-redo').disabled = !canRedo(c);
    $('ed-revert').disabled = !canRevert(c);
  }

  function open(c) {
    build();
    if (c === cart) return;
    cart?.el.root.classList.remove('current');
    cart = c;
    dragging = false;
    visit(c);
    closePops();
    c.el.root.classList.add('current');
    [$('ed-face').width, $('ed-face').height] = api.box(c.platform);
    panel.hidden = false;
    document.body.classList.add('editing');
    refresh();
    panel.focus({ preventScroll: true });
  }

  function close() {
    if (!cart) return;
    cart.el.root.classList.remove('current');
    cart = null;
    closePops();
    panel.hidden = true;
    document.body.classList.remove('editing');
  }

  function move(by) {
    const shelf = api.carts();
    const next = shelf[shelf.indexOf(cart) + by];
    if (!next) return;
    open(next);
    next.el.root.scrollIntoView({ block: 'nearest' });
  }

  $('ed-close').addEventListener('click', close);
  $('ed-prev').addEventListener('click', () => move(-1));
  $('ed-next').addEventListener('click', () => move(1));

  $('ed-game').addEventListener('click', () => {
    if (!toggle('ed-games')) return;
    $('ed-query').value = api.name(cart);
    showGames();
    $('ed-query').select();
  });
  $('ed-query').addEventListener('input', showGames);

  $('ed-logo').addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (value === 'auto') change(api.autoLogo);
    else if (value === 'custom') $('ed-logo-file').click();
  });
  $('ed-logo-file').addEventListener('change', async () => {
    const c = cart;
    const file = $('ed-logo-file').files[0];
    $('ed-logo-file').value = '';
    const bytes = await api.readLogo(file);
    if (bytes) change((c) => api.useLogo(c, bytes), c);
  });

  $('ed-bg').addEventListener('click', () => toggle('ed-bg-pal'));
  $('ed-bg-auto').addEventListener('click', () => {
    closePops();
    change((c) => api.setBackground(c, null));
  });
  $('ed-bg-custom').addEventListener('input', () =>
    drag((c) => api.setBackground(c, api.fromHex($('ed-bg-custom').value))),
  );

  $('ed-shell').addEventListener('click', () => toggle('ed-shell-pal'));
  $('ed-shell-presets').addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (!value) return;
    const [, colour, finish] = value.split(' ');
    closePops();
    change((c) => api.setShell(c, { ...api.shellOf(c), colour, finish }));
  });
  $('ed-shell-auto').addEventListener('click', () => {
    closePops();
    change((c) => api.setShell(c, null));
  });
  $('ed-shell-custom').addEventListener('input', () =>
    drag((c) => api.setShell(c, { ...api.shellOf(c), colour: $('ed-shell-custom').value.slice(1) })),
  );
  for (const id of ['ed-bg-custom', 'ed-shell-custom']) {
    $(id).addEventListener('change', () => {
      dragging = false;
      closePops();
    });
  }
  $('ed-finish').addEventListener('click', (e) => {
    const finish = e.target.closest('button')?.dataset.value;
    if (finish) change((c) => api.setShell(c, { ...api.shellOf(c), finish }));
  });
  $('ed-outline').addEventListener('click', (e) => {
    const outline = e.target.closest('button')?.dataset.value;
    if (outline) change((c) => api.setShell(c, { ...api.shellOf(c), outline }));
  });

  $('ed-undo').addEventListener('click', () => step(undo));
  $('ed-redo').addEventListener('click', () => step(redo));
  $('ed-revert').addEventListener('click', () => step(revert));

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (Object.keys(OPENERS).some((pop) => !$(pop).hidden)) closePops();
      else close();
      e.preventDefault();
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.target.matches('input[type="search"]')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) step(undo);
    else if ((key === 'z' && e.shiftKey) || key === 'y') step(redo);
    else return;
    e.preventDefault();
  });

  return { open, close, refresh, current: () => cart };
}
