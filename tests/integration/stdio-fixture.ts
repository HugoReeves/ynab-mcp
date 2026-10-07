import { startStdio } from '../../src/index.js';
import { createDispatcher } from '../../src/runtime/dispatcher.js';
import { createProtocolServer } from '../../src/runtime/protocol.js';
import { fakeServices, ok } from './protocol-fixture.js';

// Test-only process: no config, tokens, upstream calls, or production host override.
startStdio(() => createProtocolServer(createDispatcher(fakeServices(), {
  ynab_get_user: async () => {
    if (process.argv.includes('--pending')) {
      process.stderr.write('fixture-pending\n');
      return new Promise(() => {});
    }
    return ok;
  },
})));
