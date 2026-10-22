export const STYLES = [
  { bg: '#F6C177', skin: '#E8B592', hair: '#5A3A22', shirt: '#2F6F5E', h: 1 },
  { bg: '#9CC5E8', skin: '#C98E67', hair: '#1E1E1E', shirt: '#B2433A', h: 0 },
  { bg: '#C9B6E4', skin: '#F0C8A8', hair: '#B5651D', shirt: '#12202B', h: 2 },
  { bg: '#A8D5BA', skin: '#D9A47C', hair: '#2B1B12', shirt: '#E0A526', h: 1 },
  { bg: '#F2A5A0', skin: '#E8B592', hair: '#8A8A8A', shirt: '#3A4F8C', h: 0 },
];

/** Placeholder portrait used until an admin uploads a real photo. */
export function avatarSvg(styleIdx: number): string {
  const s = STYLES[((styleIdx % STYLES.length) + STYLES.length) % STYLES.length];
  const cap = (c: string) => `<path d="M20 27a12 12 0 0 1 24 0c-5-5-19-5-24 0z" fill="${c}"/>`;
  let back = '', front = '';
  if (s.h === 0) front = cap(s.hair);
  if (s.h === 1) { back = `<path d="M18 32c-2-18 28-18 28 0v13h-5V31H23v14h-5z" fill="${s.hair}"/>`; front = cap(s.hair); }
  if (s.h === 2) front = `<circle cx="32" cy="14" r="6" fill="${s.hair}"/><path d="M20 28a12 12 0 0 1 24 0c-5-6-19-6-24 0z" fill="${s.hair}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${s.bg}"/>${back}` +
    `<path d="M6 66c2-15 13-21 26-21s24 6 26 21z" fill="${s.shirt}"/><rect x="28" y="36" width="8" height="10" rx="3" fill="${s.skin}"/>` +
    `<circle cx="32" cy="29" r="11.5" fill="${s.skin}"/>${front}<circle cx="27.5" cy="30" r="1.2" fill="#2a2a2a"/><circle cx="36.5" cy="30" r="1.2" fill="#2a2a2a"/>` +
    `<path d="M28.5 35c2 1.6 5 1.6 7 0" stroke="#2a2a2a" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
}
