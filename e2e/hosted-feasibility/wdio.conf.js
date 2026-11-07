import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHosted } from './helpers.js';
import { config as base } from '../wdio.conf.js';
requireHosted();
export const config = {
    ...base,
    specs: [fileURLToPath(new URL('./recovery.e2e.js', import.meta.url))],
    outputDir: path.join(path.dirname(process.env.HOSTED_REPORT_FILE), 'wdio-logs'),
    connectionRetryCount: 0,
    mochaOpts: { ...base.mochaOpts, timeout: 1_800_000 },
};
