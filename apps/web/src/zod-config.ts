import { z } from 'zod';

/**
 * Imported first by main.tsx (Task 46). Zod 4 probes whether `new Function` is allowed in order to JIT-compile object
 * parsers; under the production CSP (`script-src 'self'`, no 'unsafe-eval') the probe is blocked — harmlessly, zod falls
 * back — but the browser still reports a CSP violation on every page. `jitless` skips the probe and never uses eval.
 */
z.config({ jitless: true });
