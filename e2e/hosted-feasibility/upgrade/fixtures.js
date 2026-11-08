import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { command } from '../native.js';
import { requireHosted } from '../helpers.js';

export function registerFixtures(fixtures, root, runId) {
    requireHosted();
    const registrations = [];
    const folder = process.platform === 'win32'
        ? path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs', `DHHostedUpgrade-${runId}`) : null;
    if (folder) { assert(!existsSync(folder)); mkdirSync(folder, { recursive: true }); }
    for (const role of ['target', 'secondary']) {
        const entry = fixtures[role];
        assert(realpathSync(entry.binary).startsWith(realpathSync(root) + path.sep));
        const file = process.platform === 'darwin' ? `/Applications/${entry.name}.app` : path.join(folder, entry.name + '.lnk');
        const target = process.platform === 'darwin' ? path.dirname(path.dirname(path.dirname(entry.binary))) : entry.binary;
        assert(!existsSync(file), 'Refusing existing fixture registration');
        if (process.platform === 'darwin') {
            command('/usr/bin/sudo', ['/bin/ln', '-s', target, file]);
        } else {
            process.env.HOSTED_SHORTCUT_FILE = file;
            process.env.HOSTED_SHORTCUT_TARGET = target;
            process.env.HOSTED_SHORTCUT_DIRECTORY = path.join(entry.directory, 'state');
            process.env.HOSTED_SHORTCUT_TITLE = entry.name + '-shortcut';
            command('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference = "Stop"; $link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:HOSTED_SHORTCUT_FILE); $link.TargetPath = $env:HOSTED_SHORTCUT_TARGET; $link.Arguments = "`"$env:HOSTED_SHORTCUT_DIRECTORY`" `"$env:HOSTED_SHORTCUT_TITLE`""; $link.Save()']);
        }
        registrations.push({ role, file, target });
    }
    return { registrations, cleanup() {
        requireHosted();
        for (const item of registrations) {
            if (process.platform === 'darwin') {
                assert(lstatSync(item.file).isSymbolicLink() && realpathSync(item.file) === realpathSync(item.target), 'Fixture link ownership changed');
                command('/usr/bin/sudo', ['/bin/rm', item.file]);
            } else {
                process.env.HOSTED_SHORTCUT_FILE = item.file;
                const target = command('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).CreateShortcut($env:HOSTED_SHORTCUT_FILE).TargetPath']).trim();
                assert.equal(path.resolve(target).toLowerCase(), path.resolve(item.target).toLowerCase(), 'Fixture shortcut ownership changed');
                unlinkSync(item.file);
            }
        }
        if (folder) rmdirSync(folder); // Refuse unexpected files rather than recurse.
    } };
}
