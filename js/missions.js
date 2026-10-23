// PROJECT WINGNUT campaign data: 21 missions, each a sequence of phases of enemy groups.
// ES module, data only (plus two tiny helpers at the bottom). No imports.
//
// SOURCE: enemy compositions adapted from community documentation of an arcade flight game's campaign; names and story
// are original. Counts were scaled for performance (air groups <= 8, air per phase <= 16, surface groups <= 24), non-
// priority clutter was trimmed, and civilian, neutral and untargetable units were left out.
//
// SETTING: THE GALEBREAK ISLES, a jagged chain of fjords, glaciers and sea stacks off a long alpine coast, where ocean
// gales break on the Anvil Range. Lightning strikes the Anvils so often that it fuses quartz seams into THUNDERGLASS,
// crystal that holds a charge like a bottled storm: it lights cities, feeds railguns and tips very expensive warheads.
//   Fellmark Concord   mainland power run by its thunderglass mining houses; big navy, bigger budget, precision-built
//                      everything. It has decided the islands' mountains belong to it.
//   Skerry League      island towns, fishing ports and lighthouse keepers who want their mountains back. Short on jets,
//                      so it hires mercenaries.
//   Saltjaw Corsairs   sea-stack pirates who rob both sides and sell to whoever is buying.
//   Loose Screws       the player's mercenary squadron: second-hand jets, questionable judgment. Wingnut (player),
//                      Socket (lead), Torque (heavy strike), Shim (rookie), Cotter (ex-navy); AWACS Claude on radar.
//   Chime Squadron     the Concord's clockwork elite in Orrery Works prototypes: Mainspring (commander), Pendulum (a
//                      bounty-hunting ace who always swings back), Tick and Tock (interceptor twins), Cuckoo Flight
//                      (cadets), plus Shearpin Squadron (turncoat mercenaries on Chime's payroll).
//   Story beats: the League capital Lanternport falls (M5) and is retaken (M20); League sailors steal the Concord's newest
//   battleship and rename her the Hand-Me-Down (M7, M19); the Concord answers the push on Kelderwick with thunderglass
//   warheads, the Glassfall (M15).
//
// AIRCRAFT MAKERS (type keys double as HUD labels: upper case, at most 14 characters):
//   Nordvane Aerowerk    Concord state fighter works          NV-## (N = naval)       NV-62, NV-56N; Bodkin missiles
//   Halde Windworks      the Concord's rival house            WIND-mark               SQUALL-7, FALLWIND-6, HAILSTONE-3
//   Orrery Works         Concord black-budget prototypes      Q + hour on a dial      Q07, Q09, Q11; Q12 tops the dial
//   Tidewright Yards     League boatbuilders                  SEABIRD + Roman mark    EIDER IV, SCAUP II
//   Kettle & Daughters   heavy and utility airframes          KD-### + role letter    KD-480E (radar), KD-38H (rotor)
//   Aces fly a base type with extra durability; their key is base code + callsign ('Q09 TICK', 'Q12 MAINSPRING').
//
// CONVENTIONS (as js/main.js and js/targets.js consume them):
//   AIRCRAFT_TYPES main fields = player-side figures: role, hp, max speed km/h, roll / pitch ("turn") / yaw rates. ai =
//     AI-side values { kmh: [min, cruise, max], roll, pitch, yaw }; main.js reads ai.kmh[1] as cruise speed. hp is in the
//     reference durability units, where one standard missile does about 32: 35-HP fighters take 2, 70-76-HP prototypes
//     and transports take 3, aces and bosses were converted from their listed missile counts. main.js doubles hp, which
//     with 65-damage player missiles keeps those counts. Bosses (types with bars) skip the doubling: the player has
//     two 5 s missile hardpoints, so their converted counts are halved. Every spawn also scales by the difficulty's
//     enemyHp (Easy 0.8, Normal 1, Hard 1.15, Mercenary 1.3). armed: true (default) = gun + missiles, 'gun' = gun only,
//     false = unarmed. bars = boss health bar segments (shown on the HUD boss bar).
//   GROUND_TYPES.hp is raw game damage (a player missile does 65): 1 missile for AA, SAMs, C-RAM, radars, small buildings
//     and boats, 2 for armor, bunkers and hangars, 3 for railgun turrets. Ships pool hull and weapon mounts into one hitbox
//     so capital ships stay playable. refHp = the reference durability figure, kept for information only.
//   MISSIONS: main.js shows the name, up to three briefing sentences and each phase label (upper-cased). location, setting
//     and time (local, 24 h) are flavor. groups[].optional = not needed to clear the phase.
//     groups[].difficulty = 'hard' (spawns on Hard and Mercenary) or 'mercenary' (Mercenary only); counted in the caps.
//     wingmen (optional) = which Loose Screws squadmates fly with the player: '2' = Cotter, '3' = Rivet. Absent means
//     ['2', '3'] (both); [] = solo, e.g. a one-on-one duel.
//     allies (optional) = friendly story units (js/allies.js): immortal props in a friendly tint that never fire, are never
//     fired at and never count toward clearing a phase. Each group: { name, kind: 'ground' | 'naval', phase (index of
//     the phase they join, default 0), position + distance (from the player, as for enemy groups) or near: <type> +
//     distance (next to that phase's enemy units of that type: the first clear site from `distance` m out, far side
//     first; needs after: true, i.e. placed after the phase's enemies), units: [{ type, count, escort }] }. A naval
//     group's first unit is its flagship; escort units are mortal only to leakers (groups[].target). At most 20 units
//     per entry.
//     groups[].target = 'fleet' (unarmed air types only): the group spawns `distance` m past the player from the
//     mission's allied fleet and flies at its escorts. One that gets within ~150 m of an allied hull is consumed and
//     sinks the nearest live escort (once none are left it bursts harmlessly on the flagship); it counts as resolved
//     for the phase, with no score. Needs a naval allies group joining at or before that phase.
//   ESTIMATES: speeds of the AI-only types, a few agility values, every KD-38H value, HP of refineries, containers, oil
//     tanks, extractors and the M1 crate, and all surface-unit sizes (modeled on real ship and vehicle classes); each note
//     says which. Colors come from a small shared palette so main.js's color-keyed aircraft pool can reuse airframes.

// ------------------------------------------------------------------------------------------------------------------------
// Enemy aircraft. Palette: Concord grey 0x5d6670 | Concord light 0x8a929a | Halde slate 0x56606a | Orrery black 0x353a42 |
// utility 0xb4b9bf | bomber 0x1c1d20 | kelp camo 0x56663a | Chime oxblood 0x7d1212 | mercenary gunmetal 0x2a2a2f |
// missile 0xd6d6d6 | SLEET-2 has its own (0x6b7178).
export const AIRCRAFT_TYPES = {
  // ---- line fighters ----
  'SLEET-2':     { role: 'interceptor', hp: 35, speedKmh: 2500, roll: 170, pitch: 85,  yaw: 10, color: 0x6b7178, accent: 0xc0392b, ai: { kmh: [300, 1100, 1800], roll: 200, pitch: 25, yaw: 25 }, note: "Halde Windworks' first jet, a light delta interceptor (MiG-21-class) still flown by Concord reservists and anyone who buys surplus." },
  'GUST-5':      { role: 'strike',      hp: 40, speedKmh: 2700, roll: 165, pitch: 70,  yaw: 15, color: 0x5d6670, accent: 0xd8232a, ai: { kmh: [200, 1000, 1200], roll: 200, pitch: 45, yaw: 25 }, note: 'Halde canard-delta strike jet (Viggen-class) built to fly from mountain roads. Spec sheets disagree on top speed (2,700 vs 2,500 km/h); the higher figure is used.' },
  'NV-11':       { role: 'strike',      hp: 35, speedKmh: 2500, roll: 250, pitch: 75,  yaw: 10, color: 0x5d6670, accent: 0xd8232a, ai: { kmh: [300, 1000, 1800], roll: 150, pitch: 65, yaw: 10 }, note: "Nordvane's first heavy jet, a two-seat fighter-bomber (Phantom-class): old, loud and still everywhere." },
  'NV-48':       { role: 'fighter',     hp: 35, speedKmh: 2500, roll: 210, pitch: 85,  yaw: 15, color: 0x5d6670, accent: 0xd8232a, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 40, yaw: 25 }, note: "Nordvane's light multirole fighter (F-16-class), the Concord's cheap and cheerful workhorse." },
  'NV-62':       { role: 'fighter',     hp: 35, speedKmh: 2500, roll: 170, pitch: 90,  yaw: 15, color: 0x5d6670, accent: 0xd8232a, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 50, yaw: 25 }, note: "Nordvane's heavy air-superiority fighter (F-15C-class) and the most common jet in the Concord's inventory." },
  'NV-73':       { role: 'multirole',   hp: 35, speedKmh: 3000, roll: 210, pitch: 95,  yaw: 15, color: 0x5d6670, accent: 0xd8232a, ai: { kmh: [300, 1000, 1400], roll: 250, pitch: 50, yaw: 35 }, note: "Nordvane's twin-engine multirole fighter (Super Hornet-class), at home on carriers or runways." },
  'EIDER IV':    { role: 'multirole',   hp: 35, speedKmh: 2500, roll: 200, pitch: 100, yaw: 12, color: 0x5d6670, accent: 0xd8232a, ai: { kmh: [300, 1100, 1800], roll: 200, pitch: 25, yaw: 25 }, note: 'Tidewright Yards jump jet (Harrier II-class) that launches from cliff ledges and ship decks. The League sold a batch to the Concord before the war and regrets it.' },
  'NV-56N':      { role: 'interceptor', hp: 35, speedKmh: 3500, roll: 180, pitch: 88,  yaw: 10, color: 0x8a929a, accent: 0xd8232a, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 50, yaw: 25 }, note: "Nordvane's naval swing-wing interceptor (Tomcat-class); Concord carriers launch these in pairs." },
  'FALLWIND-6':  { role: 'interceptor', hp: 35, speedKmh: 3600, roll: 100, pitch: 65,  yaw: 8,  color: 0x8a929a, accent: 0xd8232a, ai: { kmh: [300, 1100, 1800], roll: 200, pitch: 25, yaw: 25 }, note: 'Halde high-speed interceptor (MiG-31-class), named for the katabatic wind that drops off the glaciers: very fast, turns like a freight train.' },
  'FLURRY-4':    { role: 'fighter',     hp: 35, speedKmh: 2900, roll: 200, pitch: 100, yaw: 12, color: 0x56606a, accent: 0xb3262e, ai: { kmh: [300, 1100, 1800], roll: 200, pitch: 50, yaw: 25 }, note: 'Halde agile twin-tail fighter (MiG-29-class).' },
  'SQUALL-7':    { role: 'fighter',     hp: 35, speedKmh: 2500, roll: 175, pitch: 85,  yaw: 15, color: 0x56606a, accent: 0xb3262e, ai: { kmh: [300, 1000, 1800], roll: 250, pitch: 50, yaw: 50 }, note: 'Halde heavy twin-engine air-superiority fighter (Su-27-class); carries four missiles.' },
  'SQUALL-7T':   { role: 'fighter',     hp: 65, speedKmh: 3500, roll: 185, pitch: 90,  yaw: 15, color: 0x56606a, accent: 0xb3262e, ai: { kmh: [300, 1000, 1800], roll: 300, pitch: 75, yaw: 25 }, note: 'Two-seat Squall (Su-30-class): heavier, tougher and better at finding you. Main fields come from its own spec sheet.' },
  'HAILSTONE-3': { role: 'attacker',    hp: 35, speedKmh: 1600, roll: 150, pitch: 55,  yaw: 5,  color: 0x56606a, accent: 0xb3262e, ai: { kmh: [300, 1100, 1800], roll: 200, pitch: 25, yaw: 25 }, note: 'Halde armored ground-attack jet (Su-25-class): slow, sturdy and happiest swarming ships and ground troops.' },
  // ---- Orrery Works prototypes ----
  'Q07':         { role: 'prototype',   hp: 70, speedKmh: 3200, roll: 180, pitch: 95,  yaw: 15, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [300, 1000, 1800], roll: 300, pitch: 85, yaw: 25 }, note: 'Orrery Works thrust-vectoring canard prototype (Su-37-class); carries four missiles.' },
  'Q09':         { role: 'prototype',   hp: 70, speedKmh: 3200, roll: 190, pitch: 110, yaw: 15, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 82.5, yaw: 25 }, note: 'Orrery Works canard and vectored-nozzle demonstrator (F-15 S/MTD-class), now in limited service.' },
  'Q10':         { role: 'prototype',   hp: 100, speedKmh: 3600, roll: 250, pitch: 120, yaw: 20, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [400, 950, 1800], roll: 250, pitch: 60, yaw: 25 }, note: "Orrery Works closed-canopy prototype, the airframe under Pendulum's second jet. Unmarked ones (no IFF) fly with Mainspring on Mercenary (Unwound) and can fire missiles backwards. hp = reference AI value (about 3 missiles); speed, pitch and yaw estimated as for Q10 PENDULUM." },
  'Q11':         { role: 'prototype',   hp: 70, speedKmh: 3200, roll: 180, pitch: 105, yaw: 20, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [300, 1000, 1800], roll: 300, pitch: 50, yaw: 25 }, note: 'Orrery Works stealth air-dominance prototype; an original shape with no real-world counterpart.' },
  // ---- support and utility (AI-only types: agility = reference AI values unless marked estimated) ----
  'KD-480E':     { role: 'awacs',       armed: false, hp: 100, speedKmh: 850, roll: 20, pitch: 5,  yaw: 5,  color: 0xb4b9bf, accent: 0x4f565e, ai: { kmh: [300, 450, 1800], roll: 20, pitch: 5, yaw: 5 }, note: "Kettle & Daughters airborne radar picket (737 AEW&C-class), the Concord's eye in the sky. Speed estimated." },
  'KD-260':      { role: 'transport',   armed: false, hp: 76,  speedKmh: 830, roll: 30, pitch: 21, yaw: 12, color: 0xb4b9bf, accent: 0x4f565e, ai: { kmh: [200, null, 1800], roll: 30, pitch: 21, yaw: 12.5 }, note: 'Kettle & Daughters heavy transport (C-17-class); its turrets are for show and its wreck keeps a hitbox. Speed estimated; the AI speed is a 200..1800 table and agility uses its maxima.' },
  'KD-910':      { role: 'bomber',      armed: false, hp: 76,  speedKmh: 900, roll: 15, pitch: 20, yaw: 10, color: 0x1c1d20, accent: 0xb22222, ai: { kmh: [300, 400, 900], roll: 15, pitch: 20, yaw: 10 }, note: 'Kettle & Daughters strategic bomber (B-52-class): jet black with a red tail; the tail gun is negligible. Speed = AI max.' },
  'KD-12U':      { role: 'drone',       armed: false, hp: 20,  speedKmh: 750, roll: 100, pitch: 30, yaw: 10, color: 0xb4b9bf, accent: 0x4f565e, ai: { kmh: [300, 550, 1800], roll: 100, pitch: 30, yaw: 25 }, note: 'Kettle & Daughters unarmed recon drone, about as sturdy as a kite. Speed and yaw estimated.' },
  'SCAUP II':    { role: 'floatplane',  armed: 'gun', hp: 35,  speedKmh: 400, roll: 150, pitch: 75, yaw: 15, color: 0x56663a, accent: 0xb9a36b, ai: { kmh: [200, 400, 1800], roll: 200, pitch: 100, yaw: 25 }, note: 'Tidewright Yards fishery-patrol floatplane with one machine gun; the Saltjaw Corsairs steal them by the dozen and paint them kelp green. Main fields estimated (speed = AI cruise).' },
  'KD-38H':      { role: 'helicopter',  hp: 30, speedKmh: 300, roll: 90, pitch: 45, yaw: 45, color: 0x56663a, accent: 0xb9a36b, note: 'Kettle & Daughters attack helicopter (Mi-28-class) with missiles and a chin gun; flies in flights of eight. Every value estimated (one-missile soft target).' },
  'BODKIN':      { role: 'cruise missile', armed: false, hp: 10, speedKmh: 1000, roll: 150, pitch: 100, yaw: 25, color: 0xd6d6d6, accent: 0xc0392b, ai: { kmh: [300, 1000, 1800], roll: 150, pitch: 100, yaw: 25 }, note: "Nordvane Arsenal's standard cruise missile: fragile, and it jinks away from incoming missiles. Speed = AI cruise." },
  'THUNDERHEAD': { role: 'cruise missile', armed: false, hp: 70, speedKmh: 1200, roll: 300, pitch: 200, yaw: 25, color: 0xd6d6d6, accent: 0xc0392b, ai: { kmh: [300, 1200, 1800], roll: 300, pitch: 200, yaw: 25 }, note: 'A Bodkin with a thunderglass warhead, the weapon of the Glassfall: much tougher and far more agile. Speed = AI cruise.' },
  // ---- Chime Squadron and company (base-type stats; durability converted at 32 HP per missile) ----
  'NV-73 CUCKOO':   { role: 'multirole', hp: 35,  speedKmh: 3000, roll: 210, pitch: 95,  yaw: 15, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [300, 1000, 1400], roll: 250, pitch: 50, yaw: 35 }, note: "Cuckoo Flight, Chime Squadron's cadets, in gilded NV-73s; they pop out to evict you from Tarnfell (Housewarming). Worth double points, no extra durability." },
  'Q07 CHIME':      { role: 'prototype', hp: 200, speedKmh: 3200, roll: 180, pitch: 95,  yaw: 15, color: 0x7d1212, accent: 0x151515, ai: { kmh: [300, 1000, 1800], roll: 300, pitch: 85, yaw: 25 }, note: "Chime Squadron, the Concord's clockwork elite, in oxblood-and-black Q07s: about 6 missiles each (200 HP); post-stall flips to dodge missiles." },
  'Q11 CHIME':      { role: 'prototype', hp: 200, speedKmh: 3200, roll: 180, pitch: 105, yaw: 20, color: 0x7d1212, accent: 0x151515, ai: { kmh: [300, 1000, 1800], roll: 300, pitch: 50, yaw: 25 }, note: 'Chime Squadron in oxblood-and-black Q11s: about 6 missiles each (200 HP); post-stall flips to dodge missiles.' },
  'Q09 TICK':       { role: 'prototype', hp: 130, speedKmh: 3200, roll: 190, pitch: 110, yaw: 15, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 82.5, yaw: 25 }, note: 'Tick, of the interceptor twins Tick and Tock (Rush Hour), never more than a beat apart: about 4 missiles (130 HP).' },
  'Q09 TOCK':       { role: 'prototype', hp: 130, speedKmh: 3200, roll: 190, pitch: 110, yaw: 15, color: 0x353a42, accent: 0xe0a020, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 82.5, yaw: 25 }, note: 'Tock, the other half of the interceptor twins (Rush Hour): about 4 missiles (130 HP).' },
  'Q09 SHEARPIN':   { role: 'prototype', hp: 70,  speedKmh: 3200, roll: 190, pitch: 110, yaw: 15, color: 0x2a2a2f, accent: 0xd0473f, ai: { kmh: [300, 1000, 1800], roll: 200, pitch: 82.5, yaw: 25 }, note: "Shearpin Squadron (Backswing), the Loose Screws' old hangar-mates, now paid in Orrery jets to escort Pendulum. Built to snap under load: they withdraw once Pendulum falls; post-stall dodging." },
  'Q04 PENDULUM':   { role: 'prototype', armed: 'gun', bars: 3, hp: 530, speedKmh: 2500, roll: 200, pitch: 100, yaw: 12, color: 0x2a2a2f, accent: 0xd0473f, ai: { kmh: [null, 1000, 1800], roll: 250, pitch: 65, yaw: 25 }, note: "Pendulum's first jet (Graveyard Shift boss), a gun-only Orrery duelist. Reference AI HP 150; fought as 3 bars of about 3 missiles on Normal (530 HP, not doubled: 9 missiles). Heavy gun barrages, plus a rapid railgun from bar 2. Only cruise and max AI speeds are set." },
  'Q10 PENDULUM':   { role: 'prototype', bars: 3, hp: 710, speedKmh: 3600, roll: 250, pitch: 120, yaw: 20, color: 0x2a2a2f, accent: 0xd0473f, ai: { kmh: [400, 950, 1800], roll: 250, pitch: 60, yaw: 25 }, note: 'Pendulum swings back (Backswing boss) in the gunmetal-and-red Q10. Reference AI HP 100; 3 bars of about 3.6 missiles on Normal (710 HP, not doubled: 11 missiles). Guns, then micromissile swarms; post-stall tricks. Speed, pitch and yaw estimated.' },
  'Q12 MAINSPRING': { role: 'prototype', bars: 4, missileReload: 5 / 3, hp: 1540, speedKmh: 4000, roll: 350, pitch: 150, yaw: 15, color: 0x7d1212, accent: 0x151515, ai: { kmh: [300, 1000, 1800], roll: 300, pitch: 70, yaw: 25 }, note: "Mainspring, Chime Squadron's commander, in the Q12 at the top of the Orrery's dial (Unwound final boss). Reference AI HP 400; 1540 HP, not doubled: on Normal 4 bars of about 6 missiles (24 total; Easy 19, Hard 28, Mercenary 31). Micromissiles, railgun bursts, then area and railgun cluster bombs." },
};

// ------------------------------------------------------------------------------------------------------------------------
// Non-aircraft enemies, drawn as boxes/prisms. size = [width, height, length] in meters. hp = game damage (see header).
export const GROUND_TYPES = {
  // ---- land air defenses ----
  aa:                { shape: 'box',   size: [4, 3, 4],      hp: 50,  refHp: 30,  shoots: 'gun',     range: 1500, naval: false, note: 'AA gun: fragile, dangerous in clusters.' },
  'c-ram':           { shape: 'box',   size: [3, 5, 3],      hp: 50,  refHp: 30,  shoots: 'gun',     range: 2000, naval: false, note: 'Point-defense gun turret (Phalanx-type CIWS): very high rate of fire.' },
  sam:               { shape: 'prism', size: [6, 5, 10],     hp: 50,  refHp: 30,  shoots: 'missile', range: 4000, naval: false, note: 'SAM launcher (S-75-sized); short-range micro-missile launchers are folded in.' },
  'l-sam':           { shape: 'prism', size: [7, 6, 12],     hp: 50,  refHp: 30,  shoots: 'missile', range: 8000, naval: false, note: 'Long-range SAM: longer range, better tracking. Put a mountain between you and it.' },
  railgun:           { shape: 'box',   size: [10, 8, 16],    hp: 180, refHp: 100, shoots: 'gun',     range: 4000, naval: false, note: 'Armored thunderglass railgun turret (heavy variants folded in): slow, heavy shot that leaves a damaging trail.' },
  // ---- land vehicles and structures (they do not shoot at aircraft) ----
  tank:              { shape: 'box',   size: [3.6, 2.6, 8],  hp: 100, refHp: 20,  shoots: false, naval: false, note: 'Eight-wheeled armored vehicle; takes 2 missiles.' },
  artillery:         { shape: 'box',   size: [3.6, 3, 9],    hp: 60,  refHp: 20,  shoots: false, naval: false, note: 'Self-propelled gun on the armored-vehicle chassis.' },
  'gun emplacement': { shape: 'box',   size: [10, 5, 10],    hp: 110, refHp: 50,  shoots: false, naval: false, note: 'Fixed artillery position.' },
  bunker:            { shape: 'box',   size: [14, 5, 14],    hp: 110, refHp: 50,  shoots: false, naval: false, note: 'Reinforced gun bunker with firing slits.' },
  radar:             { shape: 'prism', size: [10, 12, 10],   hp: 60,  refHp: 40,  shoots: false, naval: false, note: 'Radar dish.' },
  'comm tower':      { shape: 'prism', size: [6, 50, 6],     hp: 50,  refHp: 30,  shoots: false, naval: false, note: 'Communications mast; tall, so a collision hazard.' },
  substation:        { shape: 'box',   size: [16, 8, 20],    hp: 50,  refHp: 30,  shoots: false, naval: false, note: 'Power substation on the thunderglass grid.' },
  hangar:            { shape: 'box',   size: [40, 16, 48],   hp: 110, refHp: 40,  shoots: false, naval: false, note: 'Airbase hangar.' },
  refinery:          { shape: 'box',   size: [24, 24, 30],   hp: 110,             shoots: false, naval: false, note: 'Thunderglass refinery. HP estimated.' },
  container:         { shape: 'box',   size: [6, 3, 12],     hp: 40,              shoots: false, naval: false, note: 'Crated thunderglass, ready to ship. HP estimated.' },
  'oil tank':        { shape: 'box',   size: [18, 12, 18],   hp: 40,              shoots: false, naval: false, note: 'Fuel tank. HP estimated.' },
  extractor:         { shape: 'box',   size: [40, 30, 60],   hp: 260,             shoots: false, naval: false, note: 'Thunderglass extraction rig on a lightning-struck summit (1000 points). HP estimated.' },
  'cargo crate':     { shape: 'box',   size: [10, 6, 20],    hp: 110,             shoots: false, naval: false, note: 'The stolen thunderglass crate, final target of Salvage Rights. HP estimated.' },
  building:          { shape: 'box',   size: [20, 14, 20],   hp: 60,              shoots: false, naval: false, note: 'Generic structure (not used by the missions below).' },
  truck:             { shape: 'box',   size: [3, 3, 8],      hp: 40,              shoots: false, naval: false, note: 'Truck (not used by the missions below).' },
  'siege crawler':   { shape: 'box',   size: [30, 22, 70],   hp: 650, refHp: 50,  shoots: 'missile', range: 5000, naval: false, note: 'Concord superheavy tracked fortress: 4 railguns, 10 SAMs, 12 AA guns (mounts pooled into one HP bar). Size estimated.' },
  // ---- naval ----
  boat:              { shape: 'prism', size: [5, 3, 22],     hp: 40,  refHp: 20,  shoots: 'gun',     range: 800,  naval: true, note: 'Fast patrol boat, one machine gun; hard to hit, low threat.' },
  frigate:           { shape: 'prism', size: [32, 16, 127],  hp: 160, refHp: 50,  shoots: 'missile', range: 4000, naval: true, note: 'Littoral frigate (127 m trimaran): 1 SAM + 1 AA gun.' },
  'railgun frigate': { shape: 'prism', size: [32, 18, 127],  hp: 220, refHp: 50,  shoots: 'missile', range: 5000, naval: true, note: 'Frigate refitted with a cannon, a railgun and a SAM. Deadly in numbers.' },
  cruiser:           { shape: 'prism', size: [21, 28, 186],  hp: 260, refHp: 25,  shoots: 'missile', range: 5000, naval: true, note: 'Missile cruiser (Slava-class size): bow cannon, 2 SAMs, 2 AA guns.' },
  battleship:        { shape: 'prism', size: [40, 36, 279],  hp: 650, refHp: 150, shoots: 'missile', range: 6000, naval: true, note: 'Railgun-era battleship, 279 m: turret batteries, 4 cannons, 4 SAMs, 6 AA guns.' },
  carrier:           { shape: 'box',   size: [77, 24, 333],  hp: 450, refHp: 150, shoots: 'gun',     range: 2000, naval: true, note: 'Fleet carrier (Nimitz-class size): 4 CIWS + 1 SAM. Launches NV-56N pairs (a 4-ship NV-56N group in the same phase stands in).' },
  'cargo ship':      { shape: 'box',   size: [32, 22, 190],  hp: 120, refHp: 50,  shoots: false,                  naval: true, note: 'Unarmed bulk carrier.' },
  'armed cargo':     { shape: 'box',   size: [32, 22, 190],  hp: 200, refHp: 50,  shoots: 'missile', range: 3500, naval: true, note: 'Militarized cargo ship: 4 micro-SAM launchers in the holds.' },
  'spy ship':        { shape: 'prism', size: [16, 18, 102],  hp: 120, refHp: 50,  shoots: false,                  naval: true, note: 'Unarmed intelligence ship with twin radomes.' },
  'moored frigate':    { shape: 'prism', size: [32, 16, 127], hp: 120, refHp: 50,  shoots: false, naval: true, note: 'Frigate tied up at the pier, guns unmanned (Shore Leave).' },
  'moored cruiser':    { shape: 'prism', size: [21, 28, 186], hp: 60,  refHp: 25,  shoots: false, naval: true, note: 'Cruiser tied up at the pier, hull only (Shore Leave).' },
  'moored battleship': { shape: 'prism', size: [40, 36, 279], hp: 320, refHp: 150, shoots: false, naval: true, note: 'Battleship tied up at the pier, unmanned (Shore Leave).' },
  'moored carrier':    { shape: 'box',   size: [77, 24, 333], hp: 320, refHp: 150, shoots: false, naval: true, note: 'Carrier tied up at the pier, no launches (Shore Leave).' },
};

// ------------------------------------------------------------------------------------------------------------------------
// Missions in campaign order. Each phase spawns when the previous phase is cleared.
export const MISSIONS = [
  {
    id: 1, name: 'Salvage Rights',
    briefing: 'The Saltjaw Corsairs stole a crate of League thunderglass and holed up with it at Gullrock. Flatten their sea fort: patrol boats, flak guns and those kelp-green floatplanes.',
    setting: 'sea stacks', location: 'Gullrock Stacks (Saltjaw sea fort)', time: '16:05',
    phases: [
      { label: 'Gullrock sea fort', groups: [
        { kind: 'naval', type: 'boat', count: 12, area: 'scattered', distance: 6000 },
        { kind: 'ground', type: 'aa', count: 9, area: 'base', distance: 6500 },
        { kind: 'air', type: 'SCAUP II', count: 3, formation: 'loose', position: 'low', distance: 4500 },
        { kind: 'ground', type: 'c-ram', count: 3, area: 'base', distance: 6500, difficulty: 'mercenary' },
        { kind: 'ground', type: 'l-sam', count: 2, area: 'base', distance: 6500, difficulty: 'mercenary' },  // inside the fort walls: attack from above
        { kind: 'naval', type: 'cruiser', count: 2, area: 'fleet', distance: 7500, difficulty: 'mercenary' },
        { kind: 'naval', type: 'armed cargo', count: 2, area: 'fleet', distance: 8000, difficulty: 'mercenary' },
        { kind: 'air', type: 'SCAUP II', count: 3, formation: 'loose', position: 'low', distance: 5000, difficulty: 'mercenary' },
        { kind: 'air', type: 'NV-73', count: 3, formation: 'vee', position: 'ahead', distance: 6000, difficulty: 'mercenary' },
      ] },
      { label: 'The buyers arrive', groups: [
        { kind: 'air', type: 'NV-62', count: 3, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'NV-11', count: 3, formation: 'vee', position: 'ahead', distance: 7000 },
        { kind: 'air', type: 'NV-11', count: 2, formation: 'pair', position: 'low', distance: 4000 },        // the buyers' escort, parked on the fort's strip
        { kind: 'air', type: 'Q07', count: 1, formation: 'pair', position: 'low', distance: 4000, difficulty: 'mercenary' },  // also parked on the strip
        { kind: 'air', type: 'Q07', count: 4, formation: 'vee', position: 'left', distance: 6500, difficulty: 'mercenary' },  // 5 -> 4 (phase air cap)
        { kind: 'air', type: 'Q09', count: 3, formation: 'vee', position: 'right', distance: 6500, difficulty: 'mercenary' },
      ] },
      { label: 'The crate', groups: [
        { kind: 'ground', type: 'cargo crate', count: 1, area: 'base', distance: 5000 },
      ] },
    ],
  },
  {
    id: 2, name: 'Burned Bridges',
    briefing: 'The Concord wanted that crate, and now it wants us. Its border patrol is waiting at Hollowgap Pass; punch through to League airspace.',
    setting: 'mountains', location: 'Anvil Range (Hollowgap Pass)', time: '17:45',
    phases: [
      { label: 'Border patrol', groups: [
        { kind: 'air', type: 'NV-62', count: 6, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-62', count: 6, formation: 'vee', position: 'left', distance: 6500 },
        { kind: 'air', type: 'NV-73', count: 1, formation: 'pair', position: 'right', distance: 6000, difficulty: 'mercenary' },  // extras 6 -> 4 (phase air cap): 2/2/2 -> 1/1/2
        { kind: 'air', type: 'SQUALL-7T', count: 1, formation: 'pair', position: 'high', distance: 7000, difficulty: 'mercenary' },
        { kind: 'air', type: 'Q07', count: 2, formation: 'pair', position: 'ahead', distance: 7000, difficulty: 'mercenary' },
      ] },
      { label: 'They brought an AWACS', groups: [
        { kind: 'air', type: 'KD-480E', count: 1, formation: 'line', position: 'high', distance: 8000 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'right', distance: 6500 },
        { kind: 'air', type: 'NV-62', count: 1, formation: 'pair', position: 'left', distance: 6000, difficulty: 'mercenary' },
        { kind: 'air', type: 'Q09', count: 1, formation: 'pair', position: 'left', distance: 6300, difficulty: 'mercenary' },
        { kind: 'air', type: 'NV-11', count: 3, formation: 'vee', position: 'high', distance: 7000, difficulty: 'mercenary' },
      ] },
      { label: 'Squall flight', groups: [
        { kind: 'air', type: 'KD-480E', count: 1, formation: 'line', position: 'high', distance: 8000 },
        { kind: 'air', type: 'SQUALL-7', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'FALLWIND-6', count: 1, formation: 'pair', position: 'high', distance: 7000, difficulty: 'mercenary' },
        { kind: 'air', type: 'NV-73', count: 4, formation: 'vee', position: 'left', distance: 6000, difficulty: 'mercenary' },
      ] },
    ],
  },
  {
    id: 3, name: 'Housewarming',
    briefing: "The League can't afford a base for us, so we're taking the Concord's air station at Tarnfell. Its harbor covers the approach: sink the warships and silence the shore guns.",
    setting: 'snow coast', location: 'Tarnfell Air Station (soon the Toolshed)', time: '08:12',
    phases: [
      { label: 'Harbor and shore guns', groups: [
        { kind: 'naval', type: 'boat', count: 10, area: 'scattered', distance: 6000 },
        { kind: 'naval', type: 'cruiser', count: 2, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'frigate', count: 3, area: 'fleet', distance: 7000 },
        { kind: 'ground', type: 'aa', count: 9, area: 'coastline', distance: 7000 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'KD-12U', count: 2, formation: 'pair', position: 'high', distance: 6500, optional: true },
        { kind: 'naval', type: 'battleship', count: 1, area: 'fleet', distance: 8000, difficulty: 'mercenary' },
        { kind: 'naval', type: 'carrier', count: 1, area: 'fleet', distance: 8000, difficulty: 'mercenary' },
        { kind: 'naval', type: 'railgun frigate', count: 2, area: 'fleet', distance: 7500, difficulty: 'mercenary' },
        { kind: 'air', type: 'NV-56N', count: 3, formation: 'vee', position: 'left', distance: 6000, difficulty: 'mercenary' },
        { kind: 'air', type: 'NV-56N', count: 4, formation: 'pair', position: 'low', distance: 7000, difficulty: 'mercenary' },  // carrier launches
      ] },
      { label: 'Tarnfell Air Station', groups: [
        { kind: 'ground', type: 'aa', count: 12, area: 'base', distance: 6000 },
        { kind: 'ground', type: 'sam', count: 8, area: 'base', distance: 6500 },
        { kind: 'air', type: 'NV-48', count: 5, formation: 'pair', position: 'low', distance: 5000 },        // scrambling from the runway
        { kind: 'air', type: 'KD-260', count: 4, formation: 'line', position: 'low', distance: 5500 },       // scrambling from the runway
        { kind: 'ground', type: 'l-sam', count: 1, area: 'base', distance: 7000, difficulty: 'mercenary' },
        { kind: 'ground', type: 'c-ram', count: 3, area: 'base', distance: 6000, difficulty: 'mercenary' },
        { kind: 'ground', type: 'railgun', count: 2, area: 'base', distance: 6500, difficulty: 'mercenary' },
        { kind: 'air', type: 'Q09', count: 2, formation: 'pair', position: 'ahead', distance: 6000, difficulty: 'mercenary' },
      ] },
      { label: 'Cuckoo Flight', groups: [
        { kind: 'air', type: 'NV-73 CUCKOO', count: 6, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'FLURRY-4', count: 4, formation: 'vee', position: 'high', distance: 6500, difficulty: 'mercenary' },  // Cuckoo Flight's second wing
      ] },
    ],
  },
  {
    id: 4, name: 'Bad Apples',
    briefing: 'The Herring Guard is pinned down in the Brekka orchards by Concord armor and artillery, with bombers overhead. Break the guns around them and give them room to breathe.',
    setting: 'hills', location: 'Brekka Valley orchards', time: '17:40',
    allies: [   // the Herring Guard, dug in among the orchards just past the Concord armor that has them pinned down
      { name: 'Herring Guard', kind: 'ground', near: 'tank', distance: 1000, after: true,
        units: [{ type: 'tank', count: 8 }, { type: 'truck', count: 5 }, { type: 'aa', count: 3 }] },
    ],
    phases: [
      { label: 'Relieve the Herring Guard', groups: [
        { kind: 'ground', type: 'artillery', count: 12, area: 'convoy', distance: 6500 },
        { kind: 'ground', type: 'tank', count: 10, area: 'convoy', distance: 7000 },
        { kind: 'ground', type: 'gun emplacement', count: 3, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'bunker', count: 2, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'sam', count: 2, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'aa', count: 4, area: 'base', distance: 7000 },
        { kind: 'air', type: 'KD-910', count: 4, formation: 'line', position: 'high', distance: 7000 },
        { kind: 'air', type: 'NV-62', count: 2, formation: 'pair', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-48', count: 2, formation: 'pair', position: 'left', distance: 5500 },
        { kind: 'ground', type: 'c-ram', count: 4, area: 'base', distance: 7000, difficulty: 'mercenary' },
        { kind: 'ground', type: 'siege crawler', count: 1, area: 'scattered', distance: 7500, difficulty: 'mercenary' },
        { kind: 'air', type: 'SQUALL-7T', count: 4, formation: 'vee', position: 'right', distance: 6000, difficulty: 'mercenary' },
      ] },
      { label: 'Second push', groups: [
        { kind: 'ground', type: 'tank', count: 6, area: 'convoy', distance: 6500 },
        { kind: 'ground', type: 'artillery', count: 5, area: 'convoy', distance: 7000 },
        { kind: 'ground', type: 'gun emplacement', count: 6, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'bunker', count: 3, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'sam', count: 6, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'aa', count: 7, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'comm tower', count: 1, area: 'base', distance: 7500 },
        { kind: 'air', type: 'KD-38H', count: 6, formation: 'loose', position: 'low', distance: 5000 },
        { kind: 'air', type: 'HAILSTONE-3', count: 3, formation: 'vee', position: 'low', distance: 6000 },
        { kind: 'air', type: 'KD-910', count: 3, formation: 'line', position: 'high', distance: 7500 },
        { kind: 'air', type: 'GUST-5', count: 2, formation: 'pair', position: 'left', distance: 6000, optional: true },
        { kind: 'air', type: 'NV-73', count: 2, formation: 'pair', position: 'right', distance: 6000, optional: true },
        { kind: 'ground', type: 'l-sam', count: 2, area: 'base', distance: 7500, difficulty: 'mercenary' },
        { kind: 'ground', type: 'railgun', count: 2, area: 'base', distance: 7000, difficulty: 'mercenary' },
        { kind: 'ground', type: 'siege crawler', count: 2, area: 'scattered', distance: 7500, difficulty: 'mercenary' },
      ] },
    ],
  },
  {
    id: 5, name: 'Lights Out',
    briefing: 'Lanternport is falling, and the League government is leaving on the morning ferries. A Concord dawn raid is inbound; keep it off the boats.',
    setting: 'city coast', location: 'Lanternport harbor', time: '07:30',
    phases: [
      { label: 'Dawn raid', groups: [
        { kind: 'air', type: 'NV-48', count: 3, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-56N', count: 6, formation: 'vee', position: 'left', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 10, area: 'scattered', distance: 6000, optional: true },
        { kind: 'ground', type: 'l-sam', count: 4, area: 'base', distance: 7000, optional: true },
        { kind: 'naval', type: 'cruiser', count: 2, area: 'fleet', distance: 8000, optional: true },
        { kind: 'naval', type: 'frigate', count: 1, area: 'fleet', distance: 8000, optional: true },
        { kind: 'naval', type: 'railgun frigate', count: 2, area: 'fleet', distance: 8000, optional: true, difficulty: 'mercenary' },
        { kind: 'naval', type: 'armed cargo', count: 2, area: 'fleet', distance: 8000, optional: true, difficulty: 'mercenary' },
      ] },
      { label: 'Ferries away', groups: [
        { kind: 'air', type: 'NV-48', count: 3, formation: 'vee', position: 'right', distance: 5500 },
        { kind: 'air', type: 'NV-56N', count: 6, formation: 'vee', position: 'ahead', distance: 6500 },
      ] },
      { label: 'Pursuit', groups: [
        { kind: 'air', type: 'NV-48', count: 3, formation: 'vee', position: 'left', distance: 5500 },
        { kind: 'air', type: 'NV-56N', count: 6, formation: 'vee', position: 'high', distance: 6500 },
        { kind: 'air', type: 'NV-56N', count: 1, formation: 'pair', position: 'ahead', distance: 6000, difficulty: 'mercenary' },
      ] },
      { label: 'Last boat out', groups: [
        { kind: 'air', type: 'NV-48', count: 5, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'NV-48', count: 5, formation: 'vee', position: 'right', distance: 6500 },
        { kind: 'air', type: 'KD-480E', count: 1, formation: 'line', position: 'high', distance: 8000 },
        { kind: 'ground', type: 'sam', count: 1, area: 'base', distance: 6500, optional: true },
        { kind: 'ground', type: 'aa', count: 7, area: 'scattered', distance: 6000, optional: true },
      ] },
    ],
  },
  {
    id: 6, name: 'Lightning Rod',
    briefing: 'The Concord refines its thunderglass in Glasswater Gorge and has parked a SAM on every ledge. Burn the refineries and mind the walls.',
    setting: 'gorge', location: 'Glasswater Gorge, Anvil Range', time: '17:30',
    phases: [
      { label: 'Refineries', groups: [
        { kind: 'ground', type: 'refinery', count: 8, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'sam', count: 13, area: 'scattered', distance: 7000 },
        { kind: 'ground', type: 'aa', count: 7, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'c-ram', count: 1, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'refinery', count: 2, area: 'base', distance: 6000, optional: true },
        { kind: 'ground', type: 'container', count: 6, area: 'base', distance: 6000, optional: true },
        { kind: 'ground', type: 'oil tank', count: 3, area: 'base', distance: 6000, optional: true },
        { kind: 'ground', type: 'radar', count: 2, area: 'ridge', distance: 7000, optional: true },
        { kind: 'ground', type: 'comm tower', count: 2, area: 'ridge', distance: 7000, optional: true },
        { kind: 'air', type: 'NV-48', count: 6, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-11', count: 6, formation: 'vee', position: 'left', distance: 6000 },
        { kind: 'ground', type: 'c-ram', count: 6, area: 'base', distance: 6500, difficulty: 'mercenary' },  // extras split across phases 1-2 like the SAMs and AA
        { kind: 'ground', type: 'l-sam', count: 1, area: 'ridge', distance: 7000, difficulty: 'mercenary' },
        { kind: 'air', type: 'NV-11', count: 1, formation: 'pair', position: 'right', distance: 6000, difficulty: 'mercenary' },
        { kind: 'air', type: 'Q09', count: 1, formation: 'pair', position: 'right', distance: 6300, difficulty: 'mercenary' },
        { kind: 'air', type: 'FLURRY-4', count: 1, formation: 'pair', position: 'high', distance: 6500, difficulty: 'mercenary' },
      ] },
      { label: 'Summit rigs', groups: [
        { kind: 'ground', type: 'extractor', count: 3, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'sam', count: 10, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'aa', count: 6, area: 'base', distance: 7000 },
        { kind: 'air', type: 'SQUALL-7', count: 6, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'ground', type: 'c-ram', count: 5, area: 'base', distance: 7000, difficulty: 'mercenary' },
        { kind: 'ground', type: 'railgun', count: 2, area: 'base', distance: 7000, difficulty: 'mercenary' },
        { kind: 'air', type: 'Q07', count: 3, formation: 'vee', position: 'left', distance: 6500, difficulty: 'mercenary' },
      ] },
      { label: 'Chime Squadron', groups: [
        { kind: 'air', type: 'Q07 CHIME', count: 1, formation: 'pair', position: 'behind', distance: 5000 },
        { kind: 'air', type: 'Q11 CHIME', count: 1, formation: 'pair', position: 'behind', distance: 5500 },
      ] },
    ],
  },
  {
    id: 7, name: 'Finders Keepers',
    briefing: "League sailors just stole the Concord's newest battleship and renamed her the Hand-Me-Down. Concord pickets are combing the Galestrait for her: sink the ships and splash their air cover.",
    setting: 'sea', location: 'The Galestrait', time: '12:30',
    wingmen: ['3'],   // Cotter sits this one out
    allies: [   // the Hand-Me-Down shows up as the pursuit closes in, with four cruisers and a supply ship
      { name: 'Hand-Me-Down', kind: 'naval', phase: 1, position: 'ahead', distance: 3000,
        units: [{ type: 'battleship', count: 1 }, { type: 'cruiser', count: 4, escort: true }, { type: 'cargo ship', count: 1, escort: true }] },
    ],
    phases: [
      { label: 'Concord pickets', groups: [
        { kind: 'air', type: 'NV-73', count: 6, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-48', count: 2, formation: 'pair', position: 'left', distance: 5000 },
        { kind: 'air', type: 'NV-11', count: 2, formation: 'pair', position: 'right', distance: 5000 },
        { kind: 'air', type: 'FLURRY-4', count: 2, formation: 'pair', position: 'ahead', distance: 6500 },
        { kind: 'air', type: 'KD-480E', count: 2, formation: 'pair', position: 'high', distance: 8000 },      // above the cloud deck
        { kind: 'naval', type: 'boat', count: 6, area: 'scattered', distance: 6000 },
        { kind: 'naval', type: 'cruiser', count: 3, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'railgun frigate', count: 4, area: 'fleet', distance: 8000 },
        { kind: 'naval', type: 'spy ship', count: 1, area: 'fleet', distance: 7000 },
      ] },
      { label: 'Shield the Hand-Me-Down', groups: [
        { kind: 'air', type: 'SQUALL-7T', count: 4, formation: 'vee', position: 'low', distance: 5500 },
        { kind: 'air', type: 'HAILSTONE-3', count: 8, formation: 'loose', position: 'low', distance: 6000 },
        { kind: 'naval', type: 'cruiser', count: 4, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'frigate', count: 3, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'railgun frigate', count: 2, area: 'fleet', distance: 8000 },
        { kind: 'naval', type: 'carrier', count: 1, area: 'fleet', distance: 8000, difficulty: 'mercenary' },
        { kind: 'naval', type: 'battleship', count: 2, area: 'fleet', distance: 8000, difficulty: 'mercenary' },
        { kind: 'air', type: 'Q07', count: 1, formation: 'pair', position: 'ahead', distance: 6000, difficulty: 'mercenary' },  // 2 -> 1 (phase air cap)
        { kind: 'air', type: 'NV-56N', count: 3, formation: 'pair', position: 'low', distance: 7000, difficulty: 'mercenary' },  // 8 -> 3 (phase air cap); also stands in for carrier launches
      ] },
      { label: 'Bodkins inbound', groups: [
        { kind: 'air', type: 'BODKIN', count: 5, formation: 'line', position: 'right', distance: 7000, target: 'fleet' },   // at the Hand-Me-Down's escorts
        { kind: 'air', type: 'BODKIN', count: 5, formation: 'line', position: 'right', distance: 8000, target: 'fleet' },
        { kind: 'air', type: 'FALLWIND-6', count: 4, formation: 'vee', position: 'right', distance: 6500 },
        { kind: 'air', type: 'SQUALL-7T', count: 2, formation: 'pair', position: 'right', distance: 6000, difficulty: 'mercenary' },  // 4 -> 2 (phase air cap)
      ] },
    ],
  },
  {
    id: 8, name: 'Rush Hour',
    briefing: 'The Concord is flying supplies to its mountain garrisons along the Saddleback corridor. Down the transports; the escorts will object.',
    setting: 'mountains', location: 'Anvil Range (Saddleback corridor)', time: '09:30',
    wingmen: ['2'],   // just Cotter on this one
    phases: [
      { label: 'First convoy', groups: [
        { kind: 'air', type: 'KD-260', count: 3, formation: 'line', position: 'ahead', distance: 7000 },
        { kind: 'air', type: 'NV-56N', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
      ] },
      { label: 'Second convoy', groups: [
        { kind: 'air', type: 'KD-260', count: 3, formation: 'line', position: 'left', distance: 7000 },
        { kind: 'air', type: 'SQUALL-7', count: 4, formation: 'vee', position: 'left', distance: 5500 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'right', distance: 6000 },
      ] },
      { label: 'Heavy convoy', groups: [
        { kind: 'air', type: 'KD-260', count: 4, formation: 'line', position: 'ahead', distance: 7500 },
        { kind: 'air', type: 'KD-480E', count: 2, formation: 'pair', position: 'high', distance: 8000 },
        { kind: 'air', type: 'NV-56N', count: 3, formation: 'vee', position: 'left', distance: 6000 },
        { kind: 'air', type: 'FALLWIND-6', count: 3, formation: 'vee', position: 'right', distance: 6000 },
        { kind: 'air', type: 'SQUALL-7', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
      ] },
      { label: 'Tick and Tock', groups: [
        { kind: 'air', type: 'Q09 TICK', count: 1, formation: 'pair', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'Q09 TOCK', count: 1, formation: 'pair', position: 'ahead', distance: 6300 },
        { kind: 'air', type: 'Q11', count: 2, formation: 'pair', position: 'high', distance: 6500, difficulty: 'mercenary' },
      ] },
    ],
  },
  {
    id: 9, name: 'Threading the Needle',
    briefing: "Solo run tonight, Wingnut: Vesper Fjord, the back door to the Concord's array. SAM sites Hammer and Tongs guard the fjord: hug the rock and kill them. The planners named them after tools so you'd feel at home.",
    setting: 'night fjord', location: 'Vesper Fjord', time: '22:00',
    wingmen: [],   // a lone sortie
    phases: [
      { label: 'Sites Hammer and Tongs', groups: [
        { kind: 'ground', type: 'l-sam', count: 3, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'c-ram', count: 5, area: 'ridge', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 7, area: 'ridge', distance: 6500 },
        { kind: 'ground', type: 'radar', count: 1, area: 'ridge', distance: 7000 },
        { kind: 'air', type: 'FALLWIND-6', count: 4, formation: 'vee', position: 'ahead', distance: 6000 },
      ] },
      { label: 'Site Pliers', groups: [
        { kind: 'ground', type: 'l-sam', count: 2, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'c-ram', count: 4, area: 'ridge', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 4, area: 'ridge', distance: 6500 },
        { kind: 'ground', type: 'radar', count: 1, area: 'ridge', distance: 7000 },
        { kind: 'ground', type: 'comm tower', count: 1, area: 'ridge', distance: 7000 },
        { kind: 'air', type: 'KD-38H', count: 3, formation: 'loose', position: 'low', distance: 4500 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'left', distance: 6000 },
        { kind: 'air', type: 'Q09', count: 1, formation: 'pair', position: 'left', distance: 6300, difficulty: 'mercenary' },
      ] },
      { label: 'Sites Vise and Clamp', groups: [
        { kind: 'ground', type: 'l-sam', count: 5, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'c-ram', count: 5, area: 'ridge', distance: 6500 },
        { kind: 'ground', type: 'sam', count: 2, area: 'ridge', distance: 6500 },
        { kind: 'air', type: 'NV-56N', count: 3, formation: 'vee', position: 'low', distance: 5000 },       // scrambling from a tunnel runway
        { kind: 'air', type: 'NV-73', count: 3, formation: 'vee', position: 'low', distance: 5500 },
      ] },
      { label: 'Site Chisel', groups: [
        { kind: 'ground', type: 'l-sam', count: 7, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'c-ram', count: 5, area: 'ridge', distance: 6500 },
        { kind: 'air', type: 'KD-38H', count: 6, formation: 'loose', position: 'low', distance: 4500 },
        { kind: 'air', type: 'NV-62', count: 8, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'NV-62', count: 2, formation: 'pair', position: 'left', distance: 6500, difficulty: 'mercenary' },  // 4 -> 2 (phase air cap)
      ] },
      { label: 'Site Anvil', groups: [
        { kind: 'ground', type: 'l-sam', count: 3, area: 'ridge', distance: 7500 },
        { kind: 'ground', type: 'c-ram', count: 10, area: 'ridge', distance: 6500 },
        { kind: 'ground', type: 'container', count: 2, area: 'ridge', distance: 6500, optional: true },
        { kind: 'air', type: 'KD-480E', count: 2, formation: 'pair', position: 'high', distance: 8000 },
      ] },
    ],
  },
  {
    id: 10, name: 'Dead Air',
    briefing: "The League is dropping paratroopers on the Choir, the Concord's listening array on Kaldmoor. Clear the landing zone, ground and sky, before the first chute opens.",
    setting: 'plateau', location: 'Kaldmoor plateau (the Choir array)', time: '16:30',
    phases: [
      { label: 'Landing zone', groups: [
        { kind: 'ground', type: 'aa', count: 6, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'c-ram', count: 3, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'l-sam', count: 3, area: 'base', distance: 7500 },
        { kind: 'ground', type: 'comm tower', count: 1, area: 'base', distance: 7500, optional: true },
        { kind: 'air', type: 'NV-73', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-73', count: 3, formation: 'vee', position: 'left', distance: 6000 },
        { kind: 'air', type: 'NV-56N', count: 2, formation: 'pair', position: 'right', distance: 6000 },
        { kind: 'air', type: 'NV-62', count: 2, formation: 'pair', position: 'high', distance: 6500 },
        { kind: 'air', type: 'SQUALL-7', count: 3, formation: 'vee', position: 'ahead', distance: 7000 },
      ] },
      { label: 'The Choir', groups: [
        { kind: 'ground', type: 'radar', count: 4, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'bunker', count: 3, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 5, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'tank', count: 12, area: 'convoy', distance: 7000 },
        { kind: 'ground', type: 'artillery', count: 4, area: 'convoy', distance: 7500 },
      ] },
      { label: 'Kaldmoor airbase', groups: [
        { kind: 'ground', type: 'railgun', count: 4, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'radar', count: 6, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'bunker', count: 4, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'substation', count: 4, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'sam', count: 2, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 13, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'hangar', count: 3, area: 'base', distance: 6500, optional: true },
        { kind: 'ground', type: 'oil tank', count: 3, area: 'base', distance: 7000, optional: true },
        { kind: 'air', type: 'NV-73', count: 4, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'NV-73', count: 3, formation: 'pair', position: 'low', distance: 5000 },        // taking off
        { kind: 'air', type: 'FALLWIND-6', count: 4, formation: 'vee', position: 'high', distance: 7000 },
        { kind: 'air', type: 'NV-62', count: 1, formation: 'pair', position: 'left', distance: 6000 },
        { kind: 'air', type: 'NV-56N', count: 1, formation: 'pair', position: 'left', distance: 6200 },
        { kind: 'air', type: 'KD-260', count: 2, formation: 'line', position: 'low', distance: 5500 },       // taking off
      ] },
    ],
  },
  {
    id: 11, name: 'Icebreaker',
    briefing: "A Concord supply run over the Ice Gate has turned into the war's biggest dogfight. Pick a bandit, any bandit, and start thinning the crowd.",
    setting: 'pack ice', location: 'The Ice Gate, northern strait', time: '13:05',
    phases: [
      { label: 'Ice Gate furball', groups: [
        { kind: 'air', type: 'NV-73', count: 5, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-56N', count: 2, formation: 'pair', position: 'left', distance: 5500 },
        { kind: 'air', type: 'NV-62', count: 2, formation: 'pair', position: 'right', distance: 5500 },
        { kind: 'air', type: 'NV-48', count: 2, formation: 'pair', position: 'high', distance: 6500 },
        { kind: 'air', type: 'SQUALL-7', count: 1, formation: 'pair', position: 'left', distance: 7000 },
        { kind: 'air', type: 'FALLWIND-6', count: 1, formation: 'pair', position: 'right', distance: 7000 },
        { kind: 'air', type: 'EIDER IV', count: 1, formation: 'pair', position: 'ahead', distance: 7000 },
        { kind: 'air', type: 'KD-260', count: 2, formation: 'line', position: 'ahead', distance: 8000, optional: true },
      ] },
      { label: 'Concord piles in', groups: [
        { kind: 'air', type: 'SQUALL-7T', count: 2, formation: 'pair', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'NV-11', count: 2, formation: 'pair', position: 'left', distance: 6000 },
        { kind: 'air', type: 'SLEET-2', count: 2, formation: 'pair', position: 'right', distance: 6000 },
        { kind: 'air', type: 'NV-73', count: 2, formation: 'pair', position: 'high', distance: 6500 },
        { kind: 'air', type: 'EIDER IV', count: 2, formation: 'pair', position: 'behind', distance: 6500 },
        { kind: 'air', type: 'NV-48', count: 2, formation: 'pair', position: 'low', distance: 6000 },
      ] },
      { label: 'They keep coming', groups: [
        { kind: 'air', type: 'NV-73', count: 2, formation: 'pair', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'SLEET-2', count: 2, formation: 'pair', position: 'left', distance: 6000 },
        { kind: 'air', type: 'FALLWIND-6', count: 2, formation: 'pair', position: 'right', distance: 6500 },
        { kind: 'air', type: 'EIDER IV', count: 2, formation: 'pair', position: 'high', distance: 6500 },
        { kind: 'air', type: 'NV-48', count: 4, formation: 'vee', position: 'behind', distance: 6000 },
      ] },
      { label: 'Chime strikes the hour', groups: [
        { kind: 'air', type: 'Q07 CHIME', count: 4, formation: 'vee', position: 'ahead', distance: 6500 },
        { kind: 'air', type: 'Q11 CHIME', count: 4, formation: 'vee', position: 'high', distance: 7000 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'left', distance: 6000 },
        { kind: 'air', type: 'FLURRY-4', count: 4, formation: 'vee', position: 'right', distance: 6000 },
      ] },
    ],
  },
  {
    id: 12, name: 'Graveyard Shift',
    briefing: 'The Concord is working a night shift on its Morrow Deep rigs, test-firing railguns. Tear down the batteries and everything guarding them.',
    setting: 'night sea', location: 'Morrow Deep rigs', time: '00:30',
    phases: [
      { label: 'Morrow Deep rigs', groups: [
        { kind: 'ground', type: 'railgun', count: 8, area: 'scattered', distance: 7000 },
        { kind: 'ground', type: 'sam', count: 5, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'c-ram', count: 6, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'l-sam', count: 3, area: 'scattered', distance: 7500 },
        { kind: 'ground', type: 'aa', count: 2, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'radar', count: 3, area: 'base', distance: 7000, optional: true },
        { kind: 'ground', type: 'container', count: 2, area: 'base', distance: 6500, optional: true },
        { kind: 'naval', type: 'frigate', count: 1, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'spy ship', count: 1, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'cargo ship', count: 4, area: 'fleet', distance: 8000, optional: true },
        { kind: 'air', type: 'KD-38H', count: 5, formation: 'loose', position: 'low', distance: 5000 },
        { kind: 'air', type: 'KD-38H', count: 4, formation: 'loose', position: 'low', distance: 5500 },
        { kind: 'air', type: 'EIDER IV', count: 6, formation: 'vee', position: 'ahead', distance: 5500 },
      ] },
      { label: 'Pendulum', groups: [
        { kind: 'air', type: 'Q04 PENDULUM', count: 1, formation: 'pair', position: 'ahead', distance: 4000 },
        { kind: 'air', type: 'Q09', count: 6, formation: 'vee', position: 'ahead', distance: 4500, optional: true, difficulty: 'mercenary' },  // launch with Pendulum; not needed once Pendulum falls
      ] },
    ],
  },
  {
    id: 13, name: 'Shore Leave',
    briefing: 'The Concord Home Fleet is tied up at Vantmouth with half its crews ashore. Wreck the harbor defenses and depots before anyone finds their boots.',
    setting: 'harbor', location: 'Vantmouth naval yard', time: '07:00',
    phases: [
      { label: 'Harbor defenses', groups: [
        { kind: 'ground', type: 'sam', count: 7, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 12, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'railgun', count: 4, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'bunker', count: 3, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'refinery', count: 6, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'container', count: 6, area: 'base', distance: 6500 },
        { kind: 'air', type: 'NV-62', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
      ] },
      { label: 'Home Fleet at anchor', groups: [
        { kind: 'naval', type: 'moored carrier', count: 1, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'moored battleship', count: 2, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'cruiser', count: 2, area: 'fleet', distance: 6500 },
        { kind: 'naval', type: 'moored cruiser', count: 8, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'moored frigate', count: 6, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'moored frigate', count: 2, area: 'fleet', distance: 8000, optional: true },
        { kind: 'naval', type: 'cargo ship', count: 3, area: 'fleet', distance: 8000, optional: true },
        { kind: 'naval', type: 'armed cargo', count: 1, area: 'fleet', distance: 8000, optional: true },
        { kind: 'naval', type: 'spy ship', count: 2, area: 'fleet', distance: 8000, optional: true },
      ] },
      { label: 'Escorts rushing home', groups: [
        { kind: 'air', type: 'NV-48', count: 3, formation: 'vee', position: 'ahead', distance: 6500 },
        { kind: 'air', type: 'Q07', count: 6, formation: 'vee', position: 'left', distance: 7000 },
      ] },
    ],
  },
  {
    id: 14, name: 'Clearance Sale',
    briefing: 'The Concord is pulling out of Blackfir Forest and torching it on the way out. Sink the flotilla covering the retreat: everything must go.',
    setting: 'forest', location: 'Blackfir Forest', time: '16:00',
    allies: [   // the Herring Guard, pushing through the forest behind the retreat
      { name: 'Herring Guard', kind: 'ground', position: 'left', distance: 3500,
        units: [{ type: 'tank', count: 7 }, { type: 'truck', count: 5 }, { type: 'aa', count: 3 }] },
    ],
    phases: [
      { label: 'Rearguard flotilla', groups: [
        { kind: 'naval', type: 'cruiser', count: 6, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'cargo ship', count: 2, area: 'fleet', distance: 7500, optional: true },
        { kind: 'ground', type: 'aa', count: 12, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'sam', count: 2, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'l-sam', count: 1, area: 'base', distance: 7000 },
        { kind: 'air', type: 'KD-38H', count: 4, formation: 'loose', position: 'low', distance: 5000 },
        { kind: 'air', type: 'NV-48', count: 5, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-62', count: 6, formation: 'vee', position: 'left', distance: 6000 },
      ] },
      { label: 'Retreating columns', groups: [
        { kind: 'ground', type: 'tank', count: 8, area: 'convoy', distance: 6500 },
        { kind: 'ground', type: 'artillery', count: 6, area: 'convoy', distance: 7000 },
        { kind: 'ground', type: 'gun emplacement', count: 6, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'aa', count: 12, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'sam', count: 2, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'railgun', count: 2, area: 'base', distance: 7500 },
        { kind: 'air', type: 'KD-38H', count: 4, formation: 'loose', position: 'low', distance: 5000 },
        { kind: 'air', type: 'NV-48', count: 5, formation: 'vee', position: 'ahead', distance: 6000 },
      ] },
    ],
  },
  {
    id: 15, name: 'Glass Houses',
    briefing: 'The League is retaking Kelderwick, and you have the sky over the glassworks. Clear out the Concord fighters and SAMs, and try not to break anything.',
    setting: 'city', location: 'Kelderwick', time: '10:35',
    phases: [
      { label: 'Kelderwick air cover', groups: [
        { kind: 'air', type: 'NV-48', count: 6, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-56N', count: 3, formation: 'vee', position: 'left', distance: 6000 },
        { kind: 'air', type: 'NV-56N', count: 3, formation: 'pair', position: 'low', distance: 4500 },      // scrambling from hardened city shelters
        { kind: 'air', type: 'FLURRY-4', count: 4, formation: 'vee', position: 'right', distance: 6000 },
        { kind: 'ground', type: 'l-sam', count: 6, area: 'scattered', distance: 7000 },
      ] },
      { label: 'Thunderheads inbound', groups: [
        { kind: 'air', type: 'THUNDERHEAD', count: 6, formation: 'line', position: 'ahead', distance: 8000 },
        { kind: 'air', type: 'THUNDERHEAD', count: 6, formation: 'line', position: 'left', distance: 7500 },
        { kind: 'air', type: 'NV-56N', count: 4, formation: 'pair', position: 'low', distance: 5000 },      // scrambling from hardened city shelters
      ] },
    ],
  },
  {
    id: 16, name: 'Backswing',
    briefing: "Pendulum swung back and is circling the ruins of Tarnfell, our old Toolshed, in a new Orrery jet. Shearpin Squadron flies escort, and shearpins are built to snap under load: drop Pendulum and they'll bail.",
    setting: 'snow coast', location: 'Tarnfell (ruins of the Toolshed)', time: '14:00',
    phases: [
      { label: 'Pendulum swings back', groups: [
        { kind: 'air', type: 'Q10 PENDULUM', count: 1, formation: 'pair', position: 'ahead', distance: 5000 },
        { kind: 'air', type: 'Q09 SHEARPIN', count: 4, formation: 'vee', position: 'left', distance: 5500, optional: true },
      ] },
    ],
  },
  {
    id: 17, name: 'Heavy Machinery',
    briefing: 'Two months after the Glassfall, the Concord is dug in at Brassgate Fortress. Blind its radar net and break the gun batteries.',
    setting: 'valley', location: 'Brassgate Fortress, Ravel Valley', time: '15:50',
    phases: [
      { label: 'Brassgate Fortress', groups: [
        { kind: 'ground', type: 'radar', count: 12, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'railgun', count: 6, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'c-ram', count: 6, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 9, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'sam', count: 3, area: 'base', distance: 7000 },
        { kind: 'air', type: 'NV-56N', count: 2, formation: 'pair', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-73', count: 4, formation: 'vee', position: 'left', distance: 6000 },
      ] },
      { label: 'Siege crawlers', groups: [
        { kind: 'ground', type: 'siege crawler', count: 2, area: 'scattered', distance: 7000 },
      ] },
    ],
  },
  {
    id: 18, name: 'Sweeping Up',
    briefing: 'Back to Kelderwick to sweep the last Concord holdouts out of the broken glass. Flak guns and gunships are hiding in the ruins, with a few jets overhead.',
    setting: 'ruins', location: 'Kelderwick (Glassfall ruins)', time: '18:00',
    phases: [
      { label: 'Holdouts', groups: [
        { kind: 'ground', type: 'aa', count: 8, area: 'scattered', distance: 6000 },
        { kind: 'air', type: 'KD-38H', count: 5, formation: 'loose', position: 'low', distance: 5000 },
        { kind: 'air', type: 'KD-38H', count: 3, formation: 'loose', position: 'low', distance: 5500 },
        { kind: 'air', type: 'NV-56N', count: 2, formation: 'pair', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'NV-11', count: 2, formation: 'pair', position: 'left', distance: 5500 },
        { kind: 'air', type: 'SQUALL-7', count: 2, formation: 'pair', position: 'right', distance: 5500 },
      ] },
      { label: "Chime's last round", groups: [
        { kind: 'air', type: 'Q07 CHIME', count: 4, formation: 'vee', position: 'ahead', distance: 6500 },
        { kind: 'air', type: 'Q11 CHIME', count: 4, formation: 'vee', position: 'high', distance: 7000 },
      ] },
    ],
  },
  {
    id: 19, name: 'Hostile Takeover',
    briefing: 'The Hand-Me-Down is sailing for Lanternport, and the Concord battle fleet means to stop her. Cruisers and supply ships are moving to cut her off under fighter cover: sink them.',
    setting: 'sea', location: 'The Galestrait, off Lanternport', time: '17:30',
    allies: [   // the Hand-Me-Down leads the League line straight at the Concord fleet
      { name: 'Hand-Me-Down', kind: 'naval', position: 'ahead', distance: 3000, units: [{ type: 'battleship', count: 1 }] },
    ],
    phases: [
      { label: 'Screening group', groups: [
        { kind: 'air', type: 'NV-73', count: 6, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'naval', type: 'cruiser', count: 3, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'cargo ship', count: 4, area: 'fleet', distance: 7500 },
      ] },
      { label: 'Carrier group', groups: [
        { kind: 'air', type: 'Q11', count: 6, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'Q11', count: 6, formation: 'vee', position: 'left', distance: 6500 },
        { kind: 'air', type: 'NV-56N', count: 4, formation: 'pair', position: 'low', distance: 7000 },      // carrier launches
        { kind: 'naval', type: 'carrier', count: 1, area: 'fleet', distance: 8000 },
        { kind: 'naval', type: 'cruiser', count: 3, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'frigate', count: 5, area: 'fleet', distance: 7000 },
      ] },
      { label: 'The Dividend', groups: [
        { kind: 'naval', type: 'battleship', count: 1, area: 'fleet', distance: 8000 },
        { kind: 'naval', type: 'carrier', count: 1, area: 'fleet', distance: 8000 },
        { kind: 'naval', type: 'cruiser', count: 3, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'railgun frigate', count: 3, area: 'fleet', distance: 7000 },
        { kind: 'naval', type: 'boat', count: 16, area: 'scattered', distance: 6000 },
        { kind: 'air', type: 'NV-56N', count: 4, formation: 'pair', position: 'low', distance: 7000 },      // carrier launches
      ] },
    ],
  },
  {
    id: 20, name: 'Lights On',
    briefing: "Today we take Lanternport back. Concord guns are dug into the hills above the city: smash them, and let's turn the lights back on.",
    setting: 'city', location: 'Lanternport', time: '16:00',
    phases: [
      { label: 'Hill batteries', groups: [
        { kind: 'ground', type: 'artillery', count: 6, area: 'convoy', distance: 6500 },
        { kind: 'ground', type: 'gun emplacement', count: 6, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'bunker', count: 5, area: 'base', distance: 7000 },
        { kind: 'ground', type: 'sam', count: 5, area: 'base', distance: 6500 },
        { kind: 'ground', type: 'aa', count: 6, area: 'scattered', distance: 6500 },
        { kind: 'ground', type: 'railgun', count: 1, area: 'base', distance: 7000 },
        { kind: 'air', type: 'NV-11', count: 4, formation: 'vee', position: 'ahead', distance: 5500 },
        { kind: 'air', type: 'Q09', count: 6, formation: 'vee', position: 'left', distance: 6500 },
      ] },
      { label: 'Sky over Lanternport', groups: [
        { kind: 'air', type: 'NV-62', count: 8, formation: 'vee', position: 'ahead', distance: 6000 },
        { kind: 'air', type: 'NV-56N', count: 5, formation: 'vee', position: 'right', distance: 6000 },
        { kind: 'air', type: 'KD-480E', count: 2, formation: 'pair', position: 'high', distance: 8000 },
        { kind: 'ground', type: 'sam', count: 3, area: 'base', distance: 6000, optional: true },
        { kind: 'ground', type: 'aa', count: 6, area: 'scattered', distance: 6000, optional: true },
      ] },
      { label: 'Orrery prototypes', groups: [
        { kind: 'air', type: 'Q07', count: 4, formation: 'vee', position: 'high', distance: 6500 },
      ] },
      { label: 'Harbor breakout', groups: [
        { kind: 'naval', type: 'battleship', count: 1, area: 'fleet', distance: 7500 },
        { kind: 'naval', type: 'carrier', count: 1, area: 'fleet', distance: 8000 },
        { kind: 'naval', type: 'cruiser', count: 8, area: 'fleet', distance: 7000 },
        { kind: 'air', type: 'NV-56N', count: 4, formation: 'pair', position: 'low', distance: 7000 },      // carrier launches
      ] },
      { label: 'Lighthouse batteries', groups: [
        { kind: 'ground', type: 'sam', count: 6, area: 'base', distance: 6000 },
        { kind: 'ground', type: 'gun emplacement', count: 12, area: 'base', distance: 6000 },
        { kind: 'ground', type: 'aa', count: 12, area: 'base', distance: 6000 },
        { kind: 'air', type: 'KD-38H', count: 5, formation: 'loose', position: 'low', distance: 5000 },
        { kind: 'air', type: 'KD-38H', count: 3, formation: 'loose', position: 'low', distance: 5500 },
      ] },
    ],
  },
  {
    id: 21, name: 'Unwound',
    briefing: 'Mainspring is up in the Q12 over Lanternport, alone, waiting for you. One last duel, Wingnut: unwind the spring.',
    setting: 'city dusk', location: 'Lanternport at sundown', time: '18:00',
    wingmen: [],   // the duel is flown alone
    phases: [
      { label: 'Mainspring', groups: [
        { kind: 'air', type: 'Q12 MAINSPRING', count: 1, formation: 'pair', position: 'ahead', distance: 4000 },
        { kind: 'air', type: 'Q10', count: 4, formation: 'vee', position: 'ahead', distance: 4500, difficulty: 'mercenary' },  // unmarked wingmen, no IFF
      ] },
    ],
  },
];

// ------------------------------------------------------------------------------------------------------------------------
// Tiny helpers.

const LEVELS = ['easy', 'normal', 'hard', 'mercenary'];   // groups[].difficulty spawns at that level and above

/** Unit totals for a mission or a single phase as flown at `difficulty` (default 'normal', so difficulty extras are
 *  left out): { air, ground, naval, optional }. */
export function countUnits(missionOrPhase, difficulty = 'normal') {
  const phases = missionOrPhase.phases || [missionOrPhase];
  const lvl = LEVELS.indexOf(difficulty);
  const n = { air: 0, ground: 0, naval: 0, optional: 0 };
  for (const p of phases) for (const g of p.groups) {
    if (g.difficulty && LEVELS.indexOf(g.difficulty) > lvl) continue;
    n[g.kind] += g.count; if (g.optional) n.optional += g.count;
  }
  return n;
}

/** Check MISSIONS against the type tables and the performance caps (the air cap counts every group, i.e. the
 *  Mercenary total). Returns a list of problems (empty = clean). */
export function validateMissions(missions = MISSIONS) {
  const out = [];
  for (const m of missions) {
    if ('wingmen' in m) {
      const w = m.wingmen;
      if (!Array.isArray(w) || w.some((n) => n !== '2' && n !== '3') || new Set(w).size !== w.length) out.push(`M${m.id}: wingmen must be a list of distinct '2' / '3'`);
    }
    const allies = 'allies' in m ? m.allies : [];
    if (!Array.isArray(allies)) out.push(`M${m.id}: allies must be a list`);
    else for (const a of allies) {
      const where = `M${m.id} allies ${a.name || '?'}`, ph = a.phase || 0, naval = a.kind === 'naval';
      if (!naval && a.kind !== 'ground') out.push(`${where}: kind must be 'ground' or 'naval'`);
      if (!(Number.isInteger(ph) && ph >= 0 && ph < m.phases.length)) out.push(`${where}: bad phase`);
      else if (a.near && !(a.after && m.phases[ph].groups.some((g) => g.kind !== 'air' && g.type === a.near && !g.difficulty))) out.push(`${where}: near needs after: true and a '${a.near}' group in its phase`);
      if (!Array.isArray(a.units) || !a.units.length) { out.push(`${where}: no units`); continue; }
      a.units.forEach((u, k) => {
        const t = GROUND_TYPES[u.type];
        if (!t) out.push(`${where}: unknown type ${u.type}`);
        else if (naval !== !!t.naval) out.push(`${where} ${u.type}: kind/naval mismatch`);
        if (!(u.count >= 1 && u.count <= 20)) out.push(`${where} ${u.type}: count must be 1-20`);
        if (u.escort && (!naval || k === 0)) out.push(`${where} ${u.type}: escorts are ships after the flagship`);
      });
    }
    m.phases.forEach((p, i) => {
      let air = 0;
      for (const g of p.groups) {
        const where = `M${m.id} phase ${i + 1} ${g.type}`;
        if ('difficulty' in g && !['hard', 'mercenary'].includes(g.difficulty)) out.push(`${where}: bad difficulty`);
        if ('target' in g && (g.target !== 'fleet' || g.kind !== 'air' || !AIRCRAFT_TYPES[g.type] || AIRCRAFT_TYPES[g.type].armed !== false
          || !(Array.isArray(allies) && allies.some((a) => a.kind === 'naval' && (a.phase || 0) <= i)))) out.push(`${where}: target 'fleet' needs an unarmed air type and an allied fleet by this phase`);
        if (g.kind === 'air') {
          if (!AIRCRAFT_TYPES[g.type]) out.push(`${where}: unknown aircraft type`);
          if (g.count > 8) out.push(`${where}: air group over 8`);
          air += g.count;
        } else {
          const t = GROUND_TYPES[g.type];
          if (!t) out.push(`${where}: unknown ground type`);
          else if ((g.kind === 'naval') !== !!t.naval) out.push(`${where}: kind/naval mismatch`);
          if (g.count > 24) out.push(`${where}: surface group over 24`);
        }
      }
      if (air > 16) out.push(`M${m.id} phase ${i + 1}: ${air} aircraft (over 16)`);
      if (!p.groups.some((g) => !g.difficulty)) out.push(`M${m.id} phase ${i + 1}: empty below Hard`);
    });
  }
  return out;
}
