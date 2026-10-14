// Hand-built maps. Legend (see world.js): . floor  , ground  # wall
// W boarded window  1-9 buyable door group  T counter/table  t tree
// c wrecked car  f fence  X map edge  P player start  S zombie spawn
// M machine (perk / mystery crate / forge — which one is in `machines`).
// Wall-buys sit on a wall cell and are used from the floor beside it
// (`face` points at that floor). A wall-buy sells a gun, a melee weapon
// or equipment.
export const DINER = {
  name: 'Route 9 Diner',
  rows: [
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,S,,,,,,,,,,,,,,,,,,,,t,,,,,,,,,,,,,S,,,,,,,,,,,S,,,,,,X',
    'X,,t,,,,,,,,S,,,,,,,,,,,,,,,,,S,,,,,,,,,,,,,t,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,t,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,####W########W#########W#########W#####W###,,,,,X',
    'X,t,,,,,,,,#M.................#......M#.............M#,,,,,X',
    'X,,,,,,,,,,#..................#.......#.TTTT.........#,,,,,X',
    'X,,,,,,,,,,#....TTTTTTTTTT....#.TTTT..#..............#,,c,,X',
    'X,,,,,,,c,,#..................#.TTTT..#.......M......#,,c,,X',
    'X,,,,,,,c,,#..................#.......#..............#,,,,,X',
    'X,,,,,,,,,,W..................1.......#..............W,,,,,X',
    'X,,,,,,,,,,#..................1.......#..............#,,,,,X',
    'X,,,t,,,,,,#........P.........#.......#............T.#,,,S,X',
    'X,,,,,,,,,,#..................#.......2............T.#,,,,,X',
    'X,,,,,,,,,,#..................#.TT....2............T.#,,,,,X',
    'X,S,,,,,,,,#.TT...TT.......TT.#.......#..M.........T.#,,,,,X',
    'X,,,,,,,,,,#.................M#......M#.............M#,,,,,X',
    'X,,,,,,,,,,####W###W####W#########W############W######,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,t,,X',
    'X,,,,,t,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,cc,,,,,,cc,,,,,,,,,,,,,,,,ffffff,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,cc,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'X,,,S,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,t,,,,,,,,,,,,,S,,,,,,t,X',
    'X,,,,,,,,,t,,,,,,,,,,,S,,,,,,,,,,,,,,,,,S,,,,,,,,,,,,,,,,,,X',
    'X,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,X',
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  ],
  doors: { 1: { cost: 750, name: 'Kitchen' }, 2: { cost: 1250, name: 'Garage' } },
  machines: [
    { x: 12, y: 10, kind: 'perk', perk: 'secondwind' },
    { x: 29, y: 21, kind: 'perk', perk: 'quickhands' },
    { x: 37, y: 10, kind: 'perk', perk: 'ironhide' },
    { x: 37, y: 21, kind: 'perk', perk: 'stamina' },
    { x: 52, y: 10, kind: 'perk', perk: 'doubletap' },
    { x: 52, y: 21, kind: 'perk', perk: 'steadyaim' },
    { x: 46, y: 13, kind: 'crate' },
    { x: 41, y: 20, kind: 'forge' },
  ],
  wallbuys: [
    { x: 11, y: 12, face: [1, 0], weapon: 'smg' },
    { x: 11, y: 19, face: [1, 0], melee: 'machete' },
    { x: 36, y: 22, face: [0, -1], weapon: 'shotgun' },
    { x: 33, y: 9, face: [0, 1], equip: 'claymore' },
    { x: 38, y: 12, face: [1, 0], weapon: 'ar' },
    { x: 48, y: 9, face: [0, 1], equip: 'noisemaker' },
    { x: 53, y: 12, face: [-1, 0], equip: 'molotov' },
    { x: 44, y: 22, face: [0, -1], equip: 'stun' },
  ],
  // Electric trap across the kitchen doorway; the switch is on the kitchen
  // side of the wall and only works once that door is open.
  traps: [{ id: 'zap', cells: [[29, 15], [29, 16], [30, 15], [30, 16], [31, 15], [31, 16]], lever: { x: 30, y: 14, face: [1, 0] }, door: 1, cost: 1000, dur: 20, cooldown: 45 }],
  // Floor styling and baked lights.
  kitchen: [31, 10, 37, 21],
  garage: [39, 10, 52, 21],
  lot: [10, 25, 44, 31],
  lamps: [[15, 14], [21, 14], [27, 14], [15, 19], [21, 19], [27, 19], [34.5, 12], [34.5, 19], [43, 13], [49, 13], [43, 19], [49, 19], [19, 27], [56, 20]],
};
