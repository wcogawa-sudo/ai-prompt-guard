// Client-side evidence decryption for the admin dashboard. Runs in the
// ADMIN'S BROWSER: the private key file and passphrase never leave the tab,
// and the collector never sees them. Also loadable in Node for tests.
//
// Key file: scrypt(passphrase) -> AES-256-GCM -> PKCS#8 RSA key
//           (written by scripts/evidence.js keygen).
// Evidence: RSA-OAEP-256 wraps an AES-256-GCM key; payload is AES-GCM
//           ciphertext + 16-byte tag (written by the extension).

(function (root) {
  "use strict";
  const subtle = root.crypto.subtle;

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // ---------- scrypt (RFC 7914), using WebCrypto PBKDF2-HMAC-SHA256 ----------
  // WebCrypto has no scrypt, so the memory-hard core (ROMix) is done here.

  async function pbkdf2(pass, salt, len) {
    const k = await subtle.importKey("raw", pass, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1 }, k, len * 8));
  }

  function salsa208(B) {
    const x = B.slice();
    const R = (a, b) => (a << b) | (a >>> (32 - b));
    for (let i = 0; i < 8; i += 2) {
      x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
    }
    for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
  }

  // BlockMix on 2r 64-byte blocks (as Uint32 words).
  function blockMix(B, Y, r) {
    const X = B.slice((2 * r - 1) * 16, 2 * r * 16);
    for (let i = 0; i < 2 * r; i++) {
      for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
      salsa208(X);
      Y.set(X, i * 16);
    }
    for (let i = 0; i < r; i++) B.set(Y.subarray(2 * i * 16, (2 * i + 1) * 16), i * 16);
    for (let i = 0; i < r; i++) B.set(Y.subarray((2 * i + 1) * 16, (2 * i + 2) * 16), (i + r) * 16);
  }

  function roMix(X, N, r) {
    const words = 32 * r;
    const V = new Uint32Array(N * words);
    const Y = new Uint32Array(words);
    for (let i = 0; i < N; i++) { V.set(X, i * words); blockMix(X, Y, r); }
    for (let i = 0; i < N; i++) {
      const j = X[(2 * r - 1) * 16] & (N - 1);
      for (let k = 0; k < words; k++) X[k] ^= V[j * words + k];
      blockMix(X, Y, r);
    }
  }

  // Byte order: scrypt works on little-endian 32-bit words.
  const toWordsLE = (bytes) => { const w = new Uint32Array(bytes.length / 4); const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); for (let i = 0; i < w.length; i++) w[i] = dv.getUint32(i * 4, true); return w; };
  const toBytesLE = (words) => { const b = new Uint8Array(words.length * 4); const dv = new DataView(b.buffer); for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i], true); return b; };

  async function scrypt(passBytes, salt, N, r, p, dkLen) {
    const B = await pbkdf2(passBytes, salt, p * 128 * r);
    for (let i = 0; i < p; i++) {
      const chunk = B.subarray(i * 128 * r, (i + 1) * 128 * r);
      const X = toWordsLE(chunk.slice());
      roMix(X, N, r);
      chunk.set(toBytesLE(X));
    }
    return pbkdf2(passBytes, B, dkLen);
  }

  // ---------- key file + evidence ----------

  // Returns a NON-extractable RSA-OAEP private CryptoKey: it can decrypt, but
  // can't be read back out of the browser's crypto engine.
  async function openKeyFile(fileText, passphrase) {
    const f = JSON.parse(fileText);
    if (f.format !== "prompt-guard-evidence-key/1" || f.kdf !== "scrypt") {
      throw new Error("Not a Prompt Guard evidence key file (regenerate older .pem keys with keygen).");
    }
    const dk = await scrypt(new TextEncoder().encode(passphrase), b64(f.salt), f.N, f.r, f.p, 32);
    const aes = await subtle.importKey("raw", dk, "AES-GCM", false, ["decrypt"]);
    const ct = b64(f.key);
    const tag = b64(f.tag);
    const sealed = new Uint8Array(ct.length + tag.length);
    sealed.set(ct); sealed.set(tag, ct.length);
    let der;
    try {
      der = await subtle.decrypt({ name: "AES-GCM", iv: b64(f.iv) }, aes, sealed);
    } catch (_) {
      throw new Error("Wrong passphrase or damaged key file.");
    }
    dk.fill(0);
    const key = await subtle.importKey("pkcs8", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    new Uint8Array(der).fill(0);
    return key;
  }

  async function decryptEvidence(rec, privateKey) {
    const raw = await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, b64(rec.wrapped_key));
    const aes = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    new Uint8Array(raw).fill(0);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: b64(rec.iv) }, aes, b64(rec.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  const api = { scrypt, openKeyFile, decryptEvidence };
  root.PGAdminCrypto = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
