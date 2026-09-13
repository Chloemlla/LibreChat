const express = require('express');
const { createWidgetGenerateHandler } = require('@librechat/api');
const {
  requireJwtAuth,
  configMiddleware,
  validateModel,
  messageUserLimiter,
} = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

router.post(
  '/generate',
  requireJwtAuth,
  messageUserLimiter,
  configMiddleware,
  validateModel.json,
  createWidgetGenerateHandler({ db }),
);

module.exports = router;
