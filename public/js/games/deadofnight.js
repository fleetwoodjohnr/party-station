// Dead of Night — TV adapter. The game (public/js/night/) is loaded only
// when it starts, so phones and the hub never download three.js. It is
// "immersive": tv.js hands over the whole screen and every button, Start
// included, and the game draws its own HUD and menus.
export const tv = {
  immersive: true,
  start(holder, ctx) {
    let game = null, stopped = false, home = holder;
    holder.innerHTML = '<div style="position:absolute;inset:0;display:flex;flex-direction:column;gap:18px;align-items:center;justify-content:center;'
      + 'background:#05060c;color:#c9b98f;font:800 28px system-ui;letter-spacing:.3em">DEAD OF NIGHT…<small style="font:600 18px system-ui;letter-spacing:.1em;opacity:.7"></small></div>';
    const note = holder.querySelector('small');
    // The models and textures (about 3 MB) load before the game starts.
    import('../night/main.js')
      .then(m => m.loadAssets(p => { note.textContent = `Loading ${Math.round(p * 100)}%`; }).then(() => m))
      .then(m => {
        if (stopped) return;
        home.innerHTML = '';
        game = m.start(home, ctx);
      })
      .catch(e => {
        console.error('Dead of Night failed to load', e);
        home.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
          + 'color:#f88;font:700 26px system-ui">Dead of Night failed to load — returning to the hub…</div>';
        setTimeout(() => ctx.quit?.(), 4000);
      });
    return {
      stop() { stopped = true; game?.stop(); },
      net(m) { game?.net?.(m); },
      rehome(h) {
        const prev = home;
        home = h;
        if (game) game.rehome(h);
        else if (h !== prev) h.append(...prev.childNodes);
      },
    };
  },
};
