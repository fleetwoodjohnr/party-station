// Thrown and placed equipment, projectiles, explosions and lingering
// areas (fire, acid, stun). Everything here is plain data advanced by
// step(); the renderer draws `projectiles` and `areas` as instanced meshes.

export const EQUIP = {
  frag: { slot: 'lethal', name: 'Frag grenade', max: 4, fuse: 2.0, radius: 4.5, dmg: 420 },
  molotov: { slot: 'lethal', name: 'Molotov', max: 3, radius: 2.8, dur: 6, dps: 160, cost: 750 },
  claymore: { slot: 'lethal', name: 'Claymore', max: 2, radius: 3.5, dmg: 650, trigger: 2.3, cost: 1000 },
  noisemaker: { slot: 'tactical', name: 'Noisemaker', max: 2, fuse: 6, radius: 3.5, dmg: 500, cost: 750 },
  stun: { slot: 'tactical', name: 'Stun grenade', max: 3, fuse: 1.4, radius: 6, dur: 4, cost: 750 },
};

const G = 9.8;

export class Equipment {
  constructor(game) {
    this.game = game;
    this.projectiles = [];   // {kind, x,y,z, vx,vy,vz, t, owner, fuse, rest}
    this.areas = [];         // {kind, x,z, r, t, dur, dps, owner}
    this.claymores = [];     // {x,z,yaw,owner}
    this.decoys = [];        // {x,z,t} — live noisemakers zombies chase
  }

  // Throw from the player's eye along their view.
  throwFrom(P, kind) {
    const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw), cp = Math.cos(P.pitch), sp = Math.sin(P.pitch);
    const [ex, ey, ez] = P.eyePos();
    if (kind === 'claymore') {
      if (this.claymores.filter(c => c.owner === P.seat).length >= 4) return false;
      const x = P.x - sy * 0.9, z = P.z - cy * 0.9;
      if (!this.game.world.open(Math.floor(x), Math.floor(z))) return false;
      this.claymores.push({ x, z, yaw: P.yaw, owner: P.seat, arm: 0.6 });
      this.game.ev({ e: 'place', kind, p: P.seat });
      return true;
    }
    const v = 13;
    this.projectiles.push({
      kind, owner: P.seat, x: ex - sy * 0.4, y: ey - 0.1, z: ez - cy * 0.4,
      vx: -sy * cp * v + P.vx, vy: sp * v + 3.2, vz: -cy * cp * v + P.vz,
      t: 0, fuse: EQUIP[kind]?.fuse ?? 99, rest: false,
    });
    this.game.ev({ e: 'throw', kind, p: P.seat });
    return true;
  }

  // Launcher round / spitter acid: fired along a direction at speed.
  launch(kind, owner, x, y, z, dx, dy, dz, speed, extra = {}) {
    this.projectiles.push({ kind, owner, x, y, z, vx: dx * speed, vy: dy * speed + (extra.lob || 0), vz: dz * speed, t: 0, fuse: 8, rest: false, ...extra });
  }

  step(dt) {
    const g = this.game, W = g.world, Z = g.zombies;
    for (let k = this.projectiles.length - 1; k >= 0; k--) {
      const p = this.projectiles[k];
      p.t += dt;
      if (!p.rest) {
        p.vy -= G * dt * (p.kind === 'acid' ? 0.6 : 1);
        const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
        let hit = false;
        // Impact-fused rounds also detonate on a zombie in the path.
        if (p.kind === 'shell' || p.kind === 'acid') {
          const len = Math.hypot(nx - p.x, ny - p.y, nz - p.z) || 1e-6;
          if (p.kind === 'shell') {
            const zh = Z.hitTest(p.x, p.y, p.z, (nx - p.x) / len, (ny - p.y) / len, (nz - p.z) / len, len);
            if (zh) hit = true;
          } else {
            for (const P of g.players) {
              if (!P.down && Math.hypot(P.x - nx, P.z - nz) < 0.5 && ny < P.y + 1.9 && ny > P.y) { hit = true; break; }
            }
          }
        }
        if (!hit && W.solidAt(nx, ny, nz)) {
          if (p.kind === 'shell' || p.kind === 'molotov' || p.kind === 'acid') hit = true;
          else {
            // Bounce: flip whichever axes ran into something.
            if (W.solidAt(nx, p.y, p.z)) p.vx *= -0.35; else p.x = nx;
            if (W.solidAt(p.x, p.y, nz)) p.vz *= -0.35; else p.z = nz;
            if (W.solidAt(p.x, ny, p.z)) { p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6; } else p.y = ny;
            if (p.y < 0.08 && Math.abs(p.vy) < 1) { p.y = 0.06; p.rest = true; }
            if (Math.abs(p.vx) + Math.abs(p.vz) + Math.abs(p.vy) > 2) g.ev({ e: 'bounce', x: p.x, z: p.z });
          }
        } else if (!hit) { p.x = nx; p.y = ny; p.z = nz; }
        if (hit) { this._detonate(p); this.projectiles.splice(k, 1); continue; }
      }
      if (p.kind === 'noisemaker' && p.rest && !p.decoy) {
        p.decoy = { x: p.x, z: p.z, y: 0, down: false, decoy: true };
        this.decoys.push(p.decoy);
      }
      if (p.t >= p.fuse) { this._detonate(p); this.projectiles.splice(k, 1); }
    }
    // Claymores: a zombie stepping into the front cone sets one off.
    for (let k = this.claymores.length - 1; k >= 0; k--) {
      const c = this.claymores[k];
      c.arm -= dt;
      if (c.arm > 0) continue;
      const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
      for (let i = 0; i < Z.n; i++) {
        if (!Z.isLive(i)) continue;
        const dx = Z.x[i] - c.x, dz = Z.z[i] - c.z, d = Math.hypot(dx, dz);
        if (d < EQUIP.claymore.trigger && (dx * fx + dz * fz) / (d || 1) > 0.2) {
          g.explode(c.x + fx * 1.2, 0.5, c.z + fz * 1.2, EQUIP.claymore.radius, EQUIP.claymore.dmg, c.owner, 'claymore');
          this.claymores.splice(k, 1);
          break;
        }
      }
    }
    // Areas burn / corrode / daze whatever stands in them.
    for (let k = this.areas.length - 1; k >= 0; k--) {
      const a = this.areas[k];
      a.t += dt;
      if (a.t >= a.dur) { this.areas.splice(k, 1); continue; }
      for (let i = 0; i < Z.n; i++) {
        if (!Z.isLive(i)) continue;
        const d = Math.hypot(Z.x[i] - a.x, Z.z[i] - a.z);
        if (d > a.r) continue;
        if (a.kind === 'fire') { Z.ignite(i, a.dps * g.mode.scale(), 1.5, a.owner); }
        if (a.kind === 'stun') Z.slowT[i] = Math.max(Z.slowT[i], 0.3);
      }
      if (a.kind === 'fire' || a.kind === 'acid') {
        for (const P of g.players) {
          if (P.down) continue;
          if (Math.hypot(P.x - a.x, P.z - a.z) < a.r * 0.85 && P.y < 0.5) {
            P._areaHurt = (P._areaHurt || 0) + dt;
            if (P._areaHurt > 0.5) { P._areaHurt = 0; P.hurt(a.kind === 'acid' ? 9 : 6, g); g.ev({ e: 'hurt', p: P.seat, dmg: 6, area: a.kind }); }
          }
        }
      }
    }
  }

  _detonate(p) {
    const g = this.game;
    switch (p.kind) {
      case 'frag': g.explode(p.x, p.y + 0.2, p.z, EQUIP.frag.radius, EQUIP.frag.dmg, p.owner, 'frag'); break;
      case 'shell': g.explode(p.x, p.y, p.z, p.radius || 4.2, p.dmg || 650, p.owner, 'shell'); break;
      case 'molotov':
        this.areas.push({ kind: 'fire', x: p.x, z: p.z, r: EQUIP.molotov.radius, t: 0, dur: EQUIP.molotov.dur, dps: EQUIP.molotov.dps, owner: p.owner });
        g.ev({ e: 'fire', x: p.x, z: p.z, r: EQUIP.molotov.radius });
        break;
      case 'noisemaker':
        this.decoys = this.decoys.filter(d => d !== p.decoy);
        g.explode(p.x, 0.3, p.z, EQUIP.noisemaker.radius, EQUIP.noisemaker.dmg, p.owner, 'noisemaker');
        break;
      case 'stun': {
        this.areas.push({ kind: 'stun', x: p.x, z: p.z, r: EQUIP.stun.radius, t: 0, dur: 0.15, owner: p.owner });
        const Z = g.zombies;
        for (let i = 0; i < Z.n; i++) {
          if (Z.isLive(i) && Math.hypot(Z.x[i] - p.x, Z.z[i] - p.z) < EQUIP.stun.radius) Z.slowT[i] = EQUIP.stun.dur;
        }
        g.ev({ e: 'stun', x: p.x, y: p.y, z: p.z });
        break;
      }
      case 'acid':
        this.areas.push({ kind: 'acid', x: p.x, z: p.z, r: 1.6, t: 0, dur: 3, dps: 0, owner: -1 });
        for (const P of g.players) {
          if (!P.down && Math.hypot(P.x - p.x, P.z - p.z) < 1.1) { P.hurt(p.dmg || 18, g); g.ev({ e: 'hurt', p: P.seat, dmg: p.dmg || 18, area: 'acid' }); }
        }
        g.ev({ e: 'splat', x: p.x, y: p.y, z: p.z });
        break;
    }
  }

  // Dropped on a fresh match/round restart.
  clear() { this.projectiles.length = 0; this.areas.length = 0; this.claymores.length = 0; this.decoys.length = 0; }
}

