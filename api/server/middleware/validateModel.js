const {
  handleError,
  checkModelAccess,
  modelRejectionMessage,
  modelRejectionStatus,
} = require('@librechat/api');
const { ViolationTypes } = require('librechat-data-provider');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getEndpointsConfig } = require('~/server/services/Config');
const { logViolation } = require('~/cache');

/**
 * Builds a guard around the model-access rule in `@librechat/api`, which is the
 * single definition of which models a request may name. Two guards exist because
 * the callers answer in different shapes — the chat stream over SSE, the widget
 * compile endpoint over JSON — and only the refusal differs between them.
 *
 * @param {Function} reject - Renders a refusal onto the response.
 * @returns {Function} Express middleware.
 */
const createValidateModel = (reject) => async (req, res, next) => {
  const access = await checkModelAccess({
    endpoint: req.body?.endpoint,
    model: req.body?.model,
    getEndpointsConfig: () => getEndpointsConfig(req),
    getModelsConfig: () => getModelsConfig(req),
  });

  if (access.ok) {
    req.body.model = access.model;
    return next();
  }

  if (access.rejection === 'model_not_offered') {
    const { ILLEGAL_MODEL_REQ_SCORE: score = 1 } = process.env ?? {};
    const type = ViolationTypes.ILLEGAL_MODEL_REQUEST;
    await logViolation(req, res, type, { type }, score);
  }

  return reject(res, access.rejection);
};

/** Chat guard: refuses through the SSE helper the chat stream already speaks. */
const validateModel = createValidateModel((res, rejection) =>
  handleError(res, { text: modelRejectionMessage(rejection) }),
);

/** JSON guard: the same rule, in a shape a JSON client can read. */
validateModel.json = createValidateModel((res, rejection) =>
  res.status(modelRejectionStatus(rejection)).json({ error: modelRejectionMessage(rejection) }),
);

module.exports = validateModel;
