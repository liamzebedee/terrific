// UUIDv7 — a time-ordered UUID: 48-bit big-endian millisecond timestamp + 74
// random bits (RFC 9562). Time-ordered so ids sort by creation and stay
// index-friendly on insert, while remaining unguessable (74 bits of entropy).
// Isomorphic: uses Web Crypto (`crypto.getRandomValues`), available in both the
// browser and Bun, so the same generator runs on client and server.
//
// See RFCs/0005-data-modeling.md for why ids are UUIDv7.
export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ts = Date.now();
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = Math.floor(ts / 2 ** 24) & 0xff;
  b[3] = Math.floor(ts / 2 ** 16) & 0xff;
  b[4] = Math.floor(ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}
