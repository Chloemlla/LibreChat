import type { NextFunction, Request, Response } from 'express';
import type { OAuthAccessContext, OAuthModels } from './types';
import { validateAccessToken } from './service';
import { OAuthProviderError } from './errors';

export interface OAuthScopeRequest extends Request {
  oauth?: OAuthAccessContext;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

type RateLimitResult =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      retryAfterSeconds: number;
    };

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_BUCKETS_BEFORE_CLEANUP = 10_000;
const rateLimitBuckets = new Map<string, RateLimitBucket>();

function getModels(mongoose: typeof import('mongoose')): OAuthModels {
  return {
    OAuthAuthorizationCode: mongoose.models
      .OAuthAuthorizationCode as OAuthModels['OAuthAuthorizationCode'],
    OAuthClient: mongoose.models.OAuthClient as OAuthModels['OAuthClient'],
    OAuthGrant: mongoose.models.OAuthGrant as OAuthModels['OAuthGrant'],
    OAuthToken: mongoose.models.OAuthToken as OAuthModels['OAuthToken'],
    User: mongoose.models.User as OAuthModels['User'],
  };
}

function cleanupRateLimitBuckets(now = Date.now()): void {
  if (rateLimitBuckets.size < MAX_BUCKETS_BEFORE_CLEANUP) {
    return;
  }

  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}

function consumeRateLimit(context: OAuthAccessContext, now = Date.now()): RateLimitResult {
  const max = context.client.rateLimitPerMinute;
  if (!Number.isFinite(max) || max < 1) {
    return { allowed: true };
  }

  cleanupRateLimitBuckets(now);

  const key = `${context.client.clientId}:${context.token._id.toString()}`;
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count <= max) {
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

function extractBearer(req: Request): string | undefined {
  const match = req.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

function sendAuthError(res: Response, error: unknown): void {
  if (error instanceof OAuthProviderError) {
    if (error.code === 'insufficient_scope') {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer error="${error.code}", error_description="${error.message}"`,
      );
    }
    res.status(error.status).json({
      error: error.code,
      error_description: error.message,
    });
    return;
  }

  res.status(500).json({
    error: 'server_error',
    error_description: 'Internal server error',
  });
}

export function createRequireOAuthScope(
  mongoose: typeof import('mongoose'),
  requiredScope: string,
): (req: OAuthScopeRequest, res: Response, next: NextFunction) => Promise<void> {
  const models = getModels(mongoose);

  return async (req: OAuthScopeRequest, res: Response, next: NextFunction) => {
    try {
      const context = await validateAccessToken(models, extractBearer(req), requiredScope);
      const rateLimit = consumeRateLimit(context);
      if (!rateLimit.allowed) {
        res.setHeader('Retry-After', `${rateLimit.retryAfterSeconds}`);
        res.status(429).json({
          error: 'rate_limit_exceeded',
          error_description: 'OAuth token rate limit exceeded',
        });
        return;
      }

      req.oauth = context;
      next();
    } catch (error) {
      sendAuthError(res, error);
    }
  };
}
