/** @type {import('tailwindcss').Config} */
export default {
  // `relative: true` resolves globs from this file, not from process.cwd(), so styles are
  // generated whether Vite is started from frontend/ or from the repo root (npm run dev).
  content: {
    relative: true,
    files: ["./index.html", "./src/**/*.{ts,tsx}"],
  },
  theme: { extend: {} },
  plugins: [],
};
