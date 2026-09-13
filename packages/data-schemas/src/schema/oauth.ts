import { Schema } from 'mongoose';
import type { IOAuthAuthorizationCode, IOAuthClient, IOAuthGrant, IOAuthToken } from '~/types';

export const oauthClientSchema: Schema<IOAuthClient> = new Schema<IOAuthClient>(
  {
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['confidential', 'public'],
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    homepageUrl: {
      type: String,
      trim: true,
    },
    logoUrl: {
      type: String,
      trim: true,
    },
    redirectUris: {
      type: [String],
      required: true,
      default: [],
    },
    allowedScopes: {
      type: [String],
      required: true,
      default: [],
    },
    rateLimitPerMinute: {
      type: Number,
      required: true,
      default: 60,
      min: 1,
    },
    enabled: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    secretHash: {
      type: String,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

oauthClientSchema.index({ clientId: 1, tenantId: 1 }, { unique: true });

export const oauthGrantSchema: Schema<IOAuthGrant> = new Schema<IOAuthGrant>(
  {
    clientId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'user',
      index: true,
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    revokedAt: {
      type: Date,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

oauthGrantSchema.index({ clientId: 1, userId: 1, revokedAt: 1, tenantId: 1 });

export const oauthAuthorizationCodeSchema: Schema<IOAuthAuthorizationCode> =
  new Schema<IOAuthAuthorizationCode>({
    codeHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    clientId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'user',
      index: true,
    },
    grantId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'OAuthGrant',
      index: true,
    },
    redirectUri: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    codeChallenge: {
      type: String,
    },
    codeChallengeMethod: {
      type: String,
      enum: ['S256', 'plain'],
    },
    usedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    tenantId: {
      type: String,
      index: true,
    },
  });

oauthAuthorizationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const oauthTokenSchema: Schema<IOAuthToken> = new Schema<IOAuthToken>({
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  kind: {
    type: String,
    enum: ['access', 'refresh'],
    required: true,
    index: true,
  },
  clientId: {
    type: String,
    required: true,
    index: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'user',
    index: true,
  },
  grantId: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'OAuthGrant',
    index: true,
  },
  scopes: {
    type: [String],
    required: true,
    default: [],
  },
  revokedAt: {
    type: Date,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

oauthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
oauthTokenSchema.index({ clientId: 1, grantId: 1, kind: 1, revokedAt: 1, tenantId: 1 });
