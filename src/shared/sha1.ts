/**
 * Minimal SHA-1 (hex) for deterministic Firefox identity redirect hashing.
 * Matches Firefox toolkit identity: CryptoHash("sha1") + bytesAsHex.
 * Sync so OAuth redirect resolution stays synchronous.
 */

function rotl(n: number, s: number): number {
  return (n << s) | (n >>> (32 - s));
}

/** SHA-1 digest as lowercase hex (40 chars). */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
  }
  const bitLen = bytes.length * 8;
  words[bytes.length >> 2] =
    (words[bytes.length >> 2] || 0) | (0x80 << (24 - (bytes.length % 4) * 8));
  const lenIndex = (((bytes.length + 8) >> 6) + 1) * 16 - 1;
  words[lenIndex] = bitLen;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = words[i + t] | 0;
    }
    for (let t = 16; t < 80; t += 1) {
      w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let t = 0; t < 80; t += 1) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}
