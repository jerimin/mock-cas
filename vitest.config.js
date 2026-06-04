import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    reporters: ["default"],
    coverage: {
      include: ["public/assets/js/lib/**/*.js"],
    },
  },
});
