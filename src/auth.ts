import * as ui8 from "uint8arrays";
import * as common from "@atproto/common";
import { MINUTE } from "@atproto/common";
import * as crypto from "@atproto/crypto";
import { AuthRequiredError } from "./types.ts";

/**
 * Parameters for creating a service JWT key.
 * @property {string} iss - The issuer of the JWT (typically a DID)
 * @property {string} aud - The audience of the JWT (typically the service's DID)
 * @property {number} [iat] - Issued at timestamp in seconds. Defaults to current time.
 * @property {number} [exp] - Expiration timestamp in seconds. Defaults to iat + 1 minute.
 * @property {string | null} lxm - Lexicon method identifier. Used to restrict token to specific operations.
 * @property {crypto.Keypair} keypair - The keypair used to sign the JWT
 */
type ServiceJwtParams = {
  iss: string;
  aud: string;
  iat?: number;
  exp?: number;
  lxm: string | null;
  keypair: crypto.Keypair;
};

/**
 * JWT header fields.
 * @property {string} alg - The algorithm used to sign the JWT
 * @property {Record<string, unknown>} - Additional header fields
 */
type ServiceJwtHeaders = {
  alg: string;
} & Record<string, unknown>;

/**
 * JWT payload fields.
 * @property {string} iss - The issuer of the JWT (typically a DID)
 * @property {string} aud - The audience of the JWT (typically the service's DID)
 * @property {number} exp - Expiration timestamp in seconds
 * @property {string} [lxm] - Optional lexicon method identifier
 * @property {string} [jti] - Optional JWT ID for uniqueness
 */
type ServiceJwtPayload = {
  iss: string;
  aud: string;
  exp: number;
  lxm?: string;
  jti?: string;
};

/**
 * Creates a signed JWT for service-to-service authentication.
 * The JWT includes standard claims (iss, aud, exp) and optional claims (lxm).
 * The token is signed using the provided keypair.
 *
 * @param {ServiceJwtParams} params - Parameters for creating the JWT
 * @returns {Promise<string>} A signed JWT string in the format: header.payload.signature
 *
 * @example
 * ```typescript
 * const jwt = await createServiceJwt({
 *   iss: 'did:example:issuer',
 *   aud: 'did:example:audience',
 *   lxm: 'com.example.method',
 *   keypair: myKeypair
 * });
 * ```
 */
export const createServiceJwt = async (
  params: ServiceJwtParams,
): Promise<string> => {
  const { iss, aud, keypair } = params;
  const iat = params.iat ?? Math.floor(Date.now() / 1e3);
  const exp = params.exp ?? iat + MINUTE / 1e3;
  const lxm = params.lxm ?? undefined;
  const jti = await crypto.randomStr(16, "hex");
  const header = {
    typ: "JWT",
    alg: keypair.jwtAlg,
  };
  const payload = common.noUndefinedVals({
    iat,
    iss,
    aud,
    exp,
    lxm,
    jti,
  });
  const toSignStr = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`;
  const toSign = ui8.fromString(toSignStr, "utf8");
  const sig = await keypair.sign(toSign);
  return `${toSignStr}.${ui8.toString(sig, "base64url")}`;
};

/**
 * Creates authorization headers containing a service JWT.
 * Useful for making authenticated HTTP requests to other services.
 *
 * @param {ServiceJwtParams} params - Parameters for creating the JWT
 * @returns {Promise<{headers: {authorization: string}}>} Object containing authorization header
 *
 * @example
 * ```typescript
 * const auth = await createServiceAuthHeaders({
 *   iss: 'did:example:issuer',
 *   aud: 'did:example:audience',
 *   keypair: myKeypair
 * });
 * fetch(url, { headers: auth.headers });
 * ```
 */
export const createServiceAuthHeaders = async (
  params: ServiceJwtParams,
): Promise<{ headers: { authorization: string } }> => {
  const jwt = await createServiceJwt(params);
  return {
    headers: { authorization: `Bearer ${jwt}` },
  };
};

/**
 * Converts a JSON object to a base64url-encoded string.
 * @param {Record<string, unknown>} json - The JSON object to encode
 * @returns {string} The base64url-encoded string
 * @private
 */
const jsonToB64Url = (json: Record<string, unknown>): string => {
  return common.utf8ToB64Url(JSON.stringify(json));
};

/**
 * Function type for verifying JWT signatures with a given key.
 * @param {string} key - The public key to verify against
 * @param {Uint8Array} msgBytes - The message bytes to verify
 * @param {Uint8Array} sigBytes - The signature bytes to verify
 * @param {string} alg - The algorithm used for signing
 * @returns {Promise<boolean>} Whether the signature is valid
 */
export type VerifySignatureWithKeyFn = (
  key: string,
  msgBytes: Uint8Array,
  sigBytes: Uint8Array,
  alg: string,
) => Promise<boolean> | boolean;

/**
 * Verifies a JWT's authenticity and claims.
 * Performs comprehensive validation including:
 * - JWT format and signature
 * - Token expiration
 * - Audience validation
 * - Lexicon method validation
 * - Signature verification with key rotation support
 *
 * @param {string} jwtStr - The JWT to verify
 * @param {string | null} ownDid - The expected audience (null to skip check)
 * @param {string | null} lxm - The expected lexicon method (null to skip check)
 * @param {Function} getSigningKey - Function to get the issuer's signing key
 * @param {VerifySignatureWithKeyFn} verifySignatureWithKey - Function to verify signatures
 * @returns {Promise<ServiceJwtPayload>} The verified JWT payload
 * @throws {AuthRequiredError} If verification fails
 */
export const verifyJwt = async (
  jwtStr: string,
  ownDid: string | null,
  lxm: string | null,
  getSigningKey: (iss: string, forceRefresh: boolean) => Promise<string>,
  verifySignatureWithKey: VerifySignatureWithKeyFn =
    cryptoVerifySignatureWithKey,
): Promise<ServiceJwtPayload> => {
  const parts = jwtStr.split(".");
  if (parts.length !== 3) {
    throw new AuthRequiredError("poorly formatted jwt", "BadJwt");
  }

  const header = parseHeader(parts[0]);

  // The spec does not describe what to do with the "typ" claim. We can,
  // however, forbid some values that are not compatible with our use case.
  if (
    // service tokens are not OAuth 2.0 access tokens
    // https://datatracker.ietf.org/doc/html/rfc9068
    header["typ"] === "at+jwt" ||
    // "refresh+jwt" is a non-standard type used by the @atproto packages
    header["typ"] === "refresh+jwt" ||
    // "DPoP" proofs are not meant to be used as service tokens
    // https://datatracker.ietf.org/doc/html/rfc9449
    header["typ"] === "dpop+jwt"
  ) {
    throw new AuthRequiredError(
      `Invalid jwt type "${header["typ"]}"`,
      "BadJwtType",
    );
  }

  const payload = parsePayload(parts[1]);
  const sig = parts[2];

  if (Date.now() / 1000 > payload.exp) {
    throw new AuthRequiredError("jwt expired", "JwtExpired");
  }
  if (ownDid !== null && payload.aud !== ownDid) {
    throw new AuthRequiredError(
      "jwt audience does not match service did",
      "BadJwtAudience",
    );
  }
  if (lxm !== null && payload.lxm !== lxm) {
    throw new AuthRequiredError(
      payload.lxm !== undefined
        ? `bad jwt lexicon method ("lxm"). must match: ${lxm}`
        : `missing jwt lexicon method ("lxm"). must match: ${lxm}`,
      "BadJwtLexiconMethod",
    );
  }

  const msgBytes = ui8.fromString(parts.slice(0, 2).join("."), "utf8");
  const sigBytes = ui8.fromString(sig, "base64url");

  const signingKey = await getSigningKey(payload.iss, false);
  const { alg } = header;

  let validSig: boolean;
  try {
    validSig = await verifySignatureWithKey(
      signingKey,
      msgBytes,
      sigBytes,
      alg,
    );
  } catch {
    throw new AuthRequiredError(
      "could not verify jwt signature",
      "BadJwtSignature",
    );
  }

  if (!validSig) {
    // get fresh signing key in case it failed due to a recent rotation
    const freshSigningKey = await getSigningKey(payload.iss, true);
    try {
      validSig = freshSigningKey !== signingKey
        ? await verifySignatureWithKey(
          freshSigningKey,
          msgBytes,
          sigBytes,
          alg,
        )
        : false;
    } catch {
      throw new AuthRequiredError(
        "could not verify jwt signature",
        "BadJwtSignature",
      );
    }
  }

  if (!validSig) {
    throw new AuthRequiredError(
      "jwt signature does not match jwt issuer",
      "BadJwtSignature",
    );
  }

  return payload;
};

/**
 * Default implementation of signature verification using @atproto/crypto.
 * Supports malleable signatures for compatibility.
 *
 * @param {string} key - The public key to verify against
 * @param {Uint8Array} msgBytes - The message bytes to verify
 * @param {Uint8Array} sigBytes - The signature bytes to verify
 * @param {string} alg - The algorithm used for signing
 * @returns {Promise<boolean>} Whether the signature is valid
 */
export const cryptoVerifySignatureWithKey: VerifySignatureWithKeyFn = (
  key: string,
  msgBytes: Uint8Array,
  sigBytes: Uint8Array,
  alg: string,
) => {
  return crypto.verifySignature(key, msgBytes, sigBytes, {
    jwtAlg: alg,
    allowMalleableSig: true,
  });
};

/**
 * Parses a base64url-encoded string into a JSON object.
 * @param {string} b64 - The base64url-encoded string
 * @returns {unknown} The parsed JSON object
 * @private
 */
const parseB64UrlToJson = (b64: string) => {
  return JSON.parse(common.b64UrlToUtf8(b64));
};

/**
 * Parses and validates a JWT header.
 * @param {string} b64 - The base64url-encoded header
 * @returns {ServiceJwtHeaders} The parsed and validated header
 * @throws {AuthRequiredError} If the header is invalid
 * @private
 */
const parseHeader = (b64: string): ServiceJwtHeaders => {
  const header = parseB64UrlToJson(b64);
  if (!header || typeof header !== "object" || typeof header.alg !== "string") {
    throw new AuthRequiredError("poorly formatted jwt", "BadJwt");
  }
  return header;
};

/**
 * Parses and validates a JWT payload.
 * @param {string} b64 - The base64url-encoded payload
 * @returns {ServiceJwtPayload} The parsed and validated payload
 * @throws {AuthRequiredError} If the payload is invalid
 * @private
 */
const parsePayload = (b64: string): ServiceJwtPayload => {
  const payload = parseB64UrlToJson(b64);
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.iss !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.exp !== "number" ||
    (payload.lxm && typeof payload.lxm !== "string") ||
    (payload.nonce && typeof payload.nonce !== "string")
  ) {
    throw new AuthRequiredError("poorly formatted jwt", "BadJwt");
  }
  return payload;
};
