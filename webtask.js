'use strict';

const NpmCdn = require('./modules');

const handler = NpmCdn.createRequestHandler({
    registryURL: 'https://registry.npmjs.org',
    bowerBundle: '/bower.zip',
    redirectTTL: 60,
    autoIndex: true
});

module.exports = fromConnect(handler);

function createRouteNormalizationRx(claims) {
    var rxSegments = ['^\/'];
    
    // When using a token with a host claim, the api prefix is stripped
    rxSegments.push('(?:api\/run\/)?');
    // Match a container (anything that is not a forward slash)
    rxSegments.push('[^\/]+\/');
    // Match a named webtask
    rxSegments.push('(?:[^\/\?#]+\/?)?');
    
    var normalizeRouteRx = rxSegments.join('');
    
    console.log('normalizeRouteRx', normalizeRouteRx);
    
    return new RegExp(normalizeRouteRx);
}

function fromConnect (connectFn) {
    return function (context, req, res) {
        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt);

        req.originalUrl = req.url;
        req.url = req.url.replace(normalizeRouteRx, '/');

        return connectFn(req, res);
    };
}
