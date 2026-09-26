const fs = require('node:fs');
const path = require('node:path');

// The SDK is a Lens Studio package, so load its TypeScript without a build step.
// In the deployment monorepo, reuse the frontend's TypeScript installation.
let ts;
try {
    ts = require('typescript');
} catch {
    ts = require('../../estuary-frontend/node_modules/typescript');
}
require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
        fileName: filename,
    });
    module._compile(output.outputText, filename);
};

global.print = () => {};
