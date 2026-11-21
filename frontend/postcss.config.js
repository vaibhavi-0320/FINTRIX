import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    // Explicit config path: Tailwind otherwise looks in process.cwd().
    tailwindcss: { config: path.join(here, "tailwind.config.js") },
    autoprefixer: {},
  },
};
