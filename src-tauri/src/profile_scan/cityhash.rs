//! CityHash64, version 1.0 (Google, MIT licence; Geoff Pike and Jyrki Alakuijala).
//! A pure-Rust port of the `cityhash_1` C++ bundled in the `cityhash` 0.1.1 crate,
//! which is the variant Firefox uses to name its installs.

const K0: u64 = 0xc3a5_c85c_97cb_3127;
const K1: u64 = 0xb492_b66f_be98_f273;
const K2: u64 = 0x9ae1_6a3b_2f90_404f;
const K3: u64 = 0xc949_d7c7_509e_6557;

fn fetch64(s: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(s[i..i + 8].try_into().unwrap())
}
fn fetch32(s: &[u8], i: usize) -> u64 {
    u32::from_le_bytes(s[i..i + 4].try_into().unwrap()) as u64
}
fn rot(v: u64, n: u32) -> u64 {
    v.rotate_right(n)
}
fn shift_mix(v: u64) -> u64 {
    v ^ (v >> 47)
}

fn hash16(u: u64, v: u64) -> u64 {
    const MUL: u64 = 0x9ddf_ea08_eb38_2d69;
    let a = shift_mix((u ^ v).wrapping_mul(MUL));
    shift_mix((v ^ a).wrapping_mul(MUL)).wrapping_mul(MUL)
}

fn hash_0_to_16(s: &[u8]) -> u64 {
    let len = s.len();
    if len > 8 {
        let (a, b) = (fetch64(s, 0), fetch64(s, len - 8));
        return hash16(a, rot(b.wrapping_add(len as u64), len as u32)) ^ b;
    }
    if len >= 4 {
        return hash16(
            (len as u64).wrapping_add(fetch32(s, 0) << 3),
            fetch32(s, len - 4),
        );
    }
    if len > 0 {
        let y = s[0] as u32 + ((s[len >> 1] as u32) << 8);
        let z = len as u32 + ((s[len - 1] as u32) << 2);
        return shift_mix((y as u64).wrapping_mul(K2) ^ (z as u64).wrapping_mul(K3))
            .wrapping_mul(K2);
    }
    K2
}

fn hash_17_to_32(s: &[u8]) -> u64 {
    let len = s.len();
    let a = fetch64(s, 0).wrapping_mul(K1);
    let b = fetch64(s, 8);
    let c = fetch64(s, len - 8).wrapping_mul(K2);
    let d = fetch64(s, len - 16).wrapping_mul(K0);
    hash16(
        rot(a.wrapping_sub(b), 43)
            .wrapping_add(rot(c, 30))
            .wrapping_add(d),
        a.wrapping_add(rot(b ^ K3, 20))
            .wrapping_sub(c)
            .wrapping_add(len as u64),
    )
}

fn weak_32(s: &[u8], i: usize, mut a: u64, b: u64) -> (u64, u64) {
    let (w, x, y, z) = (
        fetch64(s, i),
        fetch64(s, i + 8),
        fetch64(s, i + 16),
        fetch64(s, i + 24),
    );
    a = a.wrapping_add(w);
    let mut b = rot(b.wrapping_add(a).wrapping_add(z), 21);
    let c = a;
    a = a.wrapping_add(x).wrapping_add(y);
    b = b.wrapping_add(rot(a, 44));
    (a.wrapping_add(z), b.wrapping_add(c))
}

fn hash_33_to_64(s: &[u8]) -> u64 {
    let len = s.len();
    let mut z = fetch64(s, 24);
    let mut a = fetch64(s, 0).wrapping_add(
        (len as u64)
            .wrapping_add(fetch64(s, len - 16))
            .wrapping_mul(K0),
    );
    let mut b = rot(a.wrapping_add(z), 52);
    let mut c = rot(a, 37);
    a = a.wrapping_add(fetch64(s, 8));
    c = c.wrapping_add(rot(a, 7));
    a = a.wrapping_add(fetch64(s, 16));
    let vf = a.wrapping_add(z);
    let vs = b.wrapping_add(rot(a, 31)).wrapping_add(c);
    a = fetch64(s, 16).wrapping_add(fetch64(s, len - 32));
    z = fetch64(s, len - 8);
    b = rot(a.wrapping_add(z), 52);
    c = rot(a, 37);
    a = a.wrapping_add(fetch64(s, len - 24));
    c = c.wrapping_add(rot(a, 7));
    a = a.wrapping_add(fetch64(s, len - 16));
    let wf = a.wrapping_add(z);
    let ws = b.wrapping_add(rot(a, 31)).wrapping_add(c);
    let r = shift_mix(
        vf.wrapping_add(ws)
            .wrapping_mul(K2)
            .wrapping_add(wf.wrapping_add(vs).wrapping_mul(K0)),
    );
    shift_mix(r.wrapping_mul(K0).wrapping_add(vs)).wrapping_mul(K2)
}

/// CityHash64 v1.0 of `s`, bit-identical to `cityhash::cityhash_1::city_hash_64`.
pub fn city_hash_64(s: &[u8]) -> u64 {
    let len = s.len();
    if len <= 16 {
        return hash_0_to_16(s);
    }
    if len <= 32 {
        return hash_17_to_32(s);
    }
    if len <= 64 {
        return hash_33_to_64(s);
    }
    let n = len as u64;
    let mut x = fetch64(s, 0);
    let mut y = fetch64(s, len - 16) ^ K1;
    let mut z = fetch64(s, len - 56) ^ K0;
    let mut v = weak_32(s, len - 64, n, y);
    let mut w = weak_32(s, len - 32, n.wrapping_mul(K1), K0);
    z = z.wrapping_add(shift_mix(v.1).wrapping_mul(K1));
    x = rot(z.wrapping_add(x), 39).wrapping_mul(K1);
    y = rot(y, 33).wrapping_mul(K1);
    // Whole 64-byte chunks: (len - 1) rounded down to a multiple of 64 bytes in total.
    for i in (0..(len - 1) & !63).step_by(64) {
        x = rot(
            x.wrapping_add(y)
                .wrapping_add(v.0)
                .wrapping_add(fetch64(s, i + 16)),
            37,
        )
        .wrapping_mul(K1);
        y = rot(y.wrapping_add(v.1).wrapping_add(fetch64(s, i + 48)), 42).wrapping_mul(K1);
        x ^= w.1;
        y ^= v.0;
        z = rot(z ^ w.0, 33);
        v = weak_32(s, i, v.1.wrapping_mul(K1), x.wrapping_add(w.0));
        w = weak_32(s, i + 32, z.wrapping_add(w.1), y);
        std::mem::swap(&mut z, &mut x);
    }
    hash16(
        hash16(v.0, w.0)
            .wrapping_add(shift_mix(y).wrapping_mul(K1))
            .wrapping_add(z),
        hash16(v.1, w.1).wrapping_add(x),
    )
}

#[cfg(test)]
mod tests {
    use super::city_hash_64;

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn matches_known_values() {
        // Vectors from the cityhash 0.1.1 crate's own tests.
        for (s, h) in [
            ("I", 0x641f_1cd0_505d_1ff9),
            ("do", 0xe394_c683_1e9d_6e71),
            ("not", 0x651c_1a4b_0b3f_2d88),
            ("know", 0x9fc6_71af_2d05_1786),
            ("about", 0x1fa3_8575_7f00_16ec),
            ("making", 0xf240_7bd9_ce67_8f7f),
            ("awkward", 0x73bd_225c_6b6b_8163),
            ("rhopalic", 0xea78_562e_3577_7eb1),
            ("sentences", 0x3c85_4a92_5e6e_4a9e),
            (".", 0x84a0_4e9a_a8da_e9f5),
        ] {
            assert_eq!(city_hash_64(s.as_bytes()), h, "{s}");
        }
        assert_eq!(city_hash_64(&utf16("/Users/dave/mozilla/source/trunk/obj-browser-opt-full/dist/Nightly.app/Contents/MacOS")), 0x79dd_ed52_7a2b_a3af);
        assert_eq!(
            city_hash_64(&utf16("/Applications/Firefox Nightly.app/Contents/MacOS")),
            0x3121_0a08_1f86_e80e
        );
        // Section names in real installs.ini files for the default install folders.
        assert_eq!(
            city_hash_64(&utf16(r"C:\Program Files\Mozilla Firefox")),
            0x3080_46b0_af4a_39cb
        );
        assert_eq!(
            city_hash_64(&utf16("/Applications/Firefox.app/Contents/MacOS")),
            0x2656_ff1e_876e_9973
        );
    }
}
