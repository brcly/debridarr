import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag) throw new Error('Pass a release tag or set GITHUB_REF_NAME.');
if (tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} does not match package version v${pkg.version}.`);

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
if (!changelog.includes(`## ${pkg.version}`)) throw new Error(`CHANGELOG.md has no ${pkg.version} release section.`);
const compatibility = await readFile(new URL('../docs/compatibility.md', import.meta.url), 'utf8');
if (!compatibility.includes(`This Debridarr release (\`${pkg.version}\`)`)) throw new Error(`docs/compatibility.md does not name ${pkg.version}.`);
