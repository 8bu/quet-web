// Build the web bundle, then `wrangler deploy` to the custom domain in QUET_DOMAIN.
// QUET_DOMAIN comes from the shell, or from the gitignored `.deploy.env` file (`QUET_DOMAIN=host`).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function fromDeployEnv() {
  if (!existsSync('.deploy.env')) return undefined;
  for (const line of readFileSync('.deploy.env', 'utf8').split('\n')) {
    const match = /^\s*QUET_DOMAIN\s*=\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

const domain = (process.env.QUET_DOMAIN || fromDeployEnv() || '').trim();
if (!domain) {
  console.error(
    'deploy: QUET_DOMAIN is not set. Set it in the shell or put QUET_DOMAIN=<your-domain> in .deploy.env.',
  );
  process.exit(1);
}
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
  console.error(`deploy: QUET_DOMAIN "${domain}" is not a plain host name (no scheme, path or wildcard).`);
  process.exit(1);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run('node', ['scripts/build-web.mjs']);
run('npx', ['wrangler', 'deploy', '--domain', domain, ...process.argv.slice(2)]);
