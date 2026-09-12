import mongoose from 'mongoose';
import { createModels } from './index';

describe('OAuth models after upstream synchronization', () => {
  it('registers fork and upstream models together and reuses them on reinitialization', () => {
    const connection = new mongoose.Mongoose();
    connection.set('autoCreate', false);
    connection.set('autoIndex', false);
    const models = createModels(connection);
    const again = createModels(connection);

    expect(models.OAuthClient.modelName).toBe('OAuthClient');
    expect(models.OAuthGrant.modelName).toBe('OAuthGrant');
    expect(models.OAuthAuthorizationCode.modelName).toBe('OAuthAuthorizationCode');
    expect(models.OAuthToken.modelName).toBe('OAuthToken');
    expect(models.Schedule).toBeDefined();
    expect(models.AgentQueuedTurn).toBeDefined();
    expect(models.OpenIDRefreshFlight).toBeDefined();
    expect(again.OAuthClient).toBe(models.OAuthClient);
    expect(again.OAuthToken).toBe(models.OAuthToken);
    expect(models.OAuthClient.listenerCount('index')).toBe(1);
  });
});
