import { defineConfig } from 'vitest/config';

// Tier 0: plain unit tests over the pure helpers in `src/`.
//
// Deliberately NOT `vite.config.js` — that config carries the index.html
// rewriting plugins, none of which mean
// anything when the entry point is a test file rather than the app shell.
// The only thing Tier 0 needs from the build is the platform/build-flavor
// compile-time constants, so the modules under test resolve the same branches
// they do in a desktop build. Both must be defined even when no current test
// reaches one: an undefined identifier is a ReferenceError at call time, not a
// folded-away branch.
export default defineConfig({
    define: {
        __SYSTEM_TEST_BUILD__: false,
    },
    test: {
        include: ['test/tier0/**/*.test.js'],
        // Several `src/` modules import siblings that touch `document` at
        // import time; jsdom keeps Tier 0 usable for those without each test
        // having to hand-roll a DOM.
        environment: 'jsdom',
        restoreMocks: true,
    },
});
