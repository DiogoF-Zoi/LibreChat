const express = require('express');
const { createSignedDownloadHandler } = require('@librechat/api');
const { getContentDisposition } = require('~/server/utils/files');
const { getAppConfig } = require('~/server/services/Config/app');
const { getFiles } = require('~/models');

const router = express.Router();

router.get(
  '/:id',
  createSignedDownloadHandler({
    getSecret: () => process.env.JWT_SECRET,
    getFiles,
    getAppConfig,
    getContentDisposition,
  }),
);

module.exports = router;
