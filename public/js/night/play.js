// The in-game state: controller -> Input -> sim step -> events -> sound,
// effects, HUD and camera. Also the pause menu (Start), the objectives
// overlay (Select), the Forge, controller-loss handling, XP/rank, and the
// game-over / dawn screens.
import { THREE } from './render.js';
import { Game } from './sim/game.js';
import { World } from './sim/world.js';
import { Zombies } from './sim/zombies.js';
import { DINER } from './sim/maps.js';
import { generateWorld } from './sim/regions.js';
import { SurvivalHud, mapScreen, inventoryScreen, buildPanel, benchScreen } from './ow-ui.js';
import { ShelterView } from './shelter-view.js';
import { HostNet, ClientNet, applyAct } from './coop.js';
import { PIECES, PIECE_ORDER, RECIPES, TIER_NAMES } from './sim/shelter.js';
import { ATTACHMENTS } from './sim/weapons.js';
import { C } from './sim/world.js';
import { emptyInput } from './sim/player.js';
import { botInput } from './sim/bot.js';
import { WEAPONS, PERKS, RARITY } from './sim/weapons.js';
import { EQUIP } from './sim/equipment.js';
import { rankOf } from './sim/classic.js';
import { buildViewmodel, poseViewmodel, muzzleFlash, Effects, WorldProps, chalkSign, vmKey } from './gear.js';
import { Hud } from './hud.js';
import { audio } from './audio.js';
import { h, Menu, hints } from './ui.js';
import { Stack, settingsScreen, controlsScreen, forgeScreen } from './menus.js';
import { loadProfile, saveProfile } from './main.js';

const BASE_FOV = 62;
const LOOK_RATE = 2.9; // rad/s at sensitivity 5, full stick
const POWER_NAMES = { maxammo: 'Max Ammo', instakill: 'Insta-Kill', doublepts: 'Double Points', carpenter: 'Carpenter', nuke: 'Nuke' };

export class PlayState {
  constructor(app, opts = {}) {
    this.app = app;
    this.opts = opts;
    this.kind = opts.mode || 'classic';   // classic | world | shelter
    this.scene = opts.autopilot ? 'bench-classic' : this.kind;
  }

  enter() {
    const a = this.app;
    const seat = a.ctx.seats?.[0];
    this.career = this.opts.career || { xp: 0 };
    this.rank = rankOf(this.career.xp || 0);
    // Co-op: everyone in the lobby is a survivor; this screen plays one of
    // them. The host's screen simulates, the others are clients.
    const humans = (a.ctx.seats || []).filter(s => !s.bot);
    this.coop = !this.opts.autopilot && humans.length > 1;
    this.isClient = !!this.opts.client;
    this.localSeat = this.coop ? (a.ctx.localSeats?.()[0] ?? 0) : 0;
    const seats = this.coop ? humans.map(s => ({ name: s.name })) : [{ name: seat && !seat.bot ? seat.name : 'Survivor' }];
    let seed = (Math.random() * 1e9) | 0;
    if (this.kind === 'classic') {
      this.world = a.world; this.pool = a.pool;
      this.game = new Game({
        world: a.world, zombies: a.pool, mode: 'classic', seats,
        seed: (Math.random() * 2 ** 31) | 0,
        modeOpts: { startRound: this.opts.startRound || 1, standard: !!this.opts.standard, rank: this.rank },
      });
    } else {
      // A whole county from its seed (same seed = same map for a save).
      const save = this.isClient ? null : this.opts.save;
      seed = this.opts.seed ?? save?.seed ?? seed;
      this.world = new World(generateWorld(seed));
      this.pool = new Zombies(48);
      a.view.setWorld(this.world, this.world, this.pool);
      this.game = new Game({
        world: this.world, zombies: this.pool, mode: this.kind, seats, seed,
        modeOpts: { seed, save, sharedLoot: a.ctx.options?.coopLoot === 'shared' },
      });
      this.slot = this.opts.slot || 1;
      this.flash = false;
    }
    const P = this.P = this.game.players[this.localSeat] || this.game.players[0];
    this.home = [P.x, P.z];
    if (this.coop && !this.isClient) {
      this.host = new HostNet(this.game, a.ctx.send);
      this.host.meta = { kind: this.kind, seed, run: Math.random().toString(36).slice(2, 8), standard: !!this.opts.standard };
    }
    if (this.isClient) { this.net = new ClientNet(this.game, this.localSeat, a.ctx.send); this.meta = this.opts.meta; }
    a.view.crewPlayers = this.game.players; a.view.crewSkip = P.seat;
    if (this.opts.autopilot) {
      P.god = true; P.infiniteAmmo = true;
      P.give('smg', null); P.give('shotgun', null);
    }
    this.fx = new Effects(a.view.scene);
    this.props = new WorldProps(a.view.scene);
    this.signs = [];
    for (const b of this.world.wallbuys) {
      const m = chalkSign(b.weapon ? WEAPONS[b.weapon].model : b.melee || b.equip);
      m.position.set(b.x + 0.5 + b.face[0] * 0.505, 1.55, b.y + 0.5 + b.face[1] * 0.505);
      m.rotation.y = Math.atan2(b.face[0], b.face[1]);
      a.view.scene.add(m); this.signs.push(m);
    }
    for (const t of this.world.traps) {
      const m = chalkSign('text', `TRAP\n${t.cost}`);
      const L = t.lever;
      m.scale.setScalar(0.7);
      m.position.set(L.x + 0.5 + L.face[0] * 0.505, 1.7, L.y + 0.5 + L.face[1] * 0.505);
      m.rotation.y = Math.atan2(L.face[0], L.face[1]);
      a.view.scene.add(m); this.signs.push(m);
    }
    this.doorSigns = [];
    for (const d of Object.values(this.world.doors)) {
      const xs = d.cells.map(c => c[0]), zs = d.cells.map(c => c[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, z0 = Math.min(...zs), z1 = Math.max(...zs) + 1;
      const alongZ = (x1 - x0) < (z1 - z0);
      for (const side of [-1, 1]) {
        const m = chalkSign('text', `${d.name.toUpperCase()}\n${d.cost}`);
        m.scale.setScalar(0.9);
        m.position.set((x0 + x1) / 2 + (alongZ ? side * ((x1 - x0) / 2 + 0.02) : 0), 1.9,
          (z0 + z1) / 2 + (alongZ ? 0 : side * ((z1 - z0) / 2 + 0.02)));
        m.rotation.y = alongZ ? side * Math.PI / 2 : (side > 0 ? 0 : Math.PI);
        a.view.scene.add(m); this.doorSigns.push({ m, id: d.id });
      }
    }
    this.vmFor();
    this.hudLayer = h('div', { class: 'nn-layer' });
    a.root.insertBefore(this.hudLayer, a.uiLayer);
    this.hud = new Hud(this.hudLayer, a.input);
    if (this.kind === 'shelter') {
      this.shv = new ShelterView(a.view.scene, this.game.mode.shelter, a.view.staticMat);
      this.build = null;
      this.buildEl = h('div', { class: 'nn-panel', style: 'position:absolute;left:50%;bottom:15vh;transform:translateX(-50%);display:none;text-align:center;min-width:40vw' });
      this.hudLayer.appendChild(this.buildEl);
    }
    if (this.kind !== 'classic') {
      this.sv = new SurvivalHud(this.hudLayer);
      this.hud.round.style.display = 'none';
      this.hud.pts.style.display = 'none';
    }
    this.menus = new Stack(a.uiLayer, a.input, n => audio.ui(n));
    a.uiLayer.replaceChildren();
    audio.volume(a.settings.volume / 10 * 0.9);
    audio.ambience(true);
    this.t = 0; this.groanT = 1; this.lastStep = 0; this.overT = -1; this.lostT = 0;
    this.camRoll = 0; this.camDrop = 0; this.shake = 0;
    this.mz = new THREE.Vector3();
    if (this.opts.autopilot) this.hud.showBanner('Benchmark', `Autopilot from round ${this.opts.startRound || 1}`, 4);
    this.sendScore();
  }

  // (Re)build the first-person model when the gun, its parts or the melee change.
  vmFor() {
    const P = this.P, key = vmKey(P.weapon, P.meleeId);
    if (this.vm?.key === key) return;
    this._vmGroup?.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this.vm = buildViewmodel(P.weapon, P.meleeId);
    this._vmGroup = new THREE.Group();
    this._vmGroup.add(this.vm.root, this.vm.knife);
    this.app.view.setViewmodel(this._vmGroup);
  }

  // Menu actions: done here on the host, sent to the host from a client.
  doAct(d) {
    if (this.net) { this.net.act(d); return true; }
    return applyAct(this.game, this.P, d);
  }

  // Remote traffic (via tv.js → main.js).
  onNet(m) {
    if (this.host) this.host.onMsg(m);
    if (this.net) {
      const meta = m.d?.meta;
      if (meta && this.meta && meta.run !== this.meta.run) { this.app.startClient(meta); return; }
      this.net.onMsg(m);
    }
  }

  // One co-op frame: the host steps everyone (remote players from their
  // packets), the client only predicts its own survivor.
  coopStep(dt, now, inp) {
    const g = this.game, clear = i => ({ ...i, firePressed: false, jump: false, crouch: false, sprint: false, xPressed: false, swap: false, melee: false, lethal: false, tactical: false, heal: false, lookX: 0, lookY: 0 });
    if (this.net) {
      this.net.apply(now);
      let left = Math.min(dt, 0.1), i = inp;
      while (left > 1e-4) { const h2 = Math.min(left, 1 / 30); this.P.step(h2, i, g); left -= h2; i = clear(i); }
      this.net.sendInput(inp, this.P, dt);
      this.handle([...g.drain(), ...this.net.drainEvents()]);
      return;
    }
    this.host.drainActs((seat, d) => applyAct(g, g.players[seat], d));
    let inputs = g.players.map((Q, k) => (k === this.localSeat ? inp : this.host.inputFor(k)));
    let left = Math.min(dt, 0.1);
    while (left > 1e-4) { const h2 = Math.min(left, 1 / 30); g.step(h2, inputs); left -= h2; inputs = inputs.map(clear); }
    const ev = g.drain();
    this.host.collect(ev);
    this.host.tick(dt);
    this.handle(ev);
  }

  sendScore() {
    const P = this.P;
    this.app.ctx.sendScore?.({ text: `🧟 Round ${this.game.mode.round || 1} · ${P.points} pts · ${P.kills} kills` });
  }

  // Controller -> sim Input, sensitivity and curve already applied.
  readInput(dt) {
    const I = this.app.input, s = this.app.settings, P = this.P;
    const inp = emptyInput();
    const ads = 1 - P.ads * (1 - s.adsSens) - (this.vm.def.scope ? P.ads * 0.35 : 0);
    const rate = LOOK_RATE * (s.sens / 5) * Math.max(0.15, ads) * dt;
    inp.lookX = I.look[0] * rate;
    inp.lookY = I.look[1] * rate * 0.75;
    inp.mx = I.move[0]; inp.my = I.move[1];
    inp.fire = I.down('fire'); inp.firePressed = I.pressed('fire');
    inp.ads = I.down('ads');
    inp.jump = I.pressed('jump'); inp.crouch = I.pressed('crouch'); inp.sprint = I.pressed('sprint');
    inp.x = I.down('reload'); inp.xPressed = I.pressed('reload');
    inp.swap = I.pressed('swap'); inp.melee = I.pressed('melee');
    inp.lethal = I.pressed('lethal'); inp.tactical = I.pressed('tactical');
    inp.heal = I.pressed('heal');
    if (this.build) {
      // Building borrows the combat buttons (see buildStep).
      inp.fire = inp.firePressed = inp.ads = inp.x = inp.xPressed = inp.swap = inp.melee = inp.lethal = inp.tactical = inp.crouch = false;
    }
    inp.assist = s.aimAssist;
    return inp;
  }

  update(dt, now) {
    const a = this.app, I = a.input, g = this.game, P = this.P;
    this.t += dt;
    // Lost the controller (battery, out of range): pause until one presses.
    if (!this.opts.autopilot && !I.connected) {
      this.lostT += dt;
      if (this.lostT > 0.5 && !this.menus.open) this.openPause(true);
    } else this.lostT = 0;
    if (this.net && !this.net.ready) { this.hud.showNote('Joining the host’s game…', 0.5); return; }
    if (this.menus.open) {
      this.menus.handle();
      if (a.state !== this) return;
      // Menus don't stop a shared game.
      if (this.coop && this.overT < 0) this.coopStep(dt, now, emptyInput());
      this.pose(dt, now, 0, 0);
      return;
    }
    if (this.overT >= 0) {
      this.overT += dt;
      if (this.coop) this.coopStep(dt, now, emptyInput());
      else { g.step(Math.min(dt, 1 / 30), []); this.handle(g.drain()); } // the horde keeps feeding behind the death cam
      this.pose(dt, now, 0, 0);
      if (this.overT > 3 && !this.menus.open) this.endScreen(this.won);
      return;
    }
    if (I.pressed('pause') && !this.opts.autopilot) { this.openPause(false); return; }
    if (this.sv) {
      // Survival extras: map (Select), pack (D-pad up), torch (D-pad right).
      if (I.pressed('map')) { this.menus.push(mapScreen(a, this.menus, g)); return; }
      if (I.pressed('inv')) { this.menus.push(inventoryScreen(a, this.menus, g, P, () => this.vmFor(), d => this.doAct(d))); return; }
      if (I.pressed('dright')) { this.flash = !this.flash; this.flashSet = true; audio.ui('blip'); }
      if (this.shv) this.buildStep(I);
      const [day, dusk] = g.mode.daylight();
      a.view.setDaylight(day, dusk);
      if (!this.flashSet) this.flash = day < 0.25;
      a.view.setFlashlight(this.flash);
    }
    g.zcap = a.gov.cap;
    let inp = this.opts.autopilot ? botInput(g, P, this.home) : this.readInput(dt);
    const look = [inp.lookX / Math.max(dt, 1e-3), inp.lookY / Math.max(dt, 1e-3)];
    if (this.coop) this.coopStep(dt, now, inp);
    else {
      // Fixed-size substeps keep physics stable on a slow frame; edge-
      // triggered buttons only count once.
      let left = Math.min(dt, 0.1);
      while (left > 1e-4) {
        const h2 = Math.min(left, 1 / 30);
        g.step(h2, [inp]);
        left -= h2;
        inp = { ...inp, firePressed: false, jump: false, crouch: false, sprint: false, xPressed: false, swap: false, melee: false, lethal: false, tactical: false, heal: false, lookX: 0, lookY: 0 };
      }
      this.handle(g.drain());
    }
    if (a.state !== this) return;
    this.vmFor();
    const scoped = this.vm.def.scope && P.ads > 0.85;
    this.hud.update(dt, P, g, a.view.res.h, a.view.camera.fov * Math.PI / 180, scoped);
    if (this.sv) this.sv.update(P, g.mode);
    else this.hud.objectives(I.down('map') && !this.opts.autopilot, g.mode);
    if (this.coop) this.hud.team(g.players, P.seat);
    this.pose(dt, now, look[0] * 0.015, look[1] * 0.015);
    // Footsteps.
    const step = Math.floor(P.stepPhase / Math.PI);
    if (step !== this.lastStep && P.grounded && P.speedFrac > 0.15) audio.step(P.sprinting);
    this.lastStep = step;
    // Ambient groans from zombies that are close.
    this.groanT -= dt;
    if (this.groanT <= 0) {
      this.groanT = 0.8 + Math.random() * 1.4;
      const Z = g.zombies;
      const live = [];
      for (let i = 0; i < Z.n; i++) if (Z.isLive(i)) live.push(i);
      if (live.length) {
        const i = live[Math.floor(Math.random() * live.length)];
        const [pan, vol] = this.where(Z.x[i], Z.z[i]);
        audio.groan(pan, vol, [1, 1.25, 0.9, 0.95, 0.6, 1.2, 1.6, 0.8, 0.45][Z.type[i]] || 1);
      }
    }
    // A live trap crackles.
    for (const tr of g.world.traps) {
      if (tr.active <= 0) continue;
      const [cx, cz] = tr.cells[Math.floor(Math.random() * tr.cells.length)];
      this.fx.burst(cx + Math.random(), 0.3 + Math.random() * 2.4, cz + Math.random(), 2, this.fx.spark, 3, 0.05, 2, 0.25);
      if (Math.random() < 0.15) audio.zap();
    }
    // Rank up mid-match.
    const r = rankOf((this.career.xp || 0) + P.xp);
    if (r > this.rank && !this.opts.autopilot) {
      this.rank = r; g.mode.rank = r;
      audio.rankUp();
      this.hud.showBanner(`Rank ${r}`, 'New attachments at the Forge', 3);
    }
    if (this.opts.benchSecs && this.t >= this.opts.benchSecs && !this.benchDone) this.finishBench();
  }

  // Pan (-1 left … 1 right) and loudness of a world point, from the player.
  where(x, z) {
    const P = this.P;
    const dx = x - P.x, dz = z - P.z, d = Math.hypot(dx, dz) || 1;
    const rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
    return [(dx * rx + dz * rz) / d, Math.max(0, 1 - d / 26)];
  }

  handle(events) {
    const P = this.P, I = this.app.input, view = this.app.view, g = this.game, Z = g.zombies;
    for (const e of events) {
      switch (e.e) {
        case 'shot': {
          if (e.p !== P.seat) break;
          audio.gun(WEAPONS[e.w].sound);
          muzzleFlash(this.vm);
          const heavy = ['shotgun', 'sniper', 'marksman', 'explosive'].includes(WEAPONS[e.w].cls);
          I.rumble(heavy ? 0.7 : 0.25, 0.35, heavy ? 140 : 60);
          if (e.end) {
            this.mz.set(0.13 * (1 - P.ads), -0.09, -0.7).applyMatrix4(view.camera.matrixWorld);
            this.fx.tracer(this.mz.x, this.mz.y, this.mz.z, e.end[0], e.end[1], e.end[2]);
          }
          break;
        }
        case 'hit':
          this.fx.burst(e.x, e.y, e.z2, e.head ? 14 : e.kill ? 10 : 5, this.fx.blood, e.head ? 3 : 2, e.head ? 0.08 : 0.06);
          if (e.armor) { this.fx.burst(e.x, e.y, e.z2, 8, this.fx.metal, 3, 0.07); audio.armor(); }
          if (e.p === P.seat) {
            this.hud.flashHit(e.kill);
            if (e.kill) audio.kill(e.head); else audio.hitmark(e.head);
          }
          break;
        case 'impact': this.fx.burst(e.x, e.y, e.z, 4, this.fx.dust, 1.5, 0.04, 1, 0.45); break;
        case 'board': {
          const W = this.world.windows[e.w];
          this.fx.burst(W.x + 0.5, 1.5, W.y + 0.5, 6, this.fx.wood, 2.5, 0.08);
          const [pan, vol] = this.where(W.x + 0.5, W.y + 0.5);
          audio.board(pan, Math.max(0.15, vol));
          break;
        }
        case 'repair': audio.hammer(); break;
        case 'windup': {
          const [pan, vol] = this.where(Z.x[e.z], Z.z[e.z]);
          audio.swipe(pan, vol);
          if (Math.random() < 0.5) audio.groan(pan, vol, 1.1);
          break;
        }
        case 'hurt':
          if (e.p === P.seat) { audio.hurt(); I.rumble(1, 0.8, 260); if (e.zap) audio.zap(); }
          break;
        case 'boom': {
          this.fx.burst(e.x, e.y + 0.3, e.z, 26, this.fx.flame, 6, 0.16, 4, 0.6);
          this.fx.burst(e.x, e.y + 0.3, e.z, 10, this.fx.smoke, 2.5, 0.3, 2, 1.2);
          const [pan, vol] = this.where(e.x, e.z);
          audio.boom(pan, Math.max(0.25, vol));
          const near = Math.max(0, 1 - Math.hypot(e.x - P.x, e.z - P.z) / 14);
          this.shake = Math.max(this.shake, near);
          I.rumble(near, near, 350);
          break;
        }
        case 'fire': { const [pan, vol] = this.where(e.x, e.z); audio.fire(pan, Math.max(0.3, vol)); break; }
        case 'splat': { const [pan, vol] = this.where(e.x, e.z); audio.splat(pan, vol); this.fx.burst(e.x, e.y, e.z, 8, this.fx.acid, 2, 0.06); break; }
        case 'stun': this.fx.burst(e.x, e.y + 0.5, e.z, 20, this.fx.spark, 5, 0.06, 3, 0.4); audio.zap(); break;
        case 'throw': case 'place': audio.throwIt(); break;
        case 'bounce': audio.bounce(); break;
        case 'spit': { const [pan, vol] = this.where(e.x, e.zz); audio.spit(pan, Math.max(0.2, vol)); break; }
        case 'screamWindup': { const [pan, vol] = this.where(Z.x[e.z], Z.z[e.z]); audio.scream(pan, Math.max(0.3, vol)); break; }
        case 'scream': this.hud.showNote('A screamer whipped them into a frenzy!', 2); break;
        case 'charge': { const [pan, vol] = this.where(Z.x[e.z], Z.z[e.z]); audio.roar(pan, Math.max(0.3, vol)); break; }
        case 'fuse': this.hud.showNote('Exploder! Get back!', 1.2); break;
        case 'slamWindup': { const [pan, vol] = this.where(Z.x[e.z], Z.z[e.z]); audio.roar(pan, Math.max(0.5, vol)); break; }
        case 'slam':
          audio.slam();
          this.fx.burst(e.x, 0.2, e.zz, 24, this.fx.dust, 7, 0.14, 2.5, 0.8);
          this.shake = Math.max(this.shake, Math.max(0, 1 - Math.hypot(e.x - P.x, e.zz - P.z) / 12));
          break;
        case 'boss':
          this.hud.showBanner('The Warden', 'It came for you', 4);
          audio.roar(0, 1);
          break;
        case 'bossDown': this.hud.showBanner('The Warden falls', '+1000 points', 4); audio.victory(); break;
        case 'points': if (e.p === P.seat) this.hud.popPoints(e.n); break;
        case 'buy':
          audio.buy(); this.hud.popPoints(e.n);
          if (e.equip) this.hud.showNote(`${EQUIP[e.equip].name} — ${EQUIP[e.equip].slot === 'lethal' ? 'RB' : 'LB'} to use`, 2.5);
          this.sendScore();
          break;
        case 'perk':
          audio.perk(e.perk); this.hud.popPoints(e.n);
          this.hud.showNote(`${PERKS[e.perk].name}: ${PERKS[e.perk].desc}`, 3);
          break;
        case 'door':
          audio.door(); this.hud.popPoints(e.n);
          for (const s of this.doorSigns) if (s.id === e.id) s.m.visible = false;
          break;
        case 'denied': if (!e.quiet) { audio.denied(); this.hud.showNote('Not enough points', 1.5); } break;
        case 'crateRoll': audio.crate(); break;
        case 'crateOffer': this.hud.showNote(`The crate offers: ${e.tier ? RARITY[e.tier].name + ' ' : ''}${WEAPONS[e.w].name}`, 3); break;
        case 'crateGone': this.hud.showNote('The crate took its gift back', 2); break;
        case 'crateTaken': audio.buy(); break;
        case 'openForge':
          if (e.p === P.seat && !this.opts.autopilot) {
            this.menus.push(forgeScreen(this.app, this.menus, g, P, () => { this.vmFor(); audio.buy(); }, d => this.doAct(d)));
          }
          break;
        case 'forged': audio.perk('doubletap'); this.hud.popPoints(e.n); this.hud.showBanner(`${RARITY[e.tier].name}`, 'Forged', 2); break;
        case 'gunsmith': this.hud.popPoints(e.n); break;
        case 'trapOn': audio.zap(); this.hud.popPoints(e.n); break;
        case 'drop': this.hud.showNote(`${POWER_NAMES[e.kind]} dropped!`, 1.5); break;
        case 'power':
          audio.power();
          this.hud.showBanner(POWER_NAMES[e.kind], e.kind === 'nuke' ? 'Kaboom' : '', 2);
          if (e.kind === 'nuke') this.shake = 1;
          break;
        case 'powerEnd': audio.powerEnd(); break;
        case 'secondwind': this.hud.showBanner('Second Wind', 'Back on your feet', 2.5); break;
        case 'down': if (this.coop && e.p !== P.seat) { this.hud.showNote(`${g.players[e.p].name} is down — hold X by them to revive!`, 3); audio.denied(); } break;
        case 'revived': if (e.p === P.seat) this.hud.showBanner('Back up', `${g.players[e.by]?.name || 'A friend'} got you`, 2); else this.hud.showNote(`${g.players[e.p].name} is back up`, 1.5); break;
        case 'bledout': this.hud.showNote(e.p === P.seat ? 'You bled out — back next round' : `${g.players[e.p].name} bled out`, 3); break;
        case 'weapon': case 'swap': if (e.p === P.seat) { this.vmFor(); audio.swap(); } break;
        case 'reload': if (e.p === P.seat) audio.reload(); break;
        case 'reloaded': if (e.p === P.seat) audio.reloaded(); break;
        case 'shell': if (e.p === P.seat) audio.shell(); break;
        case 'dry': audio.dry(); break;
        case 'knife': audio.knife(); break;
        case 'land': audio.land(); break;
        case 'loot': if (e.p === P.seat) { this.sv?.showLoot(e.items, e.full); audio.buy(); } break;
        case 'used': audio.perk('quickhands'); this.hud.showNote({ food: 'Ate', water: 'Drank', meds: 'Patched up' }[e.item] || 'Used', 1.2); break;
        case 'zoneEnter': this.hud.showNote(`Infected zone — ${e.name}`, 2.5); audio.roar(0, 0.5); break;
        case 'zoneCleared': this.hud.showBanner('Zone cleared', e.name, 3); audio.victory(); break;
        case 'horde': this.hud.showNote('A horde is coming!', 2.5); audio.roar(0, 0.9); break;
        case 'dusk': this.hud.showBanner('Nightfall', 'They’re faster in the dark', 3); audio.roundStart(); break;
        case 'dawn': this.hud.showBanner(`Day ${g.mode.day}`, 'You made it to morning', 3); audio.roundEnd(); break;
        case 'missionDone':
          audio.victory();
          this.hud.showBanner(e.final ? 'The convoy is coming' : 'Mission complete', `${e.title} · +${e.xp} XP`, 3.5);
          break;
        case 'missionNote': this.hud.showNote(e.text, 2.5); break;
        case 'missionFail': this.hud.showNote(`${e.title} failed — ${e.why}`, 3); audio.denied(); break;
        case 'respawn':
          this.hud.showBanner('You woke up at the farm', e.pack ? 'Your pack is where you fell (see the map)' : '', 4);
          this.camDrop = 0; this.camRoll = 0;
          break;
        case 'slept': this.hud.showBanner(`Day ${e.day}`, 'Rested', 2.5); break;
        case 'noSleep': this.hud.showNote('You can’t sleep with zombies nearby', 2); audio.denied(); break;
        case 'autosave': this.saveWorld(); break;
        case 'built': audio.hammer(); break;
        case 'upgraded': case 'repaired': audio.hammer(); this.hud.showNote(e.e === 'upgraded' ? `Upgraded to ${TIER_NAMES[e.tier]}` : 'Repaired', 1.2); break;
        case 'buildDenied': this.hud.showNote(e.why, 1.5); audio.denied(); break;
        case 'destroyed':
          if (!e.demolished) { this.hud.showNote(`Your ${PIECES[e.type].name.toLowerCase()} was torn down!`, 2); }
          this.fx.burst(e.x + 0.5, 1.2, e.z + 0.5, 14, this.fx.wood, 3, 0.12);
          audio.board(...this.where(e.x + 0.5, e.z + 0.5));
          break;
        case 'pieceHit': if (Math.random() < 0.3) { const [pan, vol] = this.where(e.x + 0.5, e.z + 0.5); audio.board(pan, vol * 0.6); } break;
        case 'turret': {
          this.fx.tracer(e.x, e.y, e.z, e.tx, e.ty, e.tz);
          const [pan, vol] = this.where(e.x, e.z);
          if (vol > 0.05) audio.turret?.(pan, vol);
          break;
        }
        case 'turretDry': this.hud.showNote('A turret is out of ammo — stock the storage with light ammo', 3); break;
        case 'powerOut': this.hud.showNote('The generator ran dry — add fuel', 3); audio.powerEnd(); break;
        case 'fueled': this.hud.showNote(`Generator: ${e.hours}h of fuel`, 1.5); break;
        case 'shock': this.fx.burst(e.x, 0.8, e.z, 3, this.fx.spark, 3, 0.05, 2, 0.3); if (Math.random() < 0.3) audio.zap(); break;
        case 'stashed': this.hud.showNote('Stashed your materials', 1.5); audio.buy(); break;
        case 'crafted': this.hud.showNote(`Crafted: ${e.name}`, 1.5); audio.hammer(); break;
        case 'openBench':
          if (e.p === P.seat) this.menus.push(benchScreen(this.app, this.menus, g, P, this.career.xp || 0, () => this.vmFor(), RECIPES, ATTACHMENTS, rankOf, d => this.doAct(d)));
          break;
        case 'raidSoon': this.hud.showBanner('A raid is coming', `They'll hit the farm from ${e.pattern}`, 4); break;
        case 'raid': this.hud.showBanner('Raid!', `${e.n} of them — from ${e.pattern}`, 3); audio.roar(0, 1); break;
        case 'raidOver': this.hud.showBanner(e.dawn ? 'Dawn — the raid broke' : 'Raid beaten', `${e.standing} pieces still standing`, 3.5); audio.victory(); break;
        case 'vault': this.hud.showNote('Climbers are going over your wooden walls!', 2); break;
        case 'climb': audio.land(); break;
        case 'roundStart':
          audio.roundStart();
          this.hud.showBanner(`Round ${e.round}`, e.boss ? 'Something big is coming' : e.round === 1 ? 'They’re coming' : 'Here they come');
          this.sendScore();
          break;
        case 'roundEnd':
          audio.roundEnd();
          this.hud.showBanner(`Round ${e.round} survived`, 'Rebuild the windows', 3.5);
          this.sendScore();
          break;
        case 'victory':
          audio.victory();
          this.hud.showBanner('Dawn', `You survived ${e.round} rounds`, 6);
          this.won = true; this.overT = 0;
          this.saveStats(e.round + 1, true);
          break;
        case 'gameover':
          audio.gameOver();
          this.hud.showBanner('You died', `Survived ${Math.max(0, e.round - 1)} rounds`, 6);
          this.overT = 0;
          I.rumble(1, 1, 600);
          this.saveStats(e.round);
          break;
      }
    }
  }

  pose(dt, now, lookX, lookY) {
    const P = this.P, view = this.app.view;
    // Death cam: sink to the floor and roll (and back up on a Second Wind).
    if (P.down) { this.camDrop = Math.min(1.25, this.camDrop + dt * 1.6); this.camRoll = Math.min(0.5, this.camRoll + dt * 0.8); }
    else if (this.camDrop > 0) { this.camDrop = Math.max(0, this.camDrop - dt * 2); this.camRoll = Math.max(0, this.camRoll - dt); }
    const bob = P.grounded ? -Math.abs(Math.cos(P.stepPhase)) * 0.035 * P.speedFrac * (1 - P.ads * 0.7) : 0;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const sh = this.shake * this.shake * 0.06;
    view.setEye(P.x + (Math.random() - 0.5) * sh, P.y + P.eye + bob - this.camDrop + (Math.random() - 0.5) * sh, P.z,
      P.yaw, P.pitch + P.kick * 0.01, this.camRoll);
    const W = P.W;
    const fov = BASE_FOV / (1 + (W.zoom - 1) * P.ads) + (P.sprinting ? 4 : 0);
    if (Math.abs(view.camera.fov - fov) > 0.05) {
      view.camera.fov += (fov - view.camera.fov) * Math.min(1, dt * 14);
      view.camera.updateProjectionMatrix();
    }
    view.camera.updateMatrixWorld();
    poseViewmodel(this.vm, P, dt, now / 1000, lookX, lookY);
    this.fx.update(dt);
    this.props.update(this.game, now / 1000);
    this.shv?.update();
    for (const s of this.doorSigns) if (this.world.doors[s.id].open) s.m.visible = false;
  }

  // --------------------------------------------------------- build mode
  // D-pad left toggles it. The cell under the reticle (or the piece the
  // reticle is on) is the target; the ghost shows what would go there.
  buildTarget() {
    const P = this.P, W = this.world;
    const [ex, ey, ez] = P.eyePos();
    const cp = Math.cos(P.pitch), dx = -Math.sin(P.yaw) * cp, dy = Math.sin(P.pitch), dz = -Math.cos(P.yaw) * cp;
    const hit = W.raycast(ex, ey, ez, dx, dy, dz, 6);
    if (hit && W.cell(hit.cx, hit.cz) === C.STRUCT) return { x: hit.cx, z: hit.cz, piece: W.pieceAt(hit.cx, hit.cz) };
    let t = dy < -0.08 ? Math.min(6, ey / -dy) : 3;
    if (hit) t = Math.min(t, hit.t - 0.3);
    return { x: Math.floor(ex + dx * t), z: Math.floor(ez + dz * t), piece: null };
  }

  buildStep(I) {
    const Sh = this.game.mode.shelter;
    if (I.pressed('dleft')) {
      this.build = this.build ? null : { type: this.build?.type || 'wall', rot: 0 };
      audio.ui(this.build ? 'select' : 'back');
    }
    if (!this.build) { this.shv.showGhost(null); buildPanel(this.buildEl, I, null); return; }
    const B = this.build;
    if (I.hit(1)) { this.build = null; audio.ui('back'); return; }
    const avail = PIECE_ORDER.filter(t => PIECES[t].tier <= Sh.tech);
    if (I.pressed('lethal') || I.pressed('tactical')) {
      const k = avail.indexOf(B.type);
      B.type = avail[(k + (I.pressed('lethal') ? 1 : avail.length - 1)) % avail.length];
      audio.ui('blip');
    }
    if (I.pressed('swap')) { B.rot = (B.rot + 1) % 4; audio.ui('blip'); }
    const T = this.buildTarget();
    const D = PIECES[B.type];
    const fmt = need => Object.entries(need).map(([k, n]) => `${n} ${k}`).join(', ');
    const power = `Power ${Sh.power.draw}/${Sh.power.supply} · fuel ${Math.ceil(Sh.fuel)}h · ${Sh.count()} pieces`;
    if (T.piece) {
      const p = T.piece, u = Sh.upgradeCost(p);
      this.shv.showGhost(null);
      if (I.pressed('reload')) this.doAct({ a: 'improve', sid: p.id });
      if (I.pressed('melee')) this.doAct({ a: 'demolish', sid: p.id });
      buildPanel(this.buildEl, I, {
        title: `${p.def.hp.length > 1 ? TIER_NAMES[p.tier] + ' ' : ''}${p.def.name} — ${Math.round(p.hp)}/${p.maxHp}`,
        line: u ? `${u.kind === 'repair' ? 'Repair' : 'Upgrade to ' + TIER_NAMES[p.tier + 1]}: ${fmt(u.need)}` : 'Fully upgraded',
        why: u && !Sh.have(u.need) ? 'Not enough materials' : '', power,
      });
      return;
    }
    const why = Sh.canPlace(B.type, T.x, T.z);
    this.shv.showGhost(T.x, T.z, B.type, !why);
    if (I.pressed('fire') && !why) this.doAct({ a: 'place', type: B.type, x: T.x, z: T.z, rot: B.rot });
    const P = this.P;
    const have = Object.keys(D.cost[0]).map(k => `${k} ${(P.inv[k] || 0) + (Sh.stash[k] || 0)}`).join(' · ');
    buildPanel(this.buildEl, I, { title: `${D.name}`, line: `Costs ${fmt(D.cost[0])} — you have ${have}`, why: why || '', power });
  }

  openPause(lost) {
    const a = this.app;
    this.hud.objectives(false);
    const items = [
      { label: 'Resume', act: () => this.menus.clear() },
      { label: 'Settings', act: () => this.menus.push(settingsScreen(a, this.menus)) },
      { label: 'Controls', act: () => this.menus.push(controlsScreen(a, this.menus)) },
      { label: 'Restart', sub: 'Back to round 1', act: async () => { await this.saveStats(this.game.mode.round); a.setState(new PlayState(a, { standard: this.opts.standard, career: this.career })); } },
      { label: 'Quit to Party Station', act: async () => { if (this.sv) await this.saveWorld(); else this.saveStats(this.game.mode.round); a.quit(); } },
    ];
    if (this.coop) {
      items.splice(3, 1);
      items.at(-1).label = this.isClient ? 'Leave (ends the game for everyone)' : 'Quit to Party Station (ends it for everyone)';
    }
    if (this.sv && !this.isClient) {
      // Survival: no restart; save and leave instead.
      items.splice(3, 1, { label: 'Save', sub: `Slot ${this.slot}`, act: async () => { await this.saveWorld(); this.hud.showNote('Saved', 1.5); this.menus.clear(); } });
    }
    const menu = new Menu(items, { onBack: () => this.menus.clear() });
    this.menus.push({
      handle: (input, sfx) => menu.handle(input, sfx),
      el: () => [
        h('div', { style: 'position:absolute;left:7vw;top:9vh;font-size:2.4em;font-weight:900;letter-spacing:.1em' }, lost ? 'Controller lost' : 'Paused'),
        lost ? h('div', { style: 'position:absolute;left:7vw;top:20vh;font-size:1.1em;opacity:.85' },
          'Reconnect it, or press a button on any controller to take over.') : null,
        menu.el(),
        hints(a.input, [[0, 'Select'], [1, 'Resume']]),
      ],
    });
  }

  endScreen(won) {
    const a = this.app, P = this.P, g = this.game;
    const survived = won ? g.mode.round : Math.max(0, g.mode.round - 1);
    const menu = new Menu(this.isClient ? [
      { label: 'Wait for the host', sub: 'They choose what happens next', act: () => {} },
      { label: 'Quit to Party Station', act: () => a.quit() },
    ] : [
      { label: 'Play again', act: () => a.setState(new PlayState(a, { standard: this.opts.standard, career: this.career })) },
      { label: 'Quit to Party Station', act: () => a.quit() },
    ], { onBack: () => a.quit() });
    this.menus.push({
      handle: (input, sfx) => menu.handle(input, sfx),
      el: () => [
        h('div', { style: 'position:absolute;left:7vw;top:6vh' },
          h('div', { class: 'nn-title', style: 'font-size:clamp(36px,5vw,96px)' }, won ? 'Dawn breaks' : 'You died'),
          h('div', { style: 'font-size:1.3em;margin-top:.6em' }, `You survived ${survived} round${survived === 1 ? '' : 's'}`),
          h('div', { style: 'opacity:.8;margin-top:.3em' }, `${P.kills} kills · ${P.heads} headshots · ${P.points.toLocaleString()} points · +${P.xp.toLocaleString()} XP`),
          this.best != null ? h('div', { style: 'opacity:.8;margin-top:.3em;color:#ffe08a' },
            survived > this.best ? '★ New best!' : `Best: ${this.best} rounds`) : null),
        menu.el(),
        hints(a.input, [[0, 'Select']]),
      ],
    });
  }

  // Survival: the whole world into its slot, and the XP earned since the
  // last save into the career.
  async saveWorld() {
    if (!this.sv || this.isClient) return; // the host's screen owns the save
    const P = this.P;
    const data = this.game.mode.serialize();
    await saveProfile(`${this.kind}-${this.slot}`, data);
    const gained = P.xp - (this._banked || 0);
    if (gained > 0) {
      this._banked = P.xp;
      const c = (await loadProfile('career')) || { xp: 0 };
      c.xp = (c.xp || 0) + gained;
      c.kills = (c.kills || 0) + P.kills - (this._bankedKills || 0);
      this._bankedKills = P.kills;
      this.career = c;
      await saveProfile('career', c);
    }
  }

  // Career: XP, best round, totals — one profile, updated once per match.
  async saveStats(round, won = false) {
    if (this.opts.autopilot || this._saved || this.sv) return;
    this._saved = true;
    const survived = Math.max(0, round - 1);
    const c = (await loadProfile('career')) || { xp: 0, bestRound: 0, games: 0, kills: 0, wins: 0 };
    this.best = c.bestRound || 0;
    c.xp = (c.xp || 0) + this.P.xp;
    c.bestRound = Math.max(c.bestRound || 0, survived);
    c.games = (c.games || 0) + 1;
    c.kills = (c.kills || 0) + this.P.kills;
    if (won) c.wins = (c.wins || 0) + 1;
    this.career = c;
    await saveProfile('career', c);
  }

  finishBench() {
    this.benchDone = true;
    this.app.finishBench(this.game.zombies.alive);
  }

  exit() {
    const a = this.app;
    this.menus.closed = true;
    audio.ambience(false);
    for (const m of this.signs) { a.view.scene.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
    for (const { m } of this.doorSigns) { a.view.scene.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
    for (const o of [this.fx.parts, this.fx.tracers, this.props.mesh]) { a.view.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    a.view.setViewmodel(null);
    a.view.crewPlayers = null;
    this._vmGroup?.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this.hudLayer.remove();
    a.uiLayer.replaceChildren();
    this.shv?.dispose();
    if (this.sv) {
      // Back to the diner for the title screen.
      a.view.setFlashlight(false);
      a.view.setDaylight(0);
      a.view.setWorld(a.world, DINER, a.pool);
    }
    a.pool.clear();
    a.world.reset();
  }
}
