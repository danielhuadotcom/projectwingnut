// tools/dialogue_voices.mjs — voices and TTS style directions for the story dialogue (tools/dialogue_lines.mjs).
// The voices are the LOCKED VOICES of the designer's notes (DIALOGUE_NOTES.md); the WSO's prompts follow its WSO WINNING
// RECIPE (below). AWACS keeps its own voice and style keys (tools/awacs_lines.mjs).
import { AWACS_VOICE, AWACS_STYLES } from './awacs_lines.mjs';

export const DIALOGUE_MODEL = 'gemini-3.8-flash-tts';
export const DIALOGUE_VOICES = {
  AWACS: { voice: AWACS_VOICE.voice, languageCode: AWACS_VOICE.languageCode, catalog: 'en-us-ludo' },
  WSO: { voice: 'Call Center Agent 7', languageCode: 'en-ZA', catalog: 'en-za-csagent-7' },
  MAINSPRING: { voice: 'Kira', languageCode: 'en-GB', catalog: 'en-us-kira' },   // Kira with en-GB (accepted, same voice)
};

// WSO: the designer-approved recipe (DIALOGUE_NOTES.md "WSO WINNING RECIPE"; prompts in
// assets/voice_audition/climb2/index.txt and method/recipes.mjs.txt). A second-person acting scene per line (what just
// happened), in one of two modes: combat (in the fight: fast, sharp) or transit (moving in or out: lazier, dry banter).
// The row's delivery note rides on top as a light modifier; then the "not a narrator" clause and the accent line.
// Voice Call Center Agent 7, languageCode en-ZA (en-US swaps the voice), temperature 1.0; post: tight gaps, x1.15.
const TAIL = 'You are not a narrator, not a podcast host, not reading a script: you are reacting.';
const ACCENT = 'Accent: neutral, barely-there; General American-leaning English, with no noticeable South African vowels.';
const COMBAT_ACT = (scene, mod = '') => `You are the weapons systems officer in the back seat of a fighter jet in the middle of a dogfight, heart pounding, the G pulling at you. ${scene} You call it to your pilot over the intercom the instant it happens: fast and sharp, a hit of adrenaline, tomboyish edge, full chest voice, loud over the engine. One quick burst, no pauses.${mod ? ' ' + mod : ''} ${TAIL} Not slow, not sleepy. No breath or laugh before speaking; start immediately. ${ACCENT}`;
const TRANSIT_ACT = (scene, mod = '', somber = false) => `You are the weapons systems officer in the back seat of a fighter jet, in transit between fights, nobody shooting at you right now. ${scene} You ${somber ? 'say it to' : 'needle'} your pilot over the intercom with the engine droning: ${somber ? 'low and plain, no show, the feeling held back' : 'lazy-confident, dry and amused, a smirk in your voice'}, tomboyish; tossed off quickly${somber ? '' : ' like a private joke'}, not performed. Keep it moving, only a short beat between sentences.${mod ? ' ' + mod : ''} ${TAIL} Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. ${ACCENT}`;
// m01_1: the climb2 winner float_act_3__a, verbatim (designer: "excellent")
const FLOAT_WINNER = `You are the weapons systems officer in the back seat of a fighter jet, still mid-fight. You just watched the enemy floatplane explode off your nose; adrenaline still spiking, you can't hide a grin. You fire this off to your pilot over the intercom with the engine roaring: fast, clipped, cocky, no pause between the two sentences, the second a quick cheeky jab. Tomboyish edge, full chest voice. ${TAIL} Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. ${ACCENT}`;
// lockOn: the climb2 winner target_act_3__a's scene
const LOCK_SCENE = 'The radar tone just went solid on the bandit ahead.';
/** id -> [mode, scene]: mode 'combat' | 'transit' | 'somber' (transit, held back). */
export const WSO_SCENES = {
  m01_4: ['transit', 'The stolen crate you just shot blew up in a blinding flash over the sea, and now you are turning for home, a little rattled.'],
  m02_2: ['transit', 'You are pushing toward the border and an enemy radar plane has just shown up on your scope, all for your little squadron.'],
  m02_3: ['transit', 'A flight of heavy Squall fighters just appeared on your screen, coming for you.'],
  m03_1: ['transit', 'You are flying in over the air base you are about to take for yourselves, eyeing the hangars.'],
  m03_3: ['transit', 'The base is yours now and you are circling to land at your new home.'],
  m04_2: ['transit', 'A second wave of bombers is heading for the besieged troops on the ridge below.'],
  m04_3: ['transit', 'The guns around the friendly troops just went quiet, and the soldiers below are waving up at you.'],
  m05_2: ['somber', 'The ferries are away, and below you the capital is losing power, its lights going dark district by district.'],
  m05_4: ['somber', 'You are leaving the fallen capital behind, the people still ashore left to the enemy.'],
  m06_1: ['transit', 'You are flying in toward the enemy refineries, tanks full of bottled lightning.'],
  m07_2: ['transit', 'The stolen battleship just came into view under the storm clouds.'],
  m07_4: ['transit', 'The fight is over and the rescued battleship is flashing thanks at you with her signal lamp.'],
  m08_1: ['transit', 'You are flying in to hunt cargo planes, nothing much for you to do in the back.'],
  m08_3: ['combat', 'Two enemy aces are merging head-on, flying as a perfectly timed pair.'],
  m08_4: ['transit', 'The convoys are down and you are heading home, pleased with yourself.'],
  m09_1: ['transit', 'It is night, you are sneaking up a fjord alone, and the radar controller just sounded tired on the radio.'],
  m09_3: ['combat', 'You have reached the last missile site on the fjord, the one called Anvil.'],
  m10_2: ['transit', 'The enemy fighters are parked on the airstrip you need to land on.'],
  m11_1: ['combat', 'You just arrived over the biggest dogfight of the war and your scope is full of enemy contacts.'],
  m11_5: ['combat', 'An elite enemy squadron just announced itself on your frequency.'],
  m11_7: ['combat', 'The enemy commander just ordered her whole squadron to hunt you down.'],
  m12_1: ['transit', 'You are flying in low over a dark sea toward enemy oil rigs at midnight.'],
  m13_2: ['transit', 'The enemy fleet is tied up in the harbor below, half asleep, sitting ducks.'],
  m13_3: ['transit', 'The enemy fleet is sunk in its own harbor and you are pulling away.'],
  m14_1: ['combat', 'Below you the retreating enemy is setting the old forest on fire.'],
  m14_3: ['somber', 'The enemy has surrendered, and the forest below is still burning.'],
  m15_3: ['combat', 'A huge salvo of enemy missiles just launched at the city, too many to stop.'],
  m15_4: ['somber', 'The first missile just hit the city: a blinding blast where the glassworks stood.'],
  m15_7: ['somber', 'The city below is gone and the sky has turned blood red.'],
  m16_1: ['transit', 'You are flying in over the ruins of your old base and an enemy jet is circling it.'],
  m16_3: ['combat', 'The mercenaries flying the enemy escort turn out to be the pilots you used to share a base with.'],
  m16_4: ['combat', 'You are shooting at the pilots you used to eat breakfast with, and it hurts.'],
  m17_2: ['transit', 'The first targets are down, and you are thinking about how much your employer keeps paying.'],
  m17_3: ['transit', 'The job is done and you are heading home; you want your pilot to know you are not going anywhere.'],
  m18_1: ['somber', 'You are flying in over the ruined city, still glowing from the blast.'],
  m18_4: ['combat', 'The enemy commander just blamed you for the city her own missiles destroyed.'],
  m19_2: ['transit', 'You are flying in toward the last big naval battle, exhausted from the war.'],
  m19_4: ['somber', 'The battle is over and the water below is full of sailors from both sides.'],
  m20_1: ['transit', 'You are flying back into the capital you promised to return to.'],
  m20_4: ['combat', 'An unknown jet is screaming over the city far above you, heading somewhere fast.'],
  m21_1: ['somber', 'Everyone you knew is gone and the radio is silent; you are steadying yourself before the final duel.'],
  m21_3: ['combat', 'The G-force is crushing you and you are blacking out mid-sentence.'],
  tunnel_1: ['combat', 'Your pilot is lining up to fly straight into a narrow tunnel through the mountain.'],
  tunnel_2: ['combat', 'You are inside the tunnel, rock walls flashing past a few metres from the wingtips.'],
  tunnel_3: ['combat', 'You just burst out of the far end of the tunnel in one piece.'],
  wso_1: ['combat', 'An enemy fighter just slid in right behind you.'],
  wso_2: ['combat', 'An enemy fighter just slid in right behind you.'],
  wso_3: ['combat', 'An enemy missile just launched at you.'],
  wso_4: ['combat', 'An enemy missile just launched at you.'],
  wso_5: ['combat', 'The missile chasing you just went for the flares and missed.'],
  wso_7: ['combat', 'You just watched the bandit you were shooting at explode.'],
  wso_8: ['combat', 'That was your third kill in a row.'],
  wso_9: ['combat', 'You just watched an enemy gun emplacement on the ground blow up.'],
  wso_10: ['combat', 'Enemy fire just hit your jet hard.'],
  wso_11: ['combat', 'Your jet is badly damaged and every warning light is on.'],
  wso_12: ['combat', 'The ground is rushing up at you.'],
  wso_13: ['combat', 'Fresh enemy contacts just appeared on your radar.'],
  wso_14: ['combat', LOCK_SCENE],
  wso_15: ['combat', LOCK_SCENE],
  wso_16: ['combat', 'The bandit is right in front of you, close enough for the cannon.'],
  wso_17: ['combat', 'The bandit is right in front of you, close enough for the cannon.'],
};
for (let i = 1; i <= 8; i++) WSO_SCENES[`wso_lock_${i}`] = ['combat', LOCK_SCENE];
/** Takes kept from the first batch (designer-approved): not regenerated. */
export const KEEP = new Set(['typical', 'm11_4', 'm21_5', 'm11_8']);
export const WSO_TTS = { temperature: 1.0, tempo: 1.15, maxGap: 0.2 };   // generation and post-processing for WSO clips

// Mainspring: the designer's pick, round mainspring2 "_xy" (assets/voice_audition/mainspring2/index.txt): Kira with
// languageCode en-GB, temperature 1.0, the mainspring1 a2 recipe plus "Accent: crisp, cultured British English, Received
// Pronunciation; no American vowels." The exact per-line prompts, for any future regeneration (post: internal gaps over
// 120 ms cut to 80 ms, trim, x1.12, -18 LUFS: MAINSPRING_TTS). The shipped clips are those takes, copied in by
// tools/build_dialogue.mjs (tools/dialogue_takes.json "source"); "Typical." keeps its first-batch clip.
export const MAINSPRING_TTS = { temperature: 1.0, tempo: 1.12, maxGap: 0.08 };
export const MAINSPRING_STYLES = {
  m06_3: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. You are leading Chime Squadron in behind the mercenary jet, closing fast, and you claim the kill for yourself. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m06_4: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. Your squadron is breaking off after the mercenary wrecked the mission, and you throw a threat at them as you pull away. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m11_4: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. Your squadron is diving in on the mercenaries, and you announce your arrival. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m11_6: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. You have just spotted the mercenary jet and you unleash your whole squadron on it. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m11_8: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are retreating after the mercenary shot down several of your pilots; icy, accusing. A cold, defiant parting shot over the open radio, only lightly a defiant exclamation: clipped and quick, contempt held tight, not shouted. You are not a narrator, not a podcast host, not reading a script. Not slow, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m12_3: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. You have just launched off the rig deck in your prototype, furious that the mercenaries are wrecking your rigs. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m12_4: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. The mercenary has just shot your jet half to pieces, and now you are angry. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m12_5: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. The mercenary has just shot you down; you are ejecting from your burning prototype, unbothered. A cold, defiant parting shot over the open radio, only lightly a defiant exclamation: clipped and quick, contempt held tight, not shouted. You are not a narrator, not a podcast host, not reading a script. Not slow, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m16_2: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. You are back in a brand-new jet, sliding onto the mercenary\u2019s tail again. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m18_3: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. You are leading the last four jets of Chime Squadron in for revenge over the glowing ruins of Kelderwick. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m20_5: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. Thunderglass warheads are detonating across the city below you, and you put the blame on the mercenary. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m21_2: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. The final duel under a red sky: you have just found the mercenary jet. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m21_4: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You are mid-dogfight, transmitting on an open radio channel the enemy can hear. The mercenary's back-seater has just blacked out; it is down to the two of you. Defiant exclamation: you shout this over the radio, fast and hard over the roar of your engine, contempt and defiance in every word, no hesitation. One quick burst, no pauses between sentences. You are not a narrator, not a podcast host, not reading a script: you are fighting. Not slow, not sleepy, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m21_5: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. Mid-duel, after your cluster-bomb pass over the burning city, you tell the mercenary flatly whose fault it is. A cold, defiant parting shot over the open radio, only lightly a defiant exclamation: clipped and quick, contempt held tight, not shouted. You are not a narrator, not a podcast host, not reading a script. Not slow, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  m21_6: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. The mercenary has finally shot you down at the end of the last duel; you are going down, tired, almost fond. A cold, defiant parting shot over the open radio, only lightly a defiant exclamation: clipped and quick, contempt held tight, not shouted. You are not a narrator, not a podcast host, not reading a script. Not slow, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
  typical: "You are Mainspring, a 46-year-old enemy ace commanding Chime Squadron: cool, contemptuous, utterly sure of yourself. You have just shot down the mercenary pilot Wingnut, again; bored, a little disappointed. A cold, defiant parting shot over the open radio, only lightly a defiant exclamation: clipped and quick, contempt held tight, not shouted. You are not a narrator, not a podcast host, not reading a script. Not slow, not drawn out. No breath or laugh before speaking; start immediately. Accent: crisp, cultured British English, Received Pronunciation; no American vowels.",
};
/** The AWACS style key for a delivery note: its first word that names one (grave = somber, upbeat = positive). */
export function awacsStyleKey(note) {
  const map = { grave: 'somber', upbeat: 'positive', relieved: 'positive', alarm: 'urgent', proud: 'dry' };
  for (const w of String(note).toLowerCase().split(/[^a-z]+/)) { if (AWACS_STYLES[w]) return w; if (map[w]) return map[w]; }
  return 'calm';
}
/** { styleName, style } sent as speechMetadata.style (never spoken). */
export function styleFor(line) {
  const note = (line.note || '').replace(/;.*$/, '').trim();
  if (line.speaker === 'AWACS') { const k = awacsStyleKey(note); return { styleName: k, style: AWACS_STYLES[k] }; }
  if (line.speaker === 'MAINSPRING') {
    if (!MAINSPRING_STYLES[line.id]) throw new Error(`${line.id}: no Mainspring prompt (tools/dialogue_voices.mjs MAINSPRING_STYLES)`);
    return { styleName: 'mainspring-xy', style: MAINSPRING_STYLES[line.id] };
  }
  if (line.id === 'm01_1') return { styleName: 'wso-float', style: FLOAT_WINNER };
  const sc = WSO_SCENES[line.id];
  const mod = note ? `Light modifier: ${note}.` : '';
  if (sc) return sc[0] === 'combat' ? { styleName: 'wso-combat', style: COMBAT_ACT(sc[1], mod) } : { styleName: 'wso-' + sc[0], style: TRANSIT_ACT(sc[1], mod, sc[0] === 'somber') };
  throw new Error(`${line.id}: no WSO scene (tools/dialogue_voices.mjs WSO_SCENES)`);
}
