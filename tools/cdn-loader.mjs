// Node module hook: map the Three.js CDN URL used by the game modules to the local npm package (headless simulation only).
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://cdnjs.cloudflare.com/ajax/libs/three.js/')) return next('three', context);
  return next(specifier, context);
}
