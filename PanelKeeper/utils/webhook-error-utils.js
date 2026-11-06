'use strict';

const TIMEOUT_CODES = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT'
]);

function classifyWebhookError(error = {}) {
    const code = error?.cause?.code || error?.code || '';
    const timedOut = TIMEOUT_CODES.has(code)
        || error?.name === 'TimeoutError'
        || error?.name === 'AbortError'
        || /timeout|timed out/i.test(error?.message || '');
    const connectionTimedOut = code === 'UND_ERR_CONNECT_TIMEOUT'
        || code === 'ETIMEDOUT'
        || code === 'ESOCKETTIMEDOUT';

    let hint = '';
    if (code === 'ENOTFOUND') {
        hint = ' Check the hostname; PanelKeeper must be able to resolve it from the machine/container where the server runs.';
    } else if (code === 'ECONNREFUSED') {
        hint = ' The host is reachable but refused the connection; check Home Assistant address and port.';
    } else if (code === 'ECONNRESET') {
        hint = ' The remote host closed the connection; check the reverse proxy and TLS configuration.';
    } else if (connectionTimedOut) {
        hint = ' PanelKeeper could not establish a connection before the timeout. Confirm this address is reachable from the machine running PanelKeeper, Home Assistant is listening on the configured port, and firewalls or VPN routing are not blocking it.';
    } else if (timedOut) {
        hint = ' The request timed out after connecting; check Home Assistant responsiveness, the reverse proxy, and network stability.';
    }

    return {
        code,
        timedOut,
        connectionTimedOut,
        label: connectionTimedOut ? 'Webhook connection timed out' : timedOut ? 'Webhook request timed out' : 'Webhook connection failed',
        hint
    };
}

module.exports = { classifyWebhookError };
