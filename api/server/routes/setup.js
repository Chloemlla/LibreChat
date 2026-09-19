const express = require('express');
const { createSetupHandlers } = require('@librechat/api');
const { SystemRoles } = require('librechat-data-provider');
const { getTenantId } = require('@librechat/data-schemas');
const { registerUser } = require('~/server/services/AuthService');
const middleware = require('~/server/middleware');
const { countUsersByRole } = require('~/models');

const router = express.Router();

const handlers = createSetupHandlers({
  countAdmins: () => countUsersByRole(SystemRoles.ADMIN),
  registerUser,
  getTenantId,
});

router.get('/status', handlers.getSetupStatus);
router.post(
  '/',
  middleware.registerLimiter,
  middleware.requireSameOrigin,
  middleware.validateTurnstile,
  handlers.initialize,
);

module.exports = router;
