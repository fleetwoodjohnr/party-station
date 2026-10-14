// Dead of Night — first-person zombie survival on the big screen.
// A relay game: the whole simulation and the three.js renderer live in the
// TV browser (public/js/night/); the server only seats players, relays
// co-op traffic, and stores profiles (server/saves.js saveProfile).
export const meta = {
  id: 'deadofnight', name: 'Dead of Night', tagline: 'Hold the line till sunrise',
  description: 'First-person zombie survival. Fight waves at the Route 9 Diner, '
    + 'scavenge the county, and fortify a shelter that has to last the night.',
  icon: '🧟', category: 'action', mode: 'relay',
  minPlayers: 1, maxPlayers: 4,
  bots: false,       // AI seats make no sense in a shooter — the lobby hides "add bot"
  needsPad: true,    // played with a controller; phones spectate
};
