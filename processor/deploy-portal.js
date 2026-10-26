#!/usr/bin/env node
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { deployPortalIndex } = require('./portalIndex');

// Rebuild the root portal on its own, without reprocessing or redeploying any meeting
deployPortalIndex().then((url) => console.log(`Portal index updated: ${url}`)).catch((error) => {
  console.error(`Portal index deployment failed: ${error.message}`);
  process.exitCode = 1;
});
