// Packs the project, installs the tarball into a clean temp project, and exercises
// ESM import, CJS require and TypeScript type resolution.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const tmp = mkdtempSync(join(tmpdir(), "steadyfetch-smoke-"));
try {
  run("npm", ["run", "build"], root);
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], root),
  )[0].filename;
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(tmp, packed),
      "typescript@5",
      "@types/node@22",
    ],
    tmp,
  );

  const body = `
    const api = createSteadyFetch({ baseURL: "https://api.test", retry: { maxAttempts: 2, jitter: false, baseDelayMs: 1 },
      fetch: async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }) });
    const { data } = await api.json("/x");
    if (!data.ok) throw new Error("bad data");
    console.log("ok");
  `;
  writeFileSync(join(tmp, "esm.mjs"), `import { createSteadyFetch } from "steadyfetch";\n${body}`);
  writeFileSync(
    join(tmp, "cjs.cjs"),
    `const { createSteadyFetch } = require("steadyfetch");\n(async () => {${body}})();`,
  );
  writeFileSync(
    join(tmp, "types.ts"),
    `import { createSteadyFetch, HttpError, type ClientOptions } from "steadyfetch";
     const o: ClientOptions = { baseURL: "https://a.test", timeout: 1000 };
     const api = createSteadyFetch(o);
     export const r: Promise<{ data: { id: number }; response: Response }> = api.json<{ id: number }>("/x");
     export const e = (x: unknown) => x instanceof HttpError && x.status;`,
  );
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        types: ["node"],
        skipLibCheck: false,
      },
      files: ["types.ts"],
    }),
  );

  console.log("ESM:", run("node", ["esm.mjs"], tmp).trim());
  console.log("CJS:", run("node", ["cjs.cjs"], tmp).trim());
  run("npx", ["tsc", "-p", "tsconfig.json"], tmp);
  console.log("TypeScript (NodeNext): ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
