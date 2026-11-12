// Resolve tsx entry for the integration test server launcher.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx');
console.log('TSX_RESOLVE=' + tsx);
