import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { arch } from 'node:os';
import { appId, bundleIds, check, command, revision, root, sha256, team, writeJson } from './common.mjs';
import { plist, readProfile, signingProfiles } from './provisioning.mjs';

const tauri = join(root, 'node_modules/.bin/tauri');
const appleDir = join(root, 'src-tauri/gen/apple');
const deviceOptions = ['--timeout', '30', '--json-output', '-'];

export function deviceCommand(args) {
    const response = JSON.parse(command('xcrun', ['devicectl', ...args, ...deviceOptions], { timeout: 35_000 }));
    if (response.info?.outcome !== 'success') throw new Error(`CoreDevice command did not succeed: ${response.info?.outcome}`);
    return response.result;
}

export function selectDevice(devices, selector) {
    const matches = devices.filter(device => device.hardwareProperties?.platform === 'iOS'
        && device.hardwareProperties.reality === 'physical'
        && [device.identifier, device.hardwareProperties.udid].some(id => id?.toLowerCase() === selector?.toLowerCase()));
    if (matches.length !== 1) throw new Error('Specify one connected physical iPhone/iPad by its UDID or CoreDevice identifier from xcrun devicectl list devices.');
    return matches[0];
}

export function connectedDevice(selector) {
    if (!selector) throw new Error('Supply --device with an explicit iPhone or iPad identifier.');
    const { devices } = deviceCommand(['list', 'devices']);
    const device = selectDevice(devices, selector);
    const { hardwareProperties: hw, deviceProperties: properties, connectionProperties: connection } = device;
    const info = { udid: hw.udid, identifier: device.identifier, model: hw.marketingName,
        os: properties.osVersionNumber, osBuild: properties.osBuildUpdate, transport: connection.transportType };
    if (!info.udid || !info.os) throw new Error('The selected device did not report its UDID and OS.');
    if (connection.pairingState !== 'paired') throw new Error('Pair and trust this device in Xcode before proceeding.');
    if (properties.developerModeStatus !== 'enabled') throw new Error('Enable Developer Mode on the selected device.');
    const lock = deviceCommand(['device', 'info', 'lockState', '--device', info.udid]);
    if (lock.passcodeRequired !== false || lock.unlockedSinceBoot !== true) throw new Error('Unlock the selected iOS device.');
    return info;
}

export function installedApp(device) {
    const { apps } = deviceCommand(['device', 'info', 'apps', '--device', device.udid, '--bundle-id', appId]);
    const app = apps.find(app => app.bundleIdentifier === appId);
    return app ? {
        bundleId: app.bundleIdentifier, version: app.version, build: app.bundleVersion,
        developerSigned: app.builtByDeveloper, url: app.url,
    } : null;
}

function toolsInfo() {
    return {
        node: process.version,
        pnpm: command('pnpm', ['--version']),
        xcode: command('xcodebuild', ['-version']),
        swift: command('xcrun', ['swift', '--version']),
        rust: command('rustc', ['--version']),
        tauri: command(tauri, ['--version']),
    };
}

function releaseXcode() {
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    return workflow.match(/xcode-select -s \/Applications\/Xcode_([\d.]+)\.app/)?.[1];
}

export function preferReleaseXcode() {
    const release = releaseXcode();
    const developer = `/Applications/Xcode_${release}.app/Contents/Developer`;
    if (!process.env.DEVELOPER_DIR && release && existsSync(developer)) process.env.DEVELOPER_DIR = developer;
}

export function assertSafeBuild(configs, env) {
    if (env.TAURI_CONFIG || env.CARGO_ENCODED_RUSTFLAGS || env.RUSTFLAGS) {
        throw new Error('Unset TAURI_CONFIG, CARGO_ENCODED_RUSTFLAGS and RUSTFLAGS for the iOS runner.');
    }
    if (configs.some(config => (config.build?.features || []).some(feature => /(?:^|\/)(e2e-webdriver|system-test)$/.test(feature)))) {
        throw new Error('The iOS runner prohibits e2e-webdriver and system-test features.');
    }
}

function verifyToolchain(mode) {
    if (process.platform !== 'darwin') throw new Error('A Mac with full Xcode is required for native iOS builds.');
    if (!existsSync(tauri)) throw new Error('Run pnpm install --frozen-lockfile in this worktree.');
    const developerDir = process.env.DEVELOPER_DIR || command('xcode-select', ['-p']);
    if (!existsSync(join(developerDir, 'Platforms/iPhoneOS.platform'))) throw new Error('Select full Xcode with the iOS SDK.');
    const tools = toolsInfo();
    const sdk = command('xcrun', ['--sdk', mode === 'simulator' ? 'iphonesimulator' : 'iphoneos', '--show-sdk-version']);
    if (mode === 'simulator') {
        const { runtimes } = JSON.parse(command('xcrun', ['simctl', 'list', 'runtimes', '--json']));
        if (!runtimes.some(runtime => runtime.isAvailable && runtime.name.startsWith('iOS ')
            && runtime.version === sdk)) {
            throw new Error(`Tauri requires the iOS ${sdk} Simulator runtime for this Xcode. Install it in Xcode, select a matching Xcode, or use --mode unsigned-device for compilation only.`);
        }
    }
    const [major, minor] = sdk.split('.').map(Number);
    if (major < 26 || (major === 26 && minor < 5)) throw new Error(`iOS SDK ${sdk} is too old. This source needs 26.5 or later.`);
    const simTarget = arch() === 'arm64' ? 'aarch64-sim' : 'x86_64';
    const rustTarget = mode !== 'simulator' ? 'aarch64-apple-ios' : arch() === 'arm64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';
    if (!command('rustup', ['target', 'list', '--installed']).split('\n').includes(rustTarget)) {
        throw new Error(`Install the Rust target with rustup target add ${rustTarget}.`);
    }
    const release = releaseXcode();
    return { ...tools, developerDir, sdk, rustTarget, simTarget, releaseXcode: release,
        matchesReleaseXcode: Boolean(release && tools.xcode.split('\n')[0] === `Xcode ${release}`) };
}

export function preflight(run, mode, selector) {
    run.report.mode = mode;
    const prerequisites = check(run, 'toolchain', 'Xcode, iOS SDK, Rust target and local CLI checked', () => {
        const tools = verifyToolchain(mode);
        run.report.tools = tools;
        if (!tools.matchesReleaseXcode) console.warn(`Using ${tools.xcode.split('\n')[0]}; release uses Xcode ${tools.releaseXcode || 'unknown'}.`);
    }, 'BLOCKED');
    const device = mode !== 'device' || check(run, 'device-ready', 'Paired, unlocked developer device and installed app inventory checked', () => {
        run.report.device = connectedDevice(selector);
        run.report.installedBefore = installedApp(run.report.device);
    }, 'BLOCKED').ok;
    const signing = ['simulator', 'unsigned-device'].includes(mode) || (device && check(run, 'provisioning', 'Signing identity and profiles for the app and both extensions checked', () => {
        run.report.profiles = signingProfiles(mode, run.report.device?.udid);
    }, 'BLOCKED').ok);
    return prerequisites.ok && device && signing;
}

function onlyBundle(directory, suffix) {
    const matches = readdirSync(directory).filter(entry => entry.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${directory}.`);
    return join(directory, matches[0]);
}

function bundleMetadata(app, signed) {
    const paths = [app, ...readdirSync(join(app, 'PlugIns')).filter(path => path.endsWith('.appex')).sort().map(path => join(app, 'PlugIns', path))];
    const bundles = paths.map(path => {
        const info = join(path, 'Info.plist');
        const id = plist(info, 'CFBundleIdentifier');
        const executable = join(path, plist(info, 'CFBundleExecutable'));
        const profile = signed ? readProfile(join(path, 'embedded.mobileprovision')) : undefined;
        if (signed && (profile.teamId !== team || profile.applicationId !== `${team}.${id}` || Date.parse(profile.expires) <= Date.now())) {
            throw new Error(`Unexpected or expired embedded profile for ${id}.`);
        }
        return { id, version: plist(info, 'CFBundleShortVersionString'), build: plist(info, 'CFBundleVersion'),
            executableSha256: sha256(readFileSync(executable)),
            ...(signed && { profile: { uuid: profile.uuid, expires: profile.expires, development: profile.development },
                signing: command('codesign', ['-dvv', '--verbose=4', path], { stderr: true }) }) };
    });
    if (bundles.length !== bundleIds.length || !bundleIds.every(id => bundles.some(bundle => bundle.id === id))) {
        throw new Error('Native app is missing an expected monitor or shield extension.');
    }
    return bundles;
}

export function verifySignedApp(app, log) {
    command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { log });
    command('bash', ['scripts/check-ios-entitlements.sh', app], { log });
    return bundleMetadata(app, true);
}

export function build(run, mode) {
    return check(run, 'native-build', `Tauri Release ${mode} build and embedded bundles verified`, log => {
        const settings = ['src-tauri/tauri.conf.json', 'src-tauri/tauri.ios.conf.json'].map(path => JSON.parse(readFileSync(join(root, path), 'utf8')));
        assertSafeBuild(settings, process.env);
        const tools = run.report.tools;
        const buildDir = join(appleDir, 'build');
        const archive = join(buildDir, 'redd-block_iOS.xcarchive');
        const ipa = join(buildDir, 'arm64', 'Digital Habits Blocker.ipa');
        const before = Date.now();
        const env = { ...process.env, PATH: `${join(root, 'scripts/ios-test/bin')}:${join(root, 'scripts')}:${process.env.PATH}`,
            APPLE_DEVELOPMENT_TEAM: team, IPHONEOS_DEPLOYMENT_TARGET: '16.0',
            CARGO_TARGET_DIR: join(root, 'src-tauri/target'),
        };
        delete env.APPLE_API_KEY;
        delete env.APPLE_API_KEY_PATH;
        delete env.APPLE_API_ISSUER;
        delete env.XCODEBUILD_EXPORT_OPTIONS_PLIST;
        const args = ['ios', 'build', '--ci', '--target', mode === 'simulator' ? tools.simTarget : 'aarch64'];
        if (mode !== 'store') args.push('--archive-only');
        const unsigned = ['simulator', 'unsigned-device'].includes(mode);
        if (unsigned) args.push('--no-sign');
        if (mode === 'device') args.push('--export-method', 'debugging');
        if (mode === 'store') {
            args.push('--export-method', 'app-store-connect');
            env.XCODEBUILD_EXPORT_OPTIONS_PLIST = join(appleDir, 'ExportOptions.store.plist');
        }
        run.report.configuration = { mode, profile: 'Release', tauriArguments: args,
            swiftPMBuildSystem: tools.xcode.startsWith('Xcode 27.') ? 'native for Xcode 27 iOS SDK builds' : 'Xcode default' };
        writeJson(run.file, run.report);
        console.log(`Building ${mode}. Log: ${log}`);
        command(tauri, args, { env, log, timeout: 90 * 60_000 });
        if (statSync(join(archive, 'Info.plist')).mtimeMs < before - 1000) throw new Error('No fresh Xcode archive was produced.');
        const source = onlyBundle(join(archive, 'Products/Applications'), '.app');
        const app = join(dirname(run.file), basename(source));
        command('ditto', [source, app], { log });
        const bundles = unsigned ? bundleMetadata(app, false) : verifySignedApp(app, log);
        if (mode === 'device' && bundles.some(bundle => !bundle.profile.development)) {
            throw new Error('The archive contains a profile other than Apple Development.');
        }
        if (mode === 'simulator') {
            const info = join(app, 'Info.plist');
            const executable = join(app, plist(info, 'CFBundleExecutable'));
            const header = command('xcrun', ['vtool', '-show-build', executable]);
            if (!/platform\s+IOSSIMULATOR/.test(header)) throw new Error('Tauri did not produce an iOS Simulator executable.');
        }
        run.report.artifact = { app: basename(app), bundles };
        if (mode === 'store') {
            if (statSync(ipa).mtimeMs < before - 1000) throw new Error('No fresh store IPA was exported.');
            command('bash', ['scripts/check-ios-entitlements.sh', archive], { log });
            command('bash', ['scripts/check-ios-entitlements.sh', ipa], { log });
            const copy = join(dirname(run.file), basename(ipa));
            command('ditto', [ipa, copy], { log });
            run.report.artifact.ipa = { path: basename(copy), sha256: sha256(readFileSync(copy)) };
        }
        if (JSON.stringify(revision()) !== JSON.stringify(run.report.revision)) {
            throw new Error('Source identity changed while building. Inspect git status before using this artifact.');
        }
    }).ok;
}
