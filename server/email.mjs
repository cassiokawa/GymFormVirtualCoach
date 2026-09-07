/**
 * Swappable email transport.
 *
 * In dev mode, the verification/reset link is written to the server console so
 * the flow is fully testable without a provider. A real provider can be plugged
 * in by implementing send() without changing any caller.
 */

export function createEmailTransport(mode = 'dev') {
  if (mode === 'dev') {
    return {
      mode: 'dev',
      /** @returns {Promise<boolean>} true on "delivery" success. */
      async send(to, subject, link) {
        // eslint-disable-next-line no-console
        console.log('\n========== [DEV EMAIL] ==========');
        console.log(`To:      ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(`Link:    ${link}`);
        console.log('=================================\n');
        return true;
      },
    };
  }
  // Placeholder for a real provider (SMTP/API). Wire credentials here later.
  return {
    mode,
    async send(_to, _subject, _link) {
      throw new Error(`Email transport "${mode}" is not configured yet.`);
    },
  };
}
