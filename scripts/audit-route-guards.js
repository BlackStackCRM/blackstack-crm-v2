/**
 * PHASE 3 (static half) — find routes registered WITHOUT an authorization guard.
 *
 * The dynamic probe proves the runtime behaviour of the routes it knows about,
 * but it can only test paths it can guess. This walks the actual route files and
 * reports every registered method+path whose middleware chain contains neither
 * `authMiddleware`/`requirePermission`/an `auth*` gate nor a deliberate public
 * marker.
 *
 * It also flags the reverse asymmetry: mutating verbs (POST/PUT/PATCH/DELETE)
 * with no guard at all. Those are the ones that matter — an unguarded GET is
 * often a public health or login route, an unguarded POST is a defect.
 *
 * Static text analysis of route tables, not runtime: read-only, no server.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');

// Guards that count as authentication or authorization.
const AUTH_GUARDS = [
  'authMiddleware',        // inventory.js, products.js, customers.js, ...
  'requirePermission',     // rbac gate with an explicit permission code
  'authView',              // accounting.js 3-tier read gate
  'authManage',            // accounting.js 3-tier write gate
  'authCreate',            // accounting.js 3-tier create gate
  'authenticate',          // generic
  'requireAuth',
];

// Routes that are legitimately public. Each needs a reason.
const KNOWN_PUBLIC = [
  { re: /auth\/(login|logout|refresh|verify|forgot|reset)/i, why: 'authentication endpoints' },
  { re: /^\/(health|healthz|ping|status)$/i, why: 'health probe' },
  { re: /^\/(setup|install|bootstrap)/i, why: 'first-run bootstrap' },
  { re: /^\/meta\//i, why: 'public metadata' },
  { re: /webhook/i, why: 'webhook (signature-verified)' },
];

function isPublic(route) {
  return KNOWN_PUBLIC.some((p) => p.re.test(route));
}

const report = [];
let unguardedMutations = 0;
let unguardedReads = 0;

for (const file of fs.readdirSync(ROUTES_DIR)) {
  if (!file.endsWith('.js')) continue;
  const full = path.join(ROUTES_DIR, file);
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const m = line.match(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (!m) return;

    const verb = m[1].toUpperCase();
    const routePath = m[2];

    // Gather the full middleware chain: from this call to the matching close paren.
    // Route files put the chain on one line, but tolerate wrapping.
    let chain = line;
    let depth = (chain.match(/\(/g) || []).length - (chain.match(/\)/g) || []).length;
    let j = i;
    while (depth > 0 && j + 1 < lines.length && j - i < 6) {
      j++;
      chain += ` ${lines[j]}`;
      depth += (lines[j].match(/\(/g) || []).length - (lines[j].match(/\)/g) || []).length;
    }

    const guarded = AUTH_GUARDS.some((g) => chain.includes(g));
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb);

    if (!guarded && !isPublic(routePath)) {
      if (isMutation) unguardedMutations++;
      else unguardedReads++;
      report.push({
        file, line: i + 1, verb, routePath, isMutation,
        chain: chain.replace(/\s+/g, ' ').slice(0, 130),
      });
    }
  });
}

console.log('=== UNAUTHENTICATED MUTATIONS (POST/PUT/PATCH/DELETE) ===');
const muts = report.filter((r) => r.isMutation);
if (muts.length === 0) console.log('(none)');
for (const r of muts) {
  console.log(`  ${r.file}:${r.line}  ${r.verb} ${r.routePath}`);
  console.log(`      ${r.chain}`);
}

console.log('\n=== UNAUTHENTICATED READS (GET) ===');
const reads = report.filter((r) => !r.isMutation);
if (reads.length === 0) console.log('(none)');
for (const r of reads) {
  console.log(`  ${r.file}:${r.line}  ${r.verb} ${r.routePath}`);
  console.log(`      ${r.chain}`);
}

console.log(`\nsummary: ${muts.length} unguarded mutations, ${reads.length} unguarded reads`);
process.exit(muts.length > 0 ? 1 : 0);