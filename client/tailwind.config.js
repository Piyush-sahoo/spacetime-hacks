/** @type {import('tailwindcss').Config} */
// Utility colours resolve to the atlas tokens, so a Tailwind class on any
// surface lands inside the design system instead of beside it.
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        accent: 'var(--ink)',
        paper: 'var(--paper)',
        'paper-deep': 'var(--paper-2)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-2)',
        muted: 'var(--ink-2)',
        cream: 'var(--hi-fg)',
        line: 'var(--rule)',
        danger: 'var(--ink)',
        good: 'var(--ink)',
        face: 'var(--face)',
        rule: 'var(--rule)',
      },
      borderRadius: { DEFAULT: '0px', sm: '0px', md: '0px', lg: '0px', xl: '0px', '2xl': '0px', '3xl': '0px', full: '0px' },
    },
  },
  plugins: [],
}
