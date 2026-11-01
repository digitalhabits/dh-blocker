// Pure shared utilities: HTML escaping, URL display cleanup, color math.
// Extracted verbatim from app.js. Leaf module: no app imports.

export function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function cleanUrlForDisplay(url) {
    return url
        .replace(/^https?:\/\//, '')  // Remove http:// or https://
        .replace(/^www\./, '')         // Remove www.
        .replace(/\/$/, '');           // Remove trailing slash
}

// Parse #rgb / #rrggbb into { r, g, b } or null.
export function parseRgbFromColorString(color) {
    if (!color || typeof color !== 'string') return null;

    if (color.startsWith('#')) {
        const hex = color.slice(1);
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16),
            };
        }
        if (hex.length >= 6) {
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
            };
        }
        return null;
    }

    if (color.startsWith('rgb')) {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return null;
        return {
            r: parseInt(match[1], 10),
            g: parseInt(match[2], 10),
            b: parseInt(match[3], 10),
        };
    }

    return null;
}

export function rgbToHex(r, g, b) {
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    return `#${[clamp(r), clamp(g), clamp(b)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    let hue = 0;
    let saturation = 0;

    if (max !== min) {
        const delta = max - min;
        saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        switch (max) {
            case rn:
                hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
                break;
            case gn:
                hue = ((bn - rn) / delta + 2) / 6;
                break;
            default:
                hue = ((rn - gn) / delta + 4) / 6;
        }
    }

    return { h: hue * 360, s: saturation * 100, l: lightness * 100 };
}

export function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    const saturation = Math.max(0, Math.min(100, s)) / 100;
    const lightness = Math.max(0, Math.min(100, l)) / 100;

    if (saturation === 0) {
        const gray = lightness * 255;
        return [gray, gray, gray];
    }

    const q = lightness < 0.5
        ? lightness * (1 + saturation)
        : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const hueToRgb = (t) => {
        let value = t;
        if (value < 0) value += 1;
        if (value > 1) value -= 1;
        if (value < 1 / 6) return p + (q - p) * 6 * value;
        if (value < 1 / 2) return q;
        if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
        return p;
    };

    return [
        hueToRgb(hue + 1 / 3) * 255,
        hueToRgb(hue) * 255,
        hueToRgb(hue - 1 / 3) * 255,
    ];
}

export function getRelativeLuminance(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Room accent on the ENTERING chip — darkens faded pastels while keeping the hue. */
export function getEnteringChipColor(accentColor) {
    const rgb = parseRgbFromColorString(accentColor);
    if (!rgb) return accentColor || '#667eea';

    const luminance = getRelativeLuminance(rgb.r, rgb.g, rgb.b);
    if (luminance <= 0.42) return accentColor;

    const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const fadeAmount = Math.min(1, (luminance - 0.42) / 0.45);
    const targetLightness = Math.max(36, l - fadeAmount * Math.max(0, l - 40));
    const targetSaturation = Math.min(100, s + fadeAmount * 18);
    const [r, g, b] = hslToRgb(h, targetSaturation, targetLightness);
    return rgbToHex(r, g, b);
}

// Get contrasting text color (black or white) based on background color
export function getContrastTextColor(backgroundColor) {
    if (!backgroundColor) return '#ffffff';

    const rgb = parseRgbFromColorString(backgroundColor);
    if (!rgb) return '#ffffff';

    return getRelativeLuminance(rgb.r, rgb.g, rgb.b) > 0.5 ? '#000000' : '#ffffff';
}

/** Space-name titles: a name whose longest word is wider than the title breaks anywhere,
 *  so it starts beside its emoji; re-checked when the title's width changes. */
const spaceTitleObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => entries.forEach(({ target, contentRect }) => {
        if (contentRect.width !== target._spaceTitleWidth) fitSpaceTitle(target);
    }))
    : null;

export function setSpaceTitle(el, text, name) {
    el._spaceTitle = { text, name };
    fitSpaceTitle(el);
    spaceTitleObserver?.observe(el);
}

function fitSpaceTitle(el) {
    const { text, name } = el._spaceTitle;
    el._spaceTitleWidth = el.clientWidth;
    el.textContent = text;
    const at = name ? text.lastIndexOf(name) : -1;
    if (at < 0 || !el.clientWidth) return;
    const probe = document.createElement('span');
    probe.style.whiteSpace = 'nowrap';
    probe.textContent = name.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
    el.appendChild(probe);
    const tooWide = probe.offsetWidth > el.clientWidth;
    probe.remove();
    if (!tooWide) return;
    const nameEl = document.createElement('span');
    nameEl.className = 'title-name-unbroken';
    nameEl.textContent = name;
    el.replaceChildren(text.slice(0, at), nameEl, text.slice(at + name.length));
}
