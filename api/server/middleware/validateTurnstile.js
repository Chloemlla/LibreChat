const { logger, getTenantId } = require('@librechat/data-schemas');
const { verifyTurnstileToken } = require('~/server/services/start/turnstile');
const { getAppConfig } = require('~/server/services/Config');

const getTurnstileConfig = (appConfig) => appConfig?.turnstileConfig ?? appConfig?.turnstile;

/**
 * Middleware to validate Turnstile token for login and registration
 * Skips validation if Turnstile is not enabled in the configuration.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {Function} next - Express next function
 */
const validateTurnstile = async (req, res, next) => {
  try {
    const tenantId = getTenantId();
    const appConfig = await getAppConfig({
      ...(tenantId ? { tenantId } : {}),
      skipRuntimeAugmentation: true,
      failClosed: true,
    });
    const turnstileConfig = getTurnstileConfig(appConfig);
    const turnstileEnabled = Boolean(turnstileConfig?.siteKey);

    const { turnstileToken } = req.body || {};

    if (!turnstileEnabled) {
      logger.debug('[validateTurnstile] Turnstile is disabled, skipping validation');
      return next();
    }

    const token = typeof turnstileToken === 'string' ? turnstileToken.trim() : '';

    if (!token) {
      logger.warn('[validateTurnstile] Invalid or missing Turnstile token', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        tokenProvided: !!turnstileToken,
        tokenType: typeof turnstileToken,
      });
      return res.status(400).json({
        message: 'Captcha verification is required.',
      });
    }

    const turnstileResult = await verifyTurnstileToken(token);

    if (!turnstileResult || !turnstileResult.success || !turnstileResult.verified) {
      const errorDetails = {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        success: turnstileResult?.success,
        verified: turnstileResult?.verified,
        error: turnstileResult?.error,
      };

      logger.warn('[validateTurnstile] Turnstile verification failed', errorDetails);

      return res.status(400).json({
        message: 'Captcha verification failed. Please try again.',
      });
    }

    logger.debug('[validateTurnstile] Turnstile verification successful', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      tokenLength: token.length,
    });

    req.turnstileVerified = true;
    next();
  } catch (error) {
    logger.error('[validateTurnstile] Error during Turnstile validation:', {
      error: error.message,
      stack: error.stack,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      errorName: error.name,
    });

    return res.status(500).json({
      message: 'Internal server error during captcha verification.',
    });
  }
};

module.exports = {
  validateTurnstile,
};
