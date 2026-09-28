// Firefox can retain an installation default for each historical app location.
// More than one profile can therefore be marked as default. Match the Rust
// selector: prefer the default furthest through extension setup, retaining the
// first on ties. This is a setup heuristic, not proof of the running profile.
export function preferredBrowserProfile(browser) {
    const profiles = Array.isArray(browser?.profiles) ? browser.profiles : [];
    const defaults = profiles.filter(profile => profile?.isDefault);
    if (!defaults.length) return profiles[0] || null;
    const rank = profile => Number(Boolean(profile?.installed)) * 4
        + Number(profile?.enabled === true) * 2
        + Number(profile?.privateBrowsing === true);
    return defaults.reduce((best, candidate) => (
        rank(candidate) > rank(best) ? candidate : best
    ));
}
