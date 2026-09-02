// Base64 for typed-array bytes, implemented here rather than via
// Buffer/btoa so browser and node produce identical output byte-for-byte.

const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REV = new Int8Array(128).fill(-1);
for (let i = 0; i < ABC.length; i++) REV[ABC.charCodeAt(i)] = i;

export function b64encode(bytes) {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    out += ABC[a >> 2] + ABC[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < n ? ABC[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < n ? ABC[c & 63] : "=";
  }
  return out;
}

export function b64decode(str) {
  const clean = str.replace(/=+$/, "");
  const n = clean.length;
  const out = new Uint8Array(Math.floor(n * 3 / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < n; i++) {
    const v = REV[clean.charCodeAt(i)];
    if (v < 0) throw new Error(`bad base64 char at ${i}`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 255;
    }
  }
  return out;
}
