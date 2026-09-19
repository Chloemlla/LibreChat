const express = require('express');
const mongoose = require('mongoose');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { createOAuthProviderHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');

const router = express.Router();
const handlers = createOAuthProviderHandlers(mongoose);
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const adminOnly = [requireJwtAuth, requireAdminAccess];

router.get('/.well-known/openid-configuration', handlers.metadata);
router.get('/metadata', handlers.metadata);
router.get('/scopes', handlers.scopes);

router.post('/token', handlers.token);
router.get('/userinfo', handlers.userinfo);
router.post('/introspect', handlers.introspect);
router.post('/revoke', handlers.revoke);

/**
 * The consent screen's data half. `GET /oauth/authorize` documents these same query
 * parameters, but answers with a rendered page; these two answer the client-side
 * consent screen with the resolved request and then with the redirect to follow.
 * They take the session's bearer token rather than the client's credentials, because
 * it is the signed-in user who is being asked to grant.
 */
router.get('/authorize/context', optionalJwtAuth, handlers.authorizeContext);
router.post('/authorize/decision', optionalJwtAuth, handlers.authorizeDecisionJson);

router.get('/clients', adminOnly, handlers.listClients);
router.post('/clients', adminOnly, handlers.createClient);
router.get('/clients/:clientId', adminOnly, handlers.getClient);
router.put('/clients/:clientId', adminOnly, handlers.updateClient);
router.post('/clients/:clientId/rotate-secret', adminOnly, handlers.rotateClientSecret);
router.delete('/clients/:clientId', adminOnly, handlers.deleteClient);

router.get('/grants', adminOnly, handlers.listGrants);
router.post('/grants/:grantId/revoke', adminOnly, handlers.revokeGrant);

module.exports = router;
