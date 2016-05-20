'use strict';

const NpmCdn = require('./modules');
const Webtask = require('webtask-tools');

const handler = NpmCdn.createRequestHandler({
    registryURL: 'https://registry.npmjs.org',
    bowerBundle: '/bower.zip',
    redirectTTL: 60,
    autoIndex: true
});

module.exports = Webtask.fromConnect(handler);