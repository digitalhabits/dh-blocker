import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// In dev (vite dev), index.html loads test-utils.js / blocking-tests.js /
// integration-tests.js so the developer can call runBlockingTests() and
// runIntegrationTests() from the console. In production we don't want to
// ship ~120 KB of test runners, so strip those <script> tags during build.
//
// This must run as a `pre` transformIndexHtml hook: the test files are classic
// scripts (no type="module"), and Vite's core build-html plugin warns
// ("<script> can't be bundled without type=\"module\"") while scanning the HTML
// for bundling. That scan happens before normal-order transformIndexHtml hooks,
// so a normal-order strip removes them from the output but still trips the
// warning. Running `pre` deletes the tags before the scan sees them.
const DEV_TEST_SCRIPTS = ['test-utils', 'blocking-tests', 'integration-tests'];

const stripDevTestScripts = (enabled) => ({
    name: 'strip-dev-test-scripts',
    apply: 'build',
    transformIndexHtml: {
        order: 'pre',
        handler(html) {
            if (!enabled) return html;
            return html.replace(
                /\s*<script src="\.\/(test-utils|blocking-tests|integration-tests)\.js"><\/script>/g,
                '',
            );
        },
    },
});

// `--mode e2e` keeps the test runners in the bundle so a WebDriver session can
// call runIntegrationTests() against a *real built app* (Tier 2 needs the
// native command layer, which a bare Vite page does not have). The kept
// <script> tags are classic scripts, so Vite never bundles them and would
// leave them 404ing — emit each one into the output root by hand.
//
// Never use this mode for a shipped build: it re-adds ~120 KB of test runners
// and exposes the test entry points to end users.
const emitDevTestScripts = (enabled) => ({
    name: 'emit-dev-test-scripts',
    apply: 'build',
    generateBundle() {
        if (!enabled) return;
        for (const name of DEV_TEST_SCRIPTS) {
            this.emitFile({
                type: 'asset',
                fileName: `${name}.js`,
                source: readFileSync(
                    fileURLToPath(new URL(`./src/${name}.js`, import.meta.url)),
                    'utf8',
                ),
            });
        }
    },
});

// The app supports macOS 11 (Safari 14-era WebKit) and iOS 16.0. Vite 8's
// baseline-widely-available default moved Safari from 16.0 to 16.4, so keep
// the compatibility floor explicit rather than inheriting a moving major
// version default. The target applies to both Oxc JS transforms and the CSS
// minifier (via build.cssTarget's default).
const SUPPORTED_BROWSER_TARGETS = ['safari14', 'ios16'];

export default defineConfig(async ({ mode }) => ({
    plugins: [
        stripDevTestScripts(mode !== 'e2e'),
        emitDevTestScripts(mode === 'e2e'),
        // Bundle analysis: `ANALYZE=1 pnpm vite:build` writes
        // dist/stats.html (treemap of what actually ships). Dev-only; no
        // effect on the shipped bundle. Loaded via dynamic import because
        // rollup-plugin-visualizer is ESM-only and this config is CJS.
        process.env.ANALYZE &&
            (await import('rollup-plugin-visualizer')).visualizer({
                filename: 'dist/stats.html',
                gzipSize: true,
                brotliSize: true,
            }),
    ].filter(Boolean),

    define: {
        __SYSTEM_TEST_BUILD__: JSON.stringify(process.env.REDD_BLOCK_SYSTEM_TEST_BUILD === '1'),
    },

    // Root directory is src/
    root: 'src',

    build: {
        outDir: '../dist',
        emptyOutDir: true,
        target: SUPPORTED_BROWSER_TARGETS,
        cssTarget: SUPPORTED_BROWSER_TARGETS,
        cssMinify: 'lightningcss',
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./src/index.html', import.meta.url)),
            },
        },
    },

    // Dev server config
    server: {
        port: 5173,
        strictPort: true,
        // Listen on all interfaces when developing for iOS physical devices
        host: process.env.TAURI_DEV_HOST || false,
    },

    // Clear console on hot reload
    clearScreen: false,
}));
