import type { Model } from 'mongoose';
import type { IOAuthAuthorizationCode, IOAuthClient, IOAuthGrant, IOAuthToken } from '~/types';
import {
  oauthAuthorizationCodeSchema,
  oauthClientSchema,
  oauthGrantSchema,
  oauthTokenSchema,
} from '~/schema/oauth';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createOAuthModels(mongoose: typeof import('mongoose')): {
  OAuthClient: Model<IOAuthClient>;
  OAuthGrant: Model<IOAuthGrant>;
  OAuthAuthorizationCode: Model<IOAuthAuthorizationCode>;
  OAuthToken: Model<IOAuthToken>;
} {
  applyTenantIsolation(oauthClientSchema);
  applyTenantIsolation(oauthGrantSchema);
  applyTenantIsolation(oauthAuthorizationCodeSchema);
  applyTenantIsolation(oauthTokenSchema);

  return {
    OAuthClient:
      mongoose.models.OAuthClient || mongoose.model<IOAuthClient>('OAuthClient', oauthClientSchema),
    OAuthGrant:
      mongoose.models.OAuthGrant || mongoose.model<IOAuthGrant>('OAuthGrant', oauthGrantSchema),
    OAuthAuthorizationCode:
      mongoose.models.OAuthAuthorizationCode ||
      mongoose.model<IOAuthAuthorizationCode>(
        'OAuthAuthorizationCode',
        oauthAuthorizationCodeSchema,
      ),
    OAuthToken:
      mongoose.models.OAuthToken || mongoose.model<IOAuthToken>('OAuthToken', oauthTokenSchema),
  };
}
