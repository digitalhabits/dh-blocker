import { createHash } from 'node:crypto';
import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleIds, command, team } from './common.mjs';

export function plist(path, key, optional = false) {
    try {
        return command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path]);
    } catch (error) {
        if (!optional) throw error;
        return '';
    }
}

function values(array) {
    return array.split('\n').slice(1, -1).map(value => value.trim());
}

export function readProfile(profile) {
    const temp = mkdtempSync(join(tmpdir(), 'redd-ios-profile-'));
    const file = join(temp, 'profile.plist');
    try {
        writeFileSync(file, command('security', ['cms', '-D', '-i', profile]), { mode: 0o600 });
        const certs = [];
        for (let i = 0; ; i++) {
            const cert = command('plutil', ['-extract', `DeveloperCertificates.${i}`, 'raw', '-expect', 'data', '-o', '-', file]);
            certs.push(createHash('sha1').update(Buffer.from(cert, 'base64')).digest('hex').toUpperCase());
            const count = Number(command('plutil', ['-extract', 'DeveloperCertificates', 'raw', '-expect', 'array', '-o', '-', file]));
            if (i + 1 >= count) break;
        }
        return {
            uuid: plist(file, 'UUID'),
            expires: command('plutil', ['-extract', 'ExpirationDate', 'raw', '-expect', 'date', '-o', '-', file]),
            applicationId: plist(file, 'Entitlements:application-identifier'),
            teamId: plist(file, 'TeamIdentifier:0'),
            familyControls: plist(file, 'Entitlements:com.apple.developer.family-controls', true) === 'true',
            groups: values(plist(file, 'Entitlements:com.apple.security.application-groups', true)),
            devices: values(plist(file, 'ProvisionedDevices', true)),
            development: plist(file, 'Entitlements:get-task-allow', true) === 'true',
            certificates: certs,
        };
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

export function profileMatches(profile, bundle, mode, udid, identities, now = Date.now()) {
    return profile.applicationId === `${team}.${bundle}`
        && profile.teamId === team && Date.parse(profile.expires) > now
        && profile.familyControls && profile.groups.includes('group.com.reddblock')
        && profile.certificates.some(cert => identities.includes(cert))
        && (mode === 'device' ? profile.development && profile.devices.includes(udid)
            : !profile.development && profile.devices.length === 0);
}

export function signingProfiles(mode, udid) {
    const identities = command('security', ['find-identity', '-v', '-p', 'codesigning'])
        .split('\n').filter(line => mode === 'device' ? /Apple Development|iPhone Developer/.test(line) : /Apple Distribution|iPhone Distribution/.test(line))
        .map(line => line.match(/\b[A-F0-9]{40}\b/)?.[0]).filter(Boolean);
    if (!identities.length) throw new Error(`No ${mode === 'device' ? 'Apple Development' : 'Apple Distribution'} identity with private key in the Keychain.`);
    const directories = [
        join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
        join(homedir(), 'Library/MobileDevice/Provisioning Profiles'),
    ];
    const profiles = [];
    for (const dir of directories) {
        let files;
        try {
            files = readdirSync(dir);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        for (const file of files.filter(file => file.endsWith('.mobileprovision'))) {
            try {
                profiles.push(readProfile(join(dir, file)));
            } catch (error) {
                console.warn(`Could not decode provisioning profile ${file}: ${error.message.split('\n')[0]}`);
            }
        }
    }
    const missing = bundleIds.filter(id => !profiles.some(profile => profileMatches(profile, id, mode, udid, identities)));
    if (missing.length) {
        throw new Error(`Missing matching team ${team} ${mode} provisioning profiles for ${missing.join(', ')}. In Xcode, download profiles with Family Controls and group.com.reddblock for all three targets.`);
    }
    return profiles
        .filter(profile => bundleIds.some(id => profileMatches(profile, id, mode, udid, identities)))
        .map(({ applicationId, uuid, expires }) => ({ applicationId, uuid, expires }));
}
