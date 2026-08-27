// Generate the Ed25519 license keypair.
//
//   bun run scripts/gen-license-keypair.ts
//
// Writes the 32-byte raw PUBLIC key to ../scripts/license-pubkey.bin (compiled
// into the termset binary) and prints the PRIVATE key as base64 PKCS8 — set it
// as LICENSE_PRIVKEY_B64 in the backend's environment. The private key is the
// only secret in the whole scheme; anyone holding it can mint valid licenses.
//
// Running this INVALIDATES every previously issued license (they were signed by
// the old private key). Only do it to bootstrap or to rotate a compromised key.

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// The raw 32-byte public key is the tail of the SPKI DER encoding.
const spki = publicKey.export({ type: "spki", format: "der" });
const rawPub = spki.subarray(spki.length - 32);

const outPath = join(import.meta.dir, "..", "..", "scripts", "license-pubkey.bin");
writeFileSync(outPath, rawPub);

const privB64 = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");

console.log(`Wrote public key -> ${outPath}`);
console.log(`  pubkey (hex): ${Buffer.from(rawPub).toString("hex")}`);
console.log("");
console.log("Set this in the backend environment (KEEP IT SECRET):");
console.log(`LICENSE_PRIVKEY_B64=${privB64}`);
