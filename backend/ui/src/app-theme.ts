import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
  applyTheme,
} from '@material/material-color-utilities';

export type ThemeMode = 'light' | 'dark';

type NeutralPalette = {
  tone(tone: number): number;
};

const SURFACE_PATCHES: Record<ThemeMode, Array<[string, number]>> = {
  dark: [
    ['surface-container-lowest', 4],
    ['surface-container-low', 10],
    ['surface-container', 12],
    ['surface-container-high', 17],
    ['surface-container-highest', 22],
    ['surface-dim', 6],
    ['surface-bright', 24],
  ],
  light: [
    ['surface-container-lowest', 100],
    ['surface-container-low', 96],
    ['surface-container', 94],
    ['surface-container-high', 92],
    ['surface-container-highest', 90],
    ['surface-dim', 87],
    ['surface-bright', 98],
  ],
};

let currentSeed = '#4aa3ff';
let currentMode: ThemeMode = 'dark';
let currentSignature = '';
let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((ev: MediaQueryListEvent) => void) | null = null;
let hostMode: ThemeMode | null = null;

function detectMode(): ThemeMode {
  try {
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    return mq && mq.matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

function patchSurfaceTokens(root: HTMLElement, neutral: NeutralPalette): void {
  const patches = SURFACE_PATCHES[currentMode];
  for (const [name, tone] of patches) {
    root.style.setProperty(`--md-sys-color-${name}`, hexFromArgb(neutral.tone(tone)));
  }
}

function renderTheme(): void {
  const signature = `${currentSeed}|${currentMode}`;
  if (signature === currentSignature) return;
  currentSignature = signature;

  const root = document.documentElement;
  root.dataset.theme = currentMode;
  root.style.setProperty('--app-color-scheme', currentMode);
  root.style.colorScheme = currentMode;

  const theme = themeFromSourceColor(argbFromHex(currentSeed));
  applyTheme(theme, { target: root, dark: currentMode === 'dark' });
  patchSurfaceTokens(root, theme.palettes.neutral as NeutralPalette);
}

export function initTheme(seedHex: string): void {
  currentSeed = seedHex || currentSeed;
  currentMode = detectMode();
  renderTheme();

  if (mediaQuery || typeof window.matchMedia !== 'function') {
    return;
  }
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaListener = () => {
    if (hostMode) return;
    currentMode = mediaQuery?.matches ? 'dark' : 'light';
    renderTheme();
  };
  if ('addEventListener' in mediaQuery) {
    mediaQuery.addEventListener('change', mediaListener);
  } else {
    mediaQuery.addListener(mediaListener);
  }
}

export function setThemeSeed(seedHex: string | null | undefined): void {
  if (seedHex) currentSeed = seedHex;
  renderTheme();
}

export function setThemeMode(mode: ThemeMode | null | undefined): void {
  hostMode = mode === 'light' || mode === 'dark' ? mode : null;
  const next = hostMode ?? detectMode();
  if (next !== currentMode) {
    currentMode = next;
    renderTheme();
  }
}
