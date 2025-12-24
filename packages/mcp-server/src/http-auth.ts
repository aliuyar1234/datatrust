import { createHmac, timingSafeEqual, createVerify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { HttpAuthConfig, JwtAuthConfig } from './config.js';

export type AuthContext =
  | { kind: 'none' }
  | { kind: 'bearer'; subject: string }
  | {
      kind: 'jwt';
      subject: string;
      tenantId?: string;
      roles?: string[];
      scopes?: string[];
      claims: Record<string, unknown>;
    };

export class HttpAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpAuthError';
  }
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64');
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function getBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return null;
  const [scheme, token] = raw.split(' ', 2);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

type JwtVerifier = {
  verify(token: string): AuthContext;
};

function parseJwt(token: string): { header: any; payload: any; signingInput: Buffer; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HttpAuthError(401, 'Invalid JWT format');
  }
  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const signatureB64 = parts[2];
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new HttpAuthError(401, 'Invalid JWT format');
  }
  const headerRaw = base64UrlDecode(headerB64).toString('utf-8');
  const payloadRaw = base64UrlDecode(payloadB64).toString('utf-8');

  const header = safeJsonParse(headerRaw);
  const payload = safeJsonParse(payloadRaw);
  if (!header || typeof header !== 'object') {
    throw new HttpAuthError(401, 'Invalid JWT header');
  }
  if (!payload || typeof payload !== 'object') {
    throw new HttpAuthError(401, 'Invalid JWT payload');
  }

  return {
    header,
    payload,
    signingInput: Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8'),
    signature: base64UrlDecode(signatureB64),
  };
}

function getStringClaim(claims: any, name: string): string | undefined {
  const value = claims?.[name];
  return typeof value === 'string' ? value : undefined;
}

function getStringArrayClaim(claims: any, name: string): string[] | undefined {
  const value = claims?.[name];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  return undefined;
}

function getNumericClaim(claims: any, name: string): number | undefined {
  const value = claims?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ensureClaimEquals(
  claims: any,
  key: string,
  expected: string | number | boolean
): void {
  const actual = claims?.[key];
  if (actual !== expected) {
    throw new HttpAuthError(403, `JWT claim '${key}' does not match policy`);
  }
}

function normalizeAudience(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud) && aud.every((v) => typeof v === 'string')) return aud;
  return [];
}

function verifyJwtClaims(config: Required<Pick<JwtAuthConfig, 'clockSkewSeconds'>> & JwtAuthConfig, payload: any): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const skew = config.clockSkewSeconds ?? 0;

  const exp = getNumericClaim(payload, 'exp');
  if (exp !== undefined && nowSeconds > exp + skew) {
    throw new HttpAuthError(401, 'JWT expired');
  }

  const nbf = getNumericClaim(payload, 'nbf');
  if (nbf !== undefined && nowSeconds + skew < nbf) {
    throw new HttpAuthError(401, 'JWT not active yet');
  }

  if (config.issuer) {
    const iss = getStringClaim(payload, 'iss');
    if (iss !== config.issuer) {
      throw new HttpAuthError(401, 'JWT issuer mismatch');
    }
  }

  if (config.audience) {
    const expected = normalizeAudience(config.audience);
    const aud = normalizeAudience(payload?.aud);
    if (expected.length > 0 && !expected.some((e) => aud.includes(e))) {
      throw new HttpAuthError(401, 'JWT audience mismatch');
    }
  }

  if (config.requiredClaims) {
    for (const [key, expected] of Object.entries(config.requiredClaims)) {
      ensureClaimEquals(payload, key, expected);
    }
  }
}

function createHs256Verifier(config: JwtAuthConfig, secret: Buffer): JwtVerifier {
  return {
    verify(token: string): AuthContext {
      const { header, payload, signingInput, signature } = parseJwt(token);
      if (header.alg !== 'HS256') {
        throw new HttpAuthError(401, `Unsupported JWT alg: ${String(header.alg)}`);
      }

      const expected = createHmac('sha256', secret).update(signingInput).digest();
      if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
        throw new HttpAuthError(401, 'Invalid JWT signature');
      }

      verifyJwtClaims({ clockSkewSeconds: config.clockSkewSeconds ?? 0, ...config }, payload);

      const subjectClaim = config.subjectClaim ?? 'sub';
      const subject = getStringClaim(payload, subjectClaim);
      if (!subject) throw new HttpAuthError(401, `Missing JWT subject claim: ${subjectClaim}`);

      const tenantClaim = config.tenantClaim ?? 'tenant';
      const tenantId = getStringClaim(payload, tenantClaim);
      const roles = getStringArrayClaim(payload, config.rolesClaim ?? 'roles');
      const scopes = getStringArrayClaim(payload, config.scopesClaim ?? 'scope');

      return { kind: 'jwt', subject, tenantId, roles, scopes, claims: payload };
    },
  };
}

function createRs256Verifier(config: JwtAuthConfig, publicKeyPem: string): JwtVerifier {
  return {
    verify(token: string): AuthContext {
      const { header, payload, signingInput, signature } = parseJwt(token);
      if (header.alg !== 'RS256') {
        throw new HttpAuthError(401, `Unsupported JWT alg: ${String(header.alg)}`);
      }

      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingInput);
      verifier.end();
      const ok = verifier.verify(publicKeyPem, signature);
      if (!ok) {
        throw new HttpAuthError(401, 'Invalid JWT signature');
      }

      verifyJwtClaims({ clockSkewSeconds: config.clockSkewSeconds ?? 0, ...config }, payload);

      const subjectClaim = config.subjectClaim ?? 'sub';
      const subject = getStringClaim(payload, subjectClaim);
      if (!subject) throw new HttpAuthError(401, `Missing JWT subject claim: ${subjectClaim}`);

      const tenantClaim = config.tenantClaim ?? 'tenant';
      const tenantId = getStringClaim(payload, tenantClaim);
      const roles = getStringArrayClaim(payload, config.rolesClaim ?? 'roles');
      const scopes = getStringArrayClaim(payload, config.scopesClaim ?? 'scope');

      return { kind: 'jwt', subject, tenantId, roles, scopes, claims: payload };
    },
  };
}

async function loadJwtVerifier(jwt: JwtAuthConfig): Promise<JwtVerifier> {
  const algorithms = jwt.algorithms ?? ['RS256'];
  if (algorithms.includes('HS256')) {
    const secretEnv = jwt.hmacSecretEnv;
    if (!secretEnv) throw new HttpAuthError(500, 'JWT HS256 requires hmacSecretEnv');
    const secretRaw = process.env[secretEnv];
    if (!secretRaw) throw new HttpAuthError(500, `JWT secret env var not set: ${secretEnv}`);
    return createHs256Verifier(jwt, Buffer.from(secretRaw, 'utf-8'));
  }

  const publicKeyEnv = jwt.publicKeyEnv;
  const publicKeyFile = jwt.publicKeyFile;
  const publicKeyPem =
    (publicKeyEnv ? process.env[publicKeyEnv] : undefined) ??
    (publicKeyFile ? await fs.readFile(publicKeyFile, 'utf-8') : undefined);
  if (!publicKeyPem) {
    throw new HttpAuthError(500, 'JWT RS256 requires publicKeyEnv or publicKeyFile');
  }

  return createRs256Verifier(jwt, publicKeyPem);
}

export type HttpAuthRuntime = {
  mode: NonNullable<HttpAuthConfig['mode']>;
  bearerToken?: string;
  jwt?: JwtVerifier;
  breakGlassToken?: string;
  breakGlassHeader: string;
};

export async function buildHttpAuth(config?: HttpAuthConfig, legacyBearerTokenEnv?: string): Promise<HttpAuthRuntime> {
  const mode = config?.mode ?? 'none';
  const bearerTokenEnv = config?.bearerTokenEnv ?? legacyBearerTokenEnv;
  const bearerToken = bearerTokenEnv ? process.env[bearerTokenEnv] : undefined;
  if (mode !== 'none' && bearerTokenEnv && !bearerToken) {
    throw new HttpAuthError(500, `Bearer token env var not set: ${bearerTokenEnv}`);
  }

  const jwt = config?.jwt ? await loadJwtVerifier(config.jwt) : undefined;

  const breakGlassHeader = (config?.breakGlassHeader ?? 'x-datatrust-break-glass').toLowerCase();
  const breakGlassTokenEnv = config?.breakGlassTokenEnv;
  const breakGlassToken = breakGlassTokenEnv ? process.env[breakGlassTokenEnv] : undefined;

  return {
    mode,
    bearerToken,
    jwt,
    breakGlassToken,
    breakGlassHeader,
  };
}

export function authenticateHttpRequest(req: IncomingMessage, auth: HttpAuthRuntime): { auth: AuthContext; breakGlass: boolean } {
  const token = getBearerToken(req);

  const breakGlassHeaderValue = req.headers[auth.breakGlassHeader];
  const breakGlassCandidate = typeof breakGlassHeaderValue === 'string' ? breakGlassHeaderValue : undefined;
  const breakGlass = Boolean(
    auth.breakGlassToken && breakGlassCandidate && breakGlassCandidate === auth.breakGlassToken
  );

  if (auth.mode === 'none') return { auth: { kind: 'none' }, breakGlass };

  if (auth.mode === 'bearer') {
    if (!token || !auth.bearerToken || token !== auth.bearerToken) {
      throw new HttpAuthError(401, 'Unauthorized');
    }
    return { auth: { kind: 'bearer', subject: 'bearer' }, breakGlass };
  }

  if (auth.mode === 'jwt') {
    if (!token || !auth.jwt) throw new HttpAuthError(401, 'Unauthorized');
    return { auth: auth.jwt.verify(token), breakGlass };
  }

  // bearer_or_jwt
  if (token && auth.bearerToken && token === auth.bearerToken) {
    return { auth: { kind: 'bearer', subject: 'bearer' }, breakGlass };
  }
  if (token && auth.jwt) {
    return { auth: auth.jwt.verify(token), breakGlass };
  }
  throw new HttpAuthError(401, 'Unauthorized');
}
