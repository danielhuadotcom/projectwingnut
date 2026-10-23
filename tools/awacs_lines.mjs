// tools/awacs_lines.mjs — the AWACS Claude script: single source of truth for the voice pipeline.
//   event key -> variants. Variant n (1-based) lives at assets/awacs/<key>_<n>.mp3 (trimmed, shipped) and
//   assets/awacs/raw/<key>_<n>.mp3 (TTS output as delivered). The text is both what is spoken and the subtitle.
// Used by tools/build_awacs.mjs (offline rebuild of js/awacs_clips.js) and tools/gen_awacs_tts.mjs (TTS generation).

/** How the raw clips were produced (Gemini API TTS, default MP3 output: 44.1 kHz mono 128 kbps). */
export const AWACS_VOICE = {
  model: 'gemini-3.8-flash-tts',
  voice: 'Ludo',            // catalog id en-us-ludo: male, "confident and clear"
  languageCode: 'en-US',
  tempo: 1.07,              // the API has no speaking-rate knob: a pitch-preserving 1.07x time-stretch is applied at trim time
};

/** Delivery directions, sent as Part.speechMetadata.style (never spoken). */
export const AWACS_STYLES = {
  calm: 'Professional military AWACS radar controller talking to a fighter pilot over the radio: composed, clear and slightly warm, with a brisk, efficient radio cadence.',
  positive: 'Professional military AWACS radar controller on the radio, approving and upbeat but still professional; clear, slightly warm, brisk radio cadence.',
  urgent: 'Professional military AWACS radar controller warning a fighter pilot over the radio: urgent but controlled, fast and clipped.',
  somber: 'Professional military AWACS radar controller on the radio, grave and somber but steady; clear and controlled.',
  callout: 'Military AWACS radar controller calling over a noisy radio to a fighter pilot in combat: a sharp, loud, almost shouted call-out, every syllable crisply enunciated, high energy and emphatic. Not amused, not smug, no laughter, chuckle or breath before speaking; start talking immediately.',
  dry: 'Professional military AWACS radar controller on the radio, dry and deadpan with wry, mildly exasperated humor; still composed, clear and brisk.',
};

/** key -> { style, lines: [text | { text, style }] } */
export const AWACS_LINES = {
  sortieStart: { style: 'calm', lines: ['AWACS Claude on station. Bandits inbound, you are weapons free.', "This is AWACS Claude. Radar is hot. You're cleared to engage."] },
  newContacts: { style: 'calm', lines: ['New contacts on radar. Multiple bandits inbound.', 'Picture update. More bandits closing on your position.', 'Heads up, fresh bandits entering the area.'] },
  groundTargets: { style: 'calm', lines: ['Ground targets marked. Clear them out.', 'Enemy armor and air defenses below. Engage at will.'] },
  navalTargets: { style: 'calm', lines: ['Enemy ships spotted offshore. Engage the fleet.'] },
  kill: { style: 'positive', lines: ['Splash one!', 'Good kill, good kill.', 'Bandit destroyed.', 'Target down. Nice shooting.', "That's a kill."] },
  groundKill: { style: 'positive', lines: ['Ground target destroyed.', 'Direct hit.'] },
  streak: { style: 'positive', lines: [{ text: "Three down. They're getting nervous.", style: 'dry' }, "You're on a roll, Wingnut."] },
  waveClear: { style: 'positive', lines: ['Airspace clear. Nice work.', 'All bandits destroyed. Picture clean.'] },
  missionComplete: { style: 'positive', lines: ['All targets destroyed. Mission complete. Return to base.', 'Mission accomplished. Outstanding flying, Wingnut.'] },
  missileIncoming: { style: 'urgent', lines: ['Missile inbound! Break, break!', 'Enemy missile tracking you. Pop flares!', 'Missile launch on your position!'] },
  missileDefeated: { style: 'calm', lines: [{ text: 'Missile defeated!', style: 'callout' }, 'It missed. Stay sharp.'] },
  playerHit: { style: 'urgent', lines: ["You're hit! Check your status.", 'Damage reported. Keep it together.'] },
  lowHealth: { style: 'urgent', lines: ['Hull integrity critical. Get out of there!'] },
  pullUp: { style: 'urgent', lines: ['Terrain! Pull up, pull up!'] },
  checkSix: { style: 'urgent', lines: ['Bandit on your six!', "Check six, you've got one on your tail."] },
  outOfBounds: { style: 'calm', lines: ["You're leaving the operations area. Turn back."] },
  playerDown: { style: 'somber', lines: ['Wingnut is down. Repeat, Wingnut is down.', 'We lost Wingnut.'] },
  missionFailed: { style: 'somber', lines: ['Mission failed. Regroup and try again.'] },
  tunnelApproach: { style: 'dry', lines: ["Wingnut, that's a tunnel. Please tell me you're not.", "I see where this is going. I don't like it."] },
  tunnelEnter: { style: 'dry', lines: ["And he's in the tunnel. Of course he is.", 'Lost you on radar. Try not to become part of the mountain.', 'Every single time. Fine. Keep it centered.'] },
  tunnelExit: { style: 'dry', lines: ['And out the other side. Show-off.', "You're back on my scope. Never do that again.", 'Unbelievable. Okay, that was cool.'] },
  tunnelCrash: { style: 'dry', lines: ['Well. The mountain won.', "That's going in the report."] },
};

/** Flat list: [{ key, n (1-based), text, style (direction text), styleName }] */
export function awacsVariants() {
  const out = [];
  for (const [key, def] of Object.entries(AWACS_LINES)) {
    def.lines.forEach((v, i) => {
      const text = typeof v === 'string' ? v : v.text;
      const styleName = (typeof v === 'string' ? null : v.style) || def.style;
      out.push({ key, n: i + 1, text, styleName, style: AWACS_STYLES[styleName] });
    });
  }
  return out;
}
