// Local stub replacing the npm 'standardwebhooks' package (Node-only webhook
// signature verification — unused in the browser). Patched into
// resources/beta/webhooks.mjs so the vendored SDK loads without a bundler.
export class Webhook {
  constructor() { throw new Error('Webhook verification is not available in this vendored SDK build.'); }
}
