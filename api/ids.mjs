/* Schema ids.

   These ids ARE the access control. The API has no auth: anyone holding an id
   can generate from that schema, and anyone who does not hold it must not be
   able to reach it. That rules out deriving the id from the schema's content --
   a hash of {first_name, last_name, email} is the same hash for everyone who
   builds that obvious schema, so common schemas would be trivially guessable.

   So: 160 random bits from the OS CSPRNG, rendered in Crockford base32 (no
   I/L/O/U, so nothing reads as a different character when someone copies an id
   out of a chat message by hand). Guessing one is not a realistic attack even
   at millions of tries per second. */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ID_LENGTH = 32;                 // 32 chars x 5 bits = 160 bits
const ID_RE = new RegExp("^[" + ALPHABET + "]{" + ID_LENGTH + "}$");

export function newSchemaId() {
  const bytes = randomBytes(ID_LENGTH);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/* Accepts the id in whatever shape it survived a copy/paste: lower case, and
   with dashes or spaces someone's chat client may have inserted. */
export function normalizeSchemaId(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().replace(/[-\s]/g, "");
  return ID_RE.test(s) ? s : null;
}
