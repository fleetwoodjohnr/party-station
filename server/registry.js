// Central game registry. To add a game: create a module under server/games/,
// matching client modules under public/js/games/, and import it here.
import * as hearts from './games/cards/hearts.js';
import * as crazy8s from './games/cards/crazy8s.js';
import * as holdem from './games/cards/holdem.js';
import * as blackjack from './games/cards/blackjack.js';
import * as gofish from './games/cards/gofish.js';
import * as spite from './games/cards/spite.js';
import * as deadofnight from './games/action/deadofnight.js';

export const MODULES = [
  hearts, crazy8s, holdem, blackjack, gofish, spite,
  deadofnight,
];

const map = new Map(MODULES.map(m => [m.meta.id, m]));

export function byId(id) { return map.get(id); }

// Lightweight metadata sent to clients for the hub grid + lobby option forms.
export function catalog() {
  return MODULES.map(m => ({ ...m.meta }));
}
