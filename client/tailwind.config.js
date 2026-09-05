/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        accent: '#ff571a',
        paper: '#d4d3cb',
        'paper-deep': '#dcdbd3',
        ink: '#161413',
        'ink-soft': '#4a4642',
        muted: '#838077',
        cream: '#faf9f6',
        line: 'rgba(22, 20, 19, 0.12)',
        danger: '#c02618',
        good: '#2f6b46',
      },
    },
  },
  plugins: [],
}
