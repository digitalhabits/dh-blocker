// CityHash64 v1.0, which Firefox uses to name the `[Install<hash>]` sections
// of profiles.ini. A port of Google's city.cc, under its licence:
//
// Copyright (c) 2011 Google, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

const K0: u64 = 0xc3a5c85c97cb3127;
const K1: u64 = 0xb492b66fbe98f273;
const K2: u64 = 0x9ae16a3b2f90404f;
const K3: u64 = 0xc949d7c7509e6557;

fn fetch64(s: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(s[i..i + 8].try_into().unwrap())
}

fn fetch32(s: &[u8], i: usize) -> u64 {
    u32::from_le_bytes(s[i..i + 4].try_into().unwrap()) as u64
}

fn shift_mix(v: u64) -> u64 {
    v ^ (v >> 47)
}

fn hash16(u: u64, v: u64) -> u64 {
    const MUL: u64 = 0x9ddfea08eb382d69;
    let mut a = (u ^ v).wrapping_mul(MUL);
    a ^= a >> 47;
    let mut b = (v ^ a).wrapping_mul(MUL);
    b ^= b >> 47;
    b.wrapping_mul(MUL)
}

fn weak_hash32(s: &[u8], i: usize, mut a: u64, mut b: u64) -> (u64, u64) {
    let (w, x, y, z) = (
        fetch64(s, i),
        fetch64(s, i + 8),
        fetch64(s, i + 16),
        fetch64(s, i + 24),
    );
    a = a.wrapping_add(w);
    b = b.wrapping_add(a).wrapping_add(z).rotate_right(21);
    let c = a;
    a = a.wrapping_add(x).wrapping_add(y);
    b = b.wrapping_add(a.rotate_right(44));
    (a.wrapping_add(z), b.wrapping_add(c))
}

fn hash_len0to16(s: &[u8]) -> u64 {
    let n = s.len();
    if n > 8 {
        let (a, b) = (fetch64(s, 0), fetch64(s, n - 8));
        return hash16(a, b.wrapping_add(n as u64).rotate_right(n as u32)) ^ b;
    }
    if n >= 4 {
        return hash16(
            (n as u64).wrapping_add(fetch32(s, 0) << 3),
            fetch32(s, n - 4),
        );
    }
    if n > 0 {
        let y = s[0] as u64 + ((s[n >> 1] as u64) << 8);
        let z = n as u64 + ((s[n - 1] as u64) << 2);
        return shift_mix(y.wrapping_mul(K2) ^ z.wrapping_mul(K3)).wrapping_mul(K2);
    }
    K2
}

fn hash_len17to32(s: &[u8]) -> u64 {
    let n = s.len();
    let a = fetch64(s, 0).wrapping_mul(K1);
    let b = fetch64(s, 8);
    let c = fetch64(s, n - 8).wrapping_mul(K2);
    let d = fetch64(s, n - 16).wrapping_mul(K0);
    hash16(
        a.wrapping_sub(b)
            .rotate_right(43)
            .wrapping_add(c.rotate_right(30))
            .wrapping_add(d),
        a.wrapping_add((b ^ K3).rotate_right(20))
            .wrapping_sub(c)
            .wrapping_add(n as u64),
    )
}

fn hash_len33to64(s: &[u8]) -> u64 {
    let n = s.len();
    let mut z = fetch64(s, 24);
    let mut a =
        fetch64(s, 0).wrapping_add((n as u64).wrapping_add(fetch64(s, n - 16)).wrapping_mul(K0));
    let mut b = a.wrapping_add(z).rotate_right(52);
    let mut c = a.rotate_right(37);
    a = a.wrapping_add(fetch64(s, 8));
    c = c.wrapping_add(a.rotate_right(7));
    a = a.wrapping_add(fetch64(s, 16));
    let vf = a.wrapping_add(z);
    let vs = b.wrapping_add(a.rotate_right(31)).wrapping_add(c);
    a = fetch64(s, 16).wrapping_add(fetch64(s, n - 32));
    z = fetch64(s, n - 8);
    b = a.wrapping_add(z).rotate_right(52);
    c = a.rotate_right(37);
    a = a.wrapping_add(fetch64(s, n - 24));
    c = c.wrapping_add(a.rotate_right(7));
    a = a.wrapping_add(fetch64(s, n - 16));
    let wf = a.wrapping_add(z);
    let ws = b.wrapping_add(a.rotate_right(31)).wrapping_add(c);
    let r = shift_mix(
        vf.wrapping_add(ws)
            .wrapping_mul(K2)
            .wrapping_add(wf.wrapping_add(vs).wrapping_mul(K0)),
    );
    shift_mix(r.wrapping_mul(K0).wrapping_add(vs)).wrapping_mul(K2)
}

pub(super) fn city_hash64(s: &[u8]) -> u64 {
    let n = s.len();
    match n {
        0..=16 => return hash_len0to16(s),
        17..=32 => return hash_len17to32(s),
        33..=64 => return hash_len33to64(s),
        _ => {}
    }
    let mut x = fetch64(s, 0);
    let mut y = fetch64(s, n - 16) ^ K1;
    let mut z = fetch64(s, n - 56) ^ K0;
    let mut v = weak_hash32(s, n - 64, n as u64, y);
    let mut w = weak_hash32(s, n - 32, (n as u64).wrapping_mul(K1), K0);
    z = z.wrapping_add(shift_mix(v.1).wrapping_mul(K1));
    x = z.wrapping_add(x).rotate_right(39).wrapping_mul(K1);
    y = y.rotate_right(33).wrapping_mul(K1);
    for chunk in s[..(n - 1) & !63].chunks_exact(64) {
        x = x
            .wrapping_add(y)
            .wrapping_add(v.0)
            .wrapping_add(fetch64(chunk, 16))
            .rotate_right(37)
            .wrapping_mul(K1);
        y = y
            .wrapping_add(v.1)
            .wrapping_add(fetch64(chunk, 48))
            .rotate_right(42)
            .wrapping_mul(K1);
        x ^= w.1;
        y ^= v.0;
        z = (z ^ w.0).rotate_right(33);
        v = weak_hash32(chunk, 0, v.1.wrapping_mul(K1), x.wrapping_add(w.0));
        w = weak_hash32(chunk, 32, z.wrapping_add(w.1), y);
        std::mem::swap(&mut z, &mut x);
    }
    hash16(
        hash16(v.0, w.0)
            .wrapping_add(shift_mix(y).wrapping_mul(K1))
            .wrapping_add(z),
        hash16(v.1, w.1).wrapping_add(x),
    )
}
