/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#C8102E',
          dark: '#B5101F',
          light: '#FEECEC',
          muted: '#FEE2E2',
        },
        accent: {
          DEFAULT: '#1B5E20',
          light: '#D1FAE5',
        },
      },
      fontFamily: {
        sans: ['"Be Vietnam Pro"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
