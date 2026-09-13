const { validateTurnstile } = require('../validateTurnstile');
const { verifyTurnstileToken } = require('~/server/services/start/turnstile');
const { getAppConfig } = require('~/server/services/Config');
const { logger, getTenantId } = require('@librechat/data-schemas');

// Mock dependencies
jest.mock('~/server/services/start/turnstile');
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
  getTenantId: jest.fn(),
}));

describe('validateTurnstile middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      body: {},
      ip: '127.0.0.1',
      get: jest.fn().mockReturnValue('test-user-agent'),
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();

    // Reset mocks
    jest.clearAllMocks();
    getTenantId.mockReturnValue(undefined);
  });

  describe('when Turnstile is disabled', () => {
    beforeEach(() => {
      getAppConfig.mockReturnValue({
        turnstileConfig: null, // No turnstile config
      });
    });

    it('should skip validation and call next()', async () => {
      await validateTurnstile(req, res, next);

      expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
      expect(logger.debug).toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile is disabled, skipping validation',
      );
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should skip validation even when token is provided', async () => {
      req.body.turnstileToken = 'some-token';

      await validateTurnstile(req, res, next);

      expect(logger.debug).toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile is disabled, skipping validation',
      );
      expect(next).toHaveBeenCalled();
      expect(verifyTurnstileToken).not.toHaveBeenCalled();
    });

    it('should load tenant-scoped config when tenant context is present', async () => {
      getTenantId.mockReturnValue('tenant-abc');

      await validateTurnstile(req, res, next);

      expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-abc' });
      expect(next).toHaveBeenCalled();
    });
  });

  describe('when Turnstile is enabled', () => {
    beforeEach(() => {
      getAppConfig.mockReturnValue({
        turnstileConfig: {
          siteKey: 'test-site-key',
        },
      });
    });

    describe('token validation', () => {
      it('should return 400 when token is missing', async () => {
        await validateTurnstile(req, res, next);

        expect(logger.warn).toHaveBeenCalledWith(
          '[validateTurnstile] Invalid or missing Turnstile token',
          expect.objectContaining({
            ip: '127.0.0.1',
            userAgent: 'test-user-agent',
            tokenProvided: false,
            tokenType: 'undefined',
          }),
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Captcha verification is required.',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should return 400 when token is null', async () => {
        req.body.turnstileToken = null;

        await validateTurnstile(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Captcha verification is required.',
        });
      });

      it('should return 400 when token is not a string', async () => {
        req.body.turnstileToken = 123;

        await validateTurnstile(req, res, next);

        expect(logger.warn).toHaveBeenCalledWith(
          '[validateTurnstile] Invalid or missing Turnstile token',
          expect.objectContaining({
            tokenType: 'number',
          }),
        );
        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should return 400 when token is empty string', async () => {
        req.body.turnstileToken = '';

        await validateTurnstile(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Captcha verification is required.',
        });
      });

      it('should return 400 when token is only whitespace', async () => {
        req.body.turnstileToken = '   ';

        await validateTurnstile(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Captcha verification is required.',
        });
      });
    });

    describe('token verification', () => {
      it('should return 400 when verification fails', async () => {
        req.body.turnstileToken = 'invalid-token';
        verifyTurnstileToken.mockResolvedValue({
          success: false,
          verified: false,
          error: 'Invalid token',
        });

        await validateTurnstile(req, res, next);

        expect(verifyTurnstileToken).toHaveBeenCalledWith('invalid-token');
        expect(logger.warn).toHaveBeenCalledWith(
          '[validateTurnstile] Turnstile verification failed',
          expect.objectContaining({
            success: false,
            verified: false,
            error: 'Invalid token',
          }),
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Captcha verification failed. Please try again.',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should return 400 when verification result is null', async () => {
        req.body.turnstileToken = 'valid-token';
        verifyTurnstileToken.mockResolvedValue(null);

        await validateTurnstile(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Captcha verification failed. Please try again.',
        });
      });

      it('should return 400 when success is false', async () => {
        req.body.turnstileToken = 'valid-token';
        verifyTurnstileToken.mockResolvedValue({
          success: false,
          verified: true,
        });

        await validateTurnstile(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should return 400 when verified is false', async () => {
        req.body.turnstileToken = 'valid-token';
        verifyTurnstileToken.mockResolvedValue({
          success: true,
          verified: false,
        });

        await validateTurnstile(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should call next() when verification succeeds', async () => {
        req.body.turnstileToken = 'valid-token';
        verifyTurnstileToken.mockResolvedValue({
          success: true,
          verified: true,
        });

        await validateTurnstile(req, res, next);

        expect(verifyTurnstileToken).toHaveBeenCalledWith('valid-token');
        expect(logger.debug).toHaveBeenCalledWith(
          '[validateTurnstile] Turnstile verification successful',
          expect.objectContaining({
            ip: '127.0.0.1',
            userAgent: 'test-user-agent',
            tokenLength: 11, // 'valid-token'.length
          }),
        );
        expect(req.turnstileVerified).toBe(true);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should trim token before verification', async () => {
        req.body.turnstileToken = '  valid-token  ';
        verifyTurnstileToken.mockResolvedValue({
          success: true,
          verified: true,
        });

        await validateTurnstile(req, res, next);

        expect(verifyTurnstileToken).toHaveBeenCalledWith('valid-token');
        expect(logger.debug).toHaveBeenCalledWith(
          '[validateTurnstile] Turnstile verification successful',
          expect.objectContaining({
            tokenLength: 11,
          }),
        );
        expect(next).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should return 500 when verification throws an error', async () => {
        req.body.turnstileToken = 'valid-token';
        const error = new Error('Network error');
        verifyTurnstileToken.mockRejectedValue(error);

        await validateTurnstile(req, res, next);

        expect(logger.error).toHaveBeenCalledWith(
          '[validateTurnstile] Error during Turnstile validation:',
          expect.objectContaining({
            error: 'Network error',
            stack: error.stack,
            ip: '127.0.0.1',
            userAgent: 'test-user-agent',
            errorName: 'Error',
          }),
        );
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Internal server error during captcha verification.',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should return 500 when getAppConfig throws an error', async () => {
        const error = new Error('Config error');
        getAppConfig.mockImplementation(() => {
          throw error;
        });

        await validateTurnstile(req, res, next);

        expect(logger.error).toHaveBeenCalledWith(
          '[validateTurnstile] Error during Turnstile validation:',
          expect.objectContaining({
            error: 'Config error',
          }),
        );
        expect(res.status).toHaveBeenCalledWith(500);
      });
    });
  });

  describe('edge cases', () => {
    it('should handle missing req.body', async () => {
      req.body = undefined;
      getAppConfig.mockReturnValue({
        turnstileConfig: { siteKey: 'test-key' },
      });

      await validateTurnstile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Captcha verification is required.',
      });
    });

    it('should handle missing req.ip', async () => {
      req.ip = undefined;
      req.body.turnstileToken = 'valid-token';
      getAppConfig.mockReturnValue({
        turnstileConfig: { siteKey: 'test-key' },
      });
      verifyTurnstileToken.mockResolvedValue({
        success: true,
        verified: true,
      });

      await validateTurnstile(req, res, next);

      expect(logger.debug).toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile verification successful',
        expect.objectContaining({
          ip: undefined,
        }),
      );
      expect(next).toHaveBeenCalled();
    });

    it('should handle missing User-Agent header', async () => {
      req.get.mockReturnValue(undefined);
      req.body.turnstileToken = 'valid-token';
      getAppConfig.mockReturnValue({
        turnstileConfig: { siteKey: 'test-key' },
      });
      verifyTurnstileToken.mockResolvedValue({
        success: true,
        verified: true,
      });

      await validateTurnstile(req, res, next);

      expect(logger.debug).toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile verification successful',
        expect.objectContaining({
          userAgent: undefined,
        }),
      );
      expect(next).toHaveBeenCalled();
    });
  });

  describe('configuration variations', () => {
    it('should be disabled when siteKey is empty string', async () => {
      getAppConfig.mockReturnValue({
        turnstileConfig: { siteKey: '' },
      });

      await validateTurnstile(req, res, next);

      expect(logger.debug).toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile is disabled, skipping validation',
      );
      expect(next).toHaveBeenCalled();
    });

    it('should be disabled when siteKey is null', async () => {
      getAppConfig.mockReturnValue({
        turnstileConfig: { siteKey: null },
      });

      await validateTurnstile(req, res, next);

      expect(logger.debug).toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile is disabled, skipping validation',
      );
      expect(next).toHaveBeenCalled();
    });

    it('should be enabled when siteKey is present', async () => {
      getAppConfig.mockReturnValue({
        turnstileConfig: { siteKey: 'valid-site-key' },
      });

      await validateTurnstile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400); // Missing token
      expect(logger.debug).not.toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile is disabled, skipping validation',
      );
    });

    it('should support legacy turnstile config shape', async () => {
      getAppConfig.mockReturnValue({
        turnstile: { siteKey: 'valid-site-key' },
      });

      await validateTurnstile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(logger.debug).not.toHaveBeenCalledWith(
        '[validateTurnstile] Turnstile is disabled, skipping validation',
      );
    });
  });
});
