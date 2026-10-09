// Fails if the npm tarball contains anything outside the intended allowlist.
import { execFileSync } from "node:child_process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});
const [{ files, name, version }] = JSON.parse(out);
const paths = files.map((f) => f.path);

const allowed = [
  /^dist\/index\.(js|cjs|d\.ts|d\.cts)$/,
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^CHANGELOG\.md$/,
];
const forbidden = [
  /\.map$/,
  /(^|\/)\.env/,
  /\.npmrc$/,
  /(^|\/)tests?\//,
  /(^|\/)src\//,
  /\.pem$|\.key$|\.crt$/,
  /coverage/,
  /node_modules/,
];

const unexpected = paths.filter((p) => !allowed.some((re) => re.test(p)));
const bad = paths.filter((p) => forbidden.some((re) => re.test(p)));
const required = [
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
  "README.md",
  "LICENSE",
  "package.json",
];
const missing = required.filter((p) => !paths.includes(p));

if (unexpected.length || bad.length || missing.length) {
  console.error({ unexpected, forbidden: bad, missing });
  process.exit(1);
}
console.log(`${name}@${version}: ${paths.length} files OK\n  ${paths.join("\n  ")}`);
