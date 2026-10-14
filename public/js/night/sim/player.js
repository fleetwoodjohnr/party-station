// A survivor: first-person movement, weapons, melee, equipment, health,
// and the controller aim assist. One Input object per tick drives it
// (built from a gamepad by input.js, or by sim/bot.js). Pure JS — no DOM.
import { MELEE, WEAPONS, newWeapon, falloff, spreadOf, coneDir, statsOf } from './weapons.js';
import { ZTYPES } from './zombies.js';

export const STAND_EYE = 1.62, CROUCH_EYE = 1.05;
const WALK = 4.0, SPRINT = 6.1, CROUCH = 2.0, ADS_MOVE = 2.5, ACCEL = 12;
const GRAVITY = 14, JUMP_V = 4.7, RADIUS = 0.3;
export const MAX_HP = 100, REGEN_DELAY = 3, REGEN_RATE = 55;
// Aim-assist strengths: [slowdown, ADS snap, rotational follow].
const ASSIST = { off: [0, 0, 0], low: [0.25, 0.35, 0.15], standard: [0.45, 0.6, 0.3] };

export function emptyInput() {
  return { mx: 0, my: 0, lookX: 0, lookY: 0, fire: false, firePressed: false, ads: false, jump: false,
    crouch: false, sprint: false, x: false, xPressed: false, swap: false, melee: false,
    lethal: false, tactical: false, heal: false, assist: 'standard' };
}

export class Player {
  constructor(seat, name, x, z, yaw = 0) {
    this.seat = seat; this.name = name;
    this.x = x; this.z = z; this.y = 0; this.vy = 0; this.vx = 0; this.vz = 0;
    this.yaw = yaw; this.pitch = 0;
    this.eye = STAND_EYE; this.crouched = false; this.sprinting = false; this.grounded = true;
    this.hp = MAX_HP; this.maxHp = MAX_HP; this.lastHurt = -99; this.down = false; this.dead = false;
    this.weapons = [newWeapon('pistol')]; this.cur = 0;
    this.meleeId = 'knife';
    this.lethal = { id: 'frag', n: 2 };
    this.tactical = null;
    this.perks = new Set();
    this.act = 'raise'; this.actT = 0; this.fireCd = 0; this.fireBuffer = 0; this.burstLeft = 0;
    this.ads = 0; this.bloom = 0; this.recoilPending = 0; this.kick = 0;
    this.points = 0; this.kills = 0; this.heads = 0; this.shots = 0; this.hits = 0; this.xp = 0;
    this.prompt = null;       // what X would do right now (set by the mode)
    this.speedFrac = 0;       // 0..1 of sprint speed, for bob/spread
    this.stepPhase = 0;
    this.meleeHit = false;
    this.god = false;         // bench autopilot only
    this.infiniteAmmo = false;
    this.downT = 0;
    this.ammo = null;   // survival modes: { light, rifle, shells, explosive }
    this.inv = null;    // survival modes: item -> count
  }

  get weapon() { return this.weapons[this.cur]; }
  // Spare rounds for a gun: its own reserve in Classic, the shared pool of
  // that ammo type in the survival modes (this.ammo).
  reserve(w = this.weapon) { return this.infiniteAmmo ? 1e9 : this.ammo ? (this.ammo[WEAPONS[w.id].ammo] || 0) : w.reserve; }
  spend(w, n) {
    if (this.infiniteAmmo) return;
    if (this.ammo) this.ammo[WEAPONS[w.id].ammo] -= n; else w.reserve -= n;
  }
  // Effective stats of the gun in hand (rarity, attachments, perks folded in).
  get W() { return statsOf(this.weapon, this.perks); }
  get melee() { return MELEE[this.meleeId]; }

  eyePos() { return [this.x, this.y + this.eye, this.z]; }

  hurt(dmg, game) {
    if (this.down || this.god) return;
    this.hp -= dmg;
    this.lastHurt = game.time;
    if (this.hp <= 0) {
      this.hp = 0;
      this.down = true;
      this.downT = 0;
      this.act = 'idle';
      game.ev({ e: 'down', p: this.seat });
    }
  }

  revive(game, hpFrac = 0.5) {
    this.down = false;
    this.hp = this.maxHp * hpFrac;
    this.lastHurt = game.time;
    this.act = 'raise'; this.actT = 0;
    game.ev({ e: 'revived', p: this.seat });
  }

  addPerk(id) {
    this.perks.add(id);
    if (id === 'ironhide') { this.maxHp = 250; this.hp = 250; }
  }

  give(id, game, tier = 0, att = {}) {
    const have = this.weapons.findIndex(w => w.id === id);
    if (have >= 0 && !tier) { this.cur = have; }
    else if (have >= 0) { this.weapons[have] = newWeapon(id, true, tier, att); this.cur = have; }
    else if (this.weapons.length < 2) { this.weapons.push(newWeapon(id, true, tier, att)); this.cur = this.weapons.length - 1; }
    else { this.weapons[this.cur] = newWeapon(id, true, tier, att); }
    this.act = 'raise'; this.actT = 0;
    game?.ev({ e: 'weapon', p: this.seat, w: id });
  }

  step(dt, inp, game) {
    if (this.down) { this.ads = Math.max(0, this.ads - dt * 6); this.downT += dt; return; }
    const W = this.W, wpn = this.weapon;
    this._look(dt, inp, game);
    this._move(dt, inp, game);

    // Health regenerates after a few seconds out of harm's way.
    if (game.time - this.lastHurt > REGEN_DELAY && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + REGEN_RATE * (this.maxHp / MAX_HP) * dt);
    }

    // ADS blend, bloom and recoil recovery.
    const wantAds = inp.ads && this.act !== 'melee' && this.act !== 'swap';
    this.ads = Math.max(0, Math.min(1, this.ads + (wantAds ? 1 : -1) * dt / W.adsTime));
    this.bloom = Math.max(0, this.bloom - dt * 0.12);
    const rec = this.recoilPending * (1 - Math.exp(-W.recoil.recover * dt));
    this.pitch -= rec; this.recoilPending -= rec;
    this.kick = Math.max(0, this.kick - dt * 6);
    this.fireCd -= dt;
    this.fireBuffer = inp.firePressed ? 0.15 : this.fireBuffer - dt;

    // X: interact when something is in reach, otherwise reload.
    this.prompt = game.mode.interactTarget?.(this) || null;
    if (this.prompt && (inp.x || inp.xPressed)) game.mode.interact(this, this.prompt, dt, inp.xPressed);
    else if (inp.xPressed) this._startReload(game);

    // D-pad down: medkit (survival modes keep an inventory).
    if (inp.heal && this.inv) game.mode.useItem?.(this, 'meds');
    // Equipment: RB lethal, LB tactical.
    if (inp.lethal && this.lethal?.n > 0 && this.act !== 'melee') {
      if (game.equipment.throwFrom(this, this.lethal.id)) this.lethal.n--;
    }
    if (inp.tactical && this.tactical?.n > 0 && this.act !== 'melee') {
      if (game.equipment.throwFrom(this, this.tactical.id)) this.tactical.n--;
    }

    // Action timers.
    this.actT += dt;
    const swapT = this.perks.has('stamina') ? 0.25 : 0.4;
    switch (this.act) {
      case 'raise': if (this.actT >= 0.35) this.act = 'idle'; break;
      case 'swap': if (this.actT >= swapT) { this.act = 'idle'; } break;
      case 'reload':
        if (W.shell) {
          // Shell by shell; firing interrupts once there's a round in.
          if (this.actT >= W.shellStart + W.shell) {
            this.actT = W.shellStart;
            if (wpn.mag < W.mag && this.reserve(wpn) > 0) {
              wpn.mag++; this.spend(wpn, 1);
              game.ev({ e: 'shell', p: this.seat });
            }
            if (wpn.mag >= W.mag || this.reserve(wpn) <= 0) this.act = 'idle';
          }
          if ((inp.fire || this.fireBuffer > 0) && wpn.mag > 0 && this.actT > 0.1) this.act = 'idle';
        } else if (this.actT >= (this._emptyReload ? W.emptyReload : W.reload)) {
          const take = Math.min(W.mag - wpn.mag, this.reserve(wpn));
          wpn.mag += take;
          this.spend(wpn, take);
          this.act = 'idle';
          game.ev({ e: 'reloaded', p: this.seat });
        }
        break;
      case 'melee':
        if (!this.meleeHit && this.actT >= this.melee.hitAt) { this.meleeHit = true; this._knife(game); }
        if (this.actT >= this.melee.time) this.act = 'idle';
        break;
    }

    if (inp.swap && this.weapons.length > 1 && this.act !== 'melee') {
      this.cur = (this.cur + 1) % this.weapons.length;
      this.act = 'swap'; this.actT = 0; this.ads = Math.min(this.ads, 0.3); this.burstLeft = 0;
      game.ev({ e: 'swap', p: this.seat, w: this.weapon.id });
      return;
    }
    if (inp.melee && (this.act === 'idle' || this.act === 'reload')) {
      this.act = 'melee'; this.actT = 0; this.meleeHit = false; this.sprinting = false; this.burstLeft = 0;
      game.ev({ e: 'knife', p: this.seat, w: this.meleeId });
      return;
    }

    // Burst rifles: one pull fires a short burst.
    if (W.burst && this.burstLeft === 0 && this.fireBuffer > 0 && this.act === 'idle' && this.fireCd <= 0 && wpn.mag > 0) {
      this.burstLeft = W.burst; this.fireBuffer = 0;
    }
    const wantFire = W.burst ? this.burstLeft > 0 : W.auto ? inp.fire : this.fireBuffer > 0;
    if (wantFire && this.act === 'idle' && this.fireCd <= 0) {
      if (wpn.mag > 0) {
        this._shoot(game);
        if (W.burst) { this.burstLeft--; if (this.burstLeft === 0 || wpn.mag === 0) { this.burstLeft = 0; this.fireCd = W.burstGap; } }
      } else if (this.reserve(wpn) > 0) { this.burstLeft = 0; this._startReload(game); }
      else if (inp.firePressed) game.ev({ e: 'dry', p: this.seat });
      this.fireBuffer = 0;
    }
    // Auto-reload an empty magazine once the trigger is let go.
    if (wpn.mag === 0 && this.act === 'idle' && !inp.fire && this.reserve(wpn) > 0) this._startReload(game);
  }

  _startReload(game) {
    const W = this.W, wpn = this.weapon;
    if (this.act !== 'idle' || wpn.mag >= W.mag || this.reserve(wpn) <= 0) return;
    this.act = 'reload'; this.actT = 0; this._emptyReload = wpn.mag === 0;
    this.sprinting = false; this.burstLeft = 0;
    game.ev({ e: 'reload', p: this.seat, w: wpn.id });
  }

  _look(dt, inp, game) {
    const [slow, snap, follow] = ASSIST[inp.assist] || ASSIST.off;
    let lx = inp.lookX, ly = inp.lookY;
    if (slow || snap || follow) {
      const t = this._assistTarget(game);
      if (t) {
        // Slow the stick while the reticle is on (or just off) a zombie.
        if (t.ang < 0.07) { lx *= 1 - slow; ly *= 1 - slow; }
        // Pulling the trigger to aim swings onto a nearby target.
        if (inp.ads && this.ads < 0.35 && t.ang < 0.13) {
          this.yaw += t.dyaw * Math.min(1, snap * dt * 9);
          this.pitch += t.dpitch * Math.min(1, snap * dt * 9);
        }
        // Strafing: track the target a little so it doesn't slide off.
        if ((Math.abs(inp.mx) > 0.2 || Math.abs(inp.my) > 0.2) && t.ang < 0.1) {
          this.yaw += t.dyaw * Math.min(1, follow * dt * 4);
        }
      }
    }
    this.yaw -= lx;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - ly));
  }

  // Nearest zombie (by angle off the reticle) that's actually visible.
  _assistTarget(game) {
    const Z = game.zombies;
    const [ex, ey, ez] = this.eyePos();
    let best = null;
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) continue;
      const T = ZTYPES[Z.type[i]];
      const tx = Z.x[i] - ex, ty = Z.y[i] + T.headY * T.size * 0.8 - ey, tz = Z.z[i] - ez;
      const d = Math.hypot(tx, ty, tz);
      if (d > 35 || d < 0.5) continue;
      const tyaw = Math.atan2(-tx, -tz), tpitch = Math.asin(ty / d);
      let dyaw = tyaw - this.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const dpitch = tpitch - this.pitch;
      const ang = Math.hypot(dyaw, dpitch) * Math.min(1, d / 3); // close targets are big anyway
      if (ang > 0.15 || (best && ang >= best.ang)) continue;
      if (!game.world.sees(ex, ey, ez, Z.x[i], Z.y[i] + T.headY * T.size * 0.8, Z.z[i])) continue;
      best = { i, ang, dyaw, dpitch };
    }
    return best;
  }

  _move(dt, inp, game) {
    const world = game.world;
    if (inp.crouch) { this.crouched = !this.crouched; if (this.crouched) this.sprinting = false; }
    const mag = Math.hypot(inp.mx, inp.my);
    if (inp.sprint && mag > 0.3) { this.sprinting = true; this.crouched = false; }
    if (mag < 0.25 || inp.my > 0.1 || inp.fire || this.ads > 0.2 || this.act === 'reload') this.sprinting = false;
    let speed = this.sprinting ? SPRINT : this.crouched ? CROUCH : WALK;
    if (this.ads > 0.3) speed = Math.min(speed, ADS_MOVE);
    speed *= this.W.mobility;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // forward = (-sin, -cos); right = (cos, -sin); stick up = -y.
    const wx = (cy * inp.mx + -sy * -inp.my) * speed;
    const wz = (-sy * inp.mx + -cy * -inp.my) * speed;
    const k = Math.min(1, ACCEL * dt * (this.grounded ? 1 : 0.3));
    this.vx += (wx - this.vx) * k;
    this.vz += (wz - this.vz) * k;
    const p = this._p || (this._p = { x: 0, z: 0 });
    p.x = this.x + this.vx * dt; p.z = this.z + this.vz * dt;
    world.collide(p, RADIUS, false);
    this.x = p.x; this.z = p.z;
    // Bodies: shove out of zombies so you can't walk through a horde.
    const Z = game.zombies;
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) continue;
      const dx = this.x - Z.x[i], dz = this.z - Z.z[i];
      const d2 = dx * dx + dz * dz, min = RADIUS + ZTYPES[Z.type[i]].r * ZTYPES[Z.type[i]].size;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = this.x + dx / d * (min - d) * 0.7; p.z = this.z + dz / d * (min - d) * 0.7;
        world.collide(p, RADIUS, false);
        this.x = p.x; this.z = p.z;
      }
    }
    const hs = Math.hypot(this.vx, this.vz);
    this.speedFrac = Math.min(1, hs / SPRINT);
    if (this.grounded) this.stepPhase += hs * dt * 1.9;
    // Jumping and gravity (all floors are at y = 0).
    if (inp.jump && this.grounded) { this.vy = JUMP_V; this.grounded = false; this.crouched = false; game.ev({ e: 'jump', p: this.seat }); }
    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.grounded = true; game.ev({ e: 'land', p: this.seat }); }
    }
    const eyeT = this.crouched ? CROUCH_EYE : STAND_EYE;
    this.eye += (eyeT - this.eye) * Math.min(1, dt * 10);
  }

  _shoot(game) {
    const W = this.W, wpn = this.weapon;
    if (!this.infiniteAmmo) wpn.mag--;
    this.fireCd = 60 / W.rpm;
    this.sprinting = false;
    this.shots++;
    const moving = Math.min(1, Math.hypot(this.vx, this.vz) / WALK);
    const spread = spreadOf(W, this.ads, moving, this.bloom) * (this.crouched ? 0.8 : 1);
    const [ex, ey, ez] = this.eyePos();
    const dir = this._dir || (this._dir = [0, 0, 0]);
    let end = null;
    if (W.projectile) {
      // Launcher: a live round with its own arc and blast.
      coneDir(this.yaw, this.pitch, spread, game.rng, dir);
      game.equipment.launch('shell', this.seat, ex + dir[0] * 0.6, ey - 0.1, ez + dir[2] * 0.6, dir[0], dir[1], dir[2],
        W.projectile.speed, { lob: 1.5, dmg: W.dmg, radius: W.projectile.radius });
    } else {
      const dmgBy = this._dmgBy || (this._dmgBy = new Map());
      dmgBy.clear();
      const skip = this._skip || (this._skip = new Set());
      for (let k = 0; k < W.pellets; k++) {
        coneDir(this.yaw, this.pitch, spread, game.rng, dir);
        const wall = game.world.raycast(ex, ey, ez, dir[0], dir[1], dir[2], 120);
        const maxT = wall ? wall.t : 120;
        // Penetrating rounds carry on through bodies, losing a third each.
        skip.clear();
        let falloffPen = 1;
        for (let n = 0; n <= W.pen; n++) {
          const hit = game.zombies.hitTest(ex, ey, ez, dir[0], dir[1], dir[2], maxT, skip);
          if (!hit) { if (n === 0 && wall) { game.ev({ e: 'impact', x: wall.x, y: wall.y, z: wall.z }); end = end || [wall.x, wall.y, wall.z]; } break; }
          skip.add(hit.i);
          const dmg = W.dmg * falloff(W, hit.t) * (hit.head ? W.head : 1) * falloffPen * (game.dmgMul || 1);
          const prev = dmgBy.get(hit.i);
          dmgBy.set(hit.i, { dmg: (prev?.dmg || 0) + dmg, head: prev?.head || hit.head,
            x: ex + dir[0] * hit.t, y: ey + dir[1] * hit.t, z: ez + dir[2] * hit.t });
          end = end || [ex + dir[0] * hit.t, ey + dir[1] * hit.t, ez + dir[2] * hit.t];
          falloffPen *= 0.66;
        }
      }
      for (const [i, h] of dmgBy) {
        const r = game.zombies.damage(i, game.instakill ? 1e9 : h.dmg, h.head, this.seat, 'gun', W.armorMul);
        if (W.burn && !r.kill) game.zombies.ignite(i, W.burn * game.mode.scale(), 3, this.seat);
        this.hits++;
        if (r.kill) { this.kills++; if (h.head) this.heads++; }
        game.ev({ e: 'hit', p: this.seat, z: i, head: h.head, kill: r.kill, armor: r.armor, x: h.x, y: h.y, z2: h.z, dmg: h.dmg });
      }
    }
    this.bloom = Math.min(W.spread.max, this.bloom + W.spread.bloom);
    const v = W.recoil.v * (1 - this.ads * 0.35) * (this.crouched ? 0.8 : 1);
    this.pitch += v;
    this.recoilPending += v * 0.75;
    this.yaw += (game.rng() - 0.5) * 2 * W.recoil.h;
    this.kick = 1;
    game.ev({ e: 'shot', p: this.seat, w: wpn.id, end, noise: W.noise });
  }

  _knife(game) {
    const Z = game.zombies, M = this.melee;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let best = -1, bd = Infinity;
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) continue;
      const dx = Z.x[i] - this.x, dz = Z.z[i] - this.z;
      const d = Math.hypot(dx, dz);
      if (d > M.lunge || d < 1e-3) continue;
      if ((dx * fx + dz * fz) / d < M.cone) continue;
      if (Math.abs(Z.y[i] - this.y) > 1.2) continue;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) { game.ev({ e: 'whiffKnife', p: this.seat }); return; }
    if (bd > M.reach) {
      // Lunge: close the gap, stopping just short of the body.
      const step = bd - M.reach * 0.7;
      const p = { x: this.x + fx * step, z: this.z + fz * step };
      game.world.collide(p, RADIUS, false);
      this.x = p.x; this.z = p.z;
    }
    const r = Z.damage(best, game.instakill ? 1e9 : M.dmg, false, this.seat, 'melee');
    this.hits++;
    if (r.kill) this.kills++;
    game.ev({ e: 'hit', p: this.seat, z: best, head: false, kill: r.kill, melee: true, x: Z.x[best], y: 1.2, z2: Z.z[best], dmg: M.dmg });
  }
}

